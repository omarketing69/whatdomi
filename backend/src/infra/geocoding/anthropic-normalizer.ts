import { AddressNormalizer } from "../../domain/geocoding";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";

/**
 * Usa un LLM (Claude, vía la Messages API) para interpretar una dirección
 * informal ("frente al parque central, al lado de la panadería", en un
 * pueblo sin nomenclatura de calles clara) y convertirla en una búsqueda
 * más geocodificable, ej: "Parque Central, Salamina, Caldas, Colombia".
 *
 * Deliberadamente NO le pedimos coordenadas al LLM directamente: los LLMs
 * "alucinan" lat/lng plausibles pero incorrectos con facilidad, y no hay
 * forma de distinguir un acierto de una alucinación sin ya tener la
 * respuesta correcta. En cambio, el LLM solo reescribe texto ambiguo en
 * una consulta más clara, y quien resuelve las coordenadas de verdad es un
 * geocodificador real (ver `NominatimGeocodingProvider`).
 *
 * Se activa solo si `ANTHROPIC_API_KEY` está configurada; si la llamada
 * falla por cualquier razón (red, rate limit, respuesta inesperada), se
 * degrada al texto sin normalizar en vez de tumbar el flujo completo.
 */
export class AnthropicAddressNormalizer implements AddressNormalizer {
  constructor(
    private readonly apiKey: string,
    private readonly model: string = "claude-haiku-4-5-20251001"
  ) {}

  async normalize(rawText: string, context: { city?: string; country?: string }): Promise<string> {
    const trimmed = rawText.trim();
    const locationHint = [context.city, context.country].filter(Boolean).join(", ");

    const prompt = [
      "Convierte la siguiente descripción informal de una dirección en LatAm en una",
      "consulta corta apta para un geocodificador (tipo Google Maps o OpenStreetMap).",
      "Expande abreviaturas, resuelve referencias relativas a lugares conocidos",
      "(parques, iglesias, negocios), e incluye la ciudad/país si te los doy.",
      "Responde ÚNICAMENTE con la dirección resultante en una sola línea, sin",
      "explicaciones ni comillas.",
      "",
      `Dirección informal: "${trimmed}"`,
      locationHint ? `Contexto de ubicación: ${locationHint}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8_000);

      const res = await fetch(ANTHROPIC_API_URL, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: 200,
          messages: [{ role: "user", content: prompt }],
        }),
      }).finally(() => clearTimeout(timeout));

      if (!res.ok) {
        console.warn(`[geocoding] Anthropic respondió ${res.status}, uso el texto sin normalizar`);
        return this.fallback(trimmed, locationHint);
      }

      const data = (await res.json()) as {
        content?: { type: string; text?: string }[];
      };
      const text = data.content?.find((block) => block.type === "text")?.text?.trim();
      return text || this.fallback(trimmed, locationHint);
    } catch (err) {
      console.warn("[geocoding] falló la normalización con Anthropic, uso el texto sin normalizar", err);
      return this.fallback(trimmed, locationHint);
    }
  }

  private fallback(trimmed: string, locationHint: string): string {
    return [trimmed, locationHint].filter(Boolean).join(", ");
  }
}
