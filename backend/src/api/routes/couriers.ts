import { Router } from "express";
import { z } from "zod";
import { CourierActivationService, CourierNotFoundError, InvalidActivationCredentialError } from "../../domain/courier-activation";
import { DispatchRepository } from "../../domain/repository";
import { PendingSettlementError } from "../../domain/settlement";
import { asyncHandler } from "../async-handler";

const locationSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

const activateSchema = z.object({
  nationalId: z.string().min(1),
});

const nearbyQuerySchema = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
  radiusMeters: z.coerce.number().positive().max(50_000).optional(),
});

const DEFAULT_MAP_RADIUS_METERS = 5_000;
const MAX_MAP_RESULTS = 50;

/**
 * Endpoints que consume la PWA del domiciliario: activarse con su número
 * de cédula (empieza a reportar ubicación y a recibir ofertas),
 * desactivarse, y reportar ubicación en vivo. También expone `/nearby`,
 * que consume el mapa del negocio (ver frontend/index.html) para mostrar
 * los domiciliarios activos cerca del punto de recogida antes de que se
 * asigne ninguno.
 */
export function createCouriersRouter(repo: DispatchRepository): Router {
  const router = Router();
  const activation = new CourierActivationService(repo);

  // Debe ir antes de "/:courierId": si no, Express interpretaría "nearby"
  // como un courierId y esta ruta nunca se alcanzaría.
  router.get(
    "/nearby",
    asyncHandler(async (req, res) => {
      const parsed = nearbyQuerySchema.safeParse(req.query);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

      const { lat, lng, radiusMeters } = parsed.data;
      const couriers = await repo.findActiveCouriersNear(
        { lat, lng },
        radiusMeters ?? DEFAULT_MAP_RADIUS_METERS,
        MAX_MAP_RESULTS
      );

      // Solo lo necesario para pintar puntos en un mapa — sin teléfono ni cédula.
      return res.json({
        couriers: couriers.map((c) => ({
          id: c.id,
          name: c.name,
          lat: c.lat,
          lng: c.lng,
          distanceMeters: c.distanceMeters,
        })),
      });
    })
  );

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
        const courier = await activation.activate(req.params.courierId, parsed.data.nationalId);
        return res.json({ courier });
      } catch (err) {
        if (err instanceof CourierNotFoundError) return res.status(404).json({ error: err.message });
        if (err instanceof InvalidActivationCredentialError) return res.status(403).json({ error: err.message });
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
