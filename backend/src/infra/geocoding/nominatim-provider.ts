import { GeocodeResult, GeocodingProvider } from "../../domain/geocoding";

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";

/**
 * Geocodificador real usando Nominatim (OpenStreetMap), gratis y sin API
 * key. Nominatim pide explícitamente un User-Agent identificable y como
 * mucho 1 request/segundo por IP (ver su política de uso); para un
 * volumen mayor, este mismo `GeocodingProvider` se puede reemplazar por uno
 * de Google Maps o Mapbox sin tocar el resto del sistema.
 */
export class NominatimGeocodingProvider implements GeocodingProvider {
  constructor(private readonly userAgent: string = "WhatDomi/0.1 (contacto@whatdomi.example)") {}

  async geocode(query: string): Promise<GeocodeResult | null> {
    const url = new URL(NOMINATIM_URL);
    url.searchParams.set("q", query);
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("limit", "1");

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8_000);

    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { "User-Agent": this.userAgent, Accept: "application/json" },
      });
      if (!res.ok) return null;

      const results = (await res.json()) as { lat: string; lon: string; display_name: string }[];
      const first = results[0];
      if (!first) return null;

      return {
        lat: Number(first.lat),
        lng: Number(first.lon),
        formattedAddress: first.display_name,
      };
    } catch (err) {
      console.warn("[geocoding] falló la consulta a Nominatim", err);
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }
}
