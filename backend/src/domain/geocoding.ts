import { GeoPoint } from "./types";

export interface GeocodeResult extends GeoPoint {
  formattedAddress: string;
}

/**
 * Llama a un servicio de geocodificación real (Nominatim/OSM, Google Maps,
 * Mapbox...) y devuelve el primer resultado, o `null` si no encontró nada.
 */
export interface GeocodingProvider {
  geocode(query: string): Promise<GeocodeResult | null>;
}

/**
 * Limpia/normaliza una dirección en texto libre e informal ("frente al
 * parque central, al lado de la panadería") antes de mandarla a un
 * geocodificador real. Ver `docs/ARCHITECTURE.md` §5 para la justificación
 * de por qué esto se separa en dos pasos (normalizar con un LLM, resolver
 * coordenadas con una API de geocodificación real) en vez de pedirle
 * coordenadas directamente a un LLM.
 */
export interface AddressNormalizer {
  normalize(rawText: string, context: { city?: string; country?: string }): Promise<string>;
}

export class GeocodingFailedError extends Error {
  constructor(rawText: string) {
    super(`No se pudo geocodificar la dirección: "${rawText}"`);
    this.name = "GeocodingFailedError";
  }
}

/**
 * Compone normalizador + proveedor. Primero intenta con el texto
 * normalizado (más probable que un geocodificador real lo entienda); si
 * eso falla, reintenta con el texto original tal cual lo escribió el
 * solicitante, por si la normalización lo empeoró.
 */
export class GeocodingService {
  constructor(
    private readonly normalizer: AddressNormalizer,
    private readonly provider: GeocodingProvider
  ) {}

  async resolve(
    rawText: string,
    context: { city?: string; country?: string } = {}
  ): Promise<GeocodeResult> {
    const normalized = await this.normalizer.normalize(rawText, context);

    const primary = await this.provider.geocode(normalized);
    if (primary) return primary;

    if (normalized.trim() !== rawText.trim()) {
      const fallback = await this.provider.geocode(rawText);
      if (fallback) return fallback;
    }

    throw new GeocodingFailedError(rawText);
  }
}
