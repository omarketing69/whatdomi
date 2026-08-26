import { describe, expect, it } from "vitest";
import { DispatchService } from "../src/domain/dispatch";
import { GeocodeResult, GeocodingProvider, GeocodingService, AddressNormalizer } from "../src/domain/geocoding";
import { InMemoryDispatchRepository } from "../src/testing/in-memory-repository";
import { InMemoryConversationStore, WhatsAppConversationService } from "../src/whatsapp/conversation";

const FARE_CONFIG = { baseFare: 3000, pricePerKm: 800, currency: "COP" };
const PHONE = "+573001112233";

class PassthroughNormalizer implements AddressNormalizer {
  async normalize(rawText: string): Promise<string> {
    return rawText;
  }
}

class MapProvider implements GeocodingProvider {
  constructor(private readonly points: Record<string, GeocodeResult>) {}
  async geocode(query: string): Promise<GeocodeResult | null> {
    return this.points[query] ?? null;
  }
}

function makeConversation(points: Record<string, GeocodeResult>, repo = new InMemoryDispatchRepository()) {
  const dispatch = new DispatchService(repo);
  const geocoding = new GeocodingService(new PassthroughNormalizer(), new MapProvider(points));
  const conversation = new WhatsAppConversationService(
    repo,
    dispatch,
    geocoding,
    FARE_CONFIG,
    new InMemoryConversationStore()
  );
  return { repo, dispatch, conversation };
}

const ORIGIN_POINT: GeocodeResult = { lat: 4.6533, lng: -74.0836, formattedAddress: "Parque Central, Salamina" };
const DESTINATION_POINT: GeocodeResult = { lat: 4.66, lng: -74.09, formattedAddress: "Iglesia Mayor, Salamina" };

describe("flujo conversacional de WhatsApp", () => {
  it("saluda y pide el nombre en el primer mensaje", async () => {
    const { conversation } = makeConversation({});
    const reply = await conversation.handleIncomingText(PHONE, "hola");
    expect(reply[0]).toMatch(/hola/i);
    expect(reply[0]).toMatch(/nombre|llamas/i);
  });

  it("recorre nombre -> origen -> destino -> cotización -> confirmación -> pedido en SEARCHING", async () => {
    const { repo, conversation } = makeConversation({
      "frente al parque central": ORIGIN_POINT,
      "al lado de la iglesia mayor": DESTINATION_POINT,
    });
    repo.seedCourier({ isActive: true, lat: 4.6533, lng: -74.0836 });

    await conversation.handleIncomingText(PHONE, "hola");
    await conversation.handleIncomingText(PHONE, "Carlos de la tienda");
    await conversation.handleIncomingText(PHONE, "frente al parque central");
    const quoteReplies = await conversation.handleIncomingText(PHONE, "al lado de la iglesia mayor");

    expect(quoteReplies[0]).toContain("Parque Central, Salamina");
    expect(quoteReplies[0]).toContain("Iglesia Mayor, Salamina");
    expect(quoteReplies[0]).toMatch(/COP/);

    const orders = await repo.listOrders();
    expect(orders).toHaveLength(1);
    expect(orders[0].status).toBe("QUOTED");
    expect(orders[0].requesterName).toBe("Carlos de la tienda");

    const confirmReplies = await conversation.handleIncomingText(PHONE, "si");
    expect(confirmReplies[0]).toMatch(/confirmamos/i);

    const finalOrder = await repo.getOrder(orders[0].id);
    expect(finalOrder?.status).toBe("SEARCHING");
  });

  it("cancela el pedido si el solicitante responde NO a la cotización", async () => {
    const { repo, conversation } = makeConversation({
      "frente al parque central": ORIGIN_POINT,
      "al lado de la iglesia mayor": DESTINATION_POINT,
    });

    await conversation.handleIncomingText(PHONE, "hola");
    await conversation.handleIncomingText(PHONE, "Carlos");
    await conversation.handleIncomingText(PHONE, "frente al parque central");
    await conversation.handleIncomingText(PHONE, "al lado de la iglesia mayor");
    const rejectReplies = await conversation.handleIncomingText(PHONE, "no");

    expect(rejectReplies[0]).toMatch(/cancelamos/i);
    const orders = await repo.listOrders();
    expect(orders[0].status).toBe("CANCELLED");
  });

  it("vuelve a pedir la dirección si la geocodificación falla, sin perder el nombre", async () => {
    const { conversation } = makeConversation({}); // ningún punto resuelve

    await conversation.handleIncomingText(PHONE, "hola");
    await conversation.handleIncomingText(PHONE, "Carlos");
    await conversation.handleIncomingText(PHONE, "una dirección rarísima");
    const failReplies = await conversation.handleIncomingText(PHONE, "otra dirección rarísima");

    expect(failReplies[0]).toMatch(/no logré ubicar/i);

    // Debe poder reintentar sin tener que volver a dar el nombre.
    const retryReply = await conversation.handleIncomingText(PHONE, "frente al parque central");
    expect(retryReply[0]).toMatch(/entrega/i);
  });

  it("responde de nuevo si la confirmación no es entendible, sin tocar el pedido", async () => {
    const { repo, conversation } = makeConversation({
      "frente al parque central": ORIGIN_POINT,
      "al lado de la iglesia mayor": DESTINATION_POINT,
    });

    await conversation.handleIncomingText(PHONE, "hola");
    await conversation.handleIncomingText(PHONE, "Carlos");
    await conversation.handleIncomingText(PHONE, "frente al parque central");
    await conversation.handleIncomingText(PHONE, "al lado de la iglesia mayor");
    const confusedReply = await conversation.handleIncomingText(PHONE, "tal vez");

    expect(confusedReply[0]).toMatch(/no entendí/i);
    const orders = await repo.listOrders();
    expect(orders[0].status).toBe("QUOTED");
  });

  it("permite cancelar la conversación en cualquier momento antes de la cotización", async () => {
    const { conversation } = makeConversation({});
    await conversation.handleIncomingText(PHONE, "hola");
    await conversation.handleIncomingText(PHONE, "Carlos");
    const cancelReply = await conversation.handleIncomingText(PHONE, "cancelar");
    expect(cancelReply[0]).toMatch(/cancelada/i);

    // Debe reiniciar limpio: el siguiente mensaje se trata como saludo nuevo.
    const restartReply = await conversation.handleIncomingText(PHONE, "hola de nuevo");
    expect(restartReply[0]).toMatch(/nombre|llamas/i);
  });
});
