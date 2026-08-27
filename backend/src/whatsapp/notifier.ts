import { DispatchNotifier } from "../domain/dispatch";
import { DispatchRepository } from "../domain/repository";
import { Order } from "../domain/types";
import { WhatsAppSender } from "./sender";

/**
 * Traduce los eventos de asignación a los dos mensajes de WhatsApp que
 * definió el dueño del producto:
 *  - al domiciliario ganador: los datos del servicio (origen, destino, tarifa).
 *  - al negocio/solicitante: nombre, placa y teléfono del domiciliario asignado.
 */
export function createWhatsAppDispatchNotifier(
  repo: DispatchRepository,
  send: WhatsAppSender
): DispatchNotifier {
  async function notifyAssignment(order: Order, courierId: string): Promise<void> {
    const [business, courier] = await Promise.all([
      repo.getBusiness(order.businessId),
      repo.getCourier(courierId),
    ]);

    if (courier) {
      const courierMessage = [
        "🛵 ¡Nuevo servicio asignado!",
        `Recogida: ${order.pickupAddress}`,
        `Entrega: ${order.dropoffAddress}`,
        order.fare ? `Tarifa: ${order.fare} ${order.currency}` : null,
        order.notes ? `Notas: ${order.notes}` : null,
      ]
        .filter((line): line is string => Boolean(line))
        .join("\n");
      await send(courier.phone, courierMessage);
    }

    if (business && courier) {
      const businessMessage = [
        "✅ Ya tienes domiciliario asignado.",
        `Nombre: ${courier.name}`,
        `Placa: ${courier.vehiclePlate ?? "sin registrar"}`,
        `Teléfono: ${courier.phone}`,
      ].join("\n");
      await send(business.phone, businessMessage);
    }
  }

  async function notifyNoCouriers(order: Order): Promise<void> {
    const business = await repo.getBusiness(order.businessId);
    if (!business) return;
    await send(
      business.phone,
      "😕 No encontramos domiciliarios disponibles cerca en este momento. Intenta de nuevo en unos minutos."
    );
  }

  async function notifyUnassigned(order: Order): Promise<void> {
    const business = await repo.getBusiness(order.businessId);
    if (!business) return;
    await send(
      business.phone,
      "😕 Ningún domiciliario cercano aceptó a tiempo. Un administrador va a asignar uno manualmente en cuanto pueda."
    );
  }

  /**
   * El cierre del servicio puede llegar por dos caminos (cierre automático
   * por geocerca al llegar al destino, o el botón manual "Entregado" en la
   * PWA del domiciliario, ver DispatchService) — en ambos casos termina
   * pasando por `markDelivered`, así que un único mensaje aquí cubre los dos.
   */
  async function notifyDelivered(order: Order): Promise<void> {
    const business = await repo.getBusiness(order.businessId);
    if (!business) return;
    await send(business.phone, `📦 ¡Pedido entregado! Se completó la entrega en ${order.dropoffAddress}.`);
  }

  return {
    onOrderOffered() {
      // El solicitante ya recibió la confirmación al aceptar la cotización;
      // no hace falta notificarlo otra vez solo porque empezó la búsqueda
      // (ni en cada paso de la cascada, para no saturarlo de mensajes).
    },
    onOfferExpired() {
      // Es tráfico interno de la cascada (retirarle la oferta a quien no
      // respondió a tiempo); no hay nada que decirle al negocio por esto.
    },
    onOrderStatusChanged(order) {
      if (order.status !== "DELIVERED") return;
      notifyDelivered(order).catch((err) =>
        console.error("[whatsapp] error notificando la entrega del pedido", err)
      );
    },
    onOrderAssigned(order, winnerCourierId) {
      notifyAssignment(order, winnerCourierId).catch((err) =>
        console.error("[whatsapp] error notificando la asignación", err)
      );
    },
    onNoCouriersAvailable(order) {
      notifyNoCouriers(order).catch((err) =>
        console.error("[whatsapp] error notificando falta de domiciliarios", err)
      );
    },
    onOrderUnassigned(order) {
      notifyUnassigned(order).catch((err) =>
        console.error("[whatsapp] error notificando que el pedido quedó sin asignar", err)
      );
    },
  };
}
