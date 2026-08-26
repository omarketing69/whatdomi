export type OrderStatus =
  | "CREATED"
  | "SEARCHING"
  | "ASSIGNED"
  | "IN_PROGRESS"
  | "DELIVERED"
  | "CANCELLED"
  | "NO_COURIERS_AVAILABLE";

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
  lat: number | null;
  lng: number | null;
  lastSeenAt: Date | null;
  createdAt: Date;
}

export interface Order {
  id: string;
  businessId: string;
  pickup: GeoPoint;
  pickupAddress: string;
  dropoff: GeoPoint;
  dropoffAddress: string;
  customerName?: string | null;
  customerPhone?: string | null;
  notes?: string | null;
  status: OrderStatus;
  courierId: string | null;
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
  pickup: GeoPoint;
  pickupAddress: string;
  dropoff: GeoPoint;
  dropoffAddress: string;
  customerName?: string;
  customerPhone?: string;
  notes?: string;
}
