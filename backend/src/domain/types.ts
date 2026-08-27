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
  /**
   * Cuenta de acceso a la plataforma (email + contraseña hasheada). Son
   * `null`/`undefined` en negocios creados sin pasar por
   * `BusinessAuthService.register` (ej. datos de prueba sembrados
   * directamente en el repositorio) — esos negocios no pueden loguearse,
   * solo existen como dueños de pedidos para pruebas internas.
   */
  email?: string | null;
  passwordHash?: string | null;
  /**
   * Punto de recogida por defecto del negocio (geocodificado una sola vez
   * al registrarse, ver `BusinessAuthService.register`). El negocio puede
   * sobreescribirlo para un pedido puntual, pero no tiene que volver a
   * escribir su dirección cada vez que pide un domicilio.
   */
  location?: GeoPoint | null;
  createdAt: Date;
}

export interface Courier {
  id: string;
  name: string;
  /** Teléfono de contacto del domiciliario: el negocio lo ve en su dashboard al asignarse un pedido (`GET /api/orders/:id/courier-contact`), por si necesita llamarlo. */
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
  /**
   * Vector de 128 números (embedding facial) extraído por `face-api.js` en
   * el navegador del domiciliario a partir de su selfie de referencia.
   * Deliberadamente NO se guarda la foto: el descriptor no se puede
   * revertir a una imagen reconocible, así que minimiza el dato biométrico
   * sensible que queda en el servidor. `null` hasta que registre su
   * rostro — ver `docs/ARCHITECTURE.md` §10.
   */
  faceDescriptor: number[] | null;
  /** Cuándo aceptó explícitamente (checkbox) que se capture y procese su rostro. `null` si nunca lo hizo. */
  faceConsentGivenAt: Date | null;
  lat: number | null;
  lng: number | null;
  lastSeenAt: Date | null;
  createdAt: Date;
}

/**
 * Cómo se maneja el cobro del **valor de la mercancía** (la comida/producto
 * en sí, aparte de la tarifa del domicilio) — costumbre que varía por
 * negocio, así que es opcional y se elige por pedido, nunca un modelo
 * único fijo. Ver `Order.merchandiseValue`/`paymentMode` y
 * `docs/ARCHITECTURE.md` §6 para el detalle de cada escenario.
 */
export type PaymentMode =
  /** El cliente le paga la mercancía directamente al negocio (o no aplica cobro de mercancía). El domiciliario no maneja ese dinero. */
  | "DIRECT_TO_BUSINESS"
  /** El cliente le paga/transfiere todo al negocio; el negocio le reembolsa al domiciliario su servicio por fuera del sistema. */
  | "BUSINESS_REIMBURSES_COURIER"
  /** El domiciliario paga la mercancía al negocio al recogerla, y cobra mercancía + servicio al cliente al entregar. */
  | "COURIER_COLLECTS_ON_DELIVERY";

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
  /**
   * Valor de la mercancía/pedido (la comida o producto en sí), opcional —
   * `null` si no aplica. Es dinero de paso entre negocio/cliente/
   * domiciliario: nunca cuenta para la comisión de la plataforma, que se
   * calcula solo sobre `fare` (ver `SettlementService.recomputeSettlement`).
   */
  merchandiseValue: number | null;
  /** Modalidad de cobro de esa mercancía, ver `PaymentMode`. `null` = no aplica (equivalente a `DIRECT_TO_BUSINESS`). */
  paymentMode: PaymentMode | null;
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
  email?: string;
  passwordHash?: string;
  location?: GeoPoint;
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
   * `CREATED` (por defecto) es el pedido directo, sin cotizar: se busca
   * domiciliario de inmediato (primitivo interno, sin UI en el MVP —
   * ver docs/ARCHITECTURE.md §2). `QUOTED` es el que usa el dashboard del
   * negocio: el pedido queda con una tarifa calculada, esperando que el
   * negocio confirme antes de buscar domiciliario (ver DispatchService).
   */
  initialStatus?: "CREATED" | "QUOTED";
  distanceMeters?: number;
  fare?: number;
  currency?: string;
  /** Ver `Order.merchandiseValue`/`paymentMode` — ambos opcionales, sin relación con la comisión de la plataforma. */
  merchandiseValue?: number;
  paymentMode?: PaymentMode;
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
