import { Pool } from "pg";
import { DispatchRepository } from "../domain/repository";
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

type OrderRow = {
  id: string;
  business_id: string;
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
    pickup: { lat: row.pickup_lat, lng: row.pickup_lng },
    pickupAddress: row.pickup_address,
    dropoff: { lat: row.dropoff_lat, lng: row.dropoff_lng },
    dropoffAddress: row.dropoff_address,
    customerName: row.customer_name,
    customerPhone: row.customer_phone,
    notes: row.notes,
    status: row.status,
    courierId: row.courier_id,
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

  async createCourier(input: CreateCourierInput): Promise<Courier> {
    const { rows } = await this.pool.query<CourierRow>(
      `INSERT INTO couriers (name, phone, vehicle_plate, is_active) VALUES ($1, $2, $3, false) RETURNING *`,
      [input.name, input.phone, input.vehiclePlate ?? null]
    );
    return mapCourier(rows[0]);
  }

  async createOrder(input: CreateOrderInput): Promise<Order> {
    const { rows } = await this.pool.query<OrderRow>(
      `INSERT INTO orders (
         business_id, pickup_address, pickup_lat, pickup_lng,
         dropoff_address, dropoff_lat, dropoff_lng,
         customer_name, customer_phone, notes, status
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'CREATED')
       RETURNING *`,
      [
        input.businessId,
        input.pickupAddress,
        input.pickup.lat,
        input.pickup.lng,
        input.dropoffAddress,
        input.dropoff.lat,
        input.dropoff.lng,
        input.customerName ?? null,
        input.customerPhone ?? null,
        input.notes ?? null,
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
}
