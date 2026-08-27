import { describe, expect, it } from "vitest";
import { calculateFare, loadFareConfigFromEnv } from "../src/domain/fare";

describe("cálculo de tarifa", () => {
  const config = { baseFare: 3000, pricePerKm: 800, minFare: 0, currency: "COP" };

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

  it("nunca cobra menos que la tarifa mínima (piso)", () => {
    const quote = calculateFare(100, { baseFare: 1000, pricePerKm: 800, minFare: 3000, currency: "COP" });
    // base + km = 1000 + 80 = 1080, por debajo del piso de 3000
    expect(quote.fare).toBe(3000);
  });

  it("no aplica el piso si el cálculo ya lo supera", () => {
    const quote = calculateFare(10_000, { baseFare: 1000, pricePerKm: 800, minFare: 3000, currency: "COP" });
    // base + km = 1000 + 8000 = 9000, por encima del piso
    expect(quote.fare).toBe(9000);
  });

  it("lee la configuración desde variables de entorno, con valores por defecto", () => {
    const config1 = loadFareConfigFromEnv({});
    expect(config1.baseFare).toBeGreaterThan(0);
    expect(config1.pricePerKm).toBeGreaterThan(0);
    expect(config1.minFare).toBeGreaterThan(0);
    expect(config1.currency).toBe("COP");

    const config2 = loadFareConfigFromEnv({
      FARE_BASE: "5000",
      FARE_PER_KM: "1200",
      FARE_MIN: "4000",
      FARE_CURRENCY: "MXN",
    } as NodeJS.ProcessEnv);
    expect(config2).toEqual({ baseFare: 5000, pricePerKm: 1200, minFare: 4000, currency: "MXN" });
  });

  it("si no se define FARE_MIN, usa la tarifa base como piso por defecto", () => {
    const config = loadFareConfigFromEnv({ FARE_BASE: "5000", FARE_PER_KM: "1200" } as NodeJS.ProcessEnv);
    expect(config.minFare).toBe(5000);
  });
});
