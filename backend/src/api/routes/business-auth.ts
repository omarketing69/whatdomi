import { Router } from "express";
import { z } from "zod";
import {
  AddressNotFoundError,
  BusinessAuthService,
  EmailAlreadyRegisteredError,
  InvalidCredentialsError,
  TokenSigner,
  toPublicBusiness,
} from "../../domain/business-auth";
import { DispatchRepository } from "../../domain/repository";
import { asyncHandler } from "../async-handler";
import { AuthedRequest, requireBusinessAuth } from "../business-auth-middleware";

const registerSchema = z.object({
  name: z.string().min(1),
  phone: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(8, "La contraseña debe tener al menos 8 caracteres"),
  address: z.string().min(1),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

/**
 * Registro y login del negocio (reemplaza el canal de WhatsApp, ver
 * docs/ARCHITECTURE.md §11). No hay recuperación de contraseña ni 2FA en
 * este MVP — declarado fuera de alcance a propósito, ver el mismo §11.
 */
export function createBusinessAuthRouter(
  auth: BusinessAuthService,
  tokens: TokenSigner,
  repo: DispatchRepository
): Router {
  const router = Router();

  router.post(
    "/register",
    asyncHandler(async (req, res) => {
      const parsed = registerSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

      try {
        const { business, token } = await auth.register(parsed.data);
        return res.status(201).json({ token, business: toPublicBusiness(business) });
      } catch (err) {
        if (err instanceof EmailAlreadyRegisteredError) return res.status(409).json({ error: err.message });
        if (err instanceof AddressNotFoundError) return res.status(422).json({ error: err.message });
        throw err;
      }
    })
  );

  router.post(
    "/login",
    asyncHandler(async (req, res) => {
      const parsed = loginSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

      try {
        const { business, token } = await auth.login(parsed.data.email, parsed.data.password);
        return res.json({ token, business: toPublicBusiness(business) });
      } catch (err) {
        if (err instanceof InvalidCredentialsError) return res.status(401).json({ error: err.message });
        throw err;
      }
    })
  );

  router.get(
    "/me",
    requireBusinessAuth(tokens),
    asyncHandler(async (req, res) => {
      const business = await repo.getBusiness((req as AuthedRequest).businessId);
      if (!business) return res.status(404).json({ error: "Negocio no encontrado" });
      return res.json({ business: toPublicBusiness(business) });
    })
  );

  return router;
}
