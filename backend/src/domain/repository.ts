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
} from "./types";

/**
 * Puerto de persistencia que la lógica de despacho necesita. Se implementa
 * una vez contra Postgres/PostGIS (infra/postgres-repository.ts) y otra vez
 * en memoria para pruebas unitarias (testing/in-memory-repository.ts), de
 * forma que la parte más delicada del negocio -la asignación- se pueda
 * probar sin levantar una base de datos real.
 */
export interface DispatchRepository {
  createBusiness(input: CreateBusinessInput): Promise<Business>;

  createCourier(input: CreateCourierInput): Promise<Courier>;

  createOrder(input: CreateOrderInput): Promise<Order>;

  getOrder(orderId: string): Promise<Order | null>;

  /**
   * Devuelve domiciliarios activos ordenados por cercanía al punto dado,
   * dentro de un radio máximo. `excludeCourierIds` permite no volver a
   * ofrecer el pedido a quien ya lo rechazó.
   */
  findActiveCouriersNear(
    point: GeoPoint,
    radiusMeters: number,
    limit: number,
    excludeCourierIds?: string[]
  ): Promise<CourierWithDistance[]>;

  /**
   * Intento atómico de "el primero que acepta, gana": solo tiene efecto si
   * el pedido sigue en estado SEARCHING y sin domiciliario asignado. Debe
   * implementarse como una operación condicional a nivel de base de datos
   * (compare-and-swap), nunca como un read-then-write en dos pasos, para
   * evitar que dos domiciliarios "ganen" el mismo pedido en una carrera.
   *
   * Devuelve el pedido actualizado si este domiciliario ganó la asignación,
   * o `null` si el pedido ya no estaba disponible (otro domiciliario lo tomó,
   * fue cancelado, etc.).
   */
  tryAssignOrder(orderId: string, courierId: string): Promise<Order | null>;

  updateOrderStatus(
    orderId: string,
    status: OrderStatus,
    extra?: { deliveredAt?: Date; cancelledAt?: Date }
  ): Promise<Order | null>;

  upsertCourierLocation(
    courierId: string,
    point: GeoPoint
  ): Promise<Courier | null>;

  setCourierActive(courierId: string, isActive: boolean): Promise<Courier | null>;

  getCourier(courierId: string): Promise<Courier | null>;
}
