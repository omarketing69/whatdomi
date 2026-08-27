import { NextFunction, Request, Response } from "express";
import { CourierTokenSigner } from "../domain/courier-session";

/** Request ya autenticado por `requireCourierAuth` — `courierId` queda garantizado presente. */
export interface CourierAuthedRequest extends Request {
  courierId: string;
}

/**
 * Exige un `Authorization: Bearer <token>` de sesión de domiciliario (ver
 * `CourierTokenSigner`) y expone el `courierId` del token en
 * `req.courierId` — mismo patrón que `requireBusinessAuth`, pero para el
 * otro rol con cuenta propia. Las rutas que además actúan sobre un
 * `:courierId` de la URL deben comparar ese parámetro contra
 * `req.courierId`: este middleware solo prueba "quién sos", no "sos dueño
 * de este recurso puntual".
 */
export function requireCourierAuth(tokens: CourierTokenSigner) {
  return (req: Request, res: Response, next: NextFunction) => {
    const header = req.header("authorization");
    const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
    if (!token) {
      return res.status(401).json({ error: "Falta el token de sesión del domiciliario (Authorization: Bearer <token>)" });
    }

    const payload = tokens.verify(token);
    if (!payload) {
      return res.status(401).json({ error: "Token inválido o expirado, actívate de nuevo" });
    }

    (req as CourierAuthedRequest).courierId = payload.courierId;
    next();
  };
}
