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
import { effectivePiWebConfig, maxUploadBytes, scheduledTasksEnabled, spawnSessionsEnabled, subsessionsEnabled } from "../config.js";
import { PushService } from "./push/pushService.js";
import { PushSubscriptionStore } from "./push/pushSubscriptionStore.js";
import { ScheduledTaskRunStore } from "./storage/scheduledTaskRunStore.js";
import { ScheduledTaskStore } from "./storage/scheduledTaskStore.js";
import { ScheduledTaskScheduler } from "./scheduledTasks/scheduledTaskScheduler.js";
import { ScheduledTaskService } from "./scheduledTasks/scheduledTaskService.js";
import { registerScheduledTaskRoutes } from "./scheduledTasks/scheduledTaskRoutes.js";

const { config } = effectivePiWebConfig();
const app = Fastify({ logger: true, bodyLimit: maxUploadBytes(process.env, config) });
await app.register(fastifyWebsocket);

const eventHub = new SessionEventHub();
const workspaceActivity = new WorkspaceActivityService(eventHub);
const auth = new AuthService();
const projects = new ProjectService(new ProjectStore());
const workspaces = new WorkspaceService();
const spawnTargets = spawnSessionsEnabled(process.env, config)
  ? new ProjectScopedSpawnTargetResolver({ projects, workspaces })
  : undefined;
const pushStore = new PushSubscriptionStore();
const pushService = new PushService(config, pushStore, { logger: app.log });
const sessions = new PiSessionService(eventHub, {
  modelRegistry: auth.modelRegistry,
  workspaceActivity,
  logger: app.log,
  pushNotifier: pushService,
  ...(spawnTargets === undefined ? {} : { spawnTargets }),
  subsessionsEnabled: spawnTargets !== undefined && subsessionsEnabled(process.env, config),
});
auth.subscribe((change) => { sessions.applyAuthChange(change); });
const terminals = new TerminalService(eventHub, workspaceActivity);
registerWorkspaceActivityRoutes(app, workspaceActivity);
registerAuthRoutes(app, auth);
registerSessionRoutes(app, sessions, eventHub);
registerTerminalRoutes(app, terminals);

const scheduledTaskStore = new ScheduledTaskStore();
const scheduledTaskRunStore = new ScheduledTaskRunStore();
const scheduledTaskService = new ScheduledTaskService(scheduledTaskStore, scheduledTaskRunStore, projects, workspaces);
const scheduledTaskScheduler = new ScheduledTaskScheduler({
  store: scheduledTaskStore,
  runs: scheduledTaskRunStore,
  service: scheduledTaskService,
  sessions,
  pushNotifier: pushService,
  logger: app.log,
});
if (scheduledTasksEnabled(process.env, config)) {
  registerScheduledTaskRoutes(app, scheduledTaskService, scheduledTaskScheduler);
  await scheduledTaskScheduler.start();
}

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
  scheduledTaskScheduler.dispose();
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
