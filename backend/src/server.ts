import "dotenv/config";
import { createServer } from "node:http";
import { createApp } from "./api/app";
import { DispatchService } from "./domain/dispatch";
import { getPool } from "./infra/pool";
import { PostgresDispatchRepository } from "./infra/postgres-repository";
import { createSocketNotifier, createSocketServer } from "./realtime/socket";

const PORT = Number(process.env.PORT ?? 3000);
const SEARCH_RADIUS_METERS = Number(process.env.SEARCH_RADIUS_METERS ?? 5_000);
const MAX_CANDIDATES = Number(process.env.MAX_CANDIDATES ?? 5);

const repo = new PostgresDispatchRepository(getPool());

const httpServer = createServer();
const io = createSocketServer(httpServer);
const notifier = createSocketNotifier(io);

const dispatch = new DispatchService(repo, notifier, SEARCH_RADIUS_METERS, MAX_CANDIDATES);

const app = createApp(repo, dispatch);
httpServer.on("request", app);

httpServer.listen(PORT, () => {
  console.log(`WhatDomi backend escuchando en http://localhost:${PORT}`);
});
