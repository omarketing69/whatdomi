import { describe, expect, it } from "vitest";
import {
  CourierActivationService,
  CourierNotFoundError,
  InvalidActivationCredentialError,
} from "../src/domain/courier-activation";
import { PendingSettlementError, SettlementService } from "../src/domain/settlement";
import { InMemoryDispatchRepository } from "../src/testing/in-memory-repository";

describe("activación de domiciliarios con cédula", () => {
  it("activa al domiciliario si la cédula coincide", async () => {
    const repo = new InMemoryDispatchRepository();
    const courier = await repo.createCourier({ name: "Ana", phone: "+573000000003", nationalId: "573000000003" });
    expect(courier.isActive).toBe(false);

    const service = new CourierActivationService(repo);
    const activated = await service.activate(courier.id, courier.nationalId);

    expect(activated.isActive).toBe(true);
  });

  it("rechaza una cédula incorrecta sin activar al domiciliario", async () => {
    const repo = new InMemoryDispatchRepository();
    const courier = await repo.createCourier({ name: "Ana", phone: "+573000000003", nationalId: "573000000003" });
    const service = new CourierActivationService(repo);

    await expect(service.activate(courier.id, "000000")).rejects.toBeInstanceOf(
      InvalidActivationCredentialError
    );

    const stillInactive = await repo.getCourier(courier.id);
    expect(stillInactive?.isActive).toBe(false);
  });

  it("rechaza activar un domiciliario que no existe", async () => {
    const repo = new InMemoryDispatchRepository();
    const service = new CourierActivationService(repo);
    await expect(service.activate("no-existe", "123456")).rejects.toBeInstanceOf(CourierNotFoundError);
  });

  it("permite desactivarse sin necesitar la cédula", async () => {
    const repo = new InMemoryDispatchRepository();
    const courier = await repo.createCourier({ name: "Ana", phone: "+573000000003", nationalId: "573000000003" });
    const service = new CourierActivationService(repo);

    await service.activate(courier.id, courier.nationalId);
    const deactivated = await service.deactivate(courier.id);

    expect(deactivated.isActive).toBe(false);
  });

  it("bloquea la activación si el domiciliario tiene comisión pendiente de un día anterior", async () => {
    const repo = new InMemoryDispatchRepository();
    const courier = await repo.createCourier({ name: "Ana", phone: "+573000000020", nationalId: "573000000020" });
    const settlements = new SettlementService(repo);

    // Simula un día de trabajo anterior sin liquidar.
    const business = await repo.createBusiness({ name: "Negocio", phone: "+573000000021" });
    const order = await repo.createOrder({
      businessId: business.id,
      pickup: { lat: 4.65, lng: -74.08 },
      pickupAddress: "A",
      dropoff: { lat: 4.66, lng: -74.09 },
      dropoffAddress: "B",
      fare: 5000,
      currency: "COP",
    });
    await repo.updateOrderStatus(order.id, "SEARCHING");
    await repo.tryAssignOrder(order.id, courier.id);
    await repo.updateOrderStatus(order.id, "DELIVERED", { deliveredAt: new Date("2026-01-10T12:00:00Z") });
    await settlements.recomputeSettlement(courier.id, "2026-01-10");

    const service = new CourierActivationService(repo, settlements, () => new Date("2026-01-11T09:00:00Z"));

    await expect(service.activate(courier.id, courier.nationalId)).rejects.toBeInstanceOf(
      PendingSettlementError
    );
    const stillInactive = await repo.getCourier(courier.id);
    expect(stillInactive?.isActive).toBe(false);
  });

  it("permite activarse de nuevo una vez que paga la comisión pendiente", async () => {
    const repo = new InMemoryDispatchRepository();
    const courier = await repo.createCourier({ name: "Ana", phone: "+573000000022", nationalId: "573000000022" });
    const settlements = new SettlementService(repo);

    const business = await repo.createBusiness({ name: "Negocio", phone: "+573000000023" });
    const order = await repo.createOrder({
      businessId: business.id,
      pickup: { lat: 4.65, lng: -74.08 },
      pickupAddress: "A",
      dropoff: { lat: 4.66, lng: -74.09 },
      dropoffAddress: "B",
      fare: 5000,
      currency: "COP",
    });
    await repo.updateOrderStatus(order.id, "SEARCHING");
    await repo.tryAssignOrder(order.id, courier.id);
    await repo.updateOrderStatus(order.id, "DELIVERED", { deliveredAt: new Date("2026-01-10T12:00:00Z") });
    await settlements.recomputeSettlement(courier.id, "2026-01-10");
    await settlements.markPaid(courier.id, "2026-01-10");

    const service = new CourierActivationService(repo, settlements, () => new Date("2026-01-11T09:00:00Z"));
    const activated = await service.activate(courier.id, courier.nationalId);
    expect(activated.isActive).toBe(true);
  });
});
