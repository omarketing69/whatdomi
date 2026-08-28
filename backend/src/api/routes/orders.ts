import { Request, Router } from "express";
import { z } from "zod";
import {
  CourierBusyError,
  DispatchService,
  InvalidOrderStateError,
  NotOrderOwnerError,
  OrderAlreadyTakenError,
  OrderAlreadyTerminalError,
  OrderNotFoundError,
} from "../../domain/dispatch";
import { DispatchRepository } from "../../domain/repository";
import { asyncHandler } from "../async-handler";
import { requireAdminKey } from "./admin";
import { AuthedRequest, requireBusinessAuth } from "../business-auth-middleware";
import { TokenSigner } from "../../domain/business-auth";
import { CourierAuthedRequest, requireCourierAuth } from "../courier-auth-middleware";
import { CourierTokenSigner } from "../../domain/courier-session";

const geoPointSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

const PAYMENT_MODES = ["DIRECT_TO_BUSINESS", "BUSINESS_REIMBURSES_COURIER", "COURIER_COLLECTS_ON_DELIVERY"] as const;

const createOrderSchema = z.object({
  businessId: z.string().min(1),
  pickup: geoPointSchema,
  pickupAddress: z.string().min(1),
  dropoff: geoPointSchema,
  dropoffAddress: z.string().min(1),
  customerName: z.string().optional(),
  customerPhone: z.string().optional(),
  notes: z.string().optional(),
  /** Valor de la mercancía y modalidad de cobro, ambos opcionales — ver docs/ARCHITECTURE.md §6. */
  merchandiseValue: z.number().positive().optional(),
  paymentMode: z.enum(PAYMENT_MODES).optional(),
});

const assignOrderSchema = z.object({
  courierId: z.string().min(1),
});

const ORDER_STATUS_VALUES = [
  "CREATED",
  "QUOTED",
  "SEARCHING",
  "ASSIGNED",
  "IN_PROGRESS",
  "DELIVERED",
  "CANCELLED",
  "NO_COURIERS_AVAILABLE",
  "UNASSIGNED",
] as const;

/**
 * Falta ADMIN_API_KEY configurada en desarrollo local: mismo criterio
 * "sin clave, deja pasar" de `requireAdminKey` (ver `routes/admin.ts`),
 * usado acá para rutas que aceptan TANTO la clave de admin COMO el token
 * del negocio dueño del pedido (ej. cancelar), en vez de una sola vía.
 */
function passesAdminKey(req: Request): boolean {
  const expected = process.env.ADMIN_API_KEY;
  if (!expected) return true;
  return req.header("x-admin-key") === expected;
}

export function createOrdersRouter(
  dispatch: DispatchService,
  repo: DispatchRepository,
  tokens: TokenSigner,
  courierTokens: CourierTokenSigner
): Router {
  const router = Router();

  /**
   * Para el tablero de administración: lista de pedidos, opcionalmente
   * filtrada por estado. Requiere la clave de admin (ver `requireAdminKey`
   * en `routes/admin.ts`) — a diferencia de crear/aceptar/actualizar un
   * pedido puntual, que negocios y domiciliarios siguen usando sin cuenta.
   */
  router.get(
    "/",
    requireAdminKey,
    asyncHandler(async (req, res) => {
      const rawStatus = req.query.status;
      const statusValues = (Array.isArray(rawStatus) ? rawStatus : rawStatus ? [rawStatus] : [])
        .flatMap((v) => String(v).split(","))
        .filter(Boolean);

      const statuses = z.array(z.enum(ORDER_STATUS_VALUES)).optional().safeParse(
        statusValues.length > 0 ? statusValues : undefined
      );
      if (!statuses.success) return res.status(400).json({ error: statuses.error.flatten() });

      const limit = req.query.limit ? Number(req.query.limit) : undefined;
      const orders = await dispatch.listOrders({ statuses: statuses.data, limit });
      return res.json({ orders });
    })
  );

  router.post(
    "/",
    asyncHandler(async (req, res) => {
      const parsed = createOrderSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.flatten() });
      }

      const { order, candidates } = await dispatch.createDeliveryRequest(parsed.data);
      return res.status(201).json({
        order,
        candidatesOffered: candidates.length,
      });
    })
  );

  /**
   * El pedido completo incluye datos del cliente final (nombre, teléfono,
   * notas) y el valor de la mercancía — solo el negocio dueño puede
   * verlo, no cualquiera que adivine un `orderId`.
   */
  router.get(
    "/:orderId",
    requireBusinessAuth(tokens),
    asyncHandler(async (req, res) => {
      const order = await dispatch.getOrderOrNull(req.params.orderId);
      if (!order) return res.status(404).json({ error: "Pedido no encontrado" });
      if (order.businessId !== (req as AuthedRequest).businessId) {
        return res.status(403).json({ error: "Este pedido no pertenece a tu negocio" });
      }
      return res.json({ order });
    })
  );

  /**
   * Para el mapa de seguimiento del negocio: ubicación en vivo del
   * domiciliario ya asignado a este pedido (null si todavía no hay
   * ninguno). Deliberadamente no devuelve el pedido completo ni datos del
   * domiciliario más allá de su posición.
   */
  router.get(
    "/:orderId/courier-location",
    asyncHandler(async (req, res) => {
      const location = await dispatch.getCourierLocation(req.params.orderId);
      return res.json({ location });
    })
  );

  /**
   * Para el dashboard del negocio: nombre, placa y teléfono del
   * domiciliario ya asignado a este pedido (`null` si todavía no hay
   * ninguno) — reemplaza el mensaje de WhatsApp que antes le daba esos
   * mismos tres datos al negocio al asignarse. Deliberadamente NO incluye
   * la cédula ni el descriptor facial del domiciliario, que no son asunto
   * del negocio.
   */
  router.get(
    "/:orderId/courier-contact",
    requireBusinessAuth(tokens),
    asyncHandler(async (req, res) => {
      const order = await dispatch.getOrderOrNull(req.params.orderId);
      if (!order) return res.status(404).json({ error: "Pedido no encontrado" });
      if (order.businessId !== (req as AuthedRequest).businessId) {
        return res.status(403).json({ error: "Este pedido no pertenece a tu negocio" });
      }
      if (!order.courierId) return res.json({ courier: null });

      const courier = await repo.getCourier(order.courierId);
      if (!courier) return res.json({ courier: null });

      return res.json({
        courier: { name: courier.name, vehiclePlate: courier.vehiclePlate ?? null, phone: courier.phone },
      });
    })
  );

  /**
   * Seguimiento público para el cliente final del negocio (quien recibe el
   * pedido), sin necesitar cuenta: solo hace falta el `orderId`, que el
   * negocio le comparte directamente (ej. por WhatsApp). Es seguro exponerlo
   * sin autenticación porque `orders.id` es un UUID (`gen_random_uuid()`,
   * ver `db/schema.sql`) — no enumerable, mismo modelo de confianza que un
   * link de seguimiento de una transportadora. Deliberadamente NO incluye
   * nada del negocio (`businessId`), del cliente (`customerName`/
   * `customerPhone`/`notes`) ni de pagos (`merchandiseValue`/`paymentMode`)
   * — solo lo que el cliente final necesita para saber dónde va su pedido.
   */
  router.get(
    "/:orderId/track",
    asyncHandler(async (req, res) => {
      const order = await dispatch.getOrderOrNull(req.params.orderId);
      if (!order) return res.status(404).json({ error: "Pedido no encontrado" });

      const courier = order.courierId ? await repo.getCourier(order.courierId) : null;

      return res.json({
        status: order.status,
        pickupAddress: order.pickupAddress,
        dropoffAddress: order.dropoffAddress,
        createdAt: order.createdAt,
        courier: courier ? { name: courier.name, vehiclePlate: courier.vehiclePlate ?? null, phone: courier.phone } : null,
      });
    })
  );

  /**
   * `courierId` viene del token de sesión (`req.courierId`), no del body:
   * antes cualquiera podía mandar el id de otro domiciliario y aceptar
   * pedidos "a su nombre" sin ser esa persona.
   */
  router.post(
    "/:orderId/accept",
    requireCourierAuth(courierTokens),
    asyncHandler(async (req, res) => {
      const courierId = (req as CourierAuthedRequest).courierId;
      try {
        const order = await dispatch.acceptOrder(req.params.orderId, courierId);
        return res.json({ order });
      } catch (err) {
        if (err instanceof OrderNotFoundError) {
          return res.status(404).json({ error: err.message });
        }
        if (err instanceof OrderAlreadyTakenError) {
          return res.status(409).json({ error: err.message });
        }
        if (err instanceof CourierBusyError) {
          return res.status(409).json({ error: err.message, activeOrderId: err.activeOrderId });
        }
        throw err;
      }
    })
  );

  router.post(
    "/:orderId/picked-up",
    requireCourierAuth(courierTokens),
    asyncHandler(async (req, res) => {
      const courierId = (req as CourierAuthedRequest).courierId;
      try {
        const order = await dispatch.markPickedUp(req.params.orderId, courierId);
        return res.json({ order });
      } catch (err) {
        if (err instanceof OrderNotFoundError) return res.status(404).json({ error: err.message });
        if (err instanceof NotOrderOwnerError) return res.status(403).json({ error: err.message });
        if (err instanceof InvalidOrderStateError) return res.status(409).json({ error: err.message });
        throw err;
      }
    })
  );

  router.post(
    "/:orderId/delivered",
    requireCourierAuth(courierTokens),
    asyncHandler(async (req, res) => {
      const courierId = (req as CourierAuthedRequest).courierId;
      try {
        const order = await dispatch.markDelivered(req.params.orderId, courierId);
        return res.json({ order });
      } catch (err) {
        if (err instanceof OrderNotFoundError) return res.status(404).json({ error: err.message });
        if (err instanceof NotOrderOwnerError) return res.status(403).json({ error: err.message });
        if (err instanceof InvalidOrderStateError) return res.status(409).json({ error: err.message });
        throw err;
      }
    })
  );

  /**
   * Cancela tanto el negocio dueño del pedido (token de negocio) como el
   * admin (`X-Admin-Key`) — antes cualquiera sin autenticarse podía
   * cancelar el pedido de cualquier otro.
   */
  router.post(
    "/:orderId/cancel",
    asyncHandler(async (req, res) => {
      const order = await dispatch.getOrderOrNull(req.params.orderId);
      if (!order) return res.status(404).json({ error: "Pedido no encontrado" });

      if (!passesAdminKey(req)) {
        const header = req.header("authorization");
        const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
        const payload = token ? tokens.verify(token) : null;
        if (!payload) {
          return res.status(401).json({ error: "Falta el token de autenticación (Authorization: Bearer <token>)" });
        }
        if (order.businessId !== payload.businessId) {
          return res.status(403).json({ error: "Este pedido no pertenece a tu negocio" });
        }
      }

      try {
        const cancelled = await dispatch.cancelOrder(order.id);
        return res.json({ order: cancelled });
      } catch (err) {
        if (err instanceof OrderNotFoundError) return res.status(404).json({ error: err.message });
        if (err instanceof OrderAlreadyTerminalError) return res.status(409).json({ error: err.message });
        throw err;
      }
    })
  );

  /**
   * Fallback manual desde el tablero de administración: el camino
   * principal de asignación es automático, esto es solo para cuando el
   * domiciliario asignado no puede cumplir y hay que reintentar la
   * cascada completa desde cero (excluyéndolo).
   */
  router.post(
    "/:orderId/reassign",
    requireAdminKey,
    asyncHandler(async (req, res) => {
      try {
        const { order, candidates } = await dispatch.reassignOrder(req.params.orderId);
        return res.json({ order, candidatesOffered: candidates.length });
      } catch (err) {
        if (err instanceof OrderNotFoundError) return res.status(404).json({ error: err.message });
        throw err;
      }
    })
  );

  /**
   * Última instancia: la cascada automática se agotó (pedido `UNASSIGNED`)
   * sin que nadie aceptara, y el admin elige directamente al domiciliario.
   * Es el único endpoint de todo el sistema donde un humano asigna a mano.
   */
  router.post(
    "/:orderId/assign",
    requireAdminKey,
    asyncHandler(async (req, res) => {
      const parsed = assignOrderSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.flatten() });
      }

      try {
        const order = await dispatch.manuallyAssignOrder(req.params.orderId, parsed.data.courierId);
        return res.json({ order });
      } catch (err) {
        if (err instanceof OrderNotFoundError) return res.status(404).json({ error: err.message });
        if (err instanceof OrderAlreadyTakenError) return res.status(409).json({ error: err.message });
        if (err instanceof CourierBusyError) {
          return res.status(409).json({ error: err.message, activeOrderId: err.activeOrderId });
        }
        throw err;
      }
    })
  );

  return router;
}
