import { describe, expect, it } from "vitest";
import {
  CourierActivationService,
  CourierNotFoundError,
  FaceReferenceMissingError,
  FaceVerificationFailedError,
  InvalidActivationCredentialError,
} from "../src/domain/courier-activation";
import { CourierTokenSigner } from "../src/domain/courier-session";
import { FACE_DESCRIPTOR_LENGTH } from "../src/domain/face-verification";
import { PendingSettlementError, SettlementService } from "../src/domain/settlement";
import { InMemoryDispatchRepository } from "../src/testing/in-memory-repository";

/** Fake simple: no hace falta un JWT real para probar el dominio de activación. */
function makeTokens(): CourierTokenSigner {
  return {
    sign: (courierId) => `token-${courierId}`,
    verify: (token) => (token.startsWith("token-") ? { courierId: token.slice("token-".length) } : null),
  };
}

function makeDescriptor(fill: number): number[] {
  return Array(FACE_DESCRIPTOR_LENGTH).fill(fill);
}

const REFERENCE_DESCRIPTOR = makeDescriptor(0.1);
const MATCHING_LIVE_DESCRIPTOR = (() => {
  const d = [...REFERENCE_DESCRIPTOR];
  d[0] += 0.01; // distancia mínima, dentro de cualquier umbral razonable
  return d;
})();
const MISMATCHED_LIVE_DESCRIPTOR = makeDescriptor(5); // muy lejos del de referencia

async function createCourierWithFaceReference(
  repo: InMemoryDispatchRepository,
  overrides: { name: string; phone: string; nationalId: string }
) {
  const courier = await repo.createCourier(overrides);
  await repo.setCourierFaceReference(courier.id, REFERENCE_DESCRIPTOR, new Date());
  return (await repo.getCourier(courier.id))!;
}

describe("activación de domiciliarios con cédula + verificación facial", () => {
  it("activa al domiciliario si la cédula coincide y el rostro coincide con el de referencia", async () => {
    const repo = new InMemoryDispatchRepository();
    const courier = await createCourierWithFaceReference(repo, {
      name: "Ana",
      phone: "+573000000003",
      nationalId: "573000000003",
    });
    expect(courier.isActive).toBe(false);

    const service = new CourierActivationService(repo, makeTokens());
    const { courier: activated, token } = await service.activate(courier.id, courier.nationalId, MATCHING_LIVE_DESCRIPTOR);

    expect(activated.isActive).toBe(true);
    expect(typeof token).toBe("string");
    expect(token.length).toBeGreaterThan(0);
  });

  it("rechaza una cédula incorrecta sin activar al domiciliario", async () => {
    const repo = new InMemoryDispatchRepository();
    const courier = await createCourierWithFaceReference(repo, {
      name: "Ana",
      phone: "+573000000003",
      nationalId: "573000000003",
    });
    const service = new CourierActivationService(repo, makeTokens());

    await expect(
      service.activate(courier.id, "000000", MATCHING_LIVE_DESCRIPTOR)
    ).rejects.toBeInstanceOf(InvalidActivationCredentialError);

    const stillInactive = await repo.getCourier(courier.id);
    expect(stillInactive?.isActive).toBe(false);
  });

  it("rechaza activar un domiciliario que no existe", async () => {
    const repo = new InMemoryDispatchRepository();
    const service = new CourierActivationService(repo, makeTokens());
    await expect(
      service.activate("no-existe", "123456", MATCHING_LIVE_DESCRIPTOR)
    ).rejects.toBeInstanceOf(CourierNotFoundError);
  });

  it("rechaza activar si el domiciliario todavía no registró su rostro de referencia", async () => {
    const repo = new InMemoryDispatchRepository();
    // Sin llamar a setCourierFaceReference: faceDescriptor queda null.
    const courier = await repo.createCourier({ name: "Ana", phone: "+573000000004", nationalId: "573000000004" });
    const service = new CourierActivationService(repo, makeTokens());

    await expect(
      service.activate(courier.id, courier.nationalId, MATCHING_LIVE_DESCRIPTOR)
    ).rejects.toBeInstanceOf(FaceReferenceMissingError);

    const stillInactive = await repo.getCourier(courier.id);
    expect(stillInactive?.isActive).toBe(false);
  });

  it("rechaza activar si la selfie en vivo no coincide con el rostro de referencia", async () => {
    const repo = new InMemoryDispatchRepository();
    const courier = await createCourierWithFaceReference(repo, {
      name: "Ana",
      phone: "+573000000005",
      nationalId: "573000000005",
    });
    const service = new CourierActivationService(repo, makeTokens());

    await expect(
      service.activate(courier.id, courier.nationalId, MISMATCHED_LIVE_DESCRIPTOR)
    ).rejects.toBeInstanceOf(FaceVerificationFailedError);

    const stillInactive = await repo.getCourier(courier.id);
    expect(stillInactive?.isActive).toBe(false);
  });

  it("permite desactivarse sin necesitar la cédula ni el rostro", async () => {
    const repo = new InMemoryDispatchRepository();
    const courier = await createCourierWithFaceReference(repo, {
      name: "Ana",
      phone: "+573000000003",
      nationalId: "573000000003",
    });
    const service = new CourierActivationService(repo, makeTokens());

    await service.activate(courier.id, courier.nationalId, MATCHING_LIVE_DESCRIPTOR);
    const deactivated = await service.deactivate(courier.id);

    expect(deactivated.isActive).toBe(false);
  });

  it("bloquea la activación si el domiciliario tiene comisión pendiente de un día anterior (aunque la cédula y el rostro coincidan)", async () => {
    const repo = new InMemoryDispatchRepository();
    const courier = await createCourierWithFaceReference(repo, {
      name: "Ana",
      phone: "+573000000020",
      nationalId: "573000000020",
    });
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

    const service = new CourierActivationService(repo, makeTokens(), settlements, () => new Date("2026-01-11T09:00:00Z"));

    await expect(
      service.activate(courier.id, courier.nationalId, MATCHING_LIVE_DESCRIPTOR)
    ).rejects.toBeInstanceOf(PendingSettlementError);
    const stillInactive = await repo.getCourier(courier.id);
    expect(stillInactive?.isActive).toBe(false);
  });

  it("permite activarse de nuevo una vez que paga la comisión pendiente", async () => {
    const repo = new InMemoryDispatchRepository();
    const courier = await createCourierWithFaceReference(repo, {
      name: "Ana",
      phone: "+573000000022",
      nationalId: "573000000022",
    });
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

    const service = new CourierActivationService(repo, makeTokens(), settlements, () => new Date("2026-01-11T09:00:00Z"));
    const { courier: activated } = await service.activate(courier.id, courier.nationalId, MATCHING_LIVE_DESCRIPTOR);
    expect(activated.isActive).toBe(true);
  });
});
