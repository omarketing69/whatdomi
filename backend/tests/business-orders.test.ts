import { describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { GeocodeResult, GeocodingProvider, GeocodingService } from "../src/domain/geocoding";
import { NoopNormalizer, makeApp } from "./helpers/make-app";

const BUSINESS_ADDRESS: GeocodeResult = { lat: 4.65, lng: -74.08, formattedAddress: "Sede del negocio" };
const DROPOFF_ADDRESS: GeocodeResult = { lat: 4.66, lng: -74.09, formattedAddress: "Casa del cliente" };
const OVERRIDE_PICKUP_ADDRESS: GeocodeResult = { lat: 4.7, lng: -74.1, formattedAddress: "Otra sucursal" };

class MapProvider implements GeocodingProvider {
  constructor(private readonly byQuery: Map<string, GeocodeResult>) {}
  async geocode(query: string): Promise<GeocodeResult | null> {
    return this.byQuery.get(query) ?? null;
  }
}

function makeAppAndRegisteredBusiness() {
  const byQuery = new Map<string, GeocodeResult>([
    ["dirección del negocio", BUSINESS_ADDRESS],
    ["casa del cliente en el barrio X", DROPOFF_ADDRESS],
    ["otra sucursal del negocio", OVERRIDE_PICKUP_ADDRESS],
  ]);
  const geocoding = new GeocodingService(new NoopNormalizer(), new MapProvider(byQuery));
  const deps = makeApp({ geocoding });

  return { ...deps, byQuery };
}

async function registerBusiness(app: Express, email: string) {
  const res = await request(app).post("/api/auth/register").send({
    name: "Negocio de pruebas",
    phone: "+573000000099",
    email,
    password: "clave-super-secreta",
    address: "dirección del negocio",
  });
  return { token: res.body.token as string, business: res.body.business };
}

describe("POST /api/business/orders/quote", () => {
  it("401 sin token", async () => {
    const { app } = makeAppAndRegisteredBusiness();
    const res = await request(app).post("/api/business/orders/quote").send({ dropoffAddress: "cualquiera" });
    expect(res.status).toBe(401);
  });

  it("cotiza usando la ubicación registrada del negocio como recogida", async () => {
    const { app } = makeAppAndRegisteredBusiness();
    const { token } = await registerBusiness(app, "quote1@negocio.com");

    const res = await request(app)
      .post("/api/business/orders/quote")
      .set("Authorization", `Bearer ${token}`)
      .send({ dropoffAddress: "casa del cliente en el barrio X" });

    expect(res.status).toBe(201);
    expect(res.body.order.status).toBe("QUOTED");
    expect(res.body.order.pickupAddress).toBe(BUSINESS_ADDRESS.formattedAddress);
    expect(res.body.order.dropoffAddress).toBe(DROPOFF_ADDRESS.formattedAddress);
    expect(res.body.quote.fare).toBeGreaterThan(0);
  });

  it("permite sobreescribir la recogida para un pedido puntual", async () => {
    const { app } = makeAppAndRegisteredBusiness();
    const { token } = await registerBusiness(app, "quote2@negocio.com");

    const res = await request(app)
      .post("/api/business/orders/quote")
      .set("Authorization", `Bearer ${token}`)
      .send({ dropoffAddress: "casa del cliente en el barrio X", pickupAddress: "otra sucursal del negocio" });

    expect(res.status).toBe(201);
    expect(res.body.order.pickupAddress).toBe(OVERRIDE_PICKUP_ADDRESS.formattedAddress);
  });

  it("422 si no se pudo geocodificar la dirección de entrega", async () => {
    const { app } = makeAppAndRegisteredBusiness();
    const { token } = await registerBusiness(app, "quote3@negocio.com");

    const res = await request(app)
      .post("/api/business/orders/quote")
      .set("Authorization", `Bearer ${token}`)
      .send({ dropoffAddress: "una dirección inexistente" });

    expect(res.status).toBe(422);
  });
});

describe("POST /api/business/orders/:orderId/confirm", () => {
  it("confirma la cotización propia y arranca la búsqueda de domiciliario", async () => {
    const { app, repo } = makeAppAndRegisteredBusiness();
    const { token } = await registerBusiness(app, "confirm1@negocio.com");
    repo.seedCourier({ isActive: true, lat: 4.651, lng: -74.081 });

    const quoteRes = await request(app)
      .post("/api/business/orders/quote")
      .set("Authorization", `Bearer ${token}`)
      .send({ dropoffAddress: "casa del cliente en el barrio X" });
    const orderId = quoteRes.body.order.id;

    const confirmRes = await request(app)
      .post(`/api/business/orders/${orderId}/confirm`)
      .set("Authorization", `Bearer ${token}`);

    expect(confirmRes.status).toBe(200);
    expect(confirmRes.body.order.status).toBe("SEARCHING");
    expect(confirmRes.body.candidatesOffered).toBe(1);
  });

  it("403 si el pedido pertenece a otro negocio", async () => {
    const { app } = makeAppAndRegisteredBusiness();
    const { token: tokenA } = await registerBusiness(app, "ownerA@negocio.com");
    const { token: tokenB } = await registerBusiness(app, "ownerB@negocio.com");

    const quoteRes = await request(app)
      .post("/api/business/orders/quote")
      .set("Authorization", `Bearer ${tokenA}`)
      .send({ dropoffAddress: "casa del cliente en el barrio X" });
    const orderId = quoteRes.body.order.id;

    const confirmRes = await request(app)
      .post(`/api/business/orders/${orderId}/confirm`)
      .set("Authorization", `Bearer ${tokenB}`);

    expect(confirmRes.status).toBe(403);
  });

  it("404 con un orderId que no existe", async () => {
    const { app } = makeAppAndRegisteredBusiness();
    const { token } = await registerBusiness(app, "notfound@negocio.com");

    const res = await request(app)
      .post("/api/business/orders/no-existe/confirm")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(404);
  });
});
