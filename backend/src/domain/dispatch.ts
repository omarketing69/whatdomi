import { isoDate } from "./date";
import { haversineDistanceMeters } from "./geo";
import { DispatchRepository } from "./repository";
import { SettlementService } from "./settlement";
import { Courier, CourierWithDistance, CreateOrderInput, GeoPoint, Order, OrderStatus } from "./types";

export const DEFAULT_SEARCH_RADIUS_METERS = 5_000;
export const DEFAULT_MAX_CANDIDATES = 5;
/** Ventana que tiene cada domiciliario candidato para aceptar antes de pasar al siguiente más cercano. */
export const DEFAULT_OFFER_TIMEOUT_MS = 60_000;
/** Radio (metros) alrededor del punto de entrega dentro del cual se considera que el domiciliario "llegó". */
export const DEFAULT_DELIVERY_GEOFENCE_METERS = 100;

/**
 * Notifica eventos de despacho hacia el mundo exterior (sockets, WhatsApp,
 * logs, lo que sea). Inyectado para que la lógica de negocio no dependa de
 * la capa de tiempo real y se pueda probar en aislamiento.
 */
export interface DispatchNotifier {
  /**
   * En el modelo de cascada, `candidates` siempre trae un solo elemento: el
   * candidato al que le toca el turno ahora mismo. Se mantiene como arreglo
   * (en vez de un solo `CourierWithDistance`) porque "a quién se le está
   * ofreciendo este pedido" sigue siendo conceptualmente una lista, aunque
   * hoy solo el primero de la fila tenga la oferta viva.
   */
  onOrderOffered(order: Order, candidates: CourierWithDistance[]): void;
  /** El candidato actual no respondió a tiempo: se le retira la oferta antes de ofrecérsela al siguiente. */
  onOfferExpired(order: Order, courierId: string): void;
  onOrderAssigned(order: Order, winnerCourierId: string): void;
  onOrderStatusChanged(order: Order): void;
  onNoCouriersAvailable(order: Order): void;
  /** Se agotó la cascada completa sin que nadie aceptara: requiere asignación manual del admin. */
  onOrderUnassigned(order: Order): void;
}

export const noopNotifier: DispatchNotifier = {
  onOrderOffered() {},
  onOfferExpired() {},
  onOrderAssigned() {},
  onOrderStatusChanged() {},
  onNoCouriersAvailable() {},
  onOrderUnassigned() {},
};

/** Reenvía cada evento a todos los notificadores dados (ej. Socket.io + WhatsApp a la vez). */
export function combineNotifiers(...notifiers: DispatchNotifier[]): DispatchNotifier {
  return {
    onOrderOffered(order, candidates) {
      for (const n of notifiers) n.onOrderOffered(order, candidates);
    },
    onOfferExpired(order, courierId) {
      for (const n of notifiers) n.onOfferExpired(order, courierId);
    },
    onOrderAssigned(order, winnerCourierId) {
      for (const n of notifiers) n.onOrderAssigned(order, winnerCourierId);
    },
    onOrderStatusChanged(order) {
      for (const n of notifiers) n.onOrderStatusChanged(order);
    },
    onNoCouriersAvailable(order) {
      for (const n of notifiers) n.onNoCouriersAvailable(order);
    },
    onOrderUnassigned(order) {
      for (const n of notifiers) n.onOrderUnassigned(order);
    },
  };
}

export class OrderNotFoundError extends Error {
  constructor(orderId: string) {
    super(`Pedido ${orderId} no encontrado`);
    this.name = "OrderNotFoundError";
  }
}

export class OrderAlreadyTakenError extends Error {
  constructor(orderId: string) {
    super(`El pedido ${orderId} ya fue asignado a otro domiciliario, cancelado o no está disponible`);
    this.name = "OrderAlreadyTakenError";
  }
}

export class InvalidOrderStateError extends Error {
  constructor(orderId: string, expected: OrderStatus, actual: OrderStatus) {
    super(`El pedido ${orderId} está en estado ${actual}, se esperaba ${expected}`);
    this.name = "InvalidOrderStateError";
  }
}

/**
 * El domiciliario ya tiene otro pedido `ASSIGNED`/`IN_PROGRESS` sin
 * entregar — no puede tomar uno nuevo hasta cerrar el que tiene (ver
 * `DispatchRepository.tryAssignOrder`/`forceAssignOrder`, que son quienes
 * realmente garantizan esto de forma atómica; este error solo distingue
 * la causa para quien llama).
 */
export class CourierBusyError extends Error {
  constructor(courierId: string, public readonly activeOrderId: string) {
    super(`El domiciliario ${courierId} ya tiene otro pedido en curso (${activeOrderId})`);
    this.name = "CourierBusyError";
  }
}

export interface DispatchServiceOptions {
  notifier?: DispatchNotifier;
  searchRadiusMeters?: number;
  maxCandidates?: number;
  /** Opcional: si no se da, `markDelivered` simplemente no recalcula ninguna liquidación. */
  settlements?: SettlementService;
  offerTimeoutMs?: number;
  /** Radio (metros) de la geocerca de entrega, ver `DEFAULT_DELIVERY_GEOFENCE_METERS`. */
  deliveryGeofenceMeters?: number;
}

/** Estado en memoria de la cascada de un pedido en curso (ver §4 de docs/ARCHITECTURE.md). */
interface CascadeState {
  candidates: CourierWithDistance[];
  currentIndex: number;
  timer: ReturnType<typeof setTimeout>;
}

export class DispatchService {
  private readonly notifier: DispatchNotifier;
  private readonly searchRadiusMeters: number;
  private readonly maxCandidates: number;
  private readonly settlements?: SettlementService;
  private readonly offerTimeoutMs: number;
  private readonly deliveryGeofenceMeters: number;

  /**
   * Cascadas de asignación activas, en memoria, por `orderId`. Se pierden
   * si el proceso se reinicia — ver docs/ARCHITECTURE.md §4 para qué
   * implica eso y cómo se degrada (nunca deja un pedido atascado para
   * siempre: en el peor caso, el próximo `acceptOrder` que llegue para ese
   * pedido lo resuelve por la vía atómica normal, sin cascada).
   */
  private readonly cascades = new Map<string, CascadeState>();

  constructor(private readonly repo: DispatchRepository, options: DispatchServiceOptions = {}) {
    this.notifier = options.notifier ?? noopNotifier;
    this.searchRadiusMeters = options.searchRadiusMeters ?? DEFAULT_SEARCH_RADIUS_METERS;
    this.maxCandidates = options.maxCandidates ?? DEFAULT_MAX_CANDIDATES;
    this.settlements = options.settlements;
    this.offerTimeoutMs = options.offerTimeoutMs ?? DEFAULT_OFFER_TIMEOUT_MS;
    this.deliveryGeofenceMeters = options.deliveryGeofenceMeters ?? DEFAULT_DELIVERY_GEOFENCE_METERS;
  }

  /**
   * Crea una solicitud de domicilio y arranca la cascada de asignación
   * (ver `startCascade`) para el punto de recogida. Es el camino del
   * formulario web directo, donde no hay una tarifa que confirmar antes:
   * el negocio ya sabe lo que está pidiendo.
   *
   * El flujo de WhatsApp usa en cambio `createQuote` + `confirmQuote` (ver
   * más abajo), porque ahí primero hay que cotizar y esperar que el
   * solicitante acepte la tarifa antes de salir a buscar domiciliario.
   */
  async createDeliveryRequest(input: CreateOrderInput): Promise<{
    order: Order;
    candidates: CourierWithDistance[];
  }> {
    const order = await this.repo.createOrder(input);
    return this.searchAndOffer(order);
  }

  /**
   * Crea el pedido con la tarifa ya calculada, en estado `QUOTED`, sin
   * buscar domiciliario todavía. Se usa desde el flujo conversacional de
   * WhatsApp: primero se le muestra la tarifa al solicitante y solo si la
   * acepta (`confirmQuote`) se sale a buscar quién lo recoja.
   */
  async createQuote(
    input: CreateOrderInput & { distanceMeters: number; fare: number; currency: string }
  ): Promise<Order> {
    return this.repo.createOrder({ ...input, initialStatus: "QUOTED" });
  }

  /**
   * El solicitante aceptó la tarifa cotizada: se arranca la cascada de
   * asignación, igual que en `createDeliveryRequest`.
   */
  async confirmQuote(orderId: string): Promise<{ order: Order; candidates: CourierWithDistance[] }> {
    const order = await this.repo.getOrder(orderId);
    if (!order) throw new OrderNotFoundError(orderId);
    if (order.status !== "QUOTED") {
      throw new InvalidOrderStateError(orderId, "QUOTED", order.status);
    }
    return this.searchAndOffer(order);
  }

  async getOrderOrNull(orderId: string): Promise<Order | null> {
    return this.repo.getOrder(orderId);
  }

  async listOrders(filter?: { statuses?: OrderStatus[]; limit?: number }): Promise<Order[]> {
    return this.repo.listOrders(filter);
  }

  /**
   * Ubicación en vivo del domiciliario asignado a un pedido, para el mapa
   * de seguimiento del negocio (ver frontend/index.html). Devuelve
   * únicamente lat/lng — nunca el teléfono ni la cédula del domiciliario,
   * que no son asunto del negocio hasta que WhatsApp se los entregue
   * explícitamente al asignarse (ver `whatsapp/notifier.ts`).
   */
  async getCourierLocation(
    orderId: string
  ): Promise<{ lat: number; lng: number; lastSeenAt: Date | null } | null> {
    const order = await this.repo.getOrder(orderId);
    if (!order?.courierId) return null;

    const courier = await this.repo.getCourier(order.courierId);
    if (!courier || courier.lat === null || courier.lng === null) return null;

    return { lat: courier.lat, lng: courier.lng, lastSeenAt: courier.lastSeenAt };
  }

  /**
   * Reporta la ubicación en vivo del domiciliario (llamado periódicamente
   * desde su PWA) y, de paso, intenta el cierre automático por geocerca:
   * si tiene un pedido en curso (`IN_PROGRESS`, es decir ya recogido y en
   * camino) y esta posición cae dentro de `deliveryGeofenceMeters` del
   * punto de entrega, se marca `DELIVERED` sin esperar a que el
   * domiciliario presione el botón manual.
   *
   * Es deliberadamente best-effort: un fallo en el chequeo de geocerca
   * (o no tener ningún pedido en curso) nunca debe impedir que la
   * ubicación se guarde, que es lo que también alimenta el mapa en vivo
   * del negocio.
   */
  async reportCourierLocation(courierId: string, point: GeoPoint): Promise<Courier | null> {
    const courier = await this.repo.upsertCourierLocation(courierId, point);
    if (!courier) return null;

    try {
      await this.tryAutoCompleteByGeofence(courierId, point);
    } catch (err) {
      console.error(`[dispatch] error en el cierre automático por geocerca del domiciliario ${courierId}`, err);
    }

    return courier;
  }

  private async tryAutoCompleteByGeofence(courierId: string, point: GeoPoint): Promise<void> {
    const order = await this.repo.findInProgressOrderForCourier(courierId);
    if (!order) return;

    const distanceToDropoff = haversineDistanceMeters(point, order.dropoff);
    if (distanceToDropoff > this.deliveryGeofenceMeters) return;

    await this.markDelivered(order.id);
  }

  /**
   * Un domiciliario intenta aceptar un pedido ofrecido. En el modelo de
   * cascada, solo el candidato al que le toca el turno ahora mismo puede
   * intentarlo (si hay una cascada viva para este pedido en memoria); si
   * el proceso se reinició y esa cascada se perdió, se degrada al
   * comportamiento atómico simple ("el primero que acepta gana" contra
   * quien sea, ver `DispatchRepository.tryAssignOrder`).
   *
   * De cualquier forma, la asignación en sí siempre pasa por
   * `tryAssignOrder`, que es la operación atómica (compare-and-swap contra
   * SEARCHING) — el chequeo de "es tu turno" es una capa extra de
   * corrección, no un reemplazo de esa garantía.
   */
  async acceptOrder(orderId: string, courierId: string): Promise<Order> {
    const cascade = this.cascades.get(orderId);
    if (cascade && cascade.candidates[cascade.currentIndex].id !== courierId) {
      throw new OrderAlreadyTakenError(orderId);
    }

    const assigned = await this.repo.tryAssignOrder(orderId, courierId);

    if (!assigned) {
      throw await this.resolveAssignmentFailure(orderId, courierId);
    }

    this.clearCascade(orderId);
    this.notifier.onOrderAssigned(assigned, courierId);
    return assigned;
  }

  async markPickedUp(orderId: string): Promise<Order> {
    return this.transitionStatus(orderId, "IN_PROGRESS");
  }

  /**
   * Al entregar, además de cerrar el pedido, se recalcula la liquidación
   * diaria de comisión del domiciliario para el día de la entrega (ver
   * `SettlementService.recomputeSettlement`) — así el monto que le
   * corresponde pagar a la plataforma queda al día apenas termina cada
   * servicio, no al final del día en un proceso aparte.
   */
  async markDelivered(orderId: string): Promise<Order> {
    const updated = await this.transitionStatus(orderId, "DELIVERED", { deliveredAt: new Date() });
    if (updated.courierId && this.settlements) {
      await this.settlements.recomputeSettlement(updated.courierId, isoDate(updated.deliveredAt ?? new Date()));
    }
    return updated;
  }

  async cancelOrder(orderId: string): Promise<Order> {
    this.clearCascade(orderId);
    return this.transitionStatus(orderId, "CANCELLED", { cancelledAt: new Date() });
  }

  /**
   * Fallback operativo desde el tablero de administración: el camino
   * principal de asignación sigue siendo automático, pero si el
   * domiciliario asignado no puede cumplir, un admin puede forzar una
   * nueva cascada (excluyendo al domiciliario anterior) en vez de esperar
   * a que el negocio cancele y vuelva a pedir.
   */
  async reassignOrder(orderId: string): Promise<{ order: Order; candidates: CourierWithDistance[] }> {
    const previous = await this.repo.getOrder(orderId);
    if (!previous) throw new OrderNotFoundError(orderId);

    this.clearCascade(orderId);
    const unassigned = await this.repo.unassignOrder(orderId);
    if (!unassigned) throw new OrderNotFoundError(orderId);

    return this.searchAndOffer(unassigned, previous.courierId ? [previous.courierId] : []);
  }

  /**
   * Última instancia cuando la cascada se agotó sin que nadie aceptara
   * (`status = UNASSIGNED`): el admin elige directamente al domiciliario.
   * Es el único lugar de todo el sistema donde un humano asigna a mano —
   * en cualquier otro estado del pedido esto se rechaza (no le quita el
   * pedido a un domiciliario que ya está en curso).
   */
  async manuallyAssignOrder(orderId: string, courierId: string): Promise<Order> {
    this.clearCascade(orderId);
    const assigned = await this.repo.forceAssignOrder(orderId, courierId);

    if (!assigned) {
      throw await this.resolveAssignmentFailure(orderId, courierId);
    }

    this.notifier.onOrderAssigned(assigned, courierId);
    return assigned;
  }

  /**
   * `tryAssignOrder`/`forceAssignOrder` devuelven `null` por dos razones
   * posibles: el pedido ya no estaba disponible, o el domiciliario ya
   * tiene otro pedido activo (ambas comprobaciones son atómicas del lado
   * del repositorio, ver sus comentarios). Aquí solo se distingue cuál
   * fue, para dar un error más útil a quien llame.
   */
  private async resolveAssignmentFailure(orderId: string, courierId: string): Promise<Error> {
    const activeOrder = await this.repo.findActiveOrderForCourier(courierId);
    if (activeOrder) return new CourierBusyError(courierId, activeOrder.id);

    const existing = await this.repo.getOrder(orderId);
    if (!existing) return new OrderNotFoundError(orderId);
    return new OrderAlreadyTakenError(orderId);
  }

  private async searchAndOffer(
    order: Order,
    excludeCourierIds: string[] = []
  ): Promise<{ order: Order; candidates: CourierWithDistance[] }> {
    const candidates = await this.repo.findActiveCouriersNear(
      order.pickup,
      this.searchRadiusMeters,
      this.maxCandidates,
      excludeCourierIds
    );

    if (candidates.length === 0) {
      const updated = await this.repo.updateOrderStatus(order.id, "NO_COURIERS_AVAILABLE");
      const finalOrder = updated ?? order;
      this.notifier.onNoCouriersAvailable(finalOrder);
      return { order: finalOrder, candidates: [] };
    }

    const searching = await this.repo.updateOrderStatus(order.id, "SEARCHING");
    const finalOrder = searching ?? order;
    this.startCascade(finalOrder, candidates);
    return { order: finalOrder, candidates };
  }

  /**
   * Ofrece el pedido solo al candidato más cercano, con una ventana de
   * `offerTimeoutMs` (60s por defecto) para aceptar. Si no responde a
   * tiempo, `advanceCascade` le retira la oferta y pasa al siguiente más
   * cercano; si se agota la lista completa, el pedido queda `UNASSIGNED`
   * para asignación manual (ver `manuallyAssignOrder`).
   */
  private startCascade(order: Order, candidates: CourierWithDistance[]): void {
    this.clearCascade(order.id);
    this.cascades.set(order.id, {
      candidates,
      currentIndex: 0,
      timer: this.scheduleAdvance(order.id),
    });
    this.notifier.onOrderOffered(order, [candidates[0]]);
  }

  private scheduleAdvance(orderId: string): ReturnType<typeof setTimeout> {
    return setTimeout(() => {
      this.advanceCascade(orderId).catch((err) =>
        console.error(`[dispatch] error avanzando la cascada de asignación del pedido ${orderId}`, err)
      );
    }, this.offerTimeoutMs);
  }

  private async advanceCascade(orderId: string): Promise<void> {
    const cascade = this.cascades.get(orderId);
    if (!cascade) return; // ya se resolvió (aceptado/cancelado/reasignado) mientras esperábamos.

    const order = await this.repo.getOrder(orderId);
    if (!order || order.status !== "SEARCHING" || order.courierId !== null) {
      // Algo más ya lo resolvió (aceptado por fuera de la cascada tras un
      // reinicio, cancelado, etc.): no hay nada que avanzar.
      this.cascades.delete(orderId);
      return;
    }

    const expiredCandidate = cascade.candidates[cascade.currentIndex];
    this.notifier.onOfferExpired(order, expiredCandidate.id);

    const nextIndex = cascade.currentIndex + 1;
    if (nextIndex >= cascade.candidates.length) {
      this.cascades.delete(orderId);
      const updated = await this.repo.updateOrderStatus(orderId, "UNASSIGNED");
      if (updated) this.notifier.onOrderUnassigned(updated);
      return;
    }

    cascade.currentIndex = nextIndex;
    cascade.timer = this.scheduleAdvance(orderId);
    this.notifier.onOrderOffered(order, [cascade.candidates[nextIndex]]);
  }

  private clearCascade(orderId: string): void {
    const cascade = this.cascades.get(orderId);
    if (!cascade) return;
    clearTimeout(cascade.timer);
    this.cascades.delete(orderId);
  }

  private async transitionStatus(
    orderId: string,
    status: Order["status"],
    extra?: { deliveredAt?: Date; cancelledAt?: Date }
  ): Promise<Order> {
    const updated = await this.repo.updateOrderStatus(orderId, status, extra);
    if (!updated) throw new OrderNotFoundError(orderId);
    this.notifier.onOrderStatusChanged(updated);
    return updated;
  }
}
