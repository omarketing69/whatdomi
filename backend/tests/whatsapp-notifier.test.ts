import { describe, expect, it } from "vitest";
import { createWhatsAppDispatchNotifier } from "../src/whatsapp/notifier";
import { InMemoryDispatchRepository } from "../src/testing/in-memory-repository";
import { WhatsAppSender } from "../src/whatsapp/sender";

function recordingSender() {
  const sent: { phone: string; message: string }[] = [];
  const sender: WhatsAppSender = async (phone, message) => {
    sent.push({ phone, message });
  };
  return { sender, sent };
}

describe("notificador de WhatsApp en la asignación", () => {
  it("le manda al domiciliario los datos del servicio, y al negocio nombre/placa/teléfono del domiciliario", async () => {
    const repo = new InMemoryDispatchRepository();
    const business = await repo.createBusiness({ name: "Restaurante La Esquina", phone: "+573000000001" });
    const courier = repo.seedCourier({
      name: "Carlos Pérez",
      phone: "+573000000002",
      vehiclePlate: "ABC-123",
      isActive: true,
      lat: 4.65,
      lng: -74.08,
    });
    const order = await repo.createOrder({
      businessId: business.id,
      pickup: { lat: 4.65, lng: -74.08 },
      pickupAddress: "Parque Central",
      dropoff: { lat: 4.66, lng: -74.09 },
      dropoffAddress: "Iglesia Mayor",
      fare: 5000,
      currency: "COP",
    });
    await repo.updateOrderStatus(order.id, "SEARCHING");
    const assigned = await repo.tryAssignOrder(order.id, courier.id);

    const { sender, sent } = recordingSender();
    const notifier = createWhatsAppDispatchNotifier(repo, sender);
    notifier.onOrderAssigned(assigned!, courier.id);

    // Los envíos son asíncronos (fire-and-forget desde el notifier); esperamos un tick.
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(sent).toHaveLength(2);

    const toCourier = sent.find((m) => m.phone === courier.phone);
    expect(toCourier?.message).toContain("Parque Central");
    expect(toCourier?.message).toContain("Iglesia Mayor");
    expect(toCourier?.message).toContain("5000");

    const toBusiness = sent.find((m) => m.phone === business.phone);
    expect(toBusiness?.message).toContain("Carlos Pérez");
    expect(toBusiness?.message).toContain("ABC-123");
    expect(toBusiness?.message).toContain(courier.phone);
  });

  it("avisa al negocio si no hay domiciliarios disponibles", async () => {
    const repo = new InMemoryDispatchRepository();
    const business = await repo.createBusiness({ name: "Tienda X", phone: "+573000000009" });
    const order = await repo.createOrder({
      businessId: business.id,
      pickup: { lat: 4.65, lng: -74.08 },
      pickupAddress: "A",
      dropoff: { lat: 4.66, lng: -74.09 },
      dropoffAddress: "B",
    });

    const { sender, sent } = recordingSender();
    const notifier = createWhatsAppDispatchNotifier(repo, sender);
    notifier.onNoCouriersAvailable(order);

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(sent).toHaveLength(1);
    expect(sent[0].phone).toBe(business.phone);
    expect(sent[0].message).toMatch(/no encontramos domiciliarios/i);
  });
});
