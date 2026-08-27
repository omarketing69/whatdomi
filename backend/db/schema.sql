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
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name             TEXT NOT NULL,
  phone            TEXT NOT NULL UNIQUE,
  vehicle_plate    TEXT,
  is_active        BOOLEAN NOT NULL DEFAULT false,
  -- Código que el domiciliario usa para activarse desde la PWA (ver
  -- CourierActivationService). No es un mecanismo de seguridad fuerte,
  -- basta para el MVP; ver docs/ARCHITECTURE.md.
  activation_code  TEXT NOT NULL,
  lat              DOUBLE PRECISION,
  lng              DOUBLE PRECISION,
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
  -- Tarifa ya calculada, esperando que el solicitante la confirme por WhatsApp.
  'QUOTED',
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
  -- Nombre de quien solicita el servicio desde el negocio (no el cliente final).
  requester_name     TEXT,
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
  distance_meters    DOUBLE PRECISION,
  fare               NUMERIC(12, 2),
  currency           TEXT,
  -- Sin pagos integrados en el MVP (se maneja manual/offline); estos campos
  -- solo dejan el espacio listo para conectar una pasarela más adelante.
  payment_link       TEXT,
  payment_status     TEXT,
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

-- Configuración de tarifas/comisión de toda la plataforma: fila única
-- (singleton, id fijo en 1), editable por el admin desde /api/admin/config
-- — nunca hardcodeada en el código de la aplicación. Los valores por
-- defecto de abajo son el punto de partida; ajústalos desde el panel.
CREATE TABLE IF NOT EXISTS platform_config (
  id                     SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  base_fare              NUMERIC(12, 2) NOT NULL DEFAULT 3000,
  price_per_km           NUMERIC(12, 2) NOT NULL DEFAULT 800,
  min_fare               NUMERIC(12, 2) NOT NULL DEFAULT 3000,
  commission_percentage  NUMERIC(5, 2) NOT NULL DEFAULT 10,
  currency               TEXT NOT NULL DEFAULT 'COP',
  -- Recargos declarados (nocturno, zona, etc.) que el admin puede registrar;
  -- todavía no se aplican en el cálculo de tarifa, ver docs/ARCHITECTURE.md.
  surcharges             JSONB NOT NULL DEFAULT '[]',
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO platform_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- Liquidación diaria de comisión por domiciliario: cuánto cobró ese día en
-- servicios entregados y cuánto de eso le corresponde a la plataforma.
-- Pagar la comisión pendiente de un día anterior es requisito para poder
-- activarse al día siguiente (ver CourierActivationService/SettlementService).
CREATE TABLE IF NOT EXISTS courier_settlements (
  courier_id             UUID NOT NULL REFERENCES couriers(id),
  date                   DATE NOT NULL,
  service_count          INTEGER NOT NULL DEFAULT 0,
  total_earned           NUMERIC(12, 2) NOT NULL DEFAULT 0,
  -- Tasa vigente al momento del cálculo, congelada (no cambia si el admin
  -- ajusta la comisión general después).
  commission_percentage  NUMERIC(5, 2) NOT NULL,
  commission_amount      NUMERIC(12, 2) NOT NULL DEFAULT 0,
  status                 TEXT NOT NULL DEFAULT 'PENDING',
  paid_at                TIMESTAMPTZ,
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (courier_id, date)
);

CREATE INDEX IF NOT EXISTS courier_settlements_date_idx ON courier_settlements (date);
CREATE INDEX IF NOT EXISTS courier_settlements_status_idx ON courier_settlements (status);
