import { describe, expect, it } from "vitest";
import { PendingSettlementError, SettlementService } from "../src/domain/settlement";
import { InMemoryDispatchRepository } from "../src/testing/in-memory-repository";

async function deliverOrder(
  repo: InMemoryDispatchRepository,
  courierId: string,
  fare: number,
  deliveredAt: Date,
  extra?: { merchandiseValue?: number; paymentMode?: "DIRECT_TO_BUSINESS" | "BUSINESS_REIMBURSES_COURIER" | "COURIER_COLLECTS_ON_DELIVERY" }
) {
  const business = await repo.createBusiness({ name: "Negocio", phone: `+57300${Math.random()}` });
  const order = await repo.createOrder({
    businessId: business.id,
    pickup: { lat: 4.65, lng: -74.08 },
    pickupAddress: "A",
    dropoff: { lat: 4.66, lng: -74.09 },
    dropoffAddress: "B",
    fare,
    currency: "COP",
    merchandiseValue: extra?.merchandiseValue,
    paymentMode: extra?.paymentMode,
  });
  await repo.updateOrderStatus(order.id, "SEARCHING");
  await repo.tryAssignOrder(order.id, courierId);
  await repo.updateOrderStatus(order.id, "DELIVERED", { deliveredAt });
  return order;
}

describe("SettlementService.recomputeSettlement", () => {
  it("suma las tarifas de los pedidos entregados ese día y calcula la comisión con la tasa vigente", async () => {
    const repo = new InMemoryDispatchRepository();
    await repo.updatePlatformConfig({ commissionPercentage: 10 });
    const courier = await repo.createCourier({ name: "Ana", phone: "+573000000010", nationalId: "573000000010" });

    await deliverOrder(repo, courier.id, 5000, new Date("2026-01-10T12:00:00Z"));
    await deliverOrder(repo, courier.id, 7000, new Date("2026-01-10T18:00:00Z"));
    // De otro día: no debe contar.
    await deliverOrder(repo, courier.id, 100_000, new Date("2026-01-11T12:00:00Z"));

    const service = new SettlementService(repo);
    const settlement = await service.recomputeSettlement(courier.id, "2026-01-10");

    expect(settlement.serviceCount).toBe(2);
    expect(settlement.totalEarned).toBe(12_000);
    expect(settlement.commissionPercentage).toBe(10);
    expect(settlement.commissionAmount).toBe(1200);
    expect(settlement.status).toBe("PENDING");
  });

  it("la comisión se calcula solo sobre la tarifa del domicilio, nunca sobre el valor de la mercancía", async () => {
    const repo = new InMemoryDispatchRepository();
    await repo.updatePlatformConfig({ commissionPercentage: 10 });
    const courier = await repo.createCourier({ name: "Ana", phone: "+573000000011", nationalId: "573000000011" });

    // Mercancía de valor alto no debe inflar totalEarned ni la comisión —
    // es dinero de paso, no ingreso del domiciliario ni de la plataforma.
    await deliverOrder(repo, courier.id, 5000, new Date("2026-01-10T12:00:00Z"), {
      merchandiseValue: 200_000,
      paymentMode: "COURIER_COLLECTS_ON_DELIVERY",
    });
    await deliverOrder(repo, courier.id, 7000, new Date("2026-01-10T18:00:00Z"), {
      merchandiseValue: 50_000,
      paymentMode: "BUSINESS_REIMBURSES_COURIER",
    });

    const service = new SettlementService(repo);
    const settlement = await service.recomputeSettlement(courier.id, "2026-01-10");

    expect(settlement.totalEarned).toBe(12_000); // 5000 + 7000, no incluye mercancía
    expect(settlement.commissionAmount).toBe(1200); // 10% de 12000, no de 262000
  });

  it("congela la liquidación una vez pagada: entregas tardías del mismo día no la reabren", async () => {
    const repo = new InMemoryDispatchRepository();
    await repo.updatePlatformConfig({ commissionPercentage: 10 });
    const courier = await repo.createCourier({ name: "Ana", phone: "+573000000011", nationalId: "573000000011" });
    const service = new SettlementService(repo);

    await deliverOrder(repo, courier.id, 5000, new Date("2026-01-10T12:00:00Z"));
    await service.recomputeSettlement(courier.id, "2026-01-10");
    await service.markPaid(courier.id, "2026-01-10");

    // Llega una entrega tardía el mismo día, después de haber pagado.
    await deliverOrder(repo, courier.id, 9000, new Date("2026-01-10T23:00:00Z"));
    const settlement = await service.recomputeSettlement(courier.id, "2026-01-10");

    expect(settlement.status).toBe("PAID");
    expect(settlement.totalEarned).toBe(5000); // no incluyó la entrega tardía
  });

  it("usa la comisión vigente al momento del cálculo, no una futura", async () => {
    const repo = new InMemoryDispatchRepository();
    await repo.updatePlatformConfig({ commissionPercentage: 10 });
    const courier = await repo.createCourier({ name: "Ana", phone: "+573000000012", nationalId: "573000000012" });
    const service = new SettlementService(repo);

    await deliverOrder(repo, courier.id, 10_000, new Date("2026-01-10T12:00:00Z"));
    const first = await service.recomputeSettlement(courier.id, "2026-01-10");
    expect(first.commissionAmount).toBe(1000);

    await repo.updatePlatformConfig({ commissionPercentage: 20 });
    const second = await service.recomputeSettlement(courier.id, "2026-01-10");
    expect(second.commissionAmount).toBe(2000);
    expect(second.commissionPercentage).toBe(20);
  });
});

describe("SettlementService.canActivate", () => {
  it("permite activarse si no tiene liquidaciones pendientes", async () => {
    const repo = new InMemoryDispatchRepository();
    const courier = await repo.createCourier({ name: "Ana", phone: "+573000000013", nationalId: "573000000013" });
    const service = new SettlementService(repo);

    const result = await service.canActivate(courier.id, "2026-01-11");
    expect(result.allowed).toBe(true);
    expect(result.pending).toHaveLength(0);
  });

  it("bloquea si tiene comisión pendiente de un día anterior", async () => {
    const repo = new InMemoryDispatchRepository();
    const courier = await repo.createCourier({ name: "Ana", phone: "+573000000014", nationalId: "573000000014" });
    const service = new SettlementService(repo);

    await deliverOrder(repo, courier.id, 5000, new Date("2026-01-10T12:00:00Z"));
    await service.recomputeSettlement(courier.id, "2026-01-10");

    const result = await service.canActivate(courier.id, "2026-01-11");
    expect(result.allowed).toBe(false);
    expect(result.pending).toHaveLength(1);
    expect(result.pending[0].date).toBe("2026-01-10");
  });

  it("no bloquea por la liquidación del propio día en curso", async () => {
    const repo = new InMemoryDispatchRepository();
    const courier = await repo.createCourier({ name: "Ana", phone: "+573000000015", nationalId: "573000000015" });
    const service = new SettlementService(repo);

    await deliverOrder(repo, courier.id, 5000, new Date("2026-01-10T08:00:00Z"));
    await service.recomputeSettlement(courier.id, "2026-01-10");

    const result = await service.canActivate(courier.id, "2026-01-10");
    expect(result.allowed).toBe(true);
  });

  it("vuelve a permitir activarse una vez que paga la comisión pendiente", async () => {
    const repo = new InMemoryDispatchRepository();
    const courier = await repo.createCourier({ name: "Ana", phone: "+573000000016", nationalId: "573000000016" });
    const service = new SettlementService(repo);

    await deliverOrder(repo, courier.id, 5000, new Date("2026-01-10T12:00:00Z"));
    await service.recomputeSettlement(courier.id, "2026-01-10");
    expect((await service.canActivate(courier.id, "2026-01-11")).allowed).toBe(false);

    await service.markPaid(courier.id, "2026-01-10");
    expect((await service.canActivate(courier.id, "2026-01-11")).allowed).toBe(true);
  });

  it("un domiciliario no bloquea a otro", async () => {
    const repo = new InMemoryDispatchRepository();
    const courierA = await repo.createCourier({ name: "Ana", phone: "+573000000017", nationalId: "573000000017" });
    const courierB = await repo.createCourier({ name: "Beto", phone: "+573000000018", nationalId: "573000000018" });
    const service = new SettlementService(repo);

    await deliverOrder(repo, courierA.id, 5000, new Date("2026-01-10T12:00:00Z"));
    await service.recomputeSettlement(courierA.id, "2026-01-10");

    const result = await service.canActivate(courierB.id, "2026-01-11");
    expect(result.allowed).toBe(true);
  });
});

describe("SettlementService.markPaid", () => {
  it("lanza un error si intenta pagar una liquidación que no existe", async () => {
    const repo = new InMemoryDispatchRepository();
    const service = new SettlementService(repo);
    await expect(service.markPaid("no-existe", "2026-01-10")).rejects.toThrow();
  });
});

describe("SettlementService concurrencia", () => {
  it("dos recomputos concurrentes para el mismo día no duplican el conteo de servicios", async () => {
    const repo = new InMemoryDispatchRepository();
    const courier = await repo.createCourier({ name: "Ana", phone: "+573000000019", nationalId: "573000000019" });
    const service = new SettlementService(repo);

    await deliverOrder(repo, courier.id, 5000, new Date("2026-01-10T12:00:00Z"));
    await deliverOrder(repo, courier.id, 5000, new Date("2026-01-10T13:00:00Z"));

    const [a, b] = await Promise.all([
      service.recomputeSettlement(courier.id, "2026-01-10"),
      service.recomputeSettlement(courier.id, "2026-01-10"),
    ]);

    expect(a.serviceCount).toBe(2);
    expect(b.serviceCount).toBe(2);
  });
});

describe("PendingSettlementError", () => {
  it("incluye el detalle de las liquidaciones pendientes en el mensaje", () => {
    const err = new PendingSettlementError([
      {
        courierId: "c1",
        date: "2026-01-10",
        serviceCount: 2,
        totalEarned: 12_000,
        commissionPercentage: 10,
        commissionAmount: 1200,
        status: "PENDING",
        paidAt: null,
        updatedAt: new Date(),
      },
    ]);
    expect(err.message).toContain("2026-01-10");
    expect(err.message).toContain("1200");
  });
});
