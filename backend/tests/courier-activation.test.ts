import { describe, expect, it } from "vitest";
import {
  CourierActivationService,
  CourierNotFoundError,
  InvalidActivationCodeError,
} from "../src/domain/courier-activation";
import { InMemoryDispatchRepository } from "../src/testing/in-memory-repository";

describe("activación de domiciliarios con código", () => {
  it("activa al domiciliario si el código coincide", async () => {
    const repo = new InMemoryDispatchRepository();
    const courier = await repo.createCourier({ name: "Ana", phone: "+573000000003" });
    expect(courier.isActive).toBe(false);

    const service = new CourierActivationService(repo);
    const activated = await service.activate(courier.id, courier.activationCode);

    expect(activated.isActive).toBe(true);
  });

  it("rechaza un código incorrecto sin activar al domiciliario", async () => {
    const repo = new InMemoryDispatchRepository();
    const courier = await repo.createCourier({ name: "Ana", phone: "+573000000003" });
    const service = new CourierActivationService(repo);

    await expect(service.activate(courier.id, "000000")).rejects.toBeInstanceOf(
      InvalidActivationCodeError
    );

    const stillInactive = await repo.getCourier(courier.id);
    expect(stillInactive?.isActive).toBe(false);
  });

  it("rechaza activar un domiciliario que no existe", async () => {
    const repo = new InMemoryDispatchRepository();
    const service = new CourierActivationService(repo);
    await expect(service.activate("no-existe", "123456")).rejects.toBeInstanceOf(CourierNotFoundError);
  });

  it("permite desactivarse sin necesitar el código", async () => {
    const repo = new InMemoryDispatchRepository();
    const courier = await repo.createCourier({ name: "Ana", phone: "+573000000003" });
    const service = new CourierActivationService(repo);

    await service.activate(courier.id, courier.activationCode);
    const deactivated = await service.deactivate(courier.id);

    expect(deactivated.isActive).toBe(false);
  });
});
