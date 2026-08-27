import cors from "cors";
import express, { Express } from "express";
import { BusinessAuthService, TokenSigner } from "../domain/business-auth";
import { DispatchService } from "../domain/dispatch";
import { GeocodingService } from "../domain/geocoding";
import { DispatchRepository } from "../domain/repository";
import { createAdminRouter } from "./routes/admin";
import { createBusinessAuthRouter } from "./routes/business-auth";
import { createBusinessOrdersRouter } from "./routes/business-orders";
import { createCouriersRouter } from "./routes/couriers";
import { createOrdersRouter } from "./routes/orders";
import { createCourierRegistrationRouter } from "./routes/registration";

/**
 * Todo lo que `createApp` necesita para construir las rutas, agrupado en
 * un solo objeto en vez de un parámetro por dependencia — mismo motivo
 * que llevó a `DispatchServiceOptions` (ver `domain/dispatch.ts`): evitar
 * que la lista de parámetros posicionales crezca cada vez que se agrega
 * una pieza más (acá ya pasó una vez, al quitar el flujo de WhatsApp y
 * agregar el de auth/negocio).
 */
export interface CreateAppDeps {
  repo: DispatchRepository;
  dispatch: DispatchService;
  businessAuth: BusinessAuthService;
  tokens: TokenSigner;
  geocoding: GeocodingService;
  locationContext?: { city?: string; country?: string };
}

export function createApp(deps: CreateAppDeps): Express {
  const { repo, dispatch, businessAuth, tokens, geocoding, locationContext = {} } = deps;
  const app = express();

  app.use(cors({ origin: process.env.CORS_ORIGIN ?? "*" }));
  app.use(express.json());

  app.get("/health", (_req, res) => res.json({ ok: true }));

  app.use("/api/orders", createOrdersRouter(dispatch, repo));
  app.use("/api/auth", createBusinessAuthRouter(businessAuth, tokens, repo));
  app.use("/api/business/orders", createBusinessOrdersRouter(repo, dispatch, geocoding, tokens, locationContext));
  app.use("/api/couriers", createCourierRegistrationRouter(repo));
  app.use("/api/couriers", createCouriersRouter(repo, dispatch));
  app.use("/api/admin", createAdminRouter(repo));

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error(err);
    res.status(500).json({ error: "Error interno del servidor" });
  });

  return app;
}
