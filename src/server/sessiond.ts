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
import { ProjectScopedSpawnTargetResolver } from "./sessions/spawnTargetResolver.js";
import { RegisteredProjectWorkspaceCwds } from "./workspaces/projectWorkspaceCwds.js";
import { ProjectService } from "./projects/projectService.js";
import { ProjectStore } from "./storage/projectStore.js";
import {
  eligibleWorkspaceProviderContributions,
  WorkspaceProviderRegistry,
} from "./workspaces/workspaceProviderRegistry.js";
import { sessiondSocketPath } from "../sessiond/config.js";
import { TerminalService } from "./terminals/terminalService.js";
import { registerTerminalRoutes } from "./terminals/terminalRoutes.js";
import { getPiWebRuntimeComponent } from "./piWebStatus.js";
import { SESSIOND_RUNTIME_CAPABILITIES } from "../shared/capabilities.js";
import { agentSessionDirEnvKeys, effectivePiWebConfig, maxUploadBytes, offlineModeEnabled } from "../config.js";
import { createActiveAgentProfileDescriptor } from "../sessiond/activeAgentProfile.js";
import { loadServerPluginRecoveryConfig } from "../serverPluginRecovery.js";
import { PiWebPluginCatalog } from "./piWebPluginCatalog.js";
import { createServerPluginExecFile } from "./plugins/serverPluginExec.js";
import { createServerPluginRuntime } from "./plugins/serverPluginRuntime.js";
import { runSessionDaemonShutdown } from "./sessiond/sessionDaemonShutdown.js";
import { sessionServiceDependencies } from "./sessiond/sessionServiceDependencies.js";
import { registerWorkspaceCatalogRoutes } from "./sessiond/workspaceCatalogRoutes.js";
import { registerPluginBackendRoutes } from "./sessiond/pluginBackendRoutes.js";
import { registerWorkspaceRemovalRoutes } from "./sessiond/workspaceRemovalRoutes.js";
import { createWorkspaceProviderRuntimeSnapshot } from "./workspaces/workspaceCatalog.js";
import { WorkspaceRemovalService } from "./workspaces/workspaceRemovalService.js";

const daemonEnvironment: NodeJS.ProcessEnv = Object.freeze({ ...process.env });
const serverPluginRecovery = loadServerPluginRecoveryConfig({ env: daemonEnvironment });
const { config } = effectivePiWebConfig({ env: daemonEnvironment });
const activeAgentProfile = createActiveAgentProfileDescriptor({
  command: config.agent.command,
  dir: config.agent.dir,
  sessionDirEnvKeys: agentSessionDirEnvKeys(config.agent.command),
});
const app = Fastify({ logger: true, bodyLimit: maxUploadBytes(daemonEnvironment, config) });
if (serverPluginRecovery.safeStartDiagnostic !== undefined) {
  app.log.error(
    { component: "server-plugins", configPath: serverPluginRecovery.path },
    serverPluginRecovery.safeStartDiagnostic,
  );
}
await app.register(fastifyWebsocket);
let serverQuiescing = false;
app.addHook("onRequest", (_request, reply, done) => {
  if (!serverQuiescing) {
    done();
    return;
  }
  void reply.code(503).send({ error: "Session daemon is shutting down" });
});
const serverPluginCatalog = new PiWebPluginCatalog({
  cwd: process.cwd(),
  agentDir: activeAgentProfile.dir,
  configProvider: () => config,
  warningSink: (message) => { app.log.warn({ component: "server-plugins" }, message); },
});

let runtimeShutdown: (() => Promise<void>) | undefined;
let pendingShutdownSignal: NodeJS.Signals | undefined;
let shutdownStarted = false;
async function requestShutdown(signal: NodeJS.Signals): Promise<void> {
  if (shutdownStarted) return;
  if (runtimeShutdown === undefined) {
    pendingShutdownSignal = signal;
    return;
  }
  shutdownStarted = true;
  app.log.info({ signal }, "shutting down session daemon");
  await runtimeShutdown();
}
process.once("SIGINT", (signal) => { void requestShutdown(signal); });
process.once("SIGTERM", (signal) => { void requestShutdown(signal); });

const runtime = await createSessionDaemonRuntime();
try {
  registerSessionDaemonRoutes(runtime);
  await listenSessionDaemon(runtime);
} catch (error) {
  try {
    await runtime.shutdown();
  } catch (disposeError) {
    app.log.error({ err: disposeError }, "session daemon startup failed and runtime disposal was incomplete");
  }
  throw error;
}

type SessionDaemonRuntime = Awaited<ReturnType<typeof createSessionDaemonRuntime>>;

async function createSessionDaemonRuntime() {
  const serverPlugins = await createServerPluginRuntime({
    catalog: serverPluginCatalog,
    ...(serverPluginRecovery.safeStart === undefined ? {} : { safeStart: serverPluginRecovery.safeStart }),
    logger: app.log,
    execFile: createServerPluginExecFile({ env: daemonEnvironment }),
  });
  try {
    const eventHub = new SessionEventHub();
    const notificationStore = new SessionNotificationStore();
    const unreadStore = new SessionUnreadStore({
      persistence: new FileSessionUnreadPersistence(),
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
    const projects = new ProjectService(new ProjectStore());
    const providerHealth = await serverPlugins.inspectHealth();
    const workspaceProviders = new WorkspaceProviderRegistry({
      contributions: eligibleWorkspaceProviderContributions(serverPlugins.providerContributions(), providerHealth),
      logger: app.log,
    });
    const workspaceProviderRuntime = createWorkspaceProviderRuntimeSnapshot(
      serverPlugins.healthRecords(),
      providerHealth,
      serverPlugins.safeStartLevel(),
      serverPlugins.catalogDiagnostics(),
    );
    // Cross-workspace session relationships are reported regardless of whether
    // agents may spawn sessions: children can predate a config change, and the
    // session tree should stay honest about them either way.
    const projectWorkspaceDeps = { projects, workspaces: workspaceProviders };
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
      catalogRefreshStatus: catalogRefresher,
      sessionManager: createPiSessionManagerGateway({
        agentDir: activeAgentProfile.dir,
        env: daemonEnvironment,
        sessionDirEnvKeys: activeAgentProfile.sessionDirEnvKeys,
      }),
    }));
    auth.subscribe((change) => { sessions.applyAuthChange(change); });
    const terminals = new TerminalService(eventHub, workspaceActivity);
    const workspaceRemovals = new WorkspaceRemovalService(workspaceProviders, terminals);
    const runtimeComponent = Object.freeze({
      ...getPiWebRuntimeComponent("sessiond", SESSIOND_RUNTIME_CAPABILITIES),
      activeAgentProfile,
    });
    let disposed = false;
    const shutdown = async (): Promise<void> => {
      if (disposed) return;
      disposed = true;
      await runSessionDaemonShutdown({
        logger: app.log,
        dependencies: {
          quiesceServer: () => { serverQuiescing = true; },
          serverPlugins,
          terminals,
          catalogRefresher,
          auth,
          sessions,
          unreadStore,
          closeServer: () => app.close(),
        },
        onFailure: () => { process.exitCode = 1; },
      });
    };
    return { eventHub, workspaceActivity, auth, sessions, terminals, unreadStore, activeAgentProfile, runtimeComponent, catalogRefresher, serverPlugins, projects, workspaceProviders, workspaceProviderRuntime, workspaceRemovals, shutdown };
  } catch (error) {
    try {
      await serverPlugins.stop();
    } catch (disposeError) {
      app.log.error({ err: disposeError }, "session daemon construction failed and server plugin disposal was incomplete");
    }
    throw error;
  }
}

function registerSessionDaemonRoutes({ eventHub, workspaceActivity, auth, sessions, terminals, runtimeComponent, projects, workspaceProviders, workspaceProviderRuntime, workspaceRemovals }: SessionDaemonRuntime): void {
  registerWorkspaceActivityRoutes(app, workspaceActivity);
  registerAuthRoutes(app, auth);
  registerSessionRoutes(app, sessions, eventHub);
  registerTerminalRoutes(app, terminals);
  registerWorkspaceCatalogRoutes(app, {
    projects,
    workspaces: workspaceProviders,
    providerRuntime: workspaceProviderRuntime,
  });
  registerPluginBackendRoutes(app, {
    projects,
    backends: workspaceProviders,
  });
  registerWorkspaceRemovalRoutes(app, {
    projects,
    removals: workspaceRemovals,
  });

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

async function listenSessionDaemon({ shutdown }: SessionDaemonRuntime): Promise<void> {
  runtimeShutdown = shutdown;
  if (pendingShutdownSignal !== undefined) {
    await requestShutdown(pendingShutdownSignal);
    return;
  }

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
