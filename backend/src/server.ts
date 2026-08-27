import "dotenv/config";
import { createServer } from "node:http";
import { createApp } from "./api/app";
import { combineNotifiers, DispatchService } from "./domain/dispatch";
import { GeocodingService } from "./domain/geocoding";
import { SettlementService } from "./domain/settlement";
import { getPool } from "./infra/pool";
import { AnthropicAddressNormalizer } from "./infra/geocoding/anthropic-normalizer";
import { NominatimGeocodingProvider } from "./infra/geocoding/nominatim-provider";
import { PassthroughAddressNormalizer } from "./infra/geocoding/passthrough-normalizer";
import { PostgresDispatchRepository } from "./infra/postgres-repository";
import { createSocketNotifier, createSocketServer } from "./realtime/socket";
import { WhatsAppConversationService } from "./whatsapp/conversation";
import { createWhatsAppDispatchNotifier } from "./whatsapp/notifier";
import { stubWhatsAppSender } from "./whatsapp/sender";

const PORT = Number(process.env.PORT ?? 3000);
const SEARCH_RADIUS_METERS = Number(process.env.SEARCH_RADIUS_METERS ?? 5_000);
const MAX_CANDIDATES = Number(process.env.MAX_CANDIDATES ?? 5);
const OFFER_TIMEOUT_MS = Number(process.env.OFFER_TIMEOUT_MS ?? 60_000);

const repo = new PostgresDispatchRepository(getPool());
const settlements = new SettlementService(repo);

const httpServer = createServer();
const io = createSocketServer(httpServer);

const whatsappSender = stubWhatsAppSender;
const notifier = combineNotifiers(
  createSocketNotifier(io),
  createWhatsAppDispatchNotifier(repo, whatsappSender)
);

const dispatch = new DispatchService(repo, {
  notifier,
  searchRadiusMeters: SEARCH_RADIUS_METERS,
  maxCandidates: MAX_CANDIDATES,
  settlements,
  offerTimeoutMs: OFFER_TIMEOUT_MS,
});

// Si hay ANTHROPIC_API_KEY, se usa un LLM para interpretar direcciones
// informales antes de geocodificarlas; si no, se manda el texto tal cual
// (con la ciudad/país como contexto) al geocodificador real.
const addressNormalizer = process.env.ANTHROPIC_API_KEY
  ? new AnthropicAddressNormalizer(process.env.ANTHROPIC_API_KEY, process.env.ANTHROPIC_MODEL)
  : new PassthroughAddressNormalizer();
const geocoding = new GeocodingService(addressNormalizer, new NominatimGeocodingProvider());

// La tarifa y la comisión ya no se leen de variables de entorno en cada
// cotización: viven en la tabla `platform_config` (editable por el admin
// desde /api/admin/config), sembrada por db/schema.sql.
const conversation = new WhatsAppConversationService(repo, dispatch, geocoding, undefined, {
  city: process.env.DEFAULT_CITY,
  country: process.env.DEFAULT_COUNTRY,
});

const app = createApp(repo, dispatch, conversation, whatsappSender);
httpServer.on("request", app);

httpServer.listen(PORT, () => {
  console.log(`WhatDomi backend escuchando en http://localhost:${PORT}`);
});
