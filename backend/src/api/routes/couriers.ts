import { Router } from "express";
import { z } from "zod";
import { DispatchRepository } from "../../domain/repository";
import { asyncHandler } from "../async-handler";

const locationSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

const activeSchema = z.object({
  isActive: z.boolean(),
});

/**
 * Endpoints que consume la app del domiciliario: reportar ubicación en vivo
 * y cambiar entre activo/inactivo (equivalente a "abrir/cerrar sesión" para
 * recibir pedidos).
 */
export function createCouriersRouter(repo: DispatchRepository): Router {
  const router = Router();

  router.get(
    "/:courierId",
    asyncHandler(async (req, res) => {
      const courier = await repo.getCourier(req.params.courierId);
      if (!courier) return res.status(404).json({ error: "Domiciliario no encontrado" });
      return res.json({ courier });
    })
  );

  router.post(
    "/:courierId/location",
    asyncHandler(async (req, res) => {
      const parsed = locationSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

      const courier = await repo.upsertCourierLocation(req.params.courierId, parsed.data);
      if (!courier) return res.status(404).json({ error: "Domiciliario no encontrado" });
      return res.json({ courier });
    })
  );

  router.post(
    "/:courierId/active",
    asyncHandler(async (req, res) => {
      const parsed = activeSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

      const courier = await repo.setCourierActive(req.params.courierId, parsed.data.isActive);
      if (!courier) return res.status(404).json({ error: "Domiciliario no encontrado" });
      return res.json({ courier });
    })
  );

  return router;
}
