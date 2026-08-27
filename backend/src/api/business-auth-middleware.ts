import { NextFunction, Request, Response } from "express";
import { TokenSigner } from "../domain/business-auth";

/** Request ya autenticado por `requireBusinessAuth` — `businessId` queda garantizado presente. */
export interface AuthedRequest extends Request {
  businessId: string;
}

/**
 * Exige un `Authorization: Bearer <token>` válido (ver `TokenSigner`) y
 * expone el `businessId` del token en `req.businessId` — mismo patrón de
 * cabecera que `requireAdminKey` (`X-Admin-Key`), pero con un token
 * firmado por negocio en vez de una clave compartida única, porque acá sí
 * hay más de un "dueño" (cada negocio solo debe ver/crear sus propios
 * pedidos).
 */
export function requireBusinessAuth(tokens: TokenSigner) {
  return (req: Request, res: Response, next: NextFunction) => {
    const header = req.header("authorization");
    const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
    if (!token) {
      return res.status(401).json({ error: "Falta el token de autenticación (Authorization: Bearer <token>)" });
    }

    const payload = tokens.verify(token);
    if (!payload) {
      return res.status(401).json({ error: "Token inválido o expirado, vuelve a iniciar sesión" });
    }

    (req as AuthedRequest).businessId = payload.businessId;
    next();
  };
}
