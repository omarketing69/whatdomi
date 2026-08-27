import { Router } from "express";
import { z } from "zod";
import {
  DispatchService,
  OrderAlreadyTakenError,
  OrderNotFoundError,
} from "../../domain/dispatch";
import { asyncHandler } from "../async-handler";
import { requireAdminKey } from "./admin";

const geoPointSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

const createOrderSchema = z.object({
  businessId: z.string().min(1),
  pickup: geoPointSchema,
  pickupAddress: z.string().min(1),
  dropoff: geoPointSchema,
  dropoffAddress: z.string().min(1),
  customerName: z.string().optional(),
  customerPhone: z.string().optional(),
  notes: z.string().optional(),
});

const acceptOrderSchema = z.object({
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

export function createOrdersRouter(dispatch: DispatchService): Router {
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

  router.get(
    "/:orderId",
    asyncHandler(async (req, res) => {
      const order = await dispatch.getOrderOrNull(req.params.orderId);
      if (!order) return res.status(404).json({ error: "Pedido no encontrado" });
      return res.json({ order });
    })
  );

  router.post(
    "/:orderId/accept",
    asyncHandler(async (req, res) => {
      const parsed = acceptOrderSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.flatten() });
      }

      try {
        const order = await dispatch.acceptOrder(req.params.orderId, parsed.data.courierId);
        return res.json({ order });
      } catch (err) {
        if (err instanceof OrderNotFoundError) {
          return res.status(404).json({ error: err.message });
        }
        if (err instanceof OrderAlreadyTakenError) {
          return res.status(409).json({ error: err.message });
        }
        throw err;
      }
    })
  );

  router.post(
    "/:orderId/picked-up",
    asyncHandler(async (req, res) => {
      try {
        const order = await dispatch.markPickedUp(req.params.orderId);
        return res.json({ order });
      } catch (err) {
        if (err instanceof OrderNotFoundError) return res.status(404).json({ error: err.message });
        throw err;
      }
    })
  );

  router.post(
    "/:orderId/delivered",
    asyncHandler(async (req, res) => {
      try {
        const order = await dispatch.markDelivered(req.params.orderId);
        return res.json({ order });
      } catch (err) {
        if (err instanceof OrderNotFoundError) return res.status(404).json({ error: err.message });
        throw err;
      }
    })
  );

  router.post(
    "/:orderId/cancel",
    asyncHandler(async (req, res) => {
      try {
        const order = await dispatch.cancelOrder(req.params.orderId);
        return res.json({ order });
      } catch (err) {
        if (err instanceof OrderNotFoundError) return res.status(404).json({ error: err.message });
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
      const parsed = acceptOrderSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.flatten() });
      }

      try {
        const order = await dispatch.manuallyAssignOrder(req.params.orderId, parsed.data.courierId);
        return res.json({ order });
      } catch (err) {
        if (err instanceof OrderNotFoundError) return res.status(404).json({ error: err.message });
        if (err instanceof OrderAlreadyTakenError) return res.status(409).json({ error: err.message });
        throw err;
      }
    })
  );

  return router;
}
