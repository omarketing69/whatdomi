import { describe, expect, it } from "vitest";
import request from "supertest";
import { GeocodeResult, GeocodingProvider, GeocodingService } from "../src/domain/geocoding";
import { InMemoryDispatchRepository } from "../src/testing/in-memory-repository";
import { NoopNormalizer, makeApp } from "./helpers/make-app";

/**
 * `merchandiseValue`/`paymentMode` cubren 3 costumbres distintas de cobro
 * de la mercancía (aparte de la tarifa del domicilio), todas opcionales
 * por pedido — ver docs/ARCHITECTURE.md §6 y `PaymentMode` en types.ts.
 */
describe("Order.merchandiseValue / paymentMode (dominio)", () => {
  it("por defecto (sin especificar) quedan en null — escenario 1: el cliente le paga directo al negocio", async () => {
    const repo = new InMemoryDispatchRepository();
    const business = await repo.createBusiness({ name: "Negocio", phone: "+573000000060" });
    const order = await repo.createOrder({
      businessId: business.id,
      pickup: { lat: 4.65, lng: -74.08 },
      pickupAddress: "A",
      dropoff: { lat: 4.66, lng: -74.09 },
      dropoffAddress: "B",
      fare: 5000,
      currency: "COP",
    });
    expect(order.merchandiseValue).toBeNull();
    expect(order.paymentMode).toBeNull();
  });

  it("escenario 2: BUSINESS_REIMBURSES_COURIER se guarda con su valor de mercancía", async () => {
    const repo = new InMemoryDispatchRepository();
    const business = await repo.createBusiness({ name: "Negocio", phone: "+573000000061" });
    const order = await repo.createOrder({
      businessId: business.id,
      pickup: { lat: 4.65, lng: -74.08 },
      pickupAddress: "A",
      dropoff: { lat: 4.66, lng: -74.09 },
      dropoffAddress: "B",
      fare: 5000,
      currency: "COP",
      merchandiseValue: 45_000,
      paymentMode: "BUSINESS_REIMBURSES_COURIER",
    });
    expect(order.merchandiseValue).toBe(45_000);
    expect(order.paymentMode).toBe("BUSINESS_REIMBURSES_COURIER");
  });

  it("escenario 3: COURIER_COLLECTS_ON_DELIVERY se guarda con su valor de mercancía", async () => {
    const repo = new InMemoryDispatchRepository();
    const business = await repo.createBusiness({ name: "Negocio", phone: "+573000000062" });
    const order = await repo.createOrder({
      businessId: business.id,
      pickup: { lat: 4.65, lng: -74.08 },
      pickupAddress: "A",
      dropoff: { lat: 4.66, lng: -74.09 },
      dropoffAddress: "B",
      fare: 5000,
      currency: "COP",
      merchandiseValue: 60_000,
      paymentMode: "COURIER_COLLECTS_ON_DELIVERY",
    });
    expect(order.merchandiseValue).toBe(60_000);
    expect(order.paymentMode).toBe("COURIER_COLLECTS_ON_DELIVERY");
  });
});

const BUSINESS_ADDRESS: GeocodeResult = { lat: 4.65, lng: -74.08, formattedAddress: "Sede del negocio" };
const DROPOFF_ADDRESS: GeocodeResult = { lat: 4.66, lng: -74.09, formattedAddress: "Casa del cliente" };

class MapProvider implements GeocodingProvider {
  constructor(private readonly byQuery: Map<string, GeocodeResult>) {}
  async geocode(query: string): Promise<GeocodeResult | null> {
    return this.byQuery.get(query) ?? null;
  }
}

function makeAppWithGeocoding() {
  const byQuery = new Map<string, GeocodeResult>([
    ["dirección del negocio", BUSINESS_ADDRESS],
    ["casa del cliente", DROPOFF_ADDRESS],
  ]);
  const geocoding = new GeocodingService(new NoopNormalizer(), new MapProvider(byQuery));
  return makeApp({ geocoding });
}

describe("POST /api/business/orders/quote con valor de mercancía", () => {
  it("acepta y devuelve merchandiseValue/paymentMode cuando se especifican", async () => {
    const { app } = makeAppWithGeocoding();
    const registerRes = await request(app).post("/api/auth/register").send({
      name: "Negocio de pruebas",
      phone: "+573000000063",
      email: "mercancia1@negocio.com",
      password: "clave-super-secreta",
      address: "dirección del negocio",
    });
    const token = registerRes.body.token;

    const res = await request(app)
      .post("/api/business/orders/quote")
      .set("Authorization", `Bearer ${token}`)
      .send({ dropoffAddress: "casa del cliente", merchandiseValue: 45000, paymentMode: "COURIER_COLLECTS_ON_DELIVERY" });

    expect(res.status).toBe(201);
    expect(res.body.order.merchandiseValue).toBe(45000);
    expect(res.body.order.paymentMode).toBe("COURIER_COLLECTS_ON_DELIVERY");
  });

  it("sin especificarlos, el pedido queda sin valor de mercancía (escenario por defecto)", async () => {
    const { app } = makeAppWithGeocoding();
    const registerRes = await request(app).post("/api/auth/register").send({
      name: "Negocio de pruebas",
      phone: "+573000000064",
      email: "mercancia2@negocio.com",
      password: "clave-super-secreta",
      address: "dirección del negocio",
    });
    const token = registerRes.body.token;

    const res = await request(app)
      .post("/api/business/orders/quote")
      .set("Authorization", `Bearer ${token}`)
      .send({ dropoffAddress: "casa del cliente" });

    expect(res.status).toBe(201);
    expect(res.body.order.merchandiseValue).toBeNull();
    expect(res.body.order.paymentMode).toBeNull();
  });

  it("400 con un paymentMode que no es uno de los 3 valores válidos", async () => {
    const { app } = makeAppWithGeocoding();
    const registerRes = await request(app).post("/api/auth/register").send({
      name: "Negocio de pruebas",
      phone: "+573000000065",
      email: "mercancia3@negocio.com",
      password: "clave-super-secreta",
      address: "dirección del negocio",
    });
    const token = registerRes.body.token;

    const res = await request(app)
      .post("/api/business/orders/quote")
      .set("Authorization", `Bearer ${token}`)
      .send({ dropoffAddress: "casa del cliente", paymentMode: "ALGO_INVENTADO" });

    expect(res.status).toBe(400);
  });
});
