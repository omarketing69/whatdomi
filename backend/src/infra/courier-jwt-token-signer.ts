import jwt from "jsonwebtoken";
import { CourierTokenSigner } from "../domain/courier-session";

/**
 * A diferencia del token de negocio (30 días, `jwt-token-signer.ts`), el
 * domiciliario ya repite el ritual completo de cédula + verificación
 * facial cada vez que se activa (`POST /:courierId/activate`) — no
 * necesita una sesión que le dure semanas. 12 horas cubre un turno largo
 * sin obligarlo a reactivarse a mitad de jornada.
 */
const TWELVE_HOURS_SECONDS = 12 * 60 * 60;

export function createCourierJwtTokenSigner(secret: string, expiresInSeconds = TWELVE_HOURS_SECONDS): CourierTokenSigner {
  return {
    sign: (courierId) => jwt.sign({ courierId }, secret, { expiresIn: expiresInSeconds }),
    verify: (token) => {
      try {
        const decoded = jwt.verify(token, secret);
        if (
          typeof decoded === "object" &&
          decoded !== null &&
          "courierId" in decoded &&
          typeof (decoded as Record<string, unknown>).courierId === "string"
        ) {
          return { courierId: (decoded as { courierId: string }).courierId };
        }
        return null;
      } catch {
        return null;
      }
    },
  };
}
