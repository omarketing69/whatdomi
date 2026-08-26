import { AddressNormalizer } from "../../domain/geocoding";

/**
 * Normalizador por defecto cuando no hay una API key de LLM configurada:
 * no transforma el texto, solo le agrega la ciudad/país como contexto si
 * el solicitante no la mencionó, para ayudar al geocodificador a acertar.
 */
export class PassthroughAddressNormalizer implements AddressNormalizer {
  async normalize(rawText: string, context: { city?: string; country?: string }): Promise<string> {
    const trimmed = rawText.trim();
    const parts = [trimmed, context.city, context.country].filter(Boolean);
    return parts.join(", ");
  }
}
