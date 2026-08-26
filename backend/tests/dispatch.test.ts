import { describe, expect, it } from "vitest";
import {
  DispatchService,
  DispatchNotifier,
  OrderAlreadyTakenError,
  OrderNotFoundError,
} from "../src/domain/dispatch";
import { InMemoryDispatchRepository } from "../src/testing/in-memory-repository";
import { Order, CourierWithDistance } from "../src/domain/types";

const BOGOTA_RESTAURANT = { lat: 4.6533, lng: -74.0836 };

function makeRecordingNotifier() {
  const events: { type: string; payload: unknown }[] = [];
  const notifier: DispatchNotifier = {
    onOrderOffered(order, candidates) {
      events.push({ type: "offered", payload: { order, candidates } });
    },
    onOrderAssigned(order, winnerCourierId) {
      events.push({ type: "assigned", payload: { order, winnerCourierId } });
    },
    onOrderStatusChanged(order) {
      events.push({ type: "status", payload: order });
    },
    onNoCouriersAvailable(order) {
      events.push({ type: "no-couriers", payload: order });
    },
  };
  return { notifier, events };
}

function baseOrderInput() {
  return {
    businessId: "biz_1",
    pickup: BOGOTA_RESTAURANT,
    pickupAddress: "Calle 100 #10-10",
    dropoff: { lat: 4.66, lng: -74.09 },
    dropoffAddress: "Cra 15 #85-20",
  };
}

describe("búsqueda de domiciliarios cercanos", () => {
  it("solo devuelve domiciliarios activos, dentro del radio, ordenados por distancia", async () => {
    const repo = new InMemoryDispatchRepository();
    const lejos = repo.seedCourier({ isActive: true, lat: 4.9, lng: -74.3 }); // ~30km, fuera de radio
    const inactivo = repo.seedCourier({ isActive: false, lat: 4.654, lng: -74.084 }); // cerca pero inactivo
    const cercano = repo.seedCourier({ isActive: true, lat: 4.654, lng: -74.084 }); // ~150m
    const medio = repo.seedCourier({ isActive: true, lat: 4.66, lng: -74.09 }); // ~1km

    const { notifier, events } = makeRecordingNotifier();
    const service = new DispatchService(repo, notifier, 5_000, 5);

    const { order, candidates } = await service.createDeliveryRequest(baseOrderInput());

    expect(order.status).toBe("SEARCHING");
    const candidateIds = candidates.map((c: CourierWithDistance) => c.id);
    expect(candidateIds).toEqual([cercano.id, medio.id]);
    expect(candidateIds).not.toContain(lejos.id);
    expect(candidateIds).not.toContain(inactivo.id);
    expect(candidates[0].distanceMeters).toBeLessThan(candidates[1].distanceMeters);

    expect(events.some((e) => e.type === "offered")).toBe(true);
  });

  it("marca el pedido como NO_COURIERS_AVAILABLE si no hay nadie activo cerca", async () => {
    const repo = new InMemoryDispatchRepository();
    repo.seedCourier({ isActive: false, lat: 4.654, lng: -74.084 });

    const { notifier, events } = makeRecordingNotifier();
    const service = new DispatchService(repo, notifier);

    const { order, candidates } = await service.createDeliveryRequest(baseOrderInput());

    expect(candidates).toHaveLength(0);
    expect(order.status).toBe("NO_COURIERS_AVAILABLE");
    expect(events.some((e) => e.type === "no-couriers")).toBe(true);
  });
});

describe("asignación: el primero en aceptar gana", () => {
  it("asigna el pedido al domiciliario que acepta", async () => {
    const repo = new InMemoryDispatchRepository();
    const courier = repo.seedCourier({ isActive: true, lat: 4.654, lng: -74.084 });
    const service = new DispatchService(repo);

    const { order } = await service.createDeliveryRequest(baseOrderInput());
    const assigned = await service.acceptOrder(order.id, courier.id);

    expect(assigned.status).toBe("ASSIGNED");
    expect(assigned.courierId).toBe(courier.id);
    expect(assigned.assignedAt).not.toBeNull();
  });

  it("solo uno de dos domiciliarios que aceptan al mismo tiempo gana el pedido", async () => {
    const repo = new InMemoryDispatchRepository();
    const courierA = repo.seedCourier({ isActive: true, lat: 4.654, lng: -74.084 });
    const courierB = repo.seedCourier({ isActive: true, lat: 4.655, lng: -74.085 });
    const service = new DispatchService(repo);

    const { order } = await service.createDeliveryRequest(baseOrderInput());

    const results = await Promise.allSettled([
      service.acceptOrder(order.id, courierA.id),
      service.acceptOrder(order.id, courierB.id),
    ]);

    const fulfilled = results.filter(
      (r): r is PromiseFulfilledResult<Order> => r.status === "fulfilled"
    );
    const rejected = results.filter((r) => r.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(OrderAlreadyTakenError);

    const winnerId = fulfilled[0].value.courierId;
    expect([courierA.id, courierB.id]).toContain(winnerId);

    const finalOrder = await repo.getOrder(order.id);
    expect(finalOrder?.status).toBe("ASSIGNED");
    expect(finalOrder?.courierId).toBe(winnerId);
  });

  it("una carrera de muchos domiciliarios produce exactamente un ganador", async () => {
    const repo = new InMemoryDispatchRepository();
    const couriers = Array.from({ length: 20 }, () =>
      repo.seedCourier({ isActive: true, lat: 4.654, lng: -74.084 })
    );
    const service = new DispatchService(repo);
    const { order } = await service.createDeliveryRequest(baseOrderInput());

    const results = await Promise.allSettled(
      couriers.map((c) => service.acceptOrder(order.id, c.id))
    );

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled).toHaveLength(1);

    const finalOrder = await repo.getOrder(order.id);
    expect(finalOrder?.status).toBe("ASSIGNED");
  });

  it("rechaza aceptar un pedido que no existe", async () => {
    const repo = new InMemoryDispatchRepository();
    const service = new DispatchService(repo);
    await expect(service.acceptOrder("no-existe", "courier_x")).rejects.toBeInstanceOf(
      OrderNotFoundError
    );
  });

  it("rechaza aceptar un pedido ya cancelado", async () => {
    const repo = new InMemoryDispatchRepository();
    const courier = repo.seedCourier({ isActive: true, lat: 4.654, lng: -74.084 });
    const service = new DispatchService(repo);

    const { order } = await service.createDeliveryRequest(baseOrderInput());
    await service.cancelOrder(order.id);

    await expect(service.acceptOrder(order.id, courier.id)).rejects.toBeInstanceOf(
      OrderAlreadyTakenError
    );
  });
});

describe("ciclo de vida del pedido", () => {
  it("recorre asignado -> en curso -> entregado", async () => {
    const repo = new InMemoryDispatchRepository();
    const courier = repo.seedCourier({ isActive: true, lat: 4.654, lng: -74.084 });
    const service = new DispatchService(repo);

    const { order } = await service.createDeliveryRequest(baseOrderInput());
    await service.acceptOrder(order.id, courier.id);

    const pickedUp = await service.markPickedUp(order.id);
    expect(pickedUp.status).toBe("IN_PROGRESS");

    const delivered = await service.markDelivered(order.id);
    expect(delivered.status).toBe("DELIVERED");
    expect(delivered.deliveredAt).not.toBeNull();
  });
});
