import { describe, expect, it } from "vitest";
import request from "supertest";
import { InMemoryDispatchRepository } from "../src/testing/in-memory-repository";
import { makeApp as makeAppWithDeps } from "./helpers/make-app";

/**
 * Seguimiento público (sin login) para el cliente final, por `orderId` —
 * ver frontend/track.js. Es la única ruta de `/api/orders/:id/*` sin
 * autenticación además de `courier-location`, así que estos tests
 * confirman explícitamente que NO se filtra nada del negocio/cliente/pago.
 */
function makeApp(repo = new InMemoryDispatchRepository()) {
  return makeAppWithDeps({ repo });
}

async function createOrder(repo: InMemoryDispatchRepository) {
  const business = await repo.createBusiness({ name: "Negocio", phone: "+573000000090" });
  return repo.createOrder({
    businessId: business.id,
    requesterName: "Ana la administradora",
    pickup: { lat: 4.65, lng: -74.08 },
    pickupAddress: "Sede del negocio",
    dropoff: { lat: 4.66, lng: -74.09 },
    dropoffAddress: "Casa del cliente",
    customerName: "Cliente Final",
    customerPhone: "+573000000091",
    notes: "Tocar el timbre dos veces",
    merchandiseValue: 50000,
    paymentMode: "COURIER_COLLECTS_ON_DELIVERY",
  });
}

describe("GET /api/orders/:orderId/track", () => {
  it("200 sin autenticación, con los campos mínimos y courier:null antes de asignar", async () => {
    const repo = new InMemoryDispatchRepository();
    const { app } = makeApp(repo);
    const order = await createOrder(repo);

    const res = await request(app).get(`/api/orders/${order.id}/track`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: "CREATED",
      pickupAddress: "Sede del negocio",
      dropoffAddress: "Casa del cliente",
      courier: null,
    });
    expect(res.body.createdAt).toBeTruthy();
  });

  it("nunca incluye datos del negocio, del cliente final, ni de pagos", async () => {
    const repo = new InMemoryDispatchRepository();
    const { app } = makeApp(repo);
    const order = await createOrder(repo);

    const res = await request(app).get(`/api/orders/${order.id}/track`);

    const body = JSON.stringify(res.body);
    expect(body).not.toContain(order.businessId);
    expect(res.body).not.toHaveProperty("businessId");
    expect(res.body).not.toHaveProperty("customerName");
    expect(res.body).not.toHaveProperty("customerPhone");
    expect(res.body).not.toHaveProperty("notes");
    expect(res.body).not.toHaveProperty("merchandiseValue");
    expect(res.body).not.toHaveProperty("paymentMode");
    expect(res.body).not.toHaveProperty("requesterName");
  });

  it("incluye nombre/placa/teléfono del domiciliario una vez asignado, sin cédula ni descriptor facial", async () => {
    const repo = new InMemoryDispatchRepository();
    const { app } = makeApp(repo);
    const order = await createOrder(repo);
    const courier = repo.seedCourier({
      isActive: true,
      lat: 4.651,
      lng: -74.081,
      name: "Carlos",
      phone: "+573000000092",
    });
    await repo.updateOrderStatus(order.id, "SEARCHING");
    await repo.tryAssignOrder(order.id, courier.id);

    const res = await request(app).get(`/api/orders/${order.id}/track`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ASSIGNED");
    expect(res.body.courier).toMatchObject({ name: "Carlos", phone: "+573000000092" });
    expect(res.body.courier).not.toHaveProperty("nationalId");
    expect(res.body.courier).not.toHaveProperty("faceDescriptor");
  });

  it("404 con un orderId que no existe, sin filtrar si existe o no otra información", async () => {
    const { app } = makeApp();
    const res = await request(app).get("/api/orders/no-existe/track");
    expect(res.status).toBe(404);
  });
});
