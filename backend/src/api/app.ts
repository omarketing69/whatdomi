import cors from "cors";
import express, { Express } from "express";
import { DispatchService } from "../domain/dispatch";
import { DispatchRepository } from "../domain/repository";
import { createAdminRouter } from "./routes/admin";
import { createCouriersRouter } from "./routes/couriers";
import { createOrdersRouter } from "./routes/orders";
import { createBusinessesRouter, createCourierRegistrationRouter } from "./routes/registration";
import { createWhatsAppRouter } from "../whatsapp/webhook";
import { WhatsAppConversationService } from "../whatsapp/conversation";
import { WhatsAppSender } from "../whatsapp/sender";

export function createApp(
  repo: DispatchRepository,
  dispatch: DispatchService,
  conversation: WhatsAppConversationService,
  whatsappSender: WhatsAppSender
): Express {
  const app = express();

  app.use(cors({ origin: process.env.CORS_ORIGIN ?? "*" }));
  app.use(express.json());

  app.get("/health", (_req, res) => res.json({ ok: true }));

  app.use("/api/orders", createOrdersRouter(dispatch));
  app.use("/api/businesses", createBusinessesRouter(repo));
  app.use("/api/couriers", createCourierRegistrationRouter(repo));
  app.use("/api/couriers", createCouriersRouter(repo, dispatch));
  app.use("/api/admin", createAdminRouter(repo));
  app.use("/whatsapp", createWhatsAppRouter(conversation, whatsappSender));

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error(err);
    res.status(500).json({ error: "Error interno del servidor" });
  });

  return app;
}
