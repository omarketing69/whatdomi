import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DispatchNotifier,
  DispatchService,
  OrderAlreadyTakenError,
  OrderNotFoundError,
} from "../src/domain/dispatch";
import { InMemoryDispatchRepository } from "../src/testing/in-memory-repository";

const PICKUP = { lat: 4.6533, lng: -74.0836 };
const OFFER_TIMEOUT_MS = 60_000;

function baseOrderInput() {
  return {
    businessId: "biz_1",
    pickup: PICKUP,
    pickupAddress: "Calle 100 #10-10",
    dropoff: { lat: 4.66, lng: -74.09 },
    dropoffAddress: "Cra 15 #85-20",
  };
}

function makeRecordingNotifier() {
  const events: { type: string; payload: unknown }[] = [];
  const notifier: DispatchNotifier = {
    onOrderOffered(order, candidates) {
      events.push({ type: "offered", payload: candidates[0].id });
    },
    onOfferExpired(order, courierId) {
      events.push({ type: "expired", payload: courierId });
    },
    onOrderAssigned(order, winnerCourierId) {
      events.push({ type: "assigned", payload: winnerCourierId });
    },
    onOrderStatusChanged(order) {
      events.push({ type: "status", payload: order.status });
    },
    onNoCouriersAvailable() {
      events.push({ type: "no-couriers", payload: null });
    },
    onOrderUnassigned(order) {
      events.push({ type: "unassigned", payload: order.status });
    },
  };
  return { notifier, events };
}

/**
 * InMemoryDispatchRepository.tryAssignOrder cede el control con un
 * setTimeout(0); con fake timers hay que dejarlo avanzar. Se usa
 * Promise.allSettled (en vez de esperar el avance y luego el resultado
 * por separado) para engancharle un manejador a `service.acceptOrder(...)`
 * de inmediato y evitar un aviso de "unhandled rejection" cuando la
 * promesa rechaza antes de que termine el avance del reloj.
 */
async function acceptOrder(service: DispatchService, orderId: string, courierId: string) {
  const [result] = await Promise.allSettled([
    service.acceptOrder(orderId, courierId),
    vi.advanceTimersByTimeAsync(0),
  ]);
  if (result.status === "rejected") throw result.reason;
  return result.value;
}

describe("cascada de asignación: timeout y reintento secuencial", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("al crear el pedido, solo se le ofrece al candidato más cercano (no a todos a la vez)", async () => {
    const repo = new InMemoryDispatchRepository();
    const near = repo.seedCourier({ isActive: true, lat: 4.6533, lng: -74.0836 });
    const far = repo.seedCourier({ isActive: true, lat: 4.66, lng: -74.09 });

    const { notifier, events } = makeRecordingNotifier();
    const service = new DispatchService(repo, { notifier });

    await service.createDeliveryRequest(baseOrderInput());

    const offered = events.filter((e) => e.type === "offered").map((e) => e.payload);
    expect(offered).toEqual([near.id]);
    expect(offered).not.toContain(far.id);
  });

  it("si el más cercano no responde en 60s, se le retira la oferta y pasa al siguiente", async () => {
    const repo = new InMemoryDispatchRepository();
    const near = repo.seedCourier({ isActive: true, lat: 4.6533, lng: -74.0836 });
    const far = repo.seedCourier({ isActive: true, lat: 4.66, lng: -74.09 });

    const { notifier, events } = makeRecordingNotifier();
    const service = new DispatchService(repo, { notifier });

    const { order } = await service.createDeliveryRequest(baseOrderInput());
    expect(events.filter((e) => e.type === "offered").map((e) => e.payload)).toEqual([near.id]);

    await vi.advanceTimersByTimeAsync(OFFER_TIMEOUT_MS);

    expect(events.filter((e) => e.type === "expired").map((e) => e.payload)).toEqual([near.id]);
    expect(events.filter((e) => e.type === "offered").map((e) => e.payload)).toEqual([near.id, far.id]);

    // El segundo candidato sí puede aceptar.
    const accepted = await acceptOrder(service, order.id, far.id);
    expect(accepted.status).toBe("ASSIGNED");
    expect(accepted.courierId).toBe(far.id);
  });

  it("el candidato al que se le pasó el turno ya no puede aceptar después", async () => {
    const repo = new InMemoryDispatchRepository();
    const near = repo.seedCourier({ isActive: true, lat: 4.6533, lng: -74.0836 });
    repo.seedCourier({ isActive: true, lat: 4.66, lng: -74.09 });

    const { notifier } = makeRecordingNotifier();
    const service = new DispatchService(repo, { notifier });

    const { order } = await service.createDeliveryRequest(baseOrderInput());
    await vi.advanceTimersByTimeAsync(OFFER_TIMEOUT_MS); // avanza al segundo candidato

    await expect(acceptOrder(service, order.id, near.id)).rejects.toBeInstanceOf(OrderAlreadyTakenError);

    const stillSearching = await repo.getOrder(order.id);
    expect(stillSearching?.status).toBe("SEARCHING");
    expect(stillSearching?.courierId).toBeNull();
  });

  it("si acepta antes de que se cumpla la ventana, no hay un segundo aviso ni se puede reintentar la cascada", async () => {
    const repo = new InMemoryDispatchRepository();
    const near = repo.seedCourier({ isActive: true, lat: 4.6533, lng: -74.0836 });
    const far = repo.seedCourier({ isActive: true, lat: 4.66, lng: -74.09 });

    const { notifier, events } = makeRecordingNotifier();
    const service = new DispatchService(repo, { notifier });

    const { order } = await service.createDeliveryRequest(baseOrderInput());
    const accepted = await acceptOrder(service, order.id, near.id);
    expect(accepted.courierId).toBe(near.id);

    // Avanzar el reloj no debería reactivar nada: la cascada ya se limpió al aceptar.
    await vi.advanceTimersByTimeAsync(OFFER_TIMEOUT_MS * 2);
    expect(events.some((e) => e.type === "expired")).toBe(false);
    expect(events.filter((e) => e.type === "offered").map((e) => e.payload)).toEqual([near.id]);

    const finalOrder = await repo.getOrder(order.id);
    expect(finalOrder?.status).toBe("ASSIGNED");
    expect(finalOrder?.courierId).toBe(near.id);
    void far; // no participa, solo confirma que no fue ofrecido
  });

  it("si se agota toda la lista de candidatos sin que nadie acepte, el pedido queda UNASSIGNED", async () => {
    const repo = new InMemoryDispatchRepository();
    const a = repo.seedCourier({ isActive: true, lat: 4.6533, lng: -74.0836 });
    const b = repo.seedCourier({ isActive: true, lat: 4.66, lng: -74.09 });

    const { notifier, events } = makeRecordingNotifier();
    const service = new DispatchService(repo, { notifier, maxCandidates: 5 });

    const { order, candidates } = await service.createDeliveryRequest(baseOrderInput());
    expect(candidates.map((c) => c.id).sort()).toEqual([a.id, b.id].sort());

    // Ninguno de los 2 responde nunca: dos ventanas completas.
    await vi.advanceTimersByTimeAsync(OFFER_TIMEOUT_MS);
    await vi.advanceTimersByTimeAsync(OFFER_TIMEOUT_MS);

    expect(events.filter((e) => e.type === "unassigned")).toHaveLength(1);
    const finalOrder = await repo.getOrder(order.id);
    expect(finalOrder?.status).toBe("UNASSIGNED");
    expect(finalOrder?.courierId).toBeNull();
  });

  it("el admin puede asignar manualmente un pedido UNASSIGNED", async () => {
    const repo = new InMemoryDispatchRepository();
    const a = repo.seedCourier({ isActive: true, lat: 4.6533, lng: -74.0836 });
    const service = new DispatchService(repo, { maxCandidates: 5 });

    const { order } = await service.createDeliveryRequest(baseOrderInput());
    await vi.advanceTimersByTimeAsync(OFFER_TIMEOUT_MS); // se agota el único candidato

    const beforeAssign = await repo.getOrder(order.id);
    expect(beforeAssign?.status).toBe("UNASSIGNED");

    const assigned = await service.manuallyAssignOrder(order.id, a.id);
    expect(assigned.status).toBe("ASSIGNED");
    expect(assigned.courierId).toBe(a.id);
  });

  it("no permite asignar manualmente un pedido que no está UNASSIGNED", async () => {
    const repo = new InMemoryDispatchRepository();
    const a = repo.seedCourier({ isActive: true, lat: 4.6533, lng: -74.0836 });
    const service = new DispatchService(repo);

    const { order } = await service.createDeliveryRequest(baseOrderInput());
    // Sigue en SEARCHING (dentro de su ventana de 60s), no UNASSIGNED.
    await expect(service.manuallyAssignOrder(order.id, a.id)).rejects.toBeInstanceOf(OrderAlreadyTakenError);
  });

  it("lanza OrderNotFoundError al asignar manualmente un pedido que no existe", async () => {
    const repo = new InMemoryDispatchRepository();
    const service = new DispatchService(repo);
    await expect(service.manuallyAssignOrder("no-existe", "courier-1")).rejects.toBeInstanceOf(
      OrderNotFoundError
    );
  });

  it("cancelar un pedido en plena cascada detiene los reintentos futuros", async () => {
    const repo = new InMemoryDispatchRepository();
    repo.seedCourier({ isActive: true, lat: 4.6533, lng: -74.0836 });
    repo.seedCourier({ isActive: true, lat: 4.66, lng: -74.09 });

    const { notifier, events } = makeRecordingNotifier();
    const service = new DispatchService(repo, { notifier });

    const { order } = await service.createDeliveryRequest(baseOrderInput());
    await service.cancelOrder(order.id);

    await vi.advanceTimersByTimeAsync(OFFER_TIMEOUT_MS * 3);

    expect(events.some((e) => e.type === "expired")).toBe(false);
    expect(events.some((e) => e.type === "unassigned")).toBe(false);
    const finalOrder = await repo.getOrder(order.id);
    expect(finalOrder?.status).toBe("CANCELLED");
  });
});
