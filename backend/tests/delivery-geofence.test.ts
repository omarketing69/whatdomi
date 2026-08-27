import { describe, expect, it } from "vitest";
import { DispatchService } from "../src/domain/dispatch";
import { InMemoryDispatchRepository } from "../src/testing/in-memory-repository";

describe("cierre automático del servicio por geocerca de entrega", () => {
  it("marca el pedido como DELIVERED cuando la ubicación reportada cae dentro del radio del punto de entrega", async () => {
    const repo = new InMemoryDispatchRepository();
    const business = await repo.createBusiness({ name: "Negocio", phone: "+573000000040" });
    const courier = repo.seedCourier({ isActive: true, lat: 4.65, lng: -74.08 });

    const order = await repo.createOrder({
      businessId: business.id,
      pickup: { lat: 4.65, lng: -74.08 },
      pickupAddress: "Origen",
      dropoff: { lat: 4.66, lng: -74.09 },
      dropoffAddress: "Destino",
    });
    await repo.updateOrderStatus(order.id, "SEARCHING");
    await repo.tryAssignOrder(order.id, courier.id);
    await repo.updateOrderStatus(order.id, "IN_PROGRESS");

    const dispatch = new DispatchService(repo, { deliveryGeofenceMeters: 100 });

    // Prácticamente encima del punto de entrega (dropoff): 4.66, -74.09
    await dispatch.reportCourierLocation(courier.id, { lat: 4.66001, lng: -74.09001 });

    const updated = await repo.getOrder(order.id);
    expect(updated?.status).toBe("DELIVERED");
    expect(updated?.deliveredAt).toBeTruthy();
  });

  it("no cierra el pedido si el domiciliario todavía está lejos del punto de entrega", async () => {
    const repo = new InMemoryDispatchRepository();
    const business = await repo.createBusiness({ name: "Negocio", phone: "+573000000041" });
    const courier = repo.seedCourier({ isActive: true, lat: 4.65, lng: -74.08 });

    const order = await repo.createOrder({
      businessId: business.id,
      pickup: { lat: 4.65, lng: -74.08 },
      pickupAddress: "Origen",
      dropoff: { lat: 4.66, lng: -74.09 },
      dropoffAddress: "Destino",
    });
    await repo.updateOrderStatus(order.id, "SEARCHING");
    await repo.tryAssignOrder(order.id, courier.id);
    await repo.updateOrderStatus(order.id, "IN_PROGRESS");

    const dispatch = new DispatchService(repo, { deliveryGeofenceMeters: 100 });

    // Sigue cerca del pickup, lejos del dropoff (~1.4km).
    await dispatch.reportCourierLocation(courier.id, { lat: 4.651, lng: -74.081 });

    const updated = await repo.getOrder(order.id);
    expect(updated?.status).toBe("IN_PROGRESS");
  });

  it("no hace nada si el domiciliario no tiene ningún pedido IN_PROGRESS (ej. está ASSIGNED yendo hacia la recogida)", async () => {
    const repo = new InMemoryDispatchRepository();
    const business = await repo.createBusiness({ name: "Negocio", phone: "+573000000042" });
    const courier = repo.seedCourier({ isActive: true, lat: 4.65, lng: -74.08 });

    const order = await repo.createOrder({
      businessId: business.id,
      pickup: { lat: 4.65, lng: -74.08 },
      pickupAddress: "Origen",
      dropoff: { lat: 4.66, lng: -74.09 },
      dropoffAddress: "Destino",
    });
    await repo.updateOrderStatus(order.id, "SEARCHING");
    await repo.tryAssignOrder(order.id, courier.id); // queda ASSIGNED, no IN_PROGRESS

    const dispatch = new DispatchService(repo, { deliveryGeofenceMeters: 100 });
    await dispatch.reportCourierLocation(courier.id, { lat: 4.66001, lng: -74.09001 });

    const updated = await repo.getOrder(order.id);
    expect(updated?.status).toBe("ASSIGNED");
  });

  it("igual guarda la ubicación aunque no haya ningún pedido en curso", async () => {
    const repo = new InMemoryDispatchRepository();
    const courier = repo.seedCourier({ isActive: true, lat: 4.65, lng: -74.08 });
    const dispatch = new DispatchService(repo);

    const updated = await dispatch.reportCourierLocation(courier.id, { lat: 4.7, lng: -74.1 });
    expect(updated?.lat).toBe(4.7);
    expect(updated?.lng).toBe(-74.1);
  });
});
