import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/api/app";
import { DispatchService } from "../src/domain/dispatch";
import { FACE_DESCRIPTOR_LENGTH } from "../src/domain/face-verification";
import { AddressNormalizer, GeocodeResult, GeocodingProvider, GeocodingService } from "../src/domain/geocoding";
import { InMemoryDispatchRepository } from "../src/testing/in-memory-repository";
import { WhatsAppConversationService } from "../src/whatsapp/conversation";

class NoopNormalizer implements AddressNormalizer {
  async normalize(rawText: string): Promise<string> {
    return rawText;
  }
}
class NoopProvider implements GeocodingProvider {
  async geocode(): Promise<GeocodeResult | null> {
    return null;
  }
}

function makeApp(repo = new InMemoryDispatchRepository()) {
  const dispatch = new DispatchService(repo);
  const geocoding = new GeocodingService(new NoopNormalizer(), new NoopProvider());
  const conversation = new WhatsAppConversationService(repo, dispatch, geocoding);
  const app = createApp(repo, dispatch, conversation, async () => {});
  return { repo, app };
}

function makeDescriptor(fill: number): number[] {
  return Array(FACE_DESCRIPTOR_LENGTH).fill(fill);
}

describe("POST /api/couriers/:courierId/face-reference", () => {
  it("rechaza sin consentimiento explícito", async () => {
    const { repo, app } = makeApp();
    const courier = await repo.createCourier({ name: "Ana", phone: "+573000000010", nationalId: "573000000010" });

    const res = await request(app)
      .post(`/api/couriers/${courier.id}/face-reference`)
      .send({ descriptor: makeDescriptor(0.1), consent: false });

    expect(res.status).toBe(400);
    const stored = await repo.getCourier(courier.id);
    expect(stored?.faceDescriptor).toBeNull();
  });

  it("rechaza un descriptor con una longitud distinta a 128", async () => {
    const { repo, app } = makeApp();
    const courier = await repo.createCourier({ name: "Ana", phone: "+573000000011", nationalId: "573000000011" });

    const res = await request(app)
      .post(`/api/couriers/${courier.id}/face-reference`)
      .send({ descriptor: [1, 2, 3], consent: true });

    expect(res.status).toBe(400);
  });

  it("guarda el descriptor y la marca de consentimiento cuando todo es válido", async () => {
    const { repo, app } = makeApp();
    const courier = await repo.createCourier({ name: "Ana", phone: "+573000000012", nationalId: "573000000012" });

    const res = await request(app)
      .post(`/api/couriers/${courier.id}/face-reference`)
      .send({ descriptor: makeDescriptor(0.1), consent: true });

    expect(res.status).toBe(200);
    expect(res.body.courier.faceDescriptor).toHaveLength(FACE_DESCRIPTOR_LENGTH);
    expect(res.body.courier.faceConsentGivenAt).toBeTruthy();
  });

  it("404 si el domiciliario no existe", async () => {
    const { app } = makeApp();
    const res = await request(app)
      .post(`/api/couriers/no-existe/face-reference`)
      .send({ descriptor: makeDescriptor(0.1), consent: true });
    expect(res.status).toBe(404);
  });
});

describe("POST /api/couriers/:courierId/activate (con verificación facial)", () => {
  it("428 si el domiciliario no ha registrado su rostro de referencia", async () => {
    const { repo, app } = makeApp();
    const courier = await repo.createCourier({ name: "Ana", phone: "+573000000013", nationalId: "573000000013" });

    const res = await request(app)
      .post(`/api/couriers/${courier.id}/activate`)
      .send({ nationalId: courier.nationalId, faceDescriptor: makeDescriptor(0.1) });

    expect(res.status).toBe(428);
  });

  it("403 si la selfie en vivo no coincide con el rostro de referencia", async () => {
    const { repo, app } = makeApp();
    const courier = await repo.createCourier({ name: "Ana", phone: "+573000000014", nationalId: "573000000014" });
    await request(app)
      .post(`/api/couriers/${courier.id}/face-reference`)
      .send({ descriptor: makeDescriptor(0.1), consent: true });

    const res = await request(app)
      .post(`/api/couriers/${courier.id}/activate`)
      .send({ nationalId: courier.nationalId, faceDescriptor: makeDescriptor(5) });

    expect(res.status).toBe(403);
    expect(res.body.distance).toBeGreaterThan(res.body.threshold);
  });

  it("activa cuando la cédula y el rostro coinciden", async () => {
    const { repo, app } = makeApp();
    const courier = await repo.createCourier({ name: "Ana", phone: "+573000000015", nationalId: "573000000015" });
    await request(app)
      .post(`/api/couriers/${courier.id}/face-reference`)
      .send({ descriptor: makeDescriptor(0.1), consent: true });

    const res = await request(app)
      .post(`/api/couriers/${courier.id}/activate`)
      .send({ nationalId: courier.nationalId, faceDescriptor: makeDescriptor(0.1) });

    expect(res.status).toBe(200);
    expect(res.body.courier.isActive).toBe(true);
  });

  it("400 si falta el descriptor facial en la activación", async () => {
    const { repo, app } = makeApp();
    const courier = await repo.createCourier({ name: "Ana", phone: "+573000000016", nationalId: "573000000016" });

    const res = await request(app)
      .post(`/api/couriers/${courier.id}/activate`)
      .send({ nationalId: courier.nationalId });

    expect(res.status).toBe(400);
  });
});
