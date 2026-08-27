import { Router } from "express";
import { z } from "zod";
import { DispatchRepository } from "../../domain/repository";
import { asyncHandler } from "../async-handler";

const createCourierSchema = z.object({
  name: z.string().min(1),
  phone: z.string().min(1),
  nationalId: z.string().min(5),
  vehiclePlate: z.string().optional(),
});

/**
 * Alta del domiciliario. El registro del negocio ya no vive aquí: ahora
 * es `POST /api/auth/register` (`business-auth.ts`), porque un negocio
 * necesita credenciales de acceso (email/contraseña), no solo un nombre —
 * ver docs/ARCHITECTURE.md §11.
 */
export function createCourierRegistrationRouter(repo: DispatchRepository): Router {
  const router = Router();

  router.post(
    "/",
    asyncHandler(async (req, res) => {
      const parsed = createCourierSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

      const courier = await repo.createCourier(parsed.data);
      return res.status(201).json({ courier });
    })
  );

  return router;
}
