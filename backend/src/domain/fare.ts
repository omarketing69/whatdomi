export interface FareConfig {
  /** Tarifa fija que se cobra siempre, independiente de la distancia. */
  baseFare: number;
  /** Costo adicional por cada kilómetro entre recogida y entrega. */
  pricePerKm: number;
  /** Piso: nunca se cobra menos que esto, sin importar qué tan corto sea el trayecto. */
  minFare: number;
  currency: string;
}

export interface FareQuote {
  distanceMeters: number;
  distanceKm: number;
  fare: number;
  currency: string;
}

/**
 * Valores por defecto para el repositorio en memoria (tests/desarrollo sin
 * Postgres). En Postgres la fuente de verdad es la tabla `platform_config`
 * (ver `db/schema.sql`), editable en vivo desde `/api/admin/config` o el
 * panel de administración — estos valores de entorno NO se vuelven a leer
 * una vez la fila existe, para no pisar los ajustes que haga el admin.
 */
export function loadFareConfigFromEnv(env: NodeJS.ProcessEnv = process.env): FareConfig {
  const baseFare = Number(env.FARE_BASE ?? 3000);
  return {
    baseFare,
    pricePerKm: Number(env.FARE_PER_KM ?? 800),
    minFare: Number(env.FARE_MIN ?? baseFare),
    currency: env.FARE_CURRENCY ?? "COP",
  };
}

/**
 * Modelo de tarifa deliberadamente simple para el MVP: base + costo por km,
 * con un piso mínimo, redondeado a la unidad de la moneda más cercana. Los
 * recargos (nocturno, por zona, etc.) quedan como una extensión declarada
 * en `PlatformConfig.surcharges` pero sin aplicarse todavía aquí — ver
 * docs/ARCHITECTURE.md.
 */
export function calculateFare(distanceMeters: number, config: FareConfig): FareQuote {
  const distanceKm = distanceMeters / 1000;
  const raw = config.baseFare + config.pricePerKm * distanceKm;
  const fare = Math.max(config.minFare, Math.round(raw));
  return { distanceMeters, distanceKm, fare, currency: config.currency };
}
