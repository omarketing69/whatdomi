import { describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { GeocodeResult, GeocodingProvider, GeocodingService } from "../src/domain/geocoding";
import { FACE_DESCRIPTOR_LENGTH } from "../src/domain/face-verification";
import { InMemoryDispatchRepository } from "../src/testing/in-memory-repository";
import { NoopNormalizer, makeApp as makeAppWithDeps } from "./helpers/make-app";

/** A diferencia de `NoopProvider` (siempre `null`), este resuelve cualquier dirección — el registro de negocio necesita geocodificar su dirección para no fallar. */
class AlwaysResolveProvider implements GeocodingProvider {
  async geocode(query: string): Promise<GeocodeResult | null> {
    return { lat: 4.65, lng: -74.08, formattedAddress: query };
  }
}

/**
 * WD-001: antes, GET /:orderId, /courier-contact, /cancel, /accept,
 * /picked-up y /delivered no comprobaban quién los llamaba — cualquiera
 * que adivinara un orderId/courierId podía leer datos de otro negocio o
 * actuar "como" un domiciliario que no era. Estos tests prueban que ahora
 * sí se exige el token correcto y se rechaza el que no corresponde.
 */
function makeApp() {
  const geocoding = new GeocodingService(new NoopNormalizer(), new AlwaysResolveProvider());
  return makeAppWithDeps({ repo: new InMemoryDispatchRepository(), geocoding });
}

function makeDescriptor(fill: number): number[] {
  return Array(FACE_DESCRIPTOR_LENGTH).fill(fill);
}

async function registerBusiness(app: Express, email: string) {
  const res = await request(app).post("/api/auth/register").send({
    name: "Negocio de pruebas",
    phone: "+573000000060",
    email,
    password: "clave-super-secreta",
    address: "cualquiera",
  });
  return res.body.token as string;
}

/** Recorre el flujo real por HTTP (registro → rostro → activación) para obtener un token de sesión real. */
async function createActivatedCourier(app: Express, seed: { name: string; phone: string; nationalId: string }) {
  const { body: created } = await request(app).post("/api/couriers").send(seed);
  const descriptor = makeDescriptor(0.1);

  await request(app)
    .post(`/api/couriers/${created.courier.id}/face-reference`)
    .send({ descriptor, consent: true, nationalId: seed.nationalId });

  const { body: activated } = await request(app)
    .post(`/api/couriers/${created.courier.id}/activate`)
    .send({ nationalId: seed.nationalId, faceDescriptor: descriptor });

  return { courierId: created.courier.id as string, token: activated.token as string };
}

async function createSearchingOrder(repo: InMemoryDispatchRepository, businessId: string) {
  const order = await repo.createOrder({
    businessId,
    pickup: { lat: 4.6533, lng: -74.0836 },
    pickupAddress: "A",
    dropoff: { lat: 4.66, lng: -74.09 },
    dropoffAddress: "B",
  });
  await repo.updateOrderStatus(order.id, "SEARCHING");
  return order;
}

describe("GET /api/orders/:orderId", () => {
  it("401 sin token", async () => {
    const { app, repo } = makeApp();
    const business = await repo.createBusiness({ name: "Negocio", phone: "+573000000061" });
    const order = await createSearchingOrder(repo, business.id);

    const res = await request(app).get(`/api/orders/${order.id}`);
    expect(res.status).toBe(401);
  });

  it("403 si el pedido pertenece a otro negocio", async () => {
    const { app, repo } = makeApp();
    const business = await repo.createBusiness({ name: "Negocio", phone: "+573000000062" });
    const order = await createSearchingOrder(repo, business.id);
    const otherToken = await registerBusiness(app, "otro-orderid@negocio.com");

    const res = await request(app).get(`/api/orders/${order.id}`).set("Authorization", `Bearer ${otherToken}`);
    expect(res.status).toBe(403);
  });

  it("200 para el negocio dueño del pedido", async () => {
    const { app, repo } = makeApp();
    const token = await registerBusiness(app, "dueno-orderid@negocio.com");
    const businesses = await repo.getBusinessByEmail("dueno-orderid@negocio.com");
    const order = await createSearchingOrder(repo, businesses!.id);

    const res = await request(app).get(`/api/orders/${order.id}`).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.order.id).toBe(order.id);
  });
});

describe("GET /api/orders/:orderId/courier-contact", () => {
  it("401 sin token", async () => {
    const { app, repo } = makeApp();
    const business = await repo.createBusiness({ name: "Negocio", phone: "+573000000063" });
    const order = await createSearchingOrder(repo, business.id);

    const res = await request(app).get(`/api/orders/${order.id}/courier-contact`);
    expect(res.status).toBe(401);
  });

  it("403 si el pedido pertenece a otro negocio", async () => {
    const { app, repo } = makeApp();
    const business = await repo.createBusiness({ name: "Negocio", phone: "+573000000064" });
    const order = await createSearchingOrder(repo, business.id);
    const otherToken = await registerBusiness(app, "otro-contact@negocio.com");

    const res = await request(app)
      .get(`/api/orders/${order.id}/courier-contact`)
      .set("Authorization", `Bearer ${otherToken}`);
    expect(res.status).toBe(403);
  });
});

describe("POST /api/orders/:orderId/cancel", () => {
  it("con ADMIN_API_KEY configurada, exige token de negocio o la clave de admin", async () => {
    process.env.ADMIN_API_KEY = "secreto";
    try {
      const { app, repo } = makeApp();
      const business = await repo.createBusiness({ name: "Negocio", phone: "+573000000065" });
      const order = await createSearchingOrder(repo, business.id);

      const noAuth = await request(app).post(`/api/orders/${order.id}/cancel`);
      expect(noAuth.status).toBe(401);

      const withAdminKey = await request(app)
        .post(`/api/orders/${order.id}/cancel`)
        .set("X-Admin-Key", "secreto");
      expect(withAdminKey.status).toBe(200);
    } finally {
      delete process.env.ADMIN_API_KEY;
    }
  });

  it("403 si el token de negocio no es el dueño del pedido", async () => {
    // Sin ADMIN_API_KEY configurada, la ruta deja pasar por la vía de
    // admin (mismo criterio "dev-friendly" de requireAdminKey) — hay que
    // configurarla para forzar la rama de "token de negocio dueño".
    process.env.ADMIN_API_KEY = "secreto";
    try {
      const { app, repo } = makeApp();
      const business = await repo.createBusiness({ name: "Negocio", phone: "+573000000066" });
      const order = await createSearchingOrder(repo, business.id);
      const otherToken = await registerBusiness(app, "otro-cancel@negocio.com");

      const res = await request(app)
        .post(`/api/orders/${order.id}/cancel`)
        .set("Authorization", `Bearer ${otherToken}`);
      expect(res.status).toBe(403);
      const stillSearching = await repo.getOrder(order.id);
      expect(stillSearching?.status).toBe("SEARCHING");
    } finally {
      delete process.env.ADMIN_API_KEY;
    }
  });

  it("200 para el negocio dueño del pedido", async () => {
    const { app, repo } = makeApp();
    const token = await registerBusiness(app, "dueno-cancel@negocio.com");
    const business = await repo.getBusinessByEmail("dueno-cancel@negocio.com");
    const order = await createSearchingOrder(repo, business!.id);

    const res = await request(app).post(`/api/orders/${order.id}/cancel`).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.order.status).toBe("CANCELLED");
  });
});

describe("POST /api/orders/:orderId/accept", () => {
  it("401 sin token de sesión de domiciliario", async () => {
    const { app, repo } = makeApp();
    const business = await repo.createBusiness({ name: "Negocio", phone: "+573000000067" });
    const order = await createSearchingOrder(repo, business.id);

    const res = await request(app).post(`/api/orders/${order.id}/accept`).send({ courierId: "cualquiera" });
    expect(res.status).toBe(401);
  });

  it("asigna al domiciliario dueño del token, ignorando cualquier courierId del body", async () => {
    const { app, repo } = makeApp();
    const business = await repo.createBusiness({ name: "Negocio", phone: "+573000000068" });
    const order = await createSearchingOrder(repo, business.id);
    const real = await createActivatedCourier(app, {
      name: "Carlos",
      phone: "+573000000069",
      nationalId: "573000000069",
    });

    const res = await request(app)
      .post(`/api/orders/${order.id}/accept`)
      .set("Authorization", `Bearer ${real.token}`)
      .send({ courierId: "otro-domiciliario-inventado" });

    expect(res.status).toBe(200);
    expect(res.body.order.courierId).toBe(real.courierId);
  });
});

describe("POST /api/orders/:orderId/picked-up y /delivered", () => {
  it("403 si el token pertenece a un domiciliario distinto al asignado", async () => {
    const { app, repo } = makeApp();
    const business = await repo.createBusiness({ name: "Negocio", phone: "+573000000071" });
    const order = await createSearchingOrder(repo, business.id);
    const assigned = await createActivatedCourier(app, {
      name: "Carlos",
      phone: "+573000000072",
      nationalId: "573000000072",
    });
    const impostor = await createActivatedCourier(app, {
      name: "Otro",
      phone: "+573000000073",
      nationalId: "573000000073",
    });

    await request(app)
      .post(`/api/orders/${order.id}/accept`)
      .set("Authorization", `Bearer ${assigned.token}`)
      .send({});

    const res = await request(app)
      .post(`/api/orders/${order.id}/picked-up`)
      .set("Authorization", `Bearer ${impostor.token}`);
    expect(res.status).toBe(403);
  });

  it("200 para el domiciliario asignado, recorriendo recogido -> entregado", async () => {
    const { app, repo } = makeApp();
    const business = await repo.createBusiness({ name: "Negocio", phone: "+573000000074" });
    const order = await createSearchingOrder(repo, business.id);
    const assigned = await createActivatedCourier(app, {
      name: "Carlos",
      phone: "+573000000075",
      nationalId: "573000000075",
    });

    await request(app)
      .post(`/api/orders/${order.id}/accept`)
      .set("Authorization", `Bearer ${assigned.token}`)
      .send({});

    const pickedUp = await request(app)
      .post(`/api/orders/${order.id}/picked-up`)
      .set("Authorization", `Bearer ${assigned.token}`);
    expect(pickedUp.status).toBe(200);
    expect(pickedUp.body.order.status).toBe("IN_PROGRESS");

    const delivered = await request(app)
      .post(`/api/orders/${order.id}/delivered`)
      .set("Authorization", `Bearer ${assigned.token}`);
    expect(delivered.status).toBe(200);
    expect(delivered.body.order.status).toBe("DELIVERED");
  });
});

describe("rutas del propio domiciliario (GET /:courierId, /deactivate, /location)", () => {
  it("401 sin token en las tres", async () => {
    const { app, repo } = makeApp();
    const courier = repo.seedCourier({ isActive: false });

    expect((await request(app).get(`/api/couriers/${courier.id}`)).status).toBe(401);
    expect((await request(app).post(`/api/couriers/${courier.id}/deactivate`)).status).toBe(401);
    expect(
      (await request(app).post(`/api/couriers/${courier.id}/location`).send({ lat: 4.6, lng: -74.1 })).status
    ).toBe(401);
  });

  it("403 si el token es de otro domiciliario", async () => {
    const { app } = makeApp();
    const owner = await createActivatedCourier(app, {
      name: "Carlos",
      phone: "+573000000076",
      nationalId: "573000000076",
    });
    const someoneElse = await createActivatedCourier(app, {
      name: "Otro",
      phone: "+573000000077",
      nationalId: "573000000077",
    });

    const getRes = await request(app)
      .get(`/api/couriers/${owner.courierId}`)
      .set("Authorization", `Bearer ${someoneElse.token}`);
    expect(getRes.status).toBe(403);

    const deactivateRes = await request(app)
      .post(`/api/couriers/${owner.courierId}/deactivate`)
      .set("Authorization", `Bearer ${someoneElse.token}`);
    expect(deactivateRes.status).toBe(403);

    const locationRes = await request(app)
      .post(`/api/couriers/${owner.courierId}/location`)
      .set("Authorization", `Bearer ${someoneElse.token}`)
      .send({ lat: 4.6, lng: -74.1 });
    expect(locationRes.status).toBe(403);
  });

  it("200 cuando el domiciliario actúa sobre sí mismo", async () => {
    const { app } = makeApp();
    const owner = await createActivatedCourier(app, {
      name: "Carlos",
      phone: "+573000000078",
      nationalId: "573000000078",
    });

    const getRes = await request(app)
      .get(`/api/couriers/${owner.courierId}`)
      .set("Authorization", `Bearer ${owner.token}`);
    expect(getRes.status).toBe(200);

    const locationRes = await request(app)
      .post(`/api/couriers/${owner.courierId}/location`)
      .set("Authorization", `Bearer ${owner.token}`)
      .send({ lat: 4.6, lng: -74.1 });
    expect(locationRes.status).toBe(200);

    const deactivateRes = await request(app)
      .post(`/api/couriers/${owner.courierId}/deactivate`)
      .set("Authorization", `Bearer ${owner.token}`);
    expect(deactivateRes.status).toBe(200);
  });
});
