export type OrderStatus =
  | "CREATED"
  | "QUOTED"
  | "SEARCHING"
  | "ASSIGNED"
  | "IN_PROGRESS"
  | "DELIVERED"
  | "CANCELLED"
  | "NO_COURIERS_AVAILABLE";

/**
 * No hay pasarela de pagos integrada en el MVP (se maneja manual/offline
 * entre negocio y domiciliario). Estos campos dejan el espacio en el
 * modelo de datos para conectar una pasarela más adelante sin migrar el
 * esquema otra vez.
 */
export type PaymentStatus = "PENDING" | "PAID" | "REFUNDED";

export interface GeoPoint {
  lat: number;
  lng: number;
}

export interface Business {
  id: string;
  name: string;
  phone: string;
  address?: string | null;
  createdAt: Date;
}

export interface Courier {
  id: string;
  name: string;
  phone: string;
  vehiclePlate?: string | null;
  isActive: boolean;
  /**
   * Código de activación entregado al domiciliario al registrarse en la PWA.
   * Lo usa para "prender" su sesión (activarse) sin necesitar una cuenta con
   * contraseña; ver `docs/ARCHITECTURE.md` §7 sobre por qué esto basta para
   * el MVP y qué le falta para producción.
   */
  activationCode: string;
  lat: number | null;
  lng: number | null;
  lastSeenAt: Date | null;
  createdAt: Date;
}

export interface Order {
  id: string;
  businessId: string;
  /** Nombre de quien solicita el servicio desde el negocio (no el cliente final). */
  requesterName: string | null;
  pickup: GeoPoint;
  pickupAddress: string;
  dropoff: GeoPoint;
  dropoffAddress: string;
  customerName?: string | null;
  customerPhone?: string | null;
  notes?: string | null;
  status: OrderStatus;
  courierId: string | null;
  distanceMeters: number | null;
  fare: number | null;
  currency: string | null;
  paymentLink: string | null;
  paymentStatus: PaymentStatus | null;
  createdAt: Date;
  updatedAt: Date;
  assignedAt: Date | null;
  deliveredAt: Date | null;
  cancelledAt: Date | null;
}

export interface CourierWithDistance extends Courier {
  distanceMeters: number;
}

export interface CreateBusinessInput {
  name: string;
  phone: string;
  address?: string;
}

export interface CreateCourierInput {
  name: string;
  phone: string;
  vehiclePlate?: string;
}

export interface CreateOrderInput {
  businessId: string;
  requesterName?: string;
  pickup: GeoPoint;
  pickupAddress: string;
  dropoff: GeoPoint;
  dropoffAddress: string;
  customerName?: string;
  customerPhone?: string;
  notes?: string;
  /**
   * `CREATED` (por defecto) es el pedido directo del formulario web: se
   * busca domiciliario de inmediato. `QUOTED` es el usado por el flujo de
   * WhatsApp: el pedido queda con una tarifa calculada, esperando que el
   * solicitante confirme antes de buscar domiciliario (ver DispatchService).
   */
  initialStatus?: "CREATED" | "QUOTED";
  distanceMeters?: number;
  fare?: number;
  currency?: string;
}
