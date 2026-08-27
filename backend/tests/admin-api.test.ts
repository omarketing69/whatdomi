import { afterEach, describe, expect, it } from "vitest";
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

describe("guard de administración", () => {
  afterEach(() => {
    delete process.env.ADMIN_API_KEY;
  });

  it("sin ADMIN_API_KEY configurada, deja pasar (dev local)", async () => {
    const { app } = makeApp();
    const res = await request(app).get("/api/admin/config");
    expect(res.status).toBe(200);
  });

  it("con ADMIN_API_KEY configurada, rechaza sin la cabecera", async () => {
    process.env.ADMIN_API_KEY = "secreto";
    const { app } = makeApp();
    const res = await request(app).get("/api/admin/config");
    expect(res.status).toBe(401);
  });

  it("con ADMIN_API_KEY configurada, acepta con la cabecera correcta", async () => {
    process.env.ADMIN_API_KEY = "secreto";
    const { app } = makeApp();
    const res = await request(app).get("/api/admin/config").set("X-Admin-Key", "secreto");
    expect(res.status).toBe(200);
  });

  it("protege también el listado y el reasignado de /api/orders", async () => {
    process.env.ADMIN_API_KEY = "secreto";
    const { app } = makeApp();
    const list = await request(app).get("/api/orders");
    expect(list.status).toBe(401);

    const reassign = await request(app).post("/api/orders/no-existe/reassign");
    expect(reassign.status).toBe(401);
  });
});

describe("configuración de tarifas/comisión", () => {
  it("devuelve la configuración inicial", async () => {
    const { app } = makeApp();
    const res = await request(app).get("/api/admin/config");
    expect(res.status).toBe(200);
    expect(res.body.config).toMatchObject({ currency: "COP" });
  });

  it("permite al admin actualizar la comisión y la tarifa mínima", async () => {
    const { app } = makeApp();
    const res = await request(app)
      .put("/api/admin/config")
      .send({ commissionPercentage: 15, minFare: 4000 });

    expect(res.status).toBe(200);
    expect(res.body.config.commissionPercentage).toBe(15);
    expect(res.body.config.minFare).toBe(4000);
  });

  it("rechaza un porcentaje de comisión fuera de rango", async () => {
    const { app } = makeApp();
    const res = await request(app).put("/api/admin/config").send({ commissionPercentage: 150 });
    expect(res.status).toBe(400);
  });
});

describe("registro de servicios y liquidaciones", () => {
  it("lista los servicios entregados de un día con el nombre del domiciliario", async () => {
    const repo = new InMemoryDispatchRepository();
    const { app } = makeApp(repo);

    const business = await repo.createBusiness({ name: "Negocio", phone: "+573000000030" });
    const courier = await repo.createCourier({ name: "Carlos", phone: "+573000000031", nationalId: "573000000031" });
    const order = await repo.createOrder({
      businessId: business.id,
      pickup: { lat: 4.65, lng: -74.08 },
      pickupAddress: "Origen",
      dropoff: { lat: 4.66, lng: -74.09 },
      dropoffAddress: "Destino",
      fare: 6000,
      currency: "COP",
    });
    await repo.updateOrderStatus(order.id, "SEARCHING");
    await repo.tryAssignOrder(order.id, courier.id);
    await repo.updateOrderStatus(order.id, "DELIVERED", { deliveredAt: new Date("2026-02-01T15:00:00Z") });

    const res = await request(app).get("/api/admin/service-log?date=2026-02-01");
    expect(res.status).toBe(200);
    expect(res.body.services).toHaveLength(1);
    expect(res.body.services[0]).toMatchObject({
      courierName: "Carlos",
      fare: 6000,
      pickupAddress: "Origen",
      dropoffAddress: "Destino",
    });
  });

  it("permite pagar una liquidación pendiente", async () => {
    const repo = new InMemoryDispatchRepository();
    const { app } = makeApp(repo);
    const courier = await repo.createCourier({ name: "Carlos", phone: "+573000000032", nationalId: "573000000032" });
    await repo.upsertSettlement(courier.id, "2026-02-01", {
      serviceCount: 1,
      totalEarned: 5000,
      commissionPercentage: 10,
      commissionAmount: 500,
    });

    const res = await request(app).post(`/api/admin/settlements/${courier.id}/2026-02-01/pay`);
    expect(res.status).toBe(200);
    expect(res.body.settlement.status).toBe("PAID");
  });

  it("responde 404 al intentar pagar una liquidación que no existe", async () => {
    const { app } = makeApp();
    const res = await request(app).post("/api/admin/settlements/no-existe/2026-02-01/pay");
    expect(res.status).toBe(404);
  });
});

describe("estadísticas agregadas", () => {
  it("suma servicios y calcula la comisión total con la tasa vigente", async () => {
    const repo = new InMemoryDispatchRepository();
    await repo.updatePlatformConfig({ commissionPercentage: 10 });
    const { app } = makeApp(repo);

    const business = await repo.createBusiness({ name: "Negocio", phone: "+573000000033" });
    const courier = await repo.createCourier({ name: "Carlos", phone: "+573000000034", nationalId: "573000000034" });

    for (const fare of [5000, 7000]) {
      const order = await repo.createOrder({
        businessId: business.id,
        pickup: { lat: 4.65, lng: -74.08 },
        pickupAddress: "Origen",
        dropoff: { lat: 4.66, lng: -74.09 },
        dropoffAddress: "Destino",
        fare,
        currency: "COP",
      });
      await repo.updateOrderStatus(order.id, "SEARCHING");
      await repo.tryAssignOrder(order.id, courier.id);
      await repo.updateOrderStatus(order.id, "DELIVERED", { deliveredAt: new Date() });
    }

    const res = await request(app).get("/api/admin/stats?range=day");
    expect(res.status).toBe(200);
    expect(res.body.serviceCount).toBe(2);
    expect(res.body.totalRevenue).toBe(12_000);
    expect(res.body.totalCommission).toBe(1200);
  });
});
