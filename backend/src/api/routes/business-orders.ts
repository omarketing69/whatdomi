import { Router } from "express";
import { z } from "zod";
import { calculateFare } from "../../domain/fare";
import { haversineDistanceMeters } from "../../domain/geo";
import { GeocodingFailedError, GeocodingService } from "../../domain/geocoding";
import {
  DispatchService,
  InvalidOrderStateError,
  OrderNotFoundError,
} from "../../domain/dispatch";
import { DispatchRepository } from "../../domain/repository";
import { asyncHandler } from "../async-handler";
import { AuthedRequest, requireBusinessAuth } from "../business-auth-middleware";
import { TokenSigner } from "../../domain/business-auth";

const PAYMENT_MODES = ["DIRECT_TO_BUSINESS", "BUSINESS_REIMBURSES_COURIER", "COURIER_COLLECTS_ON_DELIVERY"] as const;

const quoteSchema = z.object({
  dropoffAddress: z.string().min(1),
  customerName: z.string().optional(),
  customerPhone: z.string().optional(),
  notes: z.string().optional(),
  /** Solo si el negocio quiere recoger en un lugar distinto al registrado, para este pedido puntual. */
  pickupAddress: z.string().optional(),
  /**
   * Valor de la mercancía/pedido y cómo se cobra — ambos opcionales, y sin
   * relación con la comisión de la plataforma (ver docs/ARCHITECTURE.md §6).
   * `paymentMode` sin `merchandiseValue` no tiene sentido, pero se deja
   * que el dominio los guarde tal cual: no es este endpoint el que decide
   * esa regla de negocio.
   */
  merchandiseValue: z.number().positive().optional(),
  paymentMode: z.enum(PAYMENT_MODES).optional(),
});

/**
 * Pedidos disparados desde el dashboard autenticado del negocio (ver
 * docs/ARCHITECTURE.md §11) — reemplaza al bot de WhatsApp como origen de
 * la cotización, pero reusa exactamente la misma lógica de dominio
 * (`DispatchService.createQuote`/`confirmQuote`, `calculateFare`,
 * `GeocodingService`) que ya existía para ese flujo: solo cambia quién la
 * dispara y cómo se entera del resultado (Socket.io + polling, no
 * WhatsApp).
 */
export function createBusinessOrdersRouter(
  repo: DispatchRepository,
  dispatch: DispatchService,
  geocoding: GeocodingService,
  tokens: TokenSigner,
  locationContext: { city?: string; country?: string } = {}
): Router {
  const router = Router();
  router.use(requireBusinessAuth(tokens));

  /**
   * Para que el dashboard reconstruya su vista al cargar la página:
   * `currentOrderId` solo vivía en una variable de JS en memoria del
   * navegador, así que un refresh (F5, cerrar la pestaña, que se caiga el
   * navegador) lo perdía sin ninguna forma de recuperar el pedido en
   * curso. Devuelve `{ order: null }` si el negocio no tiene ningún
   * pedido no terminado en este momento.
   */
  router.get(
    "/active",
    asyncHandler(async (req, res) => {
      const businessId = (req as AuthedRequest).businessId;
      const order = await repo.findActiveOrderForBusiness(businessId);
      if (!order) return res.json({ order: null });

      // El dashboard, para el estado QUOTED, necesita el mismo objeto
      // "quote" que ya le devuelve /quote — se reconstruye a partir de
      // los campos que ya quedaron guardados en el pedido al cotizarlo.
      const quote =
        order.distanceMeters !== null && order.fare !== null
          ? { distanceMeters: order.distanceMeters, distanceKm: order.distanceMeters / 1000, fare: order.fare, currency: order.currency }
          : null;

      return res.json({ order, quote });
    })
  );

  router.post(
    "/quote",
    asyncHandler(async (req, res) => {
      const parsed = quoteSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

      const businessId = (req as AuthedRequest).businessId;
      const business = await repo.getBusiness(businessId);
      if (!business) return res.status(404).json({ error: "Negocio no encontrado" });

      let pickup = business.location;
      let pickupAddress = business.address ?? "Punto de recogida del negocio";
      try {
        if (parsed.data.pickupAddress) {
          const resolvedPickup = await geocoding.resolve(parsed.data.pickupAddress, locationContext);
          pickup = { lat: resolvedPickup.lat, lng: resolvedPickup.lng };
          pickupAddress = resolvedPickup.formattedAddress;
        }
        if (!pickup) {
          return res.status(422).json({
            error: "Tu negocio no tiene una ubicación de recogida registrada; indica una dirección de recogida para este pedido.",
          });
        }

        const resolvedDropoff = await geocoding.resolve(parsed.data.dropoffAddress, locationContext);
        const distanceMeters = haversineDistanceMeters(pickup, resolvedDropoff);
        const platformConfig = await repo.getPlatformConfig();
        const quote = calculateFare(distanceMeters, platformConfig);

        const order = await dispatch.createQuote({
          businessId,
          pickup,
          pickupAddress,
          dropoff: { lat: resolvedDropoff.lat, lng: resolvedDropoff.lng },
          dropoffAddress: resolvedDropoff.formattedAddress,
          customerName: parsed.data.customerName,
          customerPhone: parsed.data.customerPhone,
          notes: parsed.data.notes,
          distanceMeters: quote.distanceMeters,
          fare: quote.fare,
          currency: quote.currency,
          merchandiseValue: parsed.data.merchandiseValue,
          paymentMode: parsed.data.paymentMode,
        });

        return res.status(201).json({ order, quote });
      } catch (err) {
        if (err instanceof GeocodingFailedError) return res.status(422).json({ error: err.message });
        throw err;
      }
    })
  );

  router.post(
    "/:orderId/confirm",
    asyncHandler(async (req, res) => {
      const businessId = (req as AuthedRequest).businessId;
      const existing = await dispatch.getOrderOrNull(req.params.orderId);
      if (!existing) return res.status(404).json({ error: "Pedido no encontrado" });
      if (existing.businessId !== businessId) {
        return res.status(403).json({ error: "Este pedido no pertenece a tu negocio" });
      }

      try {
        const { order, candidates } = await dispatch.confirmQuote(req.params.orderId);
        return res.json({ order, candidatesOffered: candidates.length });
      } catch (err) {
        if (err instanceof OrderNotFoundError) return res.status(404).json({ error: err.message });
        if (err instanceof InvalidOrderStateError) return res.status(409).json({ error: err.message });
        throw err;
      }
    })
  );

  return router;
}
