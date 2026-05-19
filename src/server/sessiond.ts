#!/usr/bin/env node
import { mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import Fastify from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import { SessionEventHub } from "./realtime/sessionEventHub.js";
import { AuthService } from "./sessions/authService.js";
import { registerAuthRoutes } from "./sessions/authRoutes.js";
import { PiSessionService } from "./sessions/piSessionService.js";
import { registerSessionRoutes } from "./sessions/sessionRoutes.js";
import { sessiondSocketPath } from "./sessiond/config.js";
import { TerminalService } from "./terminals/terminalService.js";
import { registerTerminalRoutes } from "./terminals/terminalRoutes.js";
import { getPiWebComponentStatus } from "./piWebStatus.js";

const app = Fastify({ logger: true });
await app.register(fastifyWebsocket);

const eventHub = new SessionEventHub();
const auth = new AuthService();
const sessions = new PiSessionService(eventHub, { modelRegistry: auth.modelRegistry });
auth.subscribe((change) => { sessions.applyAuthChange(change); });
const terminals = new TerminalService(eventHub);
registerAuthRoutes(app, auth);
registerSessionRoutes(app, sessions, eventHub);
registerTerminalRoutes(app, terminals);

app.get("/health", async () => ({
  ok: true,
  activeSessions: sessions.activeCount(),
  checkedAt: new Date().toISOString(),
  version: await getPiWebComponentStatus("sessiond"),
}));

let shuttingDown = false;
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, "shutting down session daemon");
  terminals.dispose();
  auth.dispose();
  await sessions.dispose();
  await app.close();
}

process.once("SIGINT", (signal) => { void shutdown(signal); });
process.once("SIGTERM", (signal) => { void shutdown(signal); });

const portValue = process.env["PI_WEB_SESSIOND_PORT"];
const port = portValue !== undefined && portValue !== "" ? Number(portValue) : undefined;
const host = process.env["PI_WEB_SESSIOND_HOST"] ?? "127.0.0.1";

if (port !== undefined) {
  await app.listen({ port, host });
} else {
  const path = sessiondSocketPath();
  await mkdir(dirname(path), { recursive: true });
  await rm(path, { force: true });
  await app.listen({ path });
  process.on("exit", () => void rm(path, { force: true }));
}
