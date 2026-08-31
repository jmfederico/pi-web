#!/usr/bin/env node
import { mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import Fastify from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import { WorkspaceActivityService } from "./activity/workspaceActivityService.js";
import { MachineStatusService } from "./status/machineStatusService.js";
import { registerMachineStatusRoutes } from "./status/machineStatusRoutes.js";
import { CachedWorkspaceAttribution } from "./status/workspaceAttribution.js";
import { SessionEventHub } from "./realtime/sessionEventHub.js";
import { PushSubscriptionStore, defaultPushSubscriptionFilePath } from "./push/pushSubscriptionStore.js";
import { createWebPushRuntime } from "./push/webPushRuntime.js";
import { registerPushRoutes } from "./push/pushRoutes.js";
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
import { ProjectService } from "./projects/projectService.js";
import { ProjectStore, projectStorePath } from "./storage/projectStore.js";
import {
  eligibleWorkspaceProviderContributions,
  WorkspaceProviderRegistry,
} from "./workspaces/workspaceProviderRegistry.js";
import { sessiondSocketPath } from "../sessiond/config.js";
import { TerminalService } from "./terminals/terminalService.js";
import { registerTerminalRoutes } from "./terminals/terminalRoutes.js";
import { getPiWebRuntimeComponent } from "./piWebStatus.js";
import { SESSIOND_RUNTIME_CAPABILITIES } from "../shared/capabilities.js";
import { agentSessionDirEnvOverride, effectivePiWebConfig, maxUploadBytes, offlineModeEnabled, PI_CODING_AGENT_DIR_ENV, PI_CODING_AGENT_SESSION_DIR_ENV } from "../config.js";
import { createFilePiWebConfigService } from "./configRoutes.js";
import { createActiveAgentProfileDescriptor } from "../sessiond/activeAgentProfile.js";
import { loadServerPluginRecoveryConfig } from "../serverPluginRecovery.js";
import { DefaultPiPackageProvider, PiWebPluginCatalog } from "./piWebPluginCatalog.js";
import { createDefaultPiPackageService } from "./piPackageService.js";
import { PiPackageDismissalStore, piPackageDismissalStorePath } from "./storage/piPackageDismissalStore.js";
import { reconcileAutoInstallablePiPackages } from "./sessiond/autoInstallPiPackages.js";
import { applyAgentHttpIdleTimeout } from "./sessiond/agentHttpDispatcher.js";
import { scrubNonAgentVisibleEnvKeys } from "./sessiond/agentProcessEnvironment.js";
import { claimSessiondStateOwnership } from "./sessiond/sessiondStateOwnership.js";
import { dockerEnvironmentPromptSections } from "./sessions/dockerEnvironmentFacts.js";
import { PI_WEB_SESSION_ENV, sessionEnvironmentPromptSections } from "./sessions/sessionEnvironmentFacts.js";
import { createServerPluginExecFile } from "./plugins/serverPluginExec.js";
import { createServerPluginRuntime } from "./plugins/serverPluginRuntime.js";
import { runSessionDaemonShutdown } from "./sessiond/sessionDaemonShutdown.js";
import { sessionServiceDependencies } from "./sessiond/sessionServiceDependencies.js";
import { registerWorkspaceCatalogRoutes } from "./sessiond/workspaceCatalogRoutes.js";
import { registerPluginBackendRoutes } from "./sessiond/pluginBackendRoutes.js";
import { registerWorkspaceRemovalRoutes } from "./sessiond/workspaceRemovalRoutes.js";
import { createWorkspaceProviderRuntimeSnapshot } from "./workspaces/workspaceCatalog.js";
import { workspaceIdFor } from "./workspaces/workspaceIdentity.js";
import { WorkspaceRemovalService } from "./workspaces/workspaceRemovalService.js";

const daemonEnvironment: NodeJS.ProcessEnv = Object.freeze({ ...process.env });
const serverPluginRecovery = loadServerPluginRecoveryConfig({ env: daemonEnvironment });
const { config, deprecatedAgentInputs } = effectivePiWebConfig({ env: daemonEnvironment });
// The session service re-reads the config file at request time (e.g. for the
// attachments default folder), so Settings edits apply without a daemon
// restart; the daemon's own startup toggles keep using the snapshot above.
const configService = createFilePiWebConfigService({ env: daemonEnvironment });
const activeAgentProfile = createActiveAgentProfileDescriptor(config.agent);
// Normalize the resolved agent state locations into the canonical pi SDK env
// vars before anything agent-visible can spawn: the embedded SDK's own
// resolution (getAgentDir(), its session-dir override), terminals, the bash
// tool, and subsessions then all observe the same values by inheritance. The
// exported canonical values are fully resolved, so agent processes that also
// inherit the deprecated PI_WEB_AGENT_* aliases still resolve to the same
// locations.
process.env[PI_CODING_AGENT_DIR_ENV] = activeAgentProfile.dir;
const agentSessionDirOverride = agentSessionDirEnvOverride(daemonEnvironment);
if (agentSessionDirOverride !== undefined) {
  process.env[PI_CODING_AGENT_SESSION_DIR_ENV] = agentSessionDirOverride;
}
// Deliberately agent-visible nesting marker: every process spawned from a
// session can tell it runs inside this pi-web instance. The session
// environment facts below explain the precautions that follow from it.
process.env[PI_WEB_SESSION_ENV] = "1";
const app = Fastify({ logger: true, bodyLimit: maxUploadBytes(daemonEnvironment, config) });
if (deprecatedAgentInputs.length > 0) {
  app.log.warn({ deprecatedAgentInputs }, "deprecated agent configuration inputs detected; support will be removed in a future release");
}
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

// Agent-executed processes (bash tool, terminals, subsessions) are spawned from
// this process and inherit its environment. The scrub removes only the keys
// that silently distort the tools agents run; the daemon's PI_WEB_* wiring
// stays visible on purpose, because a nested instance resolving the same state
// now fails loudly through the ownership claim below instead of corrupting it
// silently. The daemon keeps using the captured daemonEnvironment above; its
// runtime stores resolve their paths from it explicitly below.
const scrubbedEnvKeys = scrubNonAgentVisibleEnvKeys(process.env);
app.log.info({ scrubbedEnvKeys }, "daemon-only environment keys hidden from agent processes");

// Claim ownership of the instance's durable state before any runtime store can
// touch it: a second daemon resolving the same data directory finds a live
// owner here and fails with an actionable error. Service and tsx-watch
// restarts briefly overlap the outgoing daemon, so the claim waits out a short
// grace for it to release first. The web/API process of this instance shares
// the data directory but never claims it.
const stateOwnership = await claimSessiondStateOwnership({ env: daemonEnvironment, logger: app.log });

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
  // Apply the active agent profile's httpIdleTimeoutMs before any other
  // startup work so even catalog-refresh fetches run under the configured
  // HTTP idle timeouts (issue #113).
  const appliedHttpIdleTimeout = applyAgentHttpIdleTimeout({ agentDir: activeAgentProfile.dir, cwd: process.cwd() });
  if (appliedHttpIdleTimeout.warning !== undefined) {
    app.log.warn({ httpIdleTimeoutMs: appliedHttpIdleTimeout.timeoutMs }, appliedHttpIdleTimeout.warning);
  } else {
    app.log.info({ httpIdleTimeoutMs: appliedHttpIdleTimeout.timeoutMs }, "applied agent profile HTTP idle timeout to the session daemon HTTP stack");
  }
  // Best-effort, non-fatal reconciliation of Pi packages PI WEB ships "out of
  // the box" (currently just the Relays plugin's @jmfederico/pi-relay
  // package): installs one for the active agent profile, the same way the
  // manual Settings UI Install action would, unless it is already configured
  // or the profile dismissed it (removed it on purpose) before. Deliberately
  // not awaited: reconciliation catches and logs its own failures internally,
  // and a slow or failed install must never delay or block daemon startup.
  void reconcileAutoInstallablePiPackages({
    profileDir: activeAgentProfile.dir,
    packageProvider: new DefaultPiPackageProvider(process.cwd(), activeAgentProfile.dir),
    installer: createDefaultPiPackageService(process.cwd(), activeAgentProfile.dir),
    dismissalChecker: new PiPackageDismissalStore(piPackageDismissalStorePath(daemonEnvironment)),
    logger: app.log,
  }).catch((error: unknown) => {
    app.log.warn({ err: error }, "Pi package auto-install reconciliation failed unexpectedly; continuing without it");
  });
  const serverPlugins = await createServerPluginRuntime({
    catalog: serverPluginCatalog,
    ...(serverPluginRecovery.safeStart === undefined ? {} : { safeStart: serverPluginRecovery.safeStart }),
    logger: app.log,
    execFile: createServerPluginExecFile({ env: daemonEnvironment }),
  });
  try {
    const eventHub = new SessionEventHub();
    // Web Push: the subscription store always loads (subscriptions must survive restarts), while
    // delivery arms only when a complete VAPID credential set is present via file or env config.
    // A corrupted store file resets to empty: subscriptions are re-creatable client state, never user content.
    const pushStore = new PushSubscriptionStore(defaultPushSubscriptionFilePath(daemonEnvironment), {
      onPersistenceError(operation, error) {
        app.log.error({ err: error, operation }, "push subscription persistence failed");
      },
    });
    try {
      await pushStore.load();
    } catch (error) {
      app.log.warn({ err: error }, "push subscription store unreadable; continuing without stored subscriptions");
    }
    const notificationStore = new SessionNotificationStore();
    const unreadStore = new SessionUnreadStore({
      persistence: new FileSessionUnreadPersistence(defaultSessionUnreadFilePath(daemonEnvironment)),
      onPersistenceError(operation, error) {
        app.log.error({ err: error, operation }, "session unread persistence failed");
      },
    });
    await unreadStore.load();
    // Activity and status are mutually dependent by design: the record notifies
    // the projection, the projection reads the record. The notification runs
    // long after both are constructed.
    const workspaceActivity = new WorkspaceActivityService(() => { machineStatus.notifyChanged(); });
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
    const projects = new ProjectService(new ProjectStore(projectStorePath(daemonEnvironment)));
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
    const statusAttribution = new CachedWorkspaceAttribution({
      projects,
      workspaces: workspaceProviders,
      logger: app.log,
    });
    const machineStatus = new MachineStatusService({
      activity: workspaceActivity,
      unread: unreadStore,
      attribution: statusAttribution,
      publisher: { publish: (snapshot) => { eventHub.publishRealtime({ type: "machine.status", status: snapshot }); } },
      logger: app.log,
    });
    // Every global subscriber is handed the current projection on connect, so a
    // browser never has to reconcile a snapshot fetch against live frames.
    eventHub.setGlobalJoinFrame(() => ({ type: "machine.status", status: machineStatus.snapshot() }));
    // Unread state was loaded from disk above, so the projection is computed
    // once at startup instead of waiting for the first change. It is not
    // awaited: resolving it lists workspaces through provider plugins, and
    // daemon startup must not depend on how long that takes.
    machineStatus.notifyChanged();
    const projectWorkspaceDeps = { projects, workspaces: workspaceProviders };
    const spawnTargets = config.spawnSessions ? new ProjectScopedSpawnTargetResolver(projectWorkspaceDeps) : undefined;
    const sessions = new PiSessionService(eventHub, sessionServiceDependencies({
      modelRuntime: auth.runtime,
      agentDir: activeAgentProfile.dir,
      archiveStore: new SessionArchiveStore(defaultSessionArchiveFilePath(daemonEnvironment)),
      workspaceActivity,
      logger: app.log,
      ...(spawnTargets === undefined ? {} : { spawnTargets }),
      subsessionsEnabled: config.subsessions,
      askUserEnabled: config.askUser,
      config: configService,
      appendSystemPromptSections: [
        // Sessions always run nested in this daemon, so they always get the
        // session environment facts; Docker deployments add their container
        // facts on top. Resolved once here, from the captured daemon
        // environment, because the deployment cannot change while the daemon
        // runs.
        ...sessionEnvironmentPromptSections({
          env: daemonEnvironment,
          enabled: config.environmentFacts,
        }),
        ...dockerEnvironmentPromptSections({
          env: daemonEnvironment,
          enabled: config.environmentFacts,
          logger: app.log,
        }),
      ],
      extensionDialogsTimeoutMs: config.extensionDialogsTimeoutMs,
      notificationStore,
      unreadStore,
      onUnreadChanged: () => { machineStatus.notifyChanged(); },
      catalogRefreshStatus: catalogRefresher,
      sessionManager: createPiSessionManagerGateway({
        agentDir: activeAgentProfile.dir,
        env: daemonEnvironment,
      }),
    }));
    // Created after the session service so notification payloads can resolve a session's cwd into
    // a deep-link route; the resolver stays lazy (per-event), the creation order only names it.
    const push = createWebPushRuntime({
      config,
      store: pushStore,
      eventHub,
      logger: app.log,
      resolveSessionCwd: (sessionId) => sessions.sessionCwd(sessionId),
      // Canonical deep-link route ids: the session cwd equals the project path for main workspaces,
      // whose workspace id is the shared workspaceIdentity formula over (projectId, path). Worktrees
      // are not covered here and keep the client-side cwd join as their fallback.
      resolveDeepLink: async (cwd) => {
        const project = (await projects.list()).find((candidate) => candidate.path === cwd);
        if (project === undefined) return undefined;
        return { projectId: project.id, workspaceId: workspaceIdFor(project.id, cwd) };
      },
    });
    auth.subscribe((change) => { sessions.applyAuthChange(change); });
    const terminals = new TerminalService(eventHub, workspaceActivity);
    const workspaceRemovals = new WorkspaceRemovalService(workspaceProviders, terminals);
    const runtimeComponent = Object.freeze({
      // The deprecated-input report is fixed at startup: it was detected from
      // the captured pre-scrub daemon environment and the config snapshot this
      // daemon actually honors, so it stays accurate for this daemon lifetime
      // and clears only when the inputs are removed and the daemon restarts.
      ...getPiWebRuntimeComponent("sessiond", SESSIOND_RUNTIME_CAPABILITIES, deprecatedAgentInputs),
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
          pushSubscriptions: pushStore,
          closeServer: () => app.close(),
        },
        onFailure: () => { process.exitCode = 1; },
      });
      // Release last: the daemon owns the instance state until everything that
      // writes it is down. Best-effort; a leftover marker goes stale and the
      // next start discards it.
      await stateOwnership.release();
    };
    return { eventHub, push, machineStatus, statusAttribution, auth, sessions, terminals, unreadStore, activeAgentProfile, runtimeComponent, catalogRefresher, serverPlugins, projects, workspaceProviders, workspaceProviderRuntime, workspaceRemovals, shutdown };
  } catch (error) {
    try {
      await serverPlugins.stop();
    } catch (disposeError) {
      app.log.error({ err: disposeError }, "session daemon construction failed and server plugin disposal was incomplete");
    }
    throw error;
  }
}

function registerSessionDaemonRoutes({ eventHub, push, machineStatus, statusAttribution, auth, sessions, terminals, runtimeComponent, projects, workspaceProviders, workspaceProviderRuntime, workspaceRemovals }: SessionDaemonRuntime): void {
  registerMachineStatusRoutes(app, machineStatus);
  registerAuthRoutes(app, auth);
  registerSessionRoutes(app, sessions, eventHub);
  registerPushRoutes(app, push);
  registerTerminalRoutes(app, terminals);
  registerWorkspaceCatalogRoutes(app, {
    projects,
    workspaces: workspaceProviders,
    providerRuntime: workspaceProviderRuntime,
  });
  registerPluginBackendRoutes(app, {
    projects,
    backends: workspaceProviders,
    onWorkspacesMutated: () => { statusAttribution.invalidate(); },
  });
  registerWorkspaceRemovalRoutes(app, {
    projects,
    removals: workspaceRemovals,
    onWorkspacesMutated: () => { statusAttribution.invalidate(); },
  });

  app.get("/health", () => ({
    ok: true,
    activeSessions: sessions.activeCount(),
    checkedAt: new Date().toISOString(),
    version: {
      component: runtimeComponent.component,
      label: runtimeComponent.label,
      ...(runtimeComponent.runtimeVersion === undefined ? {} : { runtimeVersion: runtimeComponent.runtimeVersion }),
      ...(runtimeComponent.piVersion === undefined ? {} : { piVersion: runtimeComponent.piVersion }),
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
    const path = sessiondSocketPath(daemonEnvironment);
    await mkdir(dirname(path), { recursive: true });
    await rm(path, { force: true });
    await app.listen({ path });
    process.on("exit", () => void rm(path, { force: true }));
  }
}
