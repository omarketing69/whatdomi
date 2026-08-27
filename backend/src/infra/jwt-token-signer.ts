import jwt from "jsonwebtoken";
import { TokenSigner } from "../domain/business-auth";

/**
 * Token de sesión con JWT firmado (HS256) en vez de una cookie de sesión
 * con estado en el servidor: el frontend es HTML/JS plano sin backend de
 * sesiones propio, así que un token que el propio cliente guarda
 * (`Authorization: Bearer <token>`, igual patrón de cabecera que
 * `ADMIN_API_KEY`) y que el servidor puede validar sin consultar una
 * tabla de sesiones es la opción más simple para este MVP. No hay
 * revocación de tokens (ej. si roban uno, sigue siendo válido hasta que
 * expire) — ver docs/ARCHITECTURE.md §11 para qué le falta a esto para
 * producción.
 */
const THIRTY_DAYS_SECONDS = 30 * 24 * 60 * 60;

export function createJwtTokenSigner(secret: string, expiresInSeconds = THIRTY_DAYS_SECONDS): TokenSigner {
  return {
    sign: (businessId) => jwt.sign({ businessId }, secret, { expiresIn: expiresInSeconds }),
    verify: (token) => {
      try {
        const decoded = jwt.verify(token, secret);
        if (
          typeof decoded === "object" &&
          decoded !== null &&
          "businessId" in decoded &&
          typeof (decoded as Record<string, unknown>).businessId === "string"
        ) {
          return { businessId: (decoded as { businessId: string }).businessId };
        }
        return null;
      } catch {
        return null;
      }
    },
  };
}
