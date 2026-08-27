import { Router } from "express";
import { z } from "zod";
import {
  CourierActivationService,
  CourierNotFoundError,
  FaceReferenceMissingError,
  FaceVerificationFailedError,
  InvalidActivationCredentialError,
} from "../../domain/courier-activation";
import { CourierTokenSigner } from "../../domain/courier-session";
import { FACE_DESCRIPTOR_LENGTH } from "../../domain/face-verification";
import { DispatchService } from "../../domain/dispatch";
import { DispatchRepository } from "../../domain/repository";
import { PendingSettlementError } from "../../domain/settlement";
import { asyncHandler } from "../async-handler";
import { CourierAuthedRequest, requireCourierAuth } from "../courier-auth-middleware";

const locationSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

const faceDescriptorSchema = z.array(z.number()).length(FACE_DESCRIPTOR_LENGTH);

const activateSchema = z.object({
  nationalId: z.string().min(1),
  faceDescriptor: faceDescriptorSchema,
});

const faceReferenceSchema = z.object({
  descriptor: faceDescriptorSchema,
  /** Consentimiento explícito (checkbox) para capturar/procesar su rostro; sin esto, se rechaza. */
  consent: z.literal(true),
  /**
   * Todavía no existe un token de sesión en este punto del flujo (es
   * anterior a la primera activación) — la cédula hace las veces de
   * credencial para probar que quien registra/reemplaza el rostro de
   * referencia es el propio domiciliario, no cualquiera que adivine o
   * conozca su `courierId`.
   */
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
export function createCouriersRouter(
  repo: DispatchRepository,
  dispatch: DispatchService,
  tokens: CourierTokenSigner
): Router {
  const router = Router();
  const activation = new CourierActivationService(repo, tokens);

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

  /**
   * Solo el propio domiciliario puede ver su registro completo (incluye
   * cédula y descriptor facial, datos sensibles) — antes cualquiera que
   * adivinara un `courierId` lo veía sin autenticarse.
   */
  router.get(
    "/:courierId",
    requireCourierAuth(tokens),
    asyncHandler(async (req, res) => {
      if ((req as CourierAuthedRequest).courierId !== req.params.courierId) {
        return res.status(403).json({ error: "No puedes ver los datos de otro domiciliario" });
      }
      const courier = await repo.getCourier(req.params.courierId);
      if (!courier) return res.status(404).json({ error: "Domiciliario no encontrado" });
      return res.json({ courier });
    })
  );

  /**
   * Registra (o reemplaza) el rostro de referencia del domiciliario: el
   * descriptor de 128 números ya fue extraído client-side por face-api.js
   * a partir de su selfie — aquí solo se guarda, junto con la marca de
   * tiempo del consentimiento explícito (checkbox), nunca la foto. Pasa
   * en un momento en que todavía no hay token de sesión (es previo a la
   * primera activación), así que la cédula hace de credencial: sin ella
   * cualquiera que supiera el `courierId` podía sobreescribir el rostro
   * de referencia de otro domiciliario y luego "activarse" como él.
   */
  router.post(
    "/:courierId/face-reference",
    asyncHandler(async (req, res) => {
      const parsed = faceReferenceSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

      const courier = await repo.getCourier(req.params.courierId);
      if (!courier) return res.status(404).json({ error: "Domiciliario no encontrado" });
      if (courier.nationalId !== parsed.data.nationalId) {
        return res.status(403).json({ error: "Número de cédula incorrecto" });
      }

      const updated = await repo.setCourierFaceReference(
        req.params.courierId,
        parsed.data.descriptor,
        new Date()
      );
      return res.json({ courier: updated });
    })
  );

  router.post(
    "/:courierId/location",
    requireCourierAuth(tokens),
    asyncHandler(async (req, res) => {
      if ((req as CourierAuthedRequest).courierId !== req.params.courierId) {
        return res.status(403).json({ error: "No puedes reportar ubicación por otro domiciliario" });
      }
      const parsed = locationSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

      // También intenta el cierre automático por geocerca si este domiciliario
      // tiene un pedido IN_PROGRESS y esta posición ya está cerca del destino
      // (ver DispatchService.reportCourierLocation) — best-effort, nunca
      // bloquea el guardado de la ubicación en sí.
      const courier = await dispatch.reportCourierLocation(req.params.courierId, parsed.data);
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
        const { courier, token } = await activation.activate(
          req.params.courierId,
          parsed.data.nationalId,
          parsed.data.faceDescriptor
        );
        return res.json({ courier, token });
      } catch (err) {
        if (err instanceof CourierNotFoundError) return res.status(404).json({ error: err.message });
        if (err instanceof InvalidActivationCredentialError) return res.status(403).json({ error: err.message });
        if (err instanceof FaceReferenceMissingError) return res.status(428).json({ error: err.message });
        if (err instanceof FaceVerificationFailedError) {
          return res.status(403).json({ error: err.message, distance: err.distance, threshold: err.threshold });
        }
        if (err instanceof PendingSettlementError) {
          return res.status(402).json({ error: err.message, pending: err.pending });
        }
        throw err;
      }
    })
  );

  router.post(
    "/:courierId/deactivate",
    requireCourierAuth(tokens),
    asyncHandler(async (req, res) => {
      if ((req as CourierAuthedRequest).courierId !== req.params.courierId) {
        return res.status(403).json({ error: "No puedes desactivar a otro domiciliario" });
      }
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
