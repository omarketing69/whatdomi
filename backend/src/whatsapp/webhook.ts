import { Router } from "express";
import { WhatsAppConversationService } from "./conversation";
import { WhatsAppSender } from "./sender";

/**
 * Webhook de WhatsApp Business, formato Meta Cloud API (verify + mensajes
 * entrantes). Delega todo el flujo conversacional a
 * `WhatsAppConversationService` y usa `send` para responder — hoy `send`
 * es un stub que solo loguea (ver `sender.ts`), listo para cambiarse por
 * una llamada real a la Graph API o a Twilio en cuanto haya credenciales.
 *
 * Para producción falta: verificar la firma `X-Hub-Signature-256` contra
 * `WHATSAPP_APP_SECRET` antes de confiar en el body.
 */
export function createWhatsAppRouter(
  conversation: WhatsAppConversationService,
  send: WhatsAppSender
): Router {
  const router = Router();
  const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN ?? "whatdomi-dev-token";

  router.get("/webhook", (req, res) => {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode === "subscribe" && token === verifyToken) {
      return res.status(200).send(challenge);
    }
    return res.sendStatus(403);
  });

  router.post("/webhook", (req, res) => {
    // Responder rápido: Meta reintenta la entrega si no contestamos 200 a tiempo.
    res.sendStatus(200);

    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0]?.value;
    const message = change?.messages?.[0];
    if (!message) return;

    const from: string | undefined = message.from;
    const text: string | undefined = message.text?.body;
    if (!from || typeof text !== "string") return;

    conversation
      .handleIncomingText(from, text)
      .then((replies) => Promise.all(replies.map((reply) => send(from, reply))))
      .catch((err) => console.error("[whatsapp] error procesando mensaje entrante", err));
  });

  return router;
}
