import { DispatchRepository } from "./repository";
import { CourierWithDistance, CreateOrderInput, Order } from "./types";

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

export class NoCouriersAvailableError extends Error {
  constructor() {
    super("No hay domiciliarios activos cerca del punto de recogida");
    this.name = "NoCouriersAvailableError";
  }
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

export class DispatchService {
  constructor(
    private readonly repo: DispatchRepository,
    private readonly notifier: DispatchNotifier = noopNotifier,
    private readonly searchRadiusMeters: number = DEFAULT_SEARCH_RADIUS_METERS,
    private readonly maxCandidates: number = DEFAULT_MAX_CANDIDATES
  ) {}

  /**
   * Crea una solicitud de domicilio y busca los domiciliarios activos más
   * cercanos al punto de recogida para ofrecérselo. No asigna a nadie
   * todavía: la asignación ocurre cuando alguno de los candidatos acepta
   * (ver `acceptOrder`).
   */
  async createDeliveryRequest(input: CreateOrderInput): Promise<{
    order: Order;
    candidates: CourierWithDistance[];
  }> {
    const order = await this.repo.createOrder(input);

    const candidates = await this.repo.findActiveCouriersNear(
      input.pickup,
      this.searchRadiusMeters,
      this.maxCandidates
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

  /**
   * Un domiciliario intenta aceptar un pedido ofrecido. Solo uno puede
   * ganar: la operación de asignación en el repositorio es atómica
   * (compare-and-swap contra el estado SEARCHING), así que si dos
   * domiciliarios llaman a este método "al mismo tiempo" para el mismo
   * pedido, como mucho uno recibe el pedido asignado y el resto recibe
   * `OrderAlreadyTakenError`.
   */
  async getOrderOrNull(orderId: string): Promise<Order | null> {
    return this.repo.getOrder(orderId);
  }

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

  async markDelivered(orderId: string): Promise<Order> {
    return this.transitionStatus(orderId, "DELIVERED", { deliveredAt: new Date() });
  }

  async cancelOrder(orderId: string): Promise<Order> {
    return this.transitionStatus(orderId, "CANCELLED", { cancelledAt: new Date() });
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
