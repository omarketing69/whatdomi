export interface FareConfig {
  /** Tarifa fija que se cobra siempre, independiente de la distancia. */
  baseFare: number;
  /** Costo adicional por cada kilómetro entre recogida y entrega. */
  pricePerKm: number;
  currency: string;
}

export interface FareQuote {
  distanceMeters: number;
  distanceKm: number;
  fare: number;
  currency: string;
}

export function loadFareConfigFromEnv(env: NodeJS.ProcessEnv = process.env): FareConfig {
  return {
    baseFare: Number(env.FARE_BASE ?? 3000),
    pricePerKm: Number(env.FARE_PER_KM ?? 800),
    currency: env.FARE_CURRENCY ?? "COP",
  };
}

/**
 * Modelo de tarifa deliberadamente simple para el MVP: base + costo por km,
 * redondeado a la unidad de la moneda más cercana. Ambos valores son
 * configurables por entorno (ver `.env.example`) para poder ajustarlos por
 * ciudad sin tocar código.
 */
export function calculateFare(distanceMeters: number, config: FareConfig): FareQuote {
  const distanceKm = distanceMeters / 1000;
  const fare = Math.round(config.baseFare + config.pricePerKm * distanceKm);
  return { distanceMeters, distanceKm, fare, currency: config.currency };
}
