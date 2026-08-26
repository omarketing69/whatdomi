-- Esquema inicial de WhatDomi.
-- Usa PostGIS para las consultas de "domiciliarios activos más cercanos".
-- Se aplica con: npm run db:migrate (ver scripts/migrate.ts) o directamente:
--   psql "$DATABASE_URL" -f db/schema.sql

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS "pgcrypto"; -- gen_random_uuid()

CREATE TABLE IF NOT EXISTS businesses (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  phone       TEXT NOT NULL UNIQUE,
  address     TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS couriers (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name           TEXT NOT NULL,
  phone          TEXT NOT NULL UNIQUE,
  vehicle_plate  TEXT,
  is_active      BOOLEAN NOT NULL DEFAULT false,
  lat            DOUBLE PRECISION,
  lng            DOUBLE PRECISION,
  -- Columna geográfica derivada de lat/lng (ver trigger más abajo), usada
  -- para las consultas espaciales con el índice GiST.
  location       GEOGRAPHY(Point, 4326),
  last_seen_at   TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS couriers_location_gix ON couriers USING GIST (location);
CREATE INDEX IF NOT EXISTS couriers_active_idx ON couriers (is_active);

CREATE TYPE order_status AS ENUM (
  'CREATED',
  'SEARCHING',
  'ASSIGNED',
  'IN_PROGRESS',
  'DELIVERED',
  'CANCELLED',
  'NO_COURIERS_AVAILABLE'
);

CREATE TABLE IF NOT EXISTS orders (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id        UUID NOT NULL REFERENCES businesses(id),
  pickup_address     TEXT NOT NULL,
  pickup_lat         DOUBLE PRECISION NOT NULL,
  pickup_lng         DOUBLE PRECISION NOT NULL,
  pickup_location    GEOGRAPHY(Point, 4326),
  dropoff_address    TEXT NOT NULL,
  dropoff_lat        DOUBLE PRECISION NOT NULL,
  dropoff_lng        DOUBLE PRECISION NOT NULL,
  customer_name      TEXT,
  customer_phone     TEXT,
  notes              TEXT,
  status             order_status NOT NULL DEFAULT 'CREATED',
  courier_id         UUID REFERENCES couriers(id),
  assigned_at        TIMESTAMPTZ,
  delivered_at       TIMESTAMPTZ,
  cancelled_at       TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS orders_pickup_location_gix ON orders USING GIST (pickup_location);
CREATE INDEX IF NOT EXISTS orders_status_idx ON orders (status);
CREATE INDEX IF NOT EXISTS orders_courier_idx ON orders (courier_id);

-- Mantiene `location`/`pickup_location` sincronizados con lat/lng en cada
-- INSERT/UPDATE, para no tener que construir el punto geográfico a mano
-- desde la aplicación en cada escritura.
CREATE OR REPLACE FUNCTION set_courier_location() RETURNS trigger AS $$
BEGIN
  IF NEW.lat IS NOT NULL AND NEW.lng IS NOT NULL THEN
    NEW.location := ST_SetSRID(ST_MakePoint(NEW.lng, NEW.lat), 4326)::geography;
  ELSE
    NEW.location := NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS couriers_set_location ON couriers;
CREATE TRIGGER couriers_set_location
  BEFORE INSERT OR UPDATE OF lat, lng ON couriers
  FOR EACH ROW EXECUTE FUNCTION set_courier_location();

CREATE OR REPLACE FUNCTION set_order_pickup_location() RETURNS trigger AS $$
BEGIN
  NEW.pickup_location := ST_SetSRID(ST_MakePoint(NEW.pickup_lng, NEW.pickup_lat), 4326)::geography;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS orders_set_pickup_location ON orders;
CREATE TRIGGER orders_set_pickup_location
  BEFORE INSERT OR UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION set_order_pickup_location();
