#!/usr/bin/env node
import { mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import Fastify from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import { WorkspaceActivityService } from "./activity/workspaceActivityService.js";
import { registerWorkspaceActivityRoutes } from "./activity/workspaceActivityRoutes.js";
import { SessionEventHub } from "./realtime/sessionEventHub.js";
import { AuthService } from "./sessions/authService.js";
import { registerAuthRoutes } from "./sessions/authRoutes.js";
import { PiSessionService } from "./sessions/piSessionService.js";
import { createPiSessionManagerGateway } from "./sessions/piSessionManagerGateway.js";
import { registerSessionRoutes } from "./sessions/sessionRoutes.js";
import { ProjectScopedSpawnTargetResolver } from "./sessions/spawnTargetResolver.js";
import { ProjectService } from "./projects/projectService.js";
import { ProjectStore } from "./storage/projectStore.js";
import { WorkspaceService } from "./workspaces/workspaceService.js";
import { sessiondSocketPath } from "../sessiond/config.js";
import { TerminalService } from "./terminals/terminalService.js";
import { registerTerminalRoutes } from "./terminals/terminalRoutes.js";
import { getPiWebRuntimeComponent } from "./piWebStatus.js";
import { SESSIOND_RUNTIME_CAPABILITIES } from "../shared/capabilities.js";
import { effectiveAgentConfig, effectivePiWebConfig, maxUploadBytes, spawnSessionsEnabled, subsessionsEnabled } from "../config.js";

const { config } = effectivePiWebConfig();
const agent = effectiveAgentConfig(process.env, config);
const app = Fastify({ logger: true, bodyLimit: maxUploadBytes(process.env, config) });
await app.register(fastifyWebsocket);

const eventHub = new SessionEventHub();
const workspaceActivity = new WorkspaceActivityService(eventHub);
const auth = new AuthService({ agentDir: agent.dir });
const spawnTargets = spawnSessionsEnabled(process.env, config)
  ? new ProjectScopedSpawnTargetResolver({ projects: new ProjectService(new ProjectStore()), workspaces: new WorkspaceService() })
  : undefined;
const sessions = new PiSessionService(eventHub, {
  modelRegistry: auth.modelRegistry,
  agentDir: agent.dir,
  workspaceActivity,
  logger: app.log,
  ...(spawnTargets === undefined ? {} : { spawnTargets }),
  subsessionsEnabled: spawnTargets !== undefined && subsessionsEnabled(process.env, config),
  sessionManager: createPiSessionManagerGateway({ agentDir: agent.dir, sessionDirEnvKeys: agent.sessionDirEnvKeys }),
});
auth.subscribe((change) => { sessions.applyAuthChange(change); });
const terminals = new TerminalService(eventHub, workspaceActivity);
registerWorkspaceActivityRoutes(app, workspaceActivity);
registerAuthRoutes(app, auth);
registerSessionRoutes(app, sessions, eventHub);
registerTerminalRoutes(app, terminals);

app.get("/health", () => {
  const runtime = getPiWebRuntimeComponent("sessiond", SESSIOND_RUNTIME_CAPABILITIES);
  return {
    ok: true,
    activeSessions: sessions.activeCount(),
    checkedAt: new Date().toISOString(),
    version: {
      component: runtime.component,
      label: runtime.label,
      ...(runtime.runtimeVersion === undefined ? {} : { runtimeVersion: runtime.runtimeVersion }),
      stale: false,
      available: runtime.available,
    },
  };
});

app.get("/runtime", () => getPiWebRuntimeComponent("sessiond", SESSIOND_RUNTIME_CAPABILITIES));

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
