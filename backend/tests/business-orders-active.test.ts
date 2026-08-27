import { describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { GeocodeResult, GeocodingProvider, GeocodingService } from "../src/domain/geocoding";
import { NoopNormalizer, makeApp } from "./helpers/make-app";

/**
 * `currentOrderId` en el dashboard solo vive en memoria del navegador: un
 * refresh de página lo pierde. `GET /api/business/orders/active` es lo
 * que le permite al dashboard reconstruir su vista al cargar — ver
 * frontend/dashboard.js `restoreActiveOrder`.
 */
const BUSINESS_ADDRESS: GeocodeResult = { lat: 4.65, lng: -74.08, formattedAddress: "Sede del negocio" };
const DROPOFF_ADDRESS: GeocodeResult = { lat: 4.66, lng: -74.09, formattedAddress: "Casa del cliente" };

class MapProvider implements GeocodingProvider {
  constructor(private readonly byQuery: Map<string, GeocodeResult>) {}
  async geocode(query: string): Promise<GeocodeResult | null> {
    return this.byQuery.get(query) ?? null;
  }
}

function makeAppAndGeocoding() {
  const byQuery = new Map<string, GeocodeResult>([
    ["dirección del negocio", BUSINESS_ADDRESS],
    ["casa del cliente", DROPOFF_ADDRESS],
  ]);
  const geocoding = new GeocodingService(new NoopNormalizer(), new MapProvider(byQuery));
  return makeApp({ geocoding });
}

async function registerBusiness(app: Express, email: string) {
  const res = await request(app).post("/api/auth/register").send({
    name: "Negocio de pruebas",
    phone: "+573000000070",
    email,
    password: "clave-super-secreta",
    address: "dirección del negocio",
  });
  return res.body.token as string;
}

describe("GET /api/business/orders/active", () => {
  it("401 sin token", async () => {
    const { app } = makeAppAndGeocoding();
    const res = await request(app).get("/api/business/orders/active");
    expect(res.status).toBe(401);
  });

  it("devuelve { order: null } si el negocio no tiene ningún pedido en curso", async () => {
    const { app } = makeAppAndGeocoding();
    const token = await registerBusiness(app, "sinactivo@negocio.com");

    const res = await request(app).get("/api/business/orders/active").set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.order).toBeNull();
  });

  it("devuelve el pedido QUOTED junto con un quote reconstruido", async () => {
    const { app } = makeAppAndGeocoding();
    const token = await registerBusiness(app, "quotado@negocio.com");

    const quoteRes = await request(app)
      .post("/api/business/orders/quote")
      .set("Authorization", `Bearer ${token}`)
      .send({ dropoffAddress: "casa del cliente" });

    const res = await request(app).get("/api/business/orders/active").set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.order.id).toBe(quoteRes.body.order.id);
    expect(res.body.order.status).toBe("QUOTED");
    expect(res.body.quote.fare).toBe(quoteRes.body.quote.fare);
    expect(res.body.quote.currency).toBe(quoteRes.body.quote.currency);
  });

  it("devuelve el pedido tras confirmar (SEARCHING)", async () => {
    const { app, repo } = makeAppAndGeocoding();
    const token = await registerBusiness(app, "buscando@negocio.com");
    repo.seedCourier({ isActive: true, lat: 4.651, lng: -74.081 });

    const quoteRes = await request(app)
      .post("/api/business/orders/quote")
      .set("Authorization", `Bearer ${token}`)
      .send({ dropoffAddress: "casa del cliente" });
    await request(app)
      .post(`/api/business/orders/${quoteRes.body.order.id}/confirm`)
      .set("Authorization", `Bearer ${token}`);

    const res = await request(app).get("/api/business/orders/active").set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.order.status).toBe("SEARCHING");
  });

  it("ignora pedidos ya entregados o cancelados", async () => {
    const { app, repo } = makeAppAndGeocoding();
    const token = await registerBusiness(app, "entregado@negocio.com");

    const quoteRes = await request(app)
      .post("/api/business/orders/quote")
      .set("Authorization", `Bearer ${token}`)
      .send({ dropoffAddress: "casa del cliente" });
    await repo.updateOrderStatus(quoteRes.body.order.id, "DELIVERED", { deliveredAt: new Date() });

    const res = await request(app).get("/api/business/orders/active").set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.order).toBeNull();
  });

  it("distingue entre negocios: no ve el pedido activo de otro negocio", async () => {
    const { app } = makeAppAndGeocoding();
    const tokenA = await registerBusiness(app, "negocioA@negocio.com");
    const tokenB = await registerBusiness(app, "negocioB@negocio.com");

    await request(app)
      .post("/api/business/orders/quote")
      .set("Authorization", `Bearer ${tokenA}`)
      .send({ dropoffAddress: "casa del cliente" });

    const res = await request(app).get("/api/business/orders/active").set("Authorization", `Bearer ${tokenB}`);

    expect(res.status).toBe(200);
    expect(res.body.order).toBeNull();
  });
});
