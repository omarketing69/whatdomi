import { isoDate } from "./date";
import { DispatchRepository } from "./repository";
import { SettlementService } from "./settlement";
import { CourierWithDistance, CreateOrderInput, Order, OrderStatus } from "./types";

export const DEFAULT_SEARCH_RADIUS_METERS = 5_000;
export const DEFAULT_MAX_CANDIDATES = 5;

/**
 * Notifica eventos de despacho hacia el mundo exterior (sockets, WhatsApp,
 * logs, lo que sea). Inyectado para que la lógica de negocio no dependa de
 * la capa de tiempo real y se pueda probar en aislamiento.
 */
export interface DispatchNotifier {
  onOrderOffered(order: Order, candidates: CourierWithDistance[]): void;
  onOrderAssigned(order: Order, winnerCourierId: string): void;
  onOrderStatusChanged(order: Order): void;
  onNoCouriersAvailable(order: Order): void;
}

export const noopNotifier: DispatchNotifier = {
  onOrderOffered() {},
  onOrderAssigned() {},
  onOrderStatusChanged() {},
  onNoCouriersAvailable() {},
};

/** Reenvía cada evento a todos los notificadores dados (ej. Socket.io + WhatsApp a la vez). */
export function combineNotifiers(...notifiers: DispatchNotifier[]): DispatchNotifier {
  return {
    onOrderOffered(order, candidates) {
      for (const n of notifiers) n.onOrderOffered(order, candidates);
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

export class DispatchService {
  constructor(
    private readonly repo: DispatchRepository,
    private readonly notifier: DispatchNotifier = noopNotifier,
    private readonly searchRadiusMeters: number = DEFAULT_SEARCH_RADIUS_METERS,
    private readonly maxCandidates: number = DEFAULT_MAX_CANDIDATES,
    /** Opcional para no romper tests/usos que no necesitan comisión (ver markDelivered). */
    private readonly settlements?: SettlementService
  ) {}

  /**
   * Crea una solicitud de domicilio y busca los domiciliarios activos más
   * cercanos al punto de recogida para ofrecérselo de inmediato. Es el
   * camino del formulario web directo, donde no hay una tarifa que
   * confirmar antes: el negocio ya sabe lo que está pidiendo.
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
   * El solicitante aceptó la tarifa cotizada: se sale a buscar
   * domiciliarios activos cerca del punto de recogida, igual que en
   * `createDeliveryRequest`.
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
   * Un domiciliario intenta aceptar un pedido ofrecido. Solo uno puede
   * ganar: la operación de asignación en el repositorio es atómica
   * (compare-and-swap contra el estado SEARCHING), así que si dos
   * domiciliarios llaman a este método "al mismo tiempo" para el mismo
   * pedido, como mucho uno recibe el pedido asignado y el resto recibe
   * `OrderAlreadyTakenError`.
   */
  async acceptOrder(orderId: string, courierId: string): Promise<Order> {
    const assigned = await this.repo.tryAssignOrder(orderId, courierId);

    if (!assigned) {
      const existing = await this.repo.getOrder(orderId);
      if (!existing) throw new OrderNotFoundError(orderId);
      throw new OrderAlreadyTakenError(orderId);
    }

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
    return this.transitionStatus(orderId, "CANCELLED", { cancelledAt: new Date() });
  }

  /**
   * Fallback operativo desde el tablero de administración: el camino
   * principal de asignación es 100% automático, pero si el domiciliario
   * asignado no puede cumplir, un admin puede forzar una nueva búsqueda
   * (excluyendo al domiciliario anterior) en vez de esperar a que el
   * negocio cancele y vuelva a pedir.
   */
  async reassignOrder(orderId: string): Promise<{ order: Order; candidates: CourierWithDistance[] }> {
    const previous = await this.repo.getOrder(orderId);
    if (!previous) throw new OrderNotFoundError(orderId);

    const unassigned = await this.repo.unassignOrder(orderId);
    if (!unassigned) throw new OrderNotFoundError(orderId);

    return this.searchAndOffer(unassigned, previous.courierId ? [previous.courierId] : []);
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
    this.notifier.onOrderOffered(finalOrder, candidates);
    return { order: finalOrder, candidates };
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
