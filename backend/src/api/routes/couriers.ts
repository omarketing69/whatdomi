import { Router } from "express";
import { z } from "zod";
import { CourierActivationService, CourierNotFoundError, InvalidActivationCodeError } from "../../domain/courier-activation";
import { DispatchRepository } from "../../domain/repository";
import { PendingSettlementError } from "../../domain/settlement";
import { asyncHandler } from "../async-handler";

const locationSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

const activateSchema = z.object({
  activationCode: z.string().min(1),
});

/**
 * Endpoints que consume la PWA del domiciliario: activarse con el código
 * que se le entregó al registrarse (empieza a reportar ubicación y a
 * recibir ofertas), desactivarse, y reportar ubicación en vivo.
 */
export function createCouriersRouter(repo: DispatchRepository): Router {
  const router = Router();
  const activation = new CourierActivationService(repo);

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
    "/:courierId/activate",
    asyncHandler(async (req, res) => {
      const parsed = activateSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

      try {
        const courier = await activation.activate(req.params.courierId, parsed.data.activationCode);
        return res.json({ courier });
      } catch (err) {
        if (err instanceof CourierNotFoundError) return res.status(404).json({ error: err.message });
        if (err instanceof InvalidActivationCodeError) return res.status(403).json({ error: err.message });
        if (err instanceof PendingSettlementError) {
          return res.status(402).json({ error: err.message, pending: err.pending });
        }
        throw err;
      }
    })
  );

  router.post(
    "/:courierId/deactivate",
    asyncHandler(async (req, res) => {
      try {
        const courier = await activation.deactivate(req.params.courierId);
        return res.json({ courier });
      } catch (err) {
        if (err instanceof CourierNotFoundError) return res.status(404).json({ error: err.message });
        throw err;
      }
    })
  );

  return router;
}
