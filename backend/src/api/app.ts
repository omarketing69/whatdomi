import cors from "cors";
import express, { Express } from "express";
import { DispatchService } from "../domain/dispatch";
import { DispatchRepository } from "../domain/repository";
import { createCouriersRouter } from "./routes/couriers";
import { createOrdersRouter } from "./routes/orders";
import { createBusinessesRouter, createCourierRegistrationRouter } from "./routes/registration";
import { createWhatsAppRouter } from "../whatsapp/webhook";

export function createApp(repo: DispatchRepository, dispatch: DispatchService): Express {
  const app = express();

  app.use(cors({ origin: process.env.CORS_ORIGIN ?? "*" }));
  app.use(express.json());

  app.get("/health", (_req, res) => res.json({ ok: true }));

  app.use("/api/orders", createOrdersRouter(dispatch));
  app.use("/api/businesses", createBusinessesRouter(repo));
  app.use("/api/couriers", createCourierRegistrationRouter(repo));
  app.use("/api/couriers", createCouriersRouter(repo));
  app.use("/whatsapp", createWhatsAppRouter(process.env.WEB_APP_URL ?? "http://localhost:5173"));

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error(err);
    res.status(500).json({ error: "Error interno del servidor" });
  });

  return app;
}
