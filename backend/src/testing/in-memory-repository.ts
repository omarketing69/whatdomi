import { DispatchRepository } from "../domain/repository";
import { haversineDistanceMeters } from "../domain/geo";
import {
  Business,
  Courier,
  CourierWithDistance,
  CreateBusinessInput,
  CreateCourierInput,
  CreateOrderInput,
  GeoPoint,
  Order,
  OrderStatus,
} from "../domain/types";

let idCounter = 0;
function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}_${idCounter}`;
}

/** Cede el control del event loop, para simular intercalado real entre dos llamadas "concurrentes". */
function tick(ms = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Implementación en memoria de `DispatchRepository`, usada en tests para
 * ejercitar la lógica de despacho (incluida la condición de carrera de
 * "el primero que acepta gana") sin depender de una base de datos real.
 *
 * `tryAssignOrder` cede el control del event loop antes de escribir el
 * nuevo estado, igual que ocurriría con una consulta real a la base de
 * datos, para que dos llamadas concurrentes puedan intercalarse de verdad
 * y la prueba sea representativa de la carrera que se da en producción.
 */
export class InMemoryDispatchRepository implements DispatchRepository {
  private orders = new Map<string, Order>();
  private couriers = new Map<string, Courier>();
  private businesses = new Map<string, Business>();

  async createBusiness(input: CreateBusinessInput): Promise<Business> {
    const business: Business = {
      id: nextId("business"),
      name: input.name,
      phone: input.phone,
      address: input.address ?? null,
      createdAt: new Date(),
    };
    this.businesses.set(business.id, business);
    return { ...business };
  }

  async createCourier(input: CreateCourierInput): Promise<Courier> {
    return this.seedCourier({
      name: input.name,
      phone: input.phone,
      vehiclePlate: input.vehiclePlate ?? null,
      isActive: false,
      lat: null,
      lng: null,
      lastSeenAt: null,
    });
  }

  seedCourier(courier: Partial<Courier> & { id?: string }): Courier {
    const full: Courier = {
      id: courier.id ?? nextId("courier"),
      name: courier.name ?? "Domiciliario",
      phone: courier.phone ?? "0000000000",
      vehiclePlate: courier.vehiclePlate ?? null,
      isActive: courier.isActive ?? true,
      lat: courier.lat ?? null,
      lng: courier.lng ?? null,
      lastSeenAt: courier.lastSeenAt ?? new Date(),
      createdAt: courier.createdAt ?? new Date(),
    };
    this.couriers.set(full.id, full);
    return full;
  }

  async createOrder(input: CreateOrderInput): Promise<Order> {
    const now = new Date();
    const order: Order = {
      id: nextId("order"),
      businessId: input.businessId,
      pickup: input.pickup,
      pickupAddress: input.pickupAddress,
      dropoff: input.dropoff,
      dropoffAddress: input.dropoffAddress,
      customerName: input.customerName ?? null,
      customerPhone: input.customerPhone ?? null,
      notes: input.notes ?? null,
      status: "CREATED",
      courierId: null,
      createdAt: now,
      updatedAt: now,
      assignedAt: null,
      deliveredAt: null,
      cancelledAt: null,
    };
    this.orders.set(order.id, order);
    return { ...order };
  }

  async getOrder(orderId: string): Promise<Order | null> {
    const order = this.orders.get(orderId);
    return order ? { ...order } : null;
  }

  async findActiveCouriersNear(
    point: GeoPoint,
    radiusMeters: number,
    limit: number,
    excludeCourierIds: string[] = []
  ): Promise<CourierWithDistance[]> {
    const excluded = new Set(excludeCourierIds);
    const withDistance: CourierWithDistance[] = [];

    for (const courier of this.couriers.values()) {
      if (!courier.isActive) continue;
      if (courier.lat === null || courier.lng === null) continue;
      if (excluded.has(courier.id)) continue;

      const distanceMeters = haversineDistanceMeters(point, {
        lat: courier.lat,
        lng: courier.lng,
      });
      if (distanceMeters > radiusMeters) continue;

      withDistance.push({ ...courier, distanceMeters });
    }

    withDistance.sort((a, b) => a.distanceMeters - b.distanceMeters);
    return withDistance.slice(0, limit);
  }

  async tryAssignOrder(orderId: string, courierId: string): Promise<Order | null> {
    // Simula la latencia de una consulta real a la base de datos, para que
    // dos llamadas "simultáneas" puedan intercalarse antes de escribir.
    await tick();

    const order = this.orders.get(orderId);
    if (!order) return null;
    // Compare-and-swap: solo gana quien encuentra el pedido todavía en
    // SEARCHING y sin domiciliario. Esta comprobación + escritura ocurre
    // sin ningún `await` en medio, así que es la sección atómica.
    if (order.status !== "SEARCHING" || order.courierId !== null) {
      return null;
    }

    const updated: Order = {
      ...order,
      status: "ASSIGNED",
      courierId,
      assignedAt: new Date(),
      updatedAt: new Date(),
    };
    this.orders.set(orderId, updated);
    return { ...updated };
  }

  async updateOrderStatus(
    orderId: string,
    status: OrderStatus,
    extra?: { deliveredAt?: Date; cancelledAt?: Date }
  ): Promise<Order | null> {
    const order = this.orders.get(orderId);
    if (!order) return null;

    const updated: Order = {
      ...order,
      status,
      updatedAt: new Date(),
      deliveredAt: extra?.deliveredAt ?? order.deliveredAt,
      cancelledAt: extra?.cancelledAt ?? order.cancelledAt,
    };
    this.orders.set(orderId, updated);
    return { ...updated };
  }

  async upsertCourierLocation(courierId: string, point: GeoPoint): Promise<Courier | null> {
    const courier = this.couriers.get(courierId);
    if (!courier) return null;
    const updated: Courier = { ...courier, lat: point.lat, lng: point.lng, lastSeenAt: new Date() };
    this.couriers.set(courierId, updated);
    return { ...updated };
  }

  async setCourierActive(courierId: string, isActive: boolean): Promise<Courier | null> {
    const courier = this.couriers.get(courierId);
    if (!courier) return null;
    const updated: Courier = { ...courier, isActive };
    this.couriers.set(courierId, updated);
    return { ...updated };
  }

  async getCourier(courierId: string): Promise<Courier | null> {
    const courier = this.couriers.get(courierId);
    return courier ? { ...courier } : null;
  }
}
