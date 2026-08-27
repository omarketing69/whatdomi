/**
 * WhatDomi tiene 3 niveles de acceso:
 *  - `admin`: el dueño de la plataforma. No es una fila más en `businesses`
 *    ni en `couriers` — se modela como acceso a `/api/admin/*` protegido
 *    por una clave compartida (`ADMIN_API_KEY`, ver `requireAdminKey`),
 *    no como una cuenta con usuario/contraseña. Configura tarifas y
 *    comisión, y ve el monitoreo/estadísticas globales.
 *  - `business`: quien solicita domicilios (entidad `Business`).
 *  - `courier`: quien los entrega (entidad `Courier`).
 * Se modelan como entidades separadas (no una tabla `users` con un campo
 * `role`) porque sus datos y ciclo de vida no se parecen en nada — ver
 * `docs/ARCHITECTURE.md` §2 para la justificación completa.
 */
export type PlatformRole = "admin" | "business" | "courier";

export type OrderStatus =
  | "CREATED"
  | "QUOTED"
  | "SEARCHING"
  | "ASSIGNED"
  | "IN_PROGRESS"
  | "DELIVERED"
  | "CANCELLED"
  | "NO_COURIERS_AVAILABLE"
  /**
   * Se agotó la cascada de candidatos (cada uno tuvo su ventana de 60s
   * para aceptar, ver DispatchService) y ninguno aceptó. Requiere
   * asignación manual desde el panel de admin — el único caso en todo el
   * sistema donde un humano asigna a mano, como fallback de última
   * instancia, nunca como camino principal.
   */
  | "UNASSIGNED";

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
  /** Número de WhatsApp del domiciliario: para contactarlo y para que negocio/cliente lo reciba al asignarse un pedido. */
  phone: string;
  vehiclePlate?: string | null;
  isActive: boolean;
  /**
   * Número de cédula de ciudadanía. Es el identificador único del
   * domiciliario Y su credencial de activación: la usa tal cual para
   * "prender" su sesión cada día (`POST /api/couriers/:id/activate`), no
   * hay un código separado generado por el sistema. Ver
   * `docs/ARCHITECTURE.md` §7 sobre por qué esto basta para el MVP y qué
   * le falta para producción (y sobre tratarla como dato sensible).
   */
  nationalId: string;
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
  nationalId: string;
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

/**
 * Recargo declarado (ej. "nocturno", "zona rural") que el admin puede
 * registrar desde el panel. Deliberadamente NO se aplica todavía en
 * `calculateFare` — es una extensión declarada, no una regla activa; ver
 * docs/ARCHITECTURE.md §6.
 */
export interface PlatformSurcharge {
  id: string;
  name: string;
  description?: string;
  active: boolean;
}

/**
 * Configuración de tarifas y comisión de toda la plataforma, editable por
 * el admin (nunca hardcodeada). Es una fila única (singleton) tanto en
 * Postgres (`platform_config`, id fijo) como en el repositorio en memoria.
 */
export interface PlatformConfig {
  baseFare: number;
  pricePerKm: number;
  minFare: number;
  /** % de lo cobrado en cada servicio que el domiciliario le debe a la plataforma. */
  commissionPercentage: number;
  currency: string;
  surcharges: PlatformSurcharge[];
  updatedAt: Date;
}

export interface UpdatePlatformConfigInput {
  baseFare?: number;
  pricePerKm?: number;
  minFare?: number;
  commissionPercentage?: number;
  currency?: string;
  surcharges?: PlatformSurcharge[];
}

export type SettlementStatus = "PENDING" | "PAID";

/**
 * Liquidación diaria de comisión de un domiciliario: cuánto cobró ese día
 * en servicios entregados, cuánto de eso le corresponde a la plataforma
 * (`commissionPercentage` queda congelado con la tasa vigente al momento
 * del cálculo), y si ya la pagó. Mientras `status` sea `PENDING` se puede
 * recalcular (llegan más entregas ese mismo día); una vez `PAID` queda
 * congelada — ver `SettlementService`.
 */
export interface CourierSettlement {
  courierId: string;
  /** Fecha en formato YYYY-MM-DD (ver `domain/date.ts`). */
  date: string;
  serviceCount: number;
  totalEarned: number;
  commissionPercentage: number;
  commissionAmount: number;
  status: SettlementStatus;
  paidAt: Date | null;
  updatedAt: Date;
}
