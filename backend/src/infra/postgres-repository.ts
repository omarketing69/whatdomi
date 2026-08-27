import { Pool } from "pg";
import { DispatchRepository } from "../domain/repository";
import {
  Business,
  Courier,
  CourierSettlement,
  CourierWithDistance,
  CreateBusinessInput,
  CreateCourierInput,
  CreateOrderInput,
  GeoPoint,
  Order,
  OrderStatus,
  PaymentStatus,
  PlatformConfig,
  PlatformSurcharge,
  SettlementStatus,
  UpdatePlatformConfigInput,
} from "../domain/types";

type OrderRow = {
  id: string;
  business_id: string;
  requester_name: string | null;
  pickup_address: string;
  pickup_lat: number;
  pickup_lng: number;
  dropoff_address: string;
  dropoff_lat: number;
  dropoff_lng: number;
  customer_name: string | null;
  customer_phone: string | null;
  notes: string | null;
  status: OrderStatus;
  courier_id: string | null;
  distance_meters: number | null;
  fare: string | null;
  currency: string | null;
  payment_link: string | null;
  payment_status: PaymentStatus | null;
  assigned_at: Date | null;
  delivered_at: Date | null;
  cancelled_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

type CourierRow = {
  id: string;
  name: string;
  phone: string;
  vehicle_plate: string | null;
  is_active: boolean;
  national_id: string;
  lat: number | null;
  lng: number | null;
  last_seen_at: Date | null;
  created_at: Date;
};

type BusinessRow = {
  id: string;
  name: string;
  phone: string;
  address: string | null;
  created_at: Date;
};

type PlatformConfigRow = {
  base_fare: string;
  price_per_km: string;
  min_fare: string;
  commission_percentage: string;
  currency: string;
  surcharges: PlatformSurcharge[];
  updated_at: Date;
};

type SettlementRow = {
  courier_id: string;
  date: string | Date;
  service_count: number;
  total_earned: string;
  commission_percentage: string;
  commission_amount: string;
  status: SettlementStatus;
  paid_at: Date | null;
  updated_at: Date;
};

function mapPlatformConfig(row: PlatformConfigRow): PlatformConfig {
  return {
    baseFare: Number(row.base_fare),
    pricePerKm: Number(row.price_per_km),
    minFare: Number(row.min_fare),
    commissionPercentage: Number(row.commission_percentage),
    currency: row.currency,
    // node-postgres ya parsea JSONB a un valor JS; el driver puede
    // devolver el default de columna como string en algunas versiones, así
    // que se tolera ambos casos.
    surcharges: typeof row.surcharges === "string" ? JSON.parse(row.surcharges) : row.surcharges,
    updatedAt: row.updated_at,
  };
}

function toDateOnly(date: string | Date): string {
  // node-postgres devuelve las columnas DATE como objetos Date (medianoche
  // UTC) por defecto; normalizamos siempre a un string YYYY-MM-DD.
  return date instanceof Date ? date.toISOString().slice(0, 10) : date.slice(0, 10);
}

function mapSettlement(row: SettlementRow): CourierSettlement {
  return {
    courierId: row.courier_id,
    date: toDateOnly(row.date),
    serviceCount: row.service_count,
    totalEarned: Number(row.total_earned),
    commissionPercentage: Number(row.commission_percentage),
    commissionAmount: Number(row.commission_amount),
    status: row.status,
    paidAt: row.paid_at,
    updatedAt: row.updated_at,
  };
}

function mapBusiness(row: BusinessRow): Business {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    address: row.address,
    createdAt: row.created_at,
  };
}

function mapOrder(row: OrderRow): Order {
  return {
    id: row.id,
    businessId: row.business_id,
    requesterName: row.requester_name,
    pickup: { lat: row.pickup_lat, lng: row.pickup_lng },
    pickupAddress: row.pickup_address,
    dropoff: { lat: row.dropoff_lat, lng: row.dropoff_lng },
    dropoffAddress: row.dropoff_address,
    customerName: row.customer_name,
    customerPhone: row.customer_phone,
    notes: row.notes,
    status: row.status,
    courierId: row.courier_id,
    distanceMeters: row.distance_meters,
    fare: row.fare === null ? null : Number(row.fare),
    currency: row.currency,
    paymentLink: row.payment_link,
    paymentStatus: row.payment_status,
    assignedAt: row.assigned_at,
    deliveredAt: row.delivered_at,
    cancelledAt: row.cancelled_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapCourier(row: CourierRow): Courier {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    vehiclePlate: row.vehicle_plate,
    isActive: row.is_active,
    nationalId: row.national_id,
    lat: row.lat,
    lng: row.lng,
    lastSeenAt: row.last_seen_at,
    createdAt: row.created_at,
  };
}

/**
 * Implementación de `DispatchRepository` sobre Postgres + PostGIS.
 *
 * La asignación "el primero que acepta gana" (`tryAssignOrder`) se resuelve
 * con un único UPDATE condicionado por WHERE, sin SELECT previo: Postgres
 * serializa los UPDATEs concurrentes sobre la misma fila, así que si dos
 * domiciliarios aceptan al mismo tiempo, el segundo UPDATE en aplicarse ve
 * que `status` ya no es 'SEARCHING' y no afecta ninguna fila.
 */
export class PostgresDispatchRepository implements DispatchRepository {
  constructor(private readonly pool: Pool) {}

  async createBusiness(input: CreateBusinessInput): Promise<Business> {
    const { rows } = await this.pool.query<BusinessRow>(
      `INSERT INTO businesses (name, phone, address) VALUES ($1, $2, $3) RETURNING *`,
      [input.name, input.phone, input.address ?? null]
    );
    return mapBusiness(rows[0]);
  }

  async getBusiness(businessId: string): Promise<Business | null> {
    const { rows } = await this.pool.query<BusinessRow>(`SELECT * FROM businesses WHERE id = $1`, [
      businessId,
    ]);
    return rows[0] ? mapBusiness(rows[0]) : null;
  }

  async findOrCreateBusinessByPhone(phone: string, name: string): Promise<Business> {
    const existing = await this.pool.query<BusinessRow>(`SELECT * FROM businesses WHERE phone = $1`, [
      phone,
    ]);
    if (existing.rows[0]) return mapBusiness(existing.rows[0]);
    return this.createBusiness({ name, phone });
  }

  async createCourier(input: CreateCourierInput): Promise<Courier> {
    const { rows } = await this.pool.query<CourierRow>(
      `INSERT INTO couriers (name, phone, vehicle_plate, is_active, national_id)
       VALUES ($1, $2, $3, false, $4) RETURNING *`,
      [input.name, input.phone, input.vehiclePlate ?? null, input.nationalId]
    );
    return mapCourier(rows[0]);
  }

  async createOrder(input: CreateOrderInput): Promise<Order> {
    const { rows } = await this.pool.query<OrderRow>(
      `INSERT INTO orders (
         business_id, requester_name, pickup_address, pickup_lat, pickup_lng,
         dropoff_address, dropoff_lat, dropoff_lng,
         customer_name, customer_phone, notes, status,
         distance_meters, fare, currency
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       RETURNING *`,
      [
        input.businessId,
        input.requesterName ?? null,
        input.pickupAddress,
        input.pickup.lat,
        input.pickup.lng,
        input.dropoffAddress,
        input.dropoff.lat,
        input.dropoff.lng,
        input.customerName ?? null,
        input.customerPhone ?? null,
        input.notes ?? null,
        input.initialStatus ?? "CREATED",
        input.distanceMeters ?? null,
        input.fare ?? null,
        input.currency ?? null,
      ]
    );
    return mapOrder(rows[0]);
  }

  async getOrder(orderId: string): Promise<Order | null> {
    const { rows } = await this.pool.query<OrderRow>(`SELECT * FROM orders WHERE id = $1`, [
      orderId,
    ]);
    return rows[0] ? mapOrder(rows[0]) : null;
  }

  async listOrders(filter?: { statuses?: OrderStatus[]; limit?: number }): Promise<Order[]> {
    const limit = filter?.limit ?? 100;
    if (filter?.statuses && filter.statuses.length > 0) {
      const { rows } = await this.pool.query<OrderRow>(
        `SELECT * FROM orders WHERE status = ANY($1::order_status[]) ORDER BY created_at DESC LIMIT $2`,
        [filter.statuses, limit]
      );
      return rows.map(mapOrder);
    }
    const { rows } = await this.pool.query<OrderRow>(
      `SELECT * FROM orders ORDER BY created_at DESC LIMIT $1`,
      [limit]
    );
    return rows.map(mapOrder);
  }

  async findActiveCouriersNear(
    point: GeoPoint,
    radiusMeters: number,
    limit: number,
    excludeCourierIds: string[] = []
  ): Promise<CourierWithDistance[]> {
    const { rows } = await this.pool.query<CourierRow & { distance_meters: number }>(
      `SELECT *, ST_Distance(location, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography) AS distance_meters
       FROM couriers
       WHERE is_active = true
         AND location IS NOT NULL
         AND ST_DWithin(location, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, $3)
         AND NOT (id = ANY($4::uuid[]))
       ORDER BY distance_meters ASC
       LIMIT $5`,
      [point.lng, point.lat, radiusMeters, excludeCourierIds, limit]
    );
    return rows.map((row) => ({ ...mapCourier(row), distanceMeters: row.distance_meters }));
  }

  async tryAssignOrder(orderId: string, courierId: string): Promise<Order | null> {
    const { rows } = await this.pool.query<OrderRow>(
      `UPDATE orders
       SET status = 'ASSIGNED', courier_id = $2, assigned_at = now()
       WHERE id = $1 AND status = 'SEARCHING' AND courier_id IS NULL
       RETURNING *`,
      [orderId, courierId]
    );
    return rows[0] ? mapOrder(rows[0]) : null;
  }

  async forceAssignOrder(orderId: string, courierId: string): Promise<Order | null> {
    const { rows } = await this.pool.query<OrderRow>(
      `UPDATE orders
       SET status = 'ASSIGNED', courier_id = $2, assigned_at = now()
       WHERE id = $1 AND status = 'UNASSIGNED' AND courier_id IS NULL
       RETURNING *`,
      [orderId, courierId]
    );
    return rows[0] ? mapOrder(rows[0]) : null;
  }

  async unassignOrder(orderId: string): Promise<Order | null> {
    const { rows } = await this.pool.query<OrderRow>(
      `UPDATE orders
       SET status = 'SEARCHING', courier_id = NULL, assigned_at = NULL
       WHERE id = $1
       RETURNING *`,
      [orderId]
    );
    return rows[0] ? mapOrder(rows[0]) : null;
  }

  async updateOrderStatus(
    orderId: string,
    status: OrderStatus,
    extra?: { deliveredAt?: Date; cancelledAt?: Date }
  ): Promise<Order | null> {
    const { rows } = await this.pool.query<OrderRow>(
      `UPDATE orders
       SET status = $2,
           delivered_at = COALESCE($3, delivered_at),
           cancelled_at = COALESCE($4, cancelled_at)
       WHERE id = $1
       RETURNING *`,
      [orderId, status, extra?.deliveredAt ?? null, extra?.cancelledAt ?? null]
    );
    return rows[0] ? mapOrder(rows[0]) : null;
  }

  async upsertCourierLocation(courierId: string, point: GeoPoint): Promise<Courier | null> {
    const { rows } = await this.pool.query<CourierRow>(
      `UPDATE couriers
       SET lat = $2, lng = $3, last_seen_at = now()
       WHERE id = $1
       RETURNING *`,
      [courierId, point.lat, point.lng]
    );
    return rows[0] ? mapCourier(rows[0]) : null;
  }

  async setCourierActive(courierId: string, isActive: boolean): Promise<Courier | null> {
    const { rows } = await this.pool.query<CourierRow>(
      `UPDATE couriers SET is_active = $2 WHERE id = $1 RETURNING *`,
      [courierId, isActive]
    );
    return rows[0] ? mapCourier(rows[0]) : null;
  }

  async getCourier(courierId: string): Promise<Courier | null> {
    const { rows } = await this.pool.query<CourierRow>(`SELECT * FROM couriers WHERE id = $1`, [
      courierId,
    ]);
    return rows[0] ? mapCourier(rows[0]) : null;
  }

  async getPlatformConfig(): Promise<PlatformConfig> {
    const { rows } = await this.pool.query<PlatformConfigRow>(
      `SELECT * FROM platform_config WHERE id = 1`
    );
    if (!rows[0]) {
      throw new Error(
        "No existe la fila de platform_config (id=1); corre `npm run db:migrate` para aplicar el esquema"
      );
    }
    return mapPlatformConfig(rows[0]);
  }

  async updatePlatformConfig(patch: UpdatePlatformConfigInput): Promise<PlatformConfig> {
    const current = await this.getPlatformConfig();
    const merged = { ...current, ...patch };
    const { rows } = await this.pool.query<PlatformConfigRow>(
      `UPDATE platform_config
       SET base_fare = $1, price_per_km = $2, min_fare = $3, commission_percentage = $4,
           currency = $5, surcharges = $6, updated_at = now()
       WHERE id = 1
       RETURNING *`,
      [
        merged.baseFare,
        merged.pricePerKm,
        merged.minFare,
        merged.commissionPercentage,
        merged.currency,
        JSON.stringify(merged.surcharges),
      ]
    );
    return mapPlatformConfig(rows[0]);
  }

  async listDeliveredOrders(filter?: { courierId?: string; date?: string }): Promise<Order[]> {
    const conditions = [`status = 'DELIVERED'`];
    const params: unknown[] = [];
    if (filter?.courierId) {
      params.push(filter.courierId);
      conditions.push(`courier_id = $${params.length}`);
    }
    if (filter?.date) {
      params.push(filter.date);
      conditions.push(`delivered_at::date = $${params.length}::date`);
    }
    const { rows } = await this.pool.query<OrderRow>(
      `SELECT * FROM orders WHERE ${conditions.join(" AND ")} ORDER BY delivered_at ASC`,
      params
    );
    return rows.map(mapOrder);
  }

  async getServiceStats(
    fromDate: string,
    toDate: string
  ): Promise<{ serviceCount: number; totalRevenue: number }> {
    const { rows } = await this.pool.query<{ service_count: string; total_revenue: string | null }>(
      `SELECT COUNT(*) AS service_count, COALESCE(SUM(fare), 0) AS total_revenue
       FROM orders
       WHERE status = 'DELIVERED' AND delivered_at::date BETWEEN $1::date AND $2::date`,
      [fromDate, toDate]
    );
    return {
      serviceCount: Number(rows[0]?.service_count ?? 0),
      totalRevenue: Number(rows[0]?.total_revenue ?? 0),
    };
  }

  async getSettlement(courierId: string, date: string): Promise<CourierSettlement | null> {
    const { rows } = await this.pool.query<SettlementRow>(
      `SELECT * FROM courier_settlements WHERE courier_id = $1 AND date = $2::date`,
      [courierId, date]
    );
    return rows[0] ? mapSettlement(rows[0]) : null;
  }

  async upsertSettlement(
    courierId: string,
    date: string,
    data: {
      serviceCount: number;
      totalEarned: number;
      commissionPercentage: number;
      commissionAmount: number;
    }
  ): Promise<CourierSettlement> {
    // El UPDATE del ON CONFLICT solo se aplica si la fila sigue PENDING;
    // si ya estaba PAID, la condición del WHERE lo salta y no se
    // actualiza nada (queda congelada), así que no devuelve fila.
    const { rows } = await this.pool.query<SettlementRow>(
      `INSERT INTO courier_settlements (courier_id, date, service_count, total_earned, commission_percentage, commission_amount, status)
       VALUES ($1, $2::date, $3, $4, $5, $6, 'PENDING')
       ON CONFLICT (courier_id, date) DO UPDATE SET
         service_count = EXCLUDED.service_count,
         total_earned = EXCLUDED.total_earned,
         commission_percentage = EXCLUDED.commission_percentage,
         commission_amount = EXCLUDED.commission_amount,
         updated_at = now()
       WHERE courier_settlements.status = 'PENDING'
       RETURNING *`,
      [courierId, date, data.serviceCount, data.totalEarned, data.commissionPercentage, data.commissionAmount]
    );
    if (rows[0]) return mapSettlement(rows[0]);

    // La fila ya existía y estaba PAID: se devuelve tal cual, congelada.
    const existing = await this.getSettlement(courierId, date);
    if (!existing) {
      throw new Error(`No se pudo crear ni recuperar la liquidación de ${courierId} en ${date}`);
    }
    return existing;
  }

  async markSettlementPaid(courierId: string, date: string): Promise<CourierSettlement | null> {
    const { rows } = await this.pool.query<SettlementRow>(
      `UPDATE courier_settlements
       SET status = 'PAID', paid_at = now(), updated_at = now()
       WHERE courier_id = $1 AND date = $2::date AND status = 'PENDING'
       RETURNING *`,
      [courierId, date]
    );
    if (rows[0]) return mapSettlement(rows[0]);
    return this.getSettlement(courierId, date);
  }

  async listPendingSettlementsBefore(courierId: string, date: string): Promise<CourierSettlement[]> {
    const { rows } = await this.pool.query<SettlementRow>(
      `SELECT * FROM courier_settlements
       WHERE courier_id = $1 AND status = 'PENDING' AND date < $2::date
       ORDER BY date ASC`,
      [courierId, date]
    );
    return rows.map(mapSettlement);
  }

  async listSettlements(filter?: { date?: string }): Promise<CourierSettlement[]> {
    if (filter?.date) {
      const { rows } = await this.pool.query<SettlementRow>(
        `SELECT * FROM courier_settlements WHERE date = $1::date ORDER BY commission_amount DESC`,
        [filter.date]
      );
      return rows.map(mapSettlement);
    }
    const { rows } = await this.pool.query<SettlementRow>(
      `SELECT * FROM courier_settlements ORDER BY date DESC, commission_amount DESC LIMIT 200`
    );
    return rows.map(mapSettlement);
  }
}
