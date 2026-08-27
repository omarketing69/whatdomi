import { describe, expect, it } from "vitest";
import { CourierBusyError, DispatchService } from "../src/domain/dispatch";
import { InMemoryDispatchRepository } from "../src/testing/in-memory-repository";

/**
 * Un domiciliario con otro pedido ASSIGNED/IN_PROGRESS sin entregar no es
 * un candidato real para uno nuevo: ya está comprometido con otro
 * servicio. Ver docs/ARCHITECTURE.md §4 y el bug reportado sobre
 * findActiveCouriersNear/tryAssignOrder/forceAssignOrder.
 */
describe("un domiciliario ocupado no puede tomar un segundo pedido", () => {
  it("findActiveCouriersNear no lo devuelve como candidato mientras tiene un pedido ASSIGNED", async () => {
    const repo = new InMemoryDispatchRepository();
    const business = await repo.createBusiness({ name: "Negocio", phone: "+573000000050" });
    const courier = repo.seedCourier({ isActive: true, lat: 4.6533, lng: -74.0836 });

    const firstOrder = await repo.createOrder({
      businessId: business.id,
      pickup: { lat: 4.6533, lng: -74.0836 },
      pickupAddress: "A",
      dropoff: { lat: 4.66, lng: -74.09 },
      dropoffAddress: "B",
    });
    await repo.updateOrderStatus(firstOrder.id, "SEARCHING");
    await repo.tryAssignOrder(firstOrder.id, courier.id); // queda ASSIGNED

    const candidates = await repo.findActiveCouriersNear({ lat: 4.6533, lng: -74.0836 }, 5000, 5);
    expect(candidates.map((c) => c.id)).not.toContain(courier.id);
  });

  it("findActiveCouriersNear no lo devuelve mientras tiene un pedido IN_PROGRESS", async () => {
    const repo = new InMemoryDispatchRepository();
    const business = await repo.createBusiness({ name: "Negocio", phone: "+573000000051" });
    const courier = repo.seedCourier({ isActive: true, lat: 4.6533, lng: -74.0836 });

    const firstOrder = await repo.createOrder({
      businessId: business.id,
      pickup: { lat: 4.6533, lng: -74.0836 },
      pickupAddress: "A",
      dropoff: { lat: 4.66, lng: -74.09 },
      dropoffAddress: "B",
    });
    await repo.updateOrderStatus(firstOrder.id, "SEARCHING");
    await repo.tryAssignOrder(firstOrder.id, courier.id);
    await repo.updateOrderStatus(firstOrder.id, "IN_PROGRESS");

    const candidates = await repo.findActiveCouriersNear({ lat: 4.6533, lng: -74.0836 }, 5000, 5);
    expect(candidates.map((c) => c.id)).not.toContain(courier.id);
  });

  it("vuelve a aparecer como candidato una vez entrega el primer pedido", async () => {
    const repo = new InMemoryDispatchRepository();
    const business = await repo.createBusiness({ name: "Negocio", phone: "+573000000052" });
    const courier = repo.seedCourier({ isActive: true, lat: 4.6533, lng: -74.0836 });

    const firstOrder = await repo.createOrder({
      businessId: business.id,
      pickup: { lat: 4.6533, lng: -74.0836 },
      pickupAddress: "A",
      dropoff: { lat: 4.66, lng: -74.09 },
      dropoffAddress: "B",
    });
    await repo.updateOrderStatus(firstOrder.id, "SEARCHING");
    await repo.tryAssignOrder(firstOrder.id, courier.id);
    await repo.updateOrderStatus(firstOrder.id, "DELIVERED", { deliveredAt: new Date() });

    const candidates = await repo.findActiveCouriersNear({ lat: 4.6533, lng: -74.0836 }, 5000, 5);
    expect(candidates.map((c) => c.id)).toContain(courier.id);
  });

  it("DispatchService.acceptOrder rechaza con CourierBusyError si el domiciliario ya tiene otro pedido ASSIGNED", async () => {
    const repo = new InMemoryDispatchRepository();
    const business = await repo.createBusiness({ name: "Negocio", phone: "+573000000053" });
    const courier = repo.seedCourier({ isActive: true, lat: 4.6533, lng: -74.0836 });
    const dispatch = new DispatchService(repo);

    const firstOrder = await repo.createOrder({
      businessId: business.id,
      pickup: { lat: 4.6533, lng: -74.0836 },
      pickupAddress: "A",
      dropoff: { lat: 4.66, lng: -74.09 },
      dropoffAddress: "B",
    });
    await repo.updateOrderStatus(firstOrder.id, "SEARCHING");
    await repo.tryAssignOrder(firstOrder.id, courier.id); // ya está ASSIGNED en un pedido

    // Un segundo pedido, sembrado directamente en SEARCHING (sin pasar por
    // la cascada real) para aislar el chequeo de acceptOrder en sí.
    const secondOrder = await repo.createOrder({
      businessId: business.id,
      pickup: { lat: 4.6533, lng: -74.0836 },
      pickupAddress: "C",
      dropoff: { lat: 4.7, lng: -74.1 },
      dropoffAddress: "D",
    });
    await repo.updateOrderStatus(secondOrder.id, "SEARCHING");

    await expect(dispatch.acceptOrder(secondOrder.id, courier.id)).rejects.toBeInstanceOf(CourierBusyError);

    const stillSearching = await repo.getOrder(secondOrder.id);
    expect(stillSearching?.status).toBe("SEARCHING");
    expect(stillSearching?.courierId).toBeNull();
  });

  it("DispatchService.manuallyAssignOrder rechaza con CourierBusyError si el domiciliario ya tiene otro pedido activo", async () => {
    const repo = new InMemoryDispatchRepository();
    const business = await repo.createBusiness({ name: "Negocio", phone: "+573000000054" });
    const courier = repo.seedCourier({ isActive: true, lat: 4.6533, lng: -74.0836 });
    const dispatch = new DispatchService(repo);

    const firstOrder = await repo.createOrder({
      businessId: business.id,
      pickup: { lat: 4.6533, lng: -74.0836 },
      pickupAddress: "A",
      dropoff: { lat: 4.66, lng: -74.09 },
      dropoffAddress: "B",
    });
    await repo.updateOrderStatus(firstOrder.id, "SEARCHING");
    await repo.tryAssignOrder(firstOrder.id, courier.id);
    await repo.updateOrderStatus(firstOrder.id, "IN_PROGRESS");

    const secondOrder = await repo.createOrder({
      businessId: business.id,
      pickup: { lat: 4.6533, lng: -74.0836 },
      pickupAddress: "C",
      dropoff: { lat: 4.7, lng: -74.1 },
      dropoffAddress: "D",
    });
    await repo.updateOrderStatus(secondOrder.id, "UNASSIGNED");

    await expect(dispatch.manuallyAssignOrder(secondOrder.id, courier.id)).rejects.toBeInstanceOf(CourierBusyError);
  });

  it("repo.tryAssignOrder devuelve null (no asigna) si el domiciliario ya está ocupado, incluso llamado directamente", async () => {
    const repo = new InMemoryDispatchRepository();
    const business = await repo.createBusiness({ name: "Negocio", phone: "+573000000055" });
    const courier = repo.seedCourier({ isActive: true, lat: 4.6533, lng: -74.0836 });

    const firstOrder = await repo.createOrder({
      businessId: business.id,
      pickup: { lat: 4.6533, lng: -74.0836 },
      pickupAddress: "A",
      dropoff: { lat: 4.66, lng: -74.09 },
      dropoffAddress: "B",
    });
    await repo.updateOrderStatus(firstOrder.id, "SEARCHING");
    await repo.tryAssignOrder(firstOrder.id, courier.id);

    const secondOrder = await repo.createOrder({
      businessId: business.id,
      pickup: { lat: 4.6533, lng: -74.0836 },
      pickupAddress: "C",
      dropoff: { lat: 4.7, lng: -74.1 },
      dropoffAddress: "D",
    });
    await repo.updateOrderStatus(secondOrder.id, "SEARCHING");

    const result = await repo.tryAssignOrder(secondOrder.id, courier.id);
    expect(result).toBeNull();
  });

  it("findActiveOrderForCourier devuelve el pedido activo, y null si no tiene ninguno", async () => {
    const repo = new InMemoryDispatchRepository();
    const business = await repo.createBusiness({ name: "Negocio", phone: "+573000000056" });
    const courier = repo.seedCourier({ isActive: true, lat: 4.6533, lng: -74.0836 });

    expect(await repo.findActiveOrderForCourier(courier.id)).toBeNull();

    const order = await repo.createOrder({
      businessId: business.id,
      pickup: { lat: 4.6533, lng: -74.0836 },
      pickupAddress: "A",
      dropoff: { lat: 4.66, lng: -74.09 },
      dropoffAddress: "B",
    });
    await repo.updateOrderStatus(order.id, "SEARCHING");
    await repo.tryAssignOrder(order.id, courier.id);

    const active = await repo.findActiveOrderForCourier(courier.id);
    expect(active?.id).toBe(order.id);
  });
});
