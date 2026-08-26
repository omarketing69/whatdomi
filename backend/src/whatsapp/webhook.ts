import { Router } from "express";

/**
 * Stub del webhook de WhatsApp Business (formato Meta Cloud API).
 *
 * No hay credenciales de WhatsApp Business todavía, así que este webhook:
 *  - responde el challenge de verificación de Meta (GET), para poder
 *    registrar la URL en el panel de Meta for Developers en cuanto haya
 *    una cuenta real.
 *  - recibe mensajes entrantes (POST), los loguea, y responde con el link
 *    al formulario web donde el negocio completa los datos del domicilio
 *    (dirección, tienda, etc.), en vez de intentar sostener toda la
 *    conversación dentro de WhatsApp.
 *
 * Para producción falta: verificar la firma `X-Hub-Signature-256`, llamar
 * a la Graph API para enviar la respuesta al usuario, y manejar sesiones
 * de conversación (en qué paso del flujo está cada número).
 *
 * Twilio es la alternativa si no se quiere pasar por la verificación de
 * empresa de Meta: el shape del payload cambia, pero la estructura de este
 * router (verify + inbound) se mantiene igual.
 */
export function createWhatsAppRouter(webAppUrl: string): Router {
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
    // TODO: verificar X-Hub-Signature-256 contra WHATSAPP_APP_SECRET antes
    // de confiar en el body, una vez haya credenciales reales.
    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0]?.value;
    const message = change?.messages?.[0];

    if (message) {
      const from = message.from;
      console.log(`[whatsapp] mensaje entrante de ${from}: ${JSON.stringify(message)}`);
      // TODO: aquí se llamaría a la Graph API para responder algo como:
      // "Para pedir un domiciliario completa los datos aquí: {webAppUrl}?from={from}"
      console.log(`[whatsapp] siguiente paso sugerido: enviar link ${webAppUrl}?from=${from}`);
    }

    // Meta requiere responder 200 rápido para no reintentar la entrega.
    return res.sendStatus(200);
  });

  return router;
}
