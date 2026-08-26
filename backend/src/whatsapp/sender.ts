/** Envía un mensaje de texto a un número de WhatsApp. */
export type WhatsAppSender = (phone: string, message: string) => Promise<void>;

/**
 * Sin credenciales de WhatsApp Business todavía, este sender solo loguea lo
 * que se enviaría. Reemplazar por una llamada real a la Graph API (Meta) o
 * al API de Twilio en cuanto haya credenciales — ver `docs/ARCHITECTURE.md` §5.
 */
export const stubWhatsAppSender: WhatsAppSender = async (phone, message) => {
  console.log(`[whatsapp] -> ${phone}:\n${message}`);
};
