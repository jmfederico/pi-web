#!/usr/bin/env node
import { mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import Fastify from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import { WorkspaceActivityService } from "./activity/workspaceActivityService.js";
import { registerWorkspaceActivityRoutes } from "./activity/workspaceActivityRoutes.js";
import { SessionEventHub } from "./realtime/sessionEventHub.js";
import { AuthService } from "./sessions/authService.js";
import { bootstrapAndFreezeGlobalExtensionProviders } from "./sessions/globalProviderPolicy.js";
import { registerAuthRoutes } from "./sessions/authRoutes.js";
import { ModelCatalogRefresher } from "./sessions/modelCatalogRefresher.js";
import { PiSessionService } from "./sessions/piSessionService.js";
import { createPiSessionManagerGateway } from "./sessions/piSessionManagerGateway.js";
import { registerSessionRoutes } from "./sessions/sessionRoutes.js";
import { SessionNotificationStore } from "./sessions/sessionNotificationStore.js";
import { FileSessionUnreadPersistence, SessionUnreadStore } from "./sessions/sessionUnreadStore.js";
import { ThroughputTracker, defaultThroughputFilePath } from "./sessions/throughputTracker.js";
import { ProjectScopedSpawnTargetResolver } from "./sessions/spawnTargetResolver.js";
import { RegisteredProjectWorkspaceCwds } from "./workspaces/projectWorkspaceCwds.js";
import { ProjectService } from "./projects/projectService.js";
import { ProjectStore } from "./storage/projectStore.js";
import { WorkspaceService } from "./workspaces/workspaceService.js";
import { sessiondSocketPath } from "../sessiond/config.js";
import { TerminalService } from "./terminals/terminalService.js";
import { registerTerminalRoutes } from "./terminals/terminalRoutes.js";
import { getPiWebRuntimeComponent } from "./piWebStatus.js";
import { SESSIOND_RUNTIME_CAPABILITIES } from "../shared/capabilities.js";
import { agentSessionDirEnvKeys, effectivePiWebConfig, maxUploadBytes, offlineModeEnabled } from "../config.js";
import { createActiveAgentProfileDescriptor } from "../sessiond/activeAgentProfile.js";
import { sessionServiceDependencies } from "./sessiond/sessionServiceDependencies.js";

const daemonEnvironment: NodeJS.ProcessEnv = Object.freeze({ ...process.env });
const { config } = effectivePiWebConfig({ env: daemonEnvironment });
const activeAgentProfile = createActiveAgentProfileDescriptor({
  command: config.agent.command,
  dir: config.agent.dir,
  sessionDirEnvKeys: agentSessionDirEnvKeys(config.agent.command),
});
const app = Fastify({ logger: true, bodyLimit: maxUploadBytes(daemonEnvironment, config) });
await app.register(fastifyWebsocket);

const runtime = await createSessionDaemonRuntime();
registerSessionDaemonRoutes(runtime);
await listenSessionDaemon(runtime);

type SessionDaemonRuntime = Awaited<ReturnType<typeof createSessionDaemonRuntime>>;

async function createSessionDaemonRuntime() {
  const eventHub = new SessionEventHub();
  const notificationStore = new SessionNotificationStore();
  const unreadStore = new SessionUnreadStore({
    persistence: new FileSessionUnreadPersistence(),
    onPersistenceError(operation, error) {
      app.log.error({ err: error, operation }, "session unread persistence failed");
    },
  });
  await unreadStore.load();
  // Hydrate the throughput history before any session can finish a turn, so
  // the first `agent_end` after startup already has prior averages to fold in.
  const throughputTracker = new ThroughputTracker(defaultThroughputFilePath());
  await throughputTracker.load();
  const workspaceActivity = new WorkspaceActivityService(eventHub);
  const auth = await AuthService.create({ agentDir: activeAgentProfile.dir, logger: app.log });
  // Capture providers registered by global extensions while the runtime is
  // still mutable, then freeze every later extension-provider mutation before
  // any real session can load project resources.
  await bootstrapAndFreezeGlobalExtensionProviders(auth.runtime, activeAgentProfile.dir, app.log);
  // The shared model runtime is constructed offline so request paths never
  // wait on provider-catalog fetches; this is the single bounded network
  // refresher, and auth changes (login/logout) ask it for a prompt run. It
  // stays fully inert when the operator asked for offline behavior.
  const catalogRefresher = new ModelCatalogRefresher({
    runtime: auth.runtime,
    logger: app.log,
    offline: offlineModeEnabled(daemonEnvironment),
  });
  catalogRefresher.start();
  auth.subscribe(() => { catalogRefresher.requestRefresh(); });
  // Cross-workspace session relationships are reported regardless of whether
  // agents may spawn sessions: children can predate a config change, and the
  // session tree should stay honest about them either way.
  const projectWorkspaceDeps = { projects: new ProjectService(new ProjectStore()), workspaces: new WorkspaceService() };
  const projectWorkspaces = new RegisteredProjectWorkspaceCwds(projectWorkspaceDeps);
  const spawnTargets = config.spawnSessions ? new ProjectScopedSpawnTargetResolver(projectWorkspaceDeps) : undefined;
  const sessions = new PiSessionService(eventHub, sessionServiceDependencies({
    modelRuntime: auth.runtime,
    agentDir: activeAgentProfile.dir,
    workspaceActivity,
    logger: app.log,
    ...(spawnTargets === undefined ? {} : { spawnTargets }),
    projectWorkspaces,
    subsessionsEnabled: config.subsessions,
    askUserEnabled: config.askUser,
    extensionDialogsTimeoutMs: config.extensionDialogsTimeoutMs,
    notificationStore,
    unreadStore,
    throughputTracker,
    catalogRefreshStatus: catalogRefresher,
    sessionManager: createPiSessionManagerGateway({
      agentDir: activeAgentProfile.dir,
      env: daemonEnvironment,
      sessionDirEnvKeys: activeAgentProfile.sessionDirEnvKeys,
    }),
  }));
  auth.subscribe((change) => { sessions.applyAuthChange(change); });
  const terminals = new TerminalService(eventHub, workspaceActivity);
  const runtimeComponent = Object.freeze({
    ...getPiWebRuntimeComponent("sessiond", SESSIOND_RUNTIME_CAPABILITIES),
    activeAgentProfile,
  });
  return { eventHub, workspaceActivity, auth, sessions, terminals, unreadStore, activeAgentProfile, runtimeComponent, catalogRefresher };
}

function registerSessionDaemonRoutes({ eventHub, workspaceActivity, auth, sessions, terminals, runtimeComponent }: SessionDaemonRuntime): void {
  registerWorkspaceActivityRoutes(app, workspaceActivity);
  registerAuthRoutes(app, auth);
  registerSessionRoutes(app, sessions, eventHub);
  registerTerminalRoutes(app, terminals);

  app.get("/health", () => ({
    ok: true,
    activeSessions: sessions.activeCount(),
    checkedAt: new Date().toISOString(),
    version: {
      component: runtimeComponent.component,
      label: runtimeComponent.label,
      ...(runtimeComponent.runtimeVersion === undefined ? {} : { runtimeVersion: runtimeComponent.runtimeVersion }),
      stale: false,
      available: runtimeComponent.available,
    },
  }));

  app.get("/runtime", () => runtimeComponent);
}

async function listenSessionDaemon({ auth, sessions, terminals, unreadStore, catalogRefresher }: SessionDaemonRuntime): Promise<void> {
  let shuttingDown = false;
  async function shutdown(signal: NodeJS.Signals): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, "shutting down session daemon");
    const attempt = async (operation: string, run: () => void | Promise<void>): Promise<void> => {
      try {
        await run();
      } catch (error: unknown) {
        process.exitCode = 1;
        app.log.error({ err: error, operation }, "session daemon shutdown operation failed");
      }
    };
    await attempt("dispose terminals", () => { terminals.dispose(); });
    await attempt("dispose catalog refresher", () => { catalogRefresher.dispose(); });
    await attempt("dispose auth", () => { auth.dispose(); });
    await attempt("dispose sessions", () => sessions.dispose());
    await attempt("flush session unread state", () => unreadStore.flush());
    await attempt("close server", () => app.close());
  }

  process.once("SIGINT", (signal) => { void shutdown(signal); });
  process.once("SIGTERM", (signal) => { void shutdown(signal); });

  const portValue = daemonEnvironment["PI_WEB_SESSIOND_PORT"];
  const port = portValue !== undefined && portValue !== "" ? Number(portValue) : undefined;
  const host = daemonEnvironment["PI_WEB_SESSIOND_HOST"] ?? "127.0.0.1";

  if (port !== undefined) {
    await app.listen({ port, host });
  } else {
    const path = sessiondSocketPath();
    await mkdir(dirname(path), { recursive: true });
    await rm(path, { force: true });
    await app.listen({ path });
    process.on("exit", () => void rm(path, { force: true }));
  }
}
