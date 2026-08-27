import { NextFunction, Request, Response, Router } from "express";
import { z } from "zod";
import { isoDate } from "../../domain/date";
import { DispatchRepository } from "../../domain/repository";
import { SettlementNotFoundError, SettlementService } from "../../domain/settlement";
import { asyncHandler } from "../async-handler";

/**
 * Protege /api/admin/*: el admin es el único de los 3 roles que toca
 * dinero de la plataforma (tarifas, comisión, ver cuánto le debe cada
 * domiciliario), así que necesita algo más que "no hay verificación" —
 * a diferencia de negocio/domiciliario, que sí operan sin cuenta en este
 * MVP (ver docs/ARCHITECTURE.md §2). No es un login completo: es una
 * clave compartida por cabecera, suficiente para no dejar el panel
 * abierto a cualquiera en internet.
 *
 * Sin ADMIN_API_KEY configurada, el panel queda abierto — aceptable solo
 * para desarrollo local; en `.env.example` se documenta como obligatorio
 * para cualquier despliegue real.
 */
export function requireAdminKey(req: Request, res: Response, next: NextFunction): void {
  const expected = process.env.ADMIN_API_KEY;
  if (!expected) {
    next();
    return;
  }
  if (req.header("x-admin-key") !== expected) {
    res.status(401).json({ error: "Falta o es inválida la cabecera X-Admin-Key" });
    return;
  }
  next();
}

const surchargeSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  active: z.boolean(),
});

const updateConfigSchema = z.object({
  baseFare: z.number().nonnegative().optional(),
  pricePerKm: z.number().nonnegative().optional(),
  minFare: z.number().nonnegative().optional(),
  commissionPercentage: z.number().min(0).max(100).optional(),
  currency: z.string().min(1).optional(),
  surcharges: z.array(surchargeSchema).optional(),
});

function queryDate(req: Request): string {
  return typeof req.query.date === "string" ? req.query.date : isoDate(new Date());
}

export function createAdminRouter(repo: DispatchRepository): Router {
  const router = Router();
  const settlements = new SettlementService(repo);
  router.use(requireAdminKey);

  router.get(
    "/config",
    asyncHandler(async (_req, res) => {
      const config = await repo.getPlatformConfig();
      res.json({ config });
    })
  );

  router.put(
    "/config",
    asyncHandler(async (req, res) => {
      const parsed = updateConfigSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.flatten() });
        return;
      }
      const config = await repo.updatePlatformConfig(parsed.data);
      res.json({ config });
    })
  );

  /** Servicios entregados en un día (quién, cuánto, origen/destino, hora). */
  router.get(
    "/service-log",
    asyncHandler(async (req, res) => {
      const date = queryDate(req);
      const orders = await repo.listDeliveredOrders({ date });

      const courierIds = Array.from(new Set(orders.map((o) => o.courierId).filter((id): id is string => !!id)));
      const couriers = await Promise.all(courierIds.map((id) => repo.getCourier(id)));
      const nameById = new Map(couriers.filter((c) => c !== null).map((c) => [c!.id, c!.name]));

      res.json({
        date,
        services: orders.map((order) => ({
          orderId: order.id,
          courierId: order.courierId,
          courierName: order.courierId ? nameById.get(order.courierId) ?? null : null,
          pickupAddress: order.pickupAddress,
          dropoffAddress: order.dropoffAddress,
          fare: order.fare,
          currency: order.currency,
          deliveredAt: order.deliveredAt,
        })),
      });
    })
  );

  /** Totales por domiciliario en un día: servicios, cobrado, comisión, si ya liquidó. */
  router.get(
    "/settlements",
    asyncHandler(async (req, res) => {
      const date = queryDate(req);
      const rows = await repo.listSettlements({ date });
      const couriers = await Promise.all(rows.map((s) => repo.getCourier(s.courierId)));

      res.json({
        date,
        settlements: rows.map((s, i) => ({ ...s, courierName: couriers[i]?.name ?? null })),
      });
    })
  );

  /** Acción manual/offline: el admin marca que un domiciliario ya pagó la comisión de ese día. */
  router.post(
    "/settlements/:courierId/:date/pay",
    asyncHandler(async (req, res) => {
      try {
        const settlement = await settlements.markPaid(req.params.courierId, req.params.date);
        res.json({ settlement });
      } catch (err) {
        if (err instanceof SettlementNotFoundError) {
          res.status(404).json({ error: err.message });
          return;
        }
        throw err;
      }
    })
  );

  /** Vista agregada básica: total de servicios e ingresos por comisión del día o de la última semana. */
  router.get(
    "/stats",
    asyncHandler(async (req, res) => {
      const range = req.query.range === "week" ? "week" : "day";
      const today = new Date();
      const to = isoDate(today);
      const from = range === "week" ? isoDate(new Date(today.getTime() - 6 * 86_400_000)) : to;

      const [{ serviceCount, totalRevenue }, config] = await Promise.all([
        repo.getServiceStats(from, to),
        repo.getPlatformConfig(),
      ]);
      // Aproximación: aplica la tasa de comisión VIGENTE a todo el rango.
      // El monto de comisión "de verdad" por día es el que quedó congelado
      // en cada liquidación (ver /settlements); esto es solo para una
      // vista agregada rápida, no para cobrar nada.
      const totalCommission = Math.round((totalRevenue * config.commissionPercentage) / 100);

      res.json({ range, from, to, serviceCount, totalRevenue, totalCommission, currency: config.currency });
    })
  );

  return router;
}
