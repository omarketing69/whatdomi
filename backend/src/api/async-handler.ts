import { NextFunction, Request, Response } from "express";

type AsyncRouteHandler = (req: Request, res: Response) => Promise<unknown>;

/**
 * Express 4 no reenvía automáticamente los rechazos de promesas de un
 * handler async al middleware de errores; sin este wrapper, un `throw`
 * dentro de un `async (req, res) => {...}` terminaría en un unhandled
 * rejection en vez de una respuesta 500 controlada.
 */
export function asyncHandler(handler: AsyncRouteHandler) {
  return (req: Request, res: Response, next: NextFunction) => {
    handler(req, res).catch(next);
  };
}
