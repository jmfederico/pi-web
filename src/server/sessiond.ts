#!/usr/bin/env node
import { mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import Fastify from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import { loadOptionalSessiondAutomationRuntime } from "./sessiond/optionalSessiondAutomationRuntime.js";
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
import { SessionArchiveStore, defaultSessionArchiveFilePath } from "./sessions/sessionArchiveStore.js";
import { FileSessionUnreadPersistence, SessionUnreadStore, defaultSessionUnreadFilePath } from "./sessions/sessionUnreadStore.js";
import { ProjectScopedSpawnTargetResolver } from "./sessions/spawnTargetResolver.js";
import { RegisteredProjectWorkspaceCwds } from "./workspaces/projectWorkspaceCwds.js";
import { ProjectService } from "./projects/projectService.js";
import { ProjectStore, projectStorePath } from "./storage/projectStore.js";
import { WorkspaceService } from "./workspaces/workspaceService.js";
import { sessiondSocketPath } from "../sessiond/config.js";
import { TerminalService } from "./terminals/terminalService.js";
import { registerTerminalRoutes } from "./terminals/terminalRoutes.js";
import { getPiWebRuntimeComponent } from "./piWebStatus.js";
import { sessiondRuntimeCapabilities } from "../shared/capabilities.js";
import { agentSessionDirEnvKeys, effectivePiWebConfig, maxUploadBytes, offlineModeEnabled } from "../config.js";
import { createActiveAgentProfileDescriptor } from "../sessiond/activeAgentProfile.js";
import { applyAgentHttpIdleTimeout } from "./sessiond/agentHttpDispatcher.js";
import { sessionServiceDependencies } from "./sessiond/sessionServiceDependencies.js";
import { scrubNonAgentVisibleEnvKeys } from "./sessiond/agentProcessEnvironment.js";

const daemonEnvironment: NodeJS.ProcessEnv = Object.freeze({ ...process.env });
const { config } = effectivePiWebConfig({ env: daemonEnvironment });
const activeAgentProfile = createActiveAgentProfileDescriptor({
  command: config.agent.command,
  dir: config.agent.dir,
  sessionDirEnvKeys: agentSessionDirEnvKeys(config.agent.command),
});
const app = Fastify({ logger: true, bodyLimit: maxUploadBytes(daemonEnvironment, config) });
await app.register(fastifyWebsocket);

// Agent-executed processes (bash tool, terminals, subsessions) are spawned from
// this process and inherit its environment, so hide the daemon's own
// configuration keys before any of them can start. The daemon keeps using the
// captured daemonEnvironment above; its runtime stores resolve their paths from
// it explicitly below.
const scrubbedEnvKeys = scrubNonAgentVisibleEnvKeys(process.env);
app.log.info({ scrubbedEnvKeys }, "daemon-only environment keys hidden from agent processes");

const runtime = await createSessionDaemonRuntime();
registerSessionDaemonRoutes(runtime);
await listenSessionDaemon(runtime);

type SessionDaemonRuntime = Awaited<ReturnType<typeof createSessionDaemonRuntime>>;

async function createSessionDaemonRuntime() {
  // Apply the active agent profile's httpIdleTimeoutMs before any other
  // startup work so even catalog-refresh fetches run under the configured
  // HTTP idle timeouts (issue #113).
  const appliedHttpIdleTimeout = applyAgentHttpIdleTimeout({ agentDir: activeAgentProfile.dir, cwd: process.cwd() });
  if (appliedHttpIdleTimeout.warning !== undefined) {
    app.log.warn({ httpIdleTimeoutMs: appliedHttpIdleTimeout.timeoutMs }, appliedHttpIdleTimeout.warning);
  } else {
    app.log.info({ httpIdleTimeoutMs: appliedHttpIdleTimeout.timeoutMs }, "applied agent profile HTTP idle timeout to the session daemon HTTP stack");
  }
  const eventHub = new SessionEventHub();
  const notificationStore = new SessionNotificationStore();
  const unreadStore = new SessionUnreadStore({
    persistence: new FileSessionUnreadPersistence(defaultSessionUnreadFilePath(daemonEnvironment)),
    onPersistenceError(operation, error) {
      app.log.error({ err: error, operation }, "session unread persistence failed");
    },
  });
  await unreadStore.load();
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
  const projectWorkspaceDeps = { projects: new ProjectService(new ProjectStore(projectStorePath(daemonEnvironment))), workspaces: new WorkspaceService() };
  const projectWorkspaces = new RegisteredProjectWorkspaceCwds(projectWorkspaceDeps);
  const spawnTargets = config.spawnSessions ? new ProjectScopedSpawnTargetResolver(projectWorkspaceDeps) : undefined;
  const sessions = new PiSessionService(eventHub, sessionServiceDependencies({
    modelRuntime: auth.runtime,
    agentDir: activeAgentProfile.dir,
    archiveStore: new SessionArchiveStore(defaultSessionArchiveFilePath(daemonEnvironment)),
    workspaceActivity,
    logger: app.log,
    ...(spawnTargets === undefined ? {} : { spawnTargets }),
    projectWorkspaces,
    subsessionsEnabled: config.subsessions,
    askUserEnabled: config.askUser,
    extensionDialogsTimeoutMs: config.extensionDialogsTimeoutMs,
    notificationStore,
    unreadStore,
    catalogRefreshStatus: catalogRefresher,
    sessionManager: createPiSessionManagerGateway({
      agentDir: activeAgentProfile.dir,
      env: daemonEnvironment,
      sessionDirEnvKeys: activeAgentProfile.sessionDirEnvKeys,
    }),
  }));
  auth.subscribe((change) => { sessions.applyAuthChange(change); });
  const terminals = new TerminalService(eventHub, workspaceActivity);
  // Keep disabled automations out of the module graph as well as the runtime:
  // no SQLite native binding, database, ownership file, or scheduler timer.
  const automations = await loadOptionalSessiondAutomationRuntime(config.automations, {
    env: daemonEnvironment,
    projects: projectWorkspaceDeps.projects,
    workspaces: projectWorkspaceDeps.workspaces,
    sessions,
    events: eventHub,
    logger: app.log,
  });
  const runtimeComponent = Object.freeze({
    ...getPiWebRuntimeComponent("sessiond", sessiondRuntimeCapabilities(config.automations)),
    activeAgentProfile,
  });
  return { eventHub, workspaceActivity, auth, sessions, terminals, unreadStore, automations, activeAgentProfile, runtimeComponent, catalogRefresher };
}

function registerSessionDaemonRoutes({ eventHub, workspaceActivity, auth, sessions, terminals, automations, runtimeComponent }: SessionDaemonRuntime): void {
  registerWorkspaceActivityRoutes(app, workspaceActivity);
  registerAuthRoutes(app, auth);
  registerSessionRoutes(app, sessions, eventHub);
  registerTerminalRoutes(app, terminals);
  automations?.registerRoutes(app);

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

async function listenSessionDaemon({ auth, sessions, terminals, unreadStore, automations, catalogRefresher }: SessionDaemonRuntime): Promise<void> {
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
    if (automations !== undefined) await attempt("stop automations scheduler", () => automations.stop());
    await attempt("dispose terminals", () => { terminals.dispose(); });
    await attempt("dispose catalog refresher", () => { catalogRefresher.dispose(); });
    await attempt("dispose auth", () => { auth.dispose(); });
    await attempt("dispose sessions", () => sessions.dispose());
    await attempt("flush session unread state", () => unreadStore.flush());
    await attempt("close server", () => app.close());
    // Keep the durable scheduler fence until the listener and every session
    // runtime have stopped, preventing split-owner restart races.
    if (automations !== undefined) await attempt("dispose automations scheduler fence", () => { automations.dispose(); });
  }

  process.once("SIGINT", (signal) => { void shutdown(signal); });
  process.once("SIGTERM", (signal) => { void shutdown(signal); });

  // Fence the durable scheduler before touching the listener. A second daemon
  // must not unlink the active socket or recover/dispatch the same database.
  automations?.acquireOwnership();

  const portValue = daemonEnvironment["PI_WEB_SESSIOND_PORT"];
  const port = portValue !== undefined && portValue !== "" ? Number(portValue) : undefined;
  const host = daemonEnvironment["PI_WEB_SESSIOND_HOST"] ?? "127.0.0.1";

  if (port !== undefined) {
    await app.listen({ port, host });
  } else {
    const path = sessiondSocketPath(daemonEnvironment);
    await mkdir(dirname(path), { recursive: true });
    await rm(path, { force: true });
    await app.listen({ path });
    process.on("exit", () => void rm(path, { force: true }));
  }

  automations?.start();
}
