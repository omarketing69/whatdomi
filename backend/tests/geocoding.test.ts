import { describe, expect, it, vi } from "vitest";
import {
  AddressNormalizer,
  GeocodeResult,
  GeocodingFailedError,
  GeocodingProvider,
  GeocodingService,
} from "../src/domain/geocoding";

class FakeNormalizer implements AddressNormalizer {
  constructor(private readonly normalized: string) {}
  normalize = vi.fn(async () => this.normalized);
}

class FakeProvider implements GeocodingProvider {
  constructor(private readonly responses: Record<string, GeocodeResult | null>) {}
  geocode = vi.fn(async (query: string) => this.responses[query] ?? null);
}

describe("GeocodingService", () => {
  it("normaliza el texto y lo resuelve con el proveedor", async () => {
    const normalizer = new FakeNormalizer("Parque Central, Salamina, Colombia");
    const provider = new FakeProvider({
      "Parque Central, Salamina, Colombia": { lat: 5.41, lng: -75.49, formattedAddress: "Parque Central, Salamina" },
    });
    const service = new GeocodingService(normalizer, provider);

    const result = await service.resolve("frente al parque central", { city: "Salamina" });

    expect(normalizer.normalize).toHaveBeenCalledWith("frente al parque central", { city: "Salamina" });
    expect(result.formattedAddress).toBe("Parque Central, Salamina");
  });

  it("si el texto normalizado no resuelve nada, reintenta con el texto original", async () => {
    const normalizer = new FakeNormalizer("una normalización que no sirvió");
    const provider = new FakeProvider({
      "la dirección original": { lat: 1, lng: 2, formattedAddress: "algo" },
    });
    const service = new GeocodingService(normalizer, provider);

    const result = await service.resolve("la dirección original");

    expect(provider.geocode).toHaveBeenCalledWith("una normalización que no sirvió");
    expect(provider.geocode).toHaveBeenCalledWith("la dirección original");
    expect(result.formattedAddress).toBe("algo");
  });

  it("lanza GeocodingFailedError si ni el texto normalizado ni el original resuelven", async () => {
    const normalizer = new FakeNormalizer("normalizado");
    const provider = new FakeProvider({});
    const service = new GeocodingService(normalizer, provider);

    await expect(service.resolve("dirección imposible")).rejects.toBeInstanceOf(GeocodingFailedError);
  });

  it("no reintenta dos veces si normalizar no cambió el texto", async () => {
    const normalizer = new FakeNormalizer("misma dirección");
    const provider = new FakeProvider({});
    const service = new GeocodingService(normalizer, provider);

    await expect(service.resolve("misma dirección")).rejects.toBeInstanceOf(GeocodingFailedError);
    expect(provider.geocode).toHaveBeenCalledTimes(1);
  });
});
