import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/api/app";
import { DispatchService } from "../src/domain/dispatch";
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
  return { repo, dispatch, app };
}

describe("GET /api/couriers/nearby", () => {
  it("devuelve solo domiciliarios activos dentro del radio, sin teléfono ni cédula", async () => {
    const repo = new InMemoryDispatchRepository();
    const { app } = makeApp(repo);

    const near = repo.seedCourier({ isActive: true, lat: 4.6533, lng: -74.0836, name: "Carlos" });
    repo.seedCourier({ isActive: false, lat: 4.654, lng: -74.084 }); // inactivo
    repo.seedCourier({ isActive: true, lat: 10, lng: -74 }); // muy lejos

    const res = await request(app).get("/api/couriers/nearby?lat=4.6533&lng=-74.0836");
    expect(res.status).toBe(200);
    expect(res.body.couriers).toHaveLength(1);
    expect(res.body.couriers[0]).toMatchObject({ id: near.id, name: "Carlos" });
    expect(res.body.couriers[0]).not.toHaveProperty("phone");
    expect(res.body.couriers[0]).not.toHaveProperty("nationalId");
  });

  it("rechaza coordenadas inválidas", async () => {
    const { app } = makeApp();
    const res = await request(app).get("/api/couriers/nearby?lat=999&lng=-74");
    expect(res.status).toBe(400);
  });

  it("respeta un radiusMeters explícito", async () => {
    const repo = new InMemoryDispatchRepository();
    const { app } = makeApp(repo);
    repo.seedCourier({ isActive: true, lat: 4.7, lng: -74.2 }); // ~25km

    const short = await request(app).get("/api/couriers/nearby?lat=4.6533&lng=-74.0836&radiusMeters=1000");
    expect(short.body.couriers).toHaveLength(0);

    const wide = await request(app).get(
      "/api/couriers/nearby?lat=4.6533&lng=-74.0836&radiusMeters=40000"
    );
    expect(wide.body.couriers).toHaveLength(1);
  });
});

describe("GET /api/orders/:orderId/courier-location", () => {
  it("devuelve null si el pedido todavía no tiene domiciliario asignado", async () => {
    const repo = new InMemoryDispatchRepository();
    const { app } = makeApp(repo);
    const business = await repo.createBusiness({ name: "Negocio", phone: "+573000000040" });
    const order = await repo.createOrder({
      businessId: business.id,
      pickup: { lat: 4.65, lng: -74.08 },
      pickupAddress: "A",
      dropoff: { lat: 4.66, lng: -74.09 },
      dropoffAddress: "B",
    });

    const res = await request(app).get(`/api/orders/${order.id}/courier-location`);
    expect(res.status).toBe(200);
    expect(res.body.location).toBeNull();
  });

  it("devuelve la ubicación del domiciliario una vez asignado, sin otros datos suyos", async () => {
    const repo = new InMemoryDispatchRepository();
    const { app } = makeApp(repo);
    const business = await repo.createBusiness({ name: "Negocio", phone: "+573000000041" });
    const courier = repo.seedCourier({ isActive: true, lat: 4.6, lng: -74.05, phone: "+573000000042" });
    const order = await repo.createOrder({
      businessId: business.id,
      pickup: { lat: 4.65, lng: -74.08 },
      pickupAddress: "A",
      dropoff: { lat: 4.66, lng: -74.09 },
      dropoffAddress: "B",
    });
    await repo.updateOrderStatus(order.id, "SEARCHING");
    await repo.tryAssignOrder(order.id, courier.id);

    const res = await request(app).get(`/api/orders/${order.id}/courier-location`);
    expect(res.status).toBe(200);
    expect(res.body.location).toMatchObject({ lat: 4.6, lng: -74.05 });
    expect(res.body.location).not.toHaveProperty("phone");
  });

  it("devuelve 200 con location null para un pedido que no existe (no filtra si existe o no)", async () => {
    const { app } = makeApp();
    const res = await request(app).get("/api/orders/no-existe/courier-location");
    expect(res.status).toBe(200);
    expect(res.body.location).toBeNull();
  });
});
