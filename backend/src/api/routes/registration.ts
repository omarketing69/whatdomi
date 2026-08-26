import { Router } from "express";
import { z } from "zod";
import { DispatchRepository } from "../../domain/repository";
import { asyncHandler } from "../async-handler";

const createBusinessSchema = z.object({
  name: z.string().min(1),
  phone: z.string().min(1),
  address: z.string().optional(),
});

const createCourierSchema = z.object({
  name: z.string().min(1),
  phone: z.string().min(1),
  vehiclePlate: z.string().optional(),
});

/** Alta mínima de negocios y domiciliarios, necesaria para poder probar el flujo completo del MVP. */
export function createBusinessesRouter(repo: DispatchRepository): Router {
  const router = Router();

  router.post(
    "/",
    asyncHandler(async (req, res) => {
      const parsed = createBusinessSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

      const business = await repo.createBusiness(parsed.data);
      return res.status(201).json({ business });
    })
  );

  return router;
}

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
