import { describe, expect, it } from "vitest";
import { calculateFare, loadFareConfigFromEnv } from "../src/domain/fare";

describe("cálculo de tarifa", () => {
  const config = { baseFare: 3000, pricePerKm: 800, currency: "COP" };

  it("cobra solo la tarifa base para distancia cero", () => {
    const quote = calculateFare(0, config);
    expect(quote.fare).toBe(3000);
    expect(quote.distanceKm).toBe(0);
  });

  it("suma base + costo por km, redondeado", () => {
    const quote = calculateFare(2_500, config); // 2.5 km
    expect(quote.distanceKm).toBe(2.5);
    expect(quote.fare).toBe(3000 + 800 * 2.5); // 5000
  });

  it("incluye la moneda configurada", () => {
    const quote = calculateFare(1_000, { ...config, currency: "MXN" });
    expect(quote.currency).toBe("MXN");
  });

  it("lee la configuración desde variables de entorno, con valores por defecto", () => {
    const config1 = loadFareConfigFromEnv({});
    expect(config1.baseFare).toBeGreaterThan(0);
    expect(config1.pricePerKm).toBeGreaterThan(0);
    expect(config1.currency).toBe("COP");

    const config2 = loadFareConfigFromEnv({
      FARE_BASE: "5000",
      FARE_PER_KM: "1200",
      FARE_CURRENCY: "MXN",
    } as NodeJS.ProcessEnv);
    expect(config2).toEqual({ baseFare: 5000, pricePerKm: 1200, currency: "MXN" });
  });
});
