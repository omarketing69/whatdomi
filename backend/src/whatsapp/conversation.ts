import { calculateFare } from "../domain/fare";
import { GeocodeResult, GeocodingService } from "../domain/geocoding";
import { haversineDistanceMeters } from "../domain/geo";
import { DispatchService } from "../domain/dispatch";
import { DispatchRepository } from "../domain/repository";

type ConversationStep =
  | "AWAITING_NAME"
  | "AWAITING_ORIGIN"
  | "AWAITING_DESTINATION"
  | "AWAITING_QUOTE_CONFIRMATION";

interface ConversationState {
  step: ConversationStep;
  requesterName?: string;
  originText?: string;
  orderId?: string;
}

/**
 * Guarda en qué paso del flujo va cada número de teléfono. En memoria
 * alcanza para el MVP porque el flujo es corto (dura lo que el solicitante
 * tarde en escribir 3-4 mensajes seguidos); en producción con más de una
 * instancia del backend corriendo, esto debería vivir en Redis o la misma
 * Postgres para no perder la conversación si el proceso se reinicia o el
 * balanceador manda el siguiente mensaje a otra instancia.
 */
export interface ConversationStore {
  get(phone: string): Promise<ConversationState | null>;
  set(phone: string, state: ConversationState): Promise<void>;
  clear(phone: string): Promise<void>;
}

export class InMemoryConversationStore implements ConversationStore {
  private sessions = new Map<string, ConversationState>();

  async get(phone: string): Promise<ConversationState | null> {
    return this.sessions.get(phone) ?? null;
  }

  async set(phone: string, state: ConversationState): Promise<void> {
    this.sessions.set(phone, state);
  }

  async clear(phone: string): Promise<void> {
    this.sessions.delete(phone);
  }
}

const GREETING = [
  "¡Hola! 👋 Soy el asistente de domicilios.",
  "¿Cómo te llamas? (para saber quién está solicitando el servicio)",
].join("\n");

const CANCEL_WORDS = new Set(["cancelar", "cancel", "salir"]);
const AFFIRMATIVE_WORDS = ["si", "sí", "ok", "okay", "dale", "claro", "yes", "confirmo"];
const NEGATIVE_WORDS = ["no", "cancelar", "cancela"];

function startsWithAny(text: string, words: string[]): boolean {
  return words.some((word) => text.startsWith(word));
}

/**
 * Máquina de estados del bot de WhatsApp: saludo → nombre → dirección de
 * recogida → dirección de entrega (ambas en texto libre) → cotización
 * (geocodificación + tarifa) → confirmación del solicitante → se crea el
 * pedido en SEARCHING (o se cancela si dice que no).
 *
 * Devuelve la lista de mensajes que el webhook debe enviar de vuelta; no
 * sabe nada de Meta/Twilio, así que se puede probar sin mockear HTTP.
 */
export class WhatsAppConversationService {
  constructor(
    private readonly repo: DispatchRepository,
    private readonly dispatch: DispatchService,
    private readonly geocoding: GeocodingService,
    private readonly store: ConversationStore = new InMemoryConversationStore(),
    private readonly locationContext: { city?: string; country?: string } = {}
  ) {}

  async handleIncomingText(phone: string, rawText: string): Promise<string[]> {
    const text = rawText.trim();
    let state = await this.store.get(phone);

    if (!state) {
      await this.store.set(phone, { step: "AWAITING_NAME" });
      return [GREETING];
    }

    if (state.step !== "AWAITING_QUOTE_CONFIRMATION" && CANCEL_WORDS.has(text.toLowerCase())) {
      await this.store.clear(phone);
      return ["Solicitud cancelada. Escríbenos de nuevo cuando quieras pedir un domicilio."];
    }

    if (!text) {
      return ["No recibí ningún texto, ¿puedes escribirlo de nuevo?"];
    }

    switch (state.step) {
      case "AWAITING_NAME":
        return this.handleName(phone, text);
      case "AWAITING_ORIGIN":
        return this.handleOrigin(phone, state, text);
      case "AWAITING_DESTINATION":
        return this.handleDestination(phone, state, text);
      case "AWAITING_QUOTE_CONFIRMATION":
        return this.handleQuoteConfirmation(phone, state, text);
    }
  }

  private async handleName(phone: string, requesterName: string): Promise<string[]> {
    await this.store.set(phone, { step: "AWAITING_ORIGIN", requesterName });
    return [
      `Gracias, ${requesterName}. Cuéntame, ¿de dónde recogemos el pedido? Descríbelo como lo harías con un vecino (ej: "frente al parque central, al lado de la panadería").`,
    ];
  }

  private async handleOrigin(
    phone: string,
    state: ConversationState,
    originText: string
  ): Promise<string[]> {
    await this.store.set(phone, { ...state, step: "AWAITING_DESTINATION", originText });
    return ["Perfecto. ¿Y hacia dónde lo llevamos? (dirección de entrega)"];
  }

  private async handleDestination(
    phone: string,
    state: ConversationState,
    destinationText: string
  ): Promise<string[]> {
    const originText = state.originText ?? "";

    let originPoint: GeocodeResult;
    let destinationPoint: GeocodeResult;
    try {
      [originPoint, destinationPoint] = await Promise.all([
        this.geocoding.resolve(originText, this.locationContext),
        this.geocoding.resolve(destinationText, this.locationContext),
      ]);
    } catch {
      // No se pudo ubicar alguna de las dos direcciones: mejor reiniciar
      // desde la recogida que dejar al solicitante adivinando cuál falló.
      await this.store.set(phone, { step: "AWAITING_ORIGIN", requesterName: state.requesterName });
      return [
        "No logré ubicar esas direcciones en el mapa 😕. Intentemos de nuevo: ¿de dónde recogemos el pedido? Intenta mencionar un lugar conocido cerca (un parque, una iglesia, un negocio reconocido).",
      ];
    }

    const distanceMeters = haversineDistanceMeters(originPoint, destinationPoint);
    // Se lee la config vigente en cada cotización (no una copia fija al
    // arrancar el servidor), para que un cambio del admin en el panel
    // aplique de inmediato a la siguiente conversación.
    const platformConfig = await this.repo.getPlatformConfig();
    const quote = calculateFare(distanceMeters, platformConfig);

    const business = await this.repo.findOrCreateBusinessByPhone(phone, state.requesterName ?? "Solicitante");
    const order = await this.dispatch.createQuote({
      businessId: business.id,
      requesterName: state.requesterName,
      pickup: { lat: originPoint.lat, lng: originPoint.lng },
      pickupAddress: originPoint.formattedAddress,
      dropoff: { lat: destinationPoint.lat, lng: destinationPoint.lng },
      dropoffAddress: destinationPoint.formattedAddress,
      distanceMeters: quote.distanceMeters,
      fare: quote.fare,
      currency: quote.currency,
    });

    await this.store.set(phone, {
      step: "AWAITING_QUOTE_CONFIRMATION",
      requesterName: state.requesterName,
      orderId: order.id,
    });

    return [
      [
        `📍 Recogida: ${originPoint.formattedAddress}`,
        `📍 Entrega: ${destinationPoint.formattedAddress}`,
        `📏 Distancia aprox: ${quote.distanceKm.toFixed(1)} km`,
        `💰 Tarifa: ${quote.fare} ${quote.currency}`,
        "",
        "¿Confirmas el servicio a esta tarifa? Responde *SI* o *NO*.",
      ].join("\n"),
    ];
  }

  private async handleQuoteConfirmation(
    phone: string,
    state: ConversationState,
    text: string
  ): Promise<string[]> {
    const normalized = text.toLowerCase();
    const orderId = state.orderId;
    if (!orderId) {
      await this.store.clear(phone);
      return ["Se me perdió el hilo de tu solicitud, empecemos de nuevo. " + GREETING];
    }

    if (startsWithAny(normalized, AFFIRMATIVE_WORDS)) {
      await this.dispatch.confirmQuote(orderId);
      await this.store.clear(phone);
      return [
        "¡Listo! ✅ Confirmamos tu domicilio y ya estamos buscando un domiciliario cercano. Te avisamos apenas alguien lo acepte.",
      ];
    }

    if (startsWithAny(normalized, NEGATIVE_WORDS)) {
      await this.dispatch.cancelOrder(orderId);
      await this.store.clear(phone);
      return ["Entendido, cancelamos la solicitud. Escríbenos cuando quieras pedir otro domicilio."];
    }

    return ["No entendí tu respuesta 🤔. Responde *SI* para confirmar el domicilio a la tarifa indicada, o *NO* para cancelar."];
  }
}
