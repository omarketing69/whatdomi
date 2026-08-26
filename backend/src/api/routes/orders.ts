import { Router } from "express";
import { z } from "zod";
import {
  DispatchService,
  OrderAlreadyTakenError,
  OrderNotFoundError,
} from "../../domain/dispatch";
import { asyncHandler } from "../async-handler";

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

export function createOrdersRouter(dispatch: DispatchService): Router {
  const router = Router();

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

  return router;
}
