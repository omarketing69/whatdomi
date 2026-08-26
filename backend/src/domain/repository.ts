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

  getBusiness(businessId: string): Promise<Business | null>;

  /**
   * Usado por el flujo de WhatsApp: la primera vez que un número escribe,
   * no hay un negocio pre-registrado detrás (no hay verificación de
   * identidad en el MVP) — se crea uno mínimo con ese teléfono y el nombre
   * que el solicitante dio por chat. Llamadas posteriores desde el mismo
   * teléfono reutilizan el mismo negocio.
   */
  findOrCreateBusinessByPhone(phone: string, name: string): Promise<Business>;

  createCourier(input: CreateCourierInput): Promise<Courier>;

  createOrder(input: CreateOrderInput): Promise<Order>;

  getOrder(orderId: string): Promise<Order | null>;

  /** Para el tablero de administración (solo monitoreo, no asigna nada). */
  listOrders(filter?: { statuses?: OrderStatus[]; limit?: number }): Promise<Order[]>;

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

  /**
   * Fallback operativo para el tablero de administración: libera la
   * asignación actual (si la hay) y vuelve a poner el pedido en
   * `SEARCHING`, para que `DispatchService` reintente la búsqueda. No es
   * el camino principal (la asignación es automática) — es la salida
   * manual cuando algo salió mal con el domiciliario asignado.
   */
  unassignOrder(orderId: string): Promise<Order | null>;

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
