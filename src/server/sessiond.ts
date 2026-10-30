#!/usr/bin/env node
import { mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { MAINTENANCE_TERMINAL_CAPABILITY } from "./terminals/maintenanceTerminalCapability.js";
import { resolveMaintenanceExecutionContext } from "./terminals/maintenanceExecutionContext.js";
import Fastify from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import { registerTerminalStatusRoutes } from "./terminals/terminalStatusRoutes.js";
import { WorkspaceActivityService } from "./activity/workspaceActivityService.js";
import { MachineStatusService } from "./status/machineStatusService.js";
import { registerMachineStatusRoutes } from "./status/machineStatusRoutes.js";
import { CachedWorkspaceAttribution } from "./status/workspaceAttribution.js";
import { SessionEventHub } from "./realtime/sessionEventHub.js";
import { ServerNoticeStore } from "./notices/serverNoticeStore.js";
import { ServerNoticeService } from "./notices/serverNoticeService.js";
import { registerServerNoticeRoutes } from "./notices/serverNoticeRoutes.js";
import { AuthService } from "./sessions/authService.js";
import { bootstrapAndFreezeGlobalExtensionProviders } from "./sessions/globalProviderPolicy.js";
import { registerAuthRoutes } from "./sessions/authRoutes.js";
import { registerMcpAuthRoutes } from "./sessions/mcpAuthRoutes.js";
import { ModelCatalogRefresher } from "./sessions/modelCatalogRefresher.js";
import { PiSessionService } from "./sessions/piSessionService.js";
import { createPiSessionManagerGateway } from "./sessions/piSessionManagerGateway.js";
import { registerSessionRoutes } from "./sessions/sessionRoutes.js";
import { SessionNotificationStore } from "./sessions/sessionNotificationStore.js";
import { SessionArchiveStore, defaultSessionArchiveFilePath } from "./sessions/sessionArchiveStore.js";
import { FileSessionUnreadPersistence, SessionUnreadStore, defaultSessionUnreadFilePath } from "./sessions/sessionUnreadStore.js";
import { ProjectScopedSpawnTargetResolver } from "./sessions/spawnTargetResolver.js";
import { ProjectService } from "./projects/projectService.js";
import { ProjectLifecycleService } from "./projects/projectLifecycleService.js";
import { registerProjectMutationRoutes } from "./sessiond/projectMutationRoutes.js";
import { ProjectStore, projectStorePath } from "./storage/projectStore.js";
import { SessionPinStore, sessionPinStorePath } from "./storage/sessionPinStore.js";
import { navigationPreferenceStorePath } from "./storage/navigationPreferenceStore.js";
import { registerSessionPinRoutes } from "./navigationPreferenceRoutes.js";
import { PI_WEB_HOST_SESSION_LIFECYCLE_CAPABILITY } from "../shared/pluginSessionLifecycleTypes.js";
import { createServerPluginSessionLifecycleCapabilityFactory } from "./plugins/serverPluginSessionLifecycleCapability.js";
import { registerPluginSessionLifecycleRoutes } from "./sessiond/pluginSessionLifecycleRoutes.js";
import {
  eligibleWorkspaceProviderContributions,
  WorkspaceProviderRegistry,
} from "./workspaces/workspaceProviderRegistry.js";
import { sessiondSocketPath } from "../sessiond/config.js";
import {
  PI_WEB_HOST_PI_SESSIONS_CAPABILITY,
  PI_WEB_HOST_PI_SESSION_EVENTS_CAPABILITY,
  PI_WEB_HOST_WORKSPACES_CAPABILITY,
} from "../server-plugin-api.js";
import { getPiWebRuntimeComponent } from "./piWebStatus.js";
import { SESSIOND_RUNTIME_CAPABILITIES } from "../shared/capabilities.js";
import { agentSessionDirEnvOverride, effectivePiWebConfig, maxUploadBytes, offlineModeEnabled, piWebDataDir, sessionArchiveDirectory, PI_CODING_AGENT_DIR_ENV, PI_CODING_AGENT_SESSION_DIR_ENV } from "../config.js";
import { createFilePiWebConfigService } from "./configRoutes.js";
import { createActiveAgentProfileDescriptor } from "../sessiond/activeAgentProfile.js";
import { loadServerPluginRecoveryConfig } from "../serverPluginRecovery.js";
import { PiWebPluginCatalog } from "./piWebPluginCatalog.js";
import { createAutoInstallPiPackageProfile } from "./sessiond/autoInstallPiPackageSources.js";
import { PiPackageDismissalStore, piPackageDismissalStorePath } from "./storage/piPackageDismissalStore.js";
import { reconcileAutoInstallablePiPackages } from "./sessiond/autoInstallPiPackages.js";
import { applyAgentHttpIdleTimeout } from "./sessiond/agentHttpDispatcher.js";
import { scrubNonAgentVisibleEnvKeys } from "./sessiond/agentProcessEnvironment.js";
import { claimSessiondStateOwnership } from "./sessiond/sessiondStateOwnership.js";
import { dockerEnvironmentPromptSections } from "./sessions/dockerEnvironmentFacts.js";
import { PI_WEB_SESSION_ENV, sessionEnvironmentPromptSections } from "./sessions/sessionEnvironmentFacts.js";
import { createServerPluginExecFile } from "./plugins/serverPluginExec.js";
import { createServerPluginRuntime } from "./plugins/serverPluginRuntime.js";
import { ProjectPluginSettingsSnapshots } from "./plugins/projectPluginSettings.js";
import { createWorkspaceNotificationCommandFactory } from "./workspaces/workspaceNotificationCommand.js";
import { WorkspaceChangeNotifier } from "./workspaces/workspaceChangeNotifier.js";
import { registerWorkspaceNotificationRoutes } from "./sessiond/workspaceNotificationRoutes.js";
import { createServerPluginPiSessionsCapabilityFactory } from "./plugins/serverPluginPiSessionsCapability.js";
import { createServerPluginPiSessionEventsCapabilityFactory } from "./plugins/serverPluginPiSessionEventsCapability.js";
import { createServerPluginWorkspacesCapabilityFactory } from "./plugins/serverPluginWorkspacesCapability.js";
import { createServerPluginCatalogCapabilityFactory } from "./plugins/serverPluginCatalogCapability.js";
import { PI_WEB_HOST_CATALOG_CAPABILITY } from "../shared/pluginCatalogTypes.js";
import { registerPluginCatalogRoutes } from "./sessiond/pluginCatalogRoutes.js";
import {
  REQUIRED_TERMINAL_SERVICE_CAPABILITY,
  unavailableRequiredTerminalService,
} from "./terminals/requiredTerminalService.js";
import {
  eligiblePluginBackendContributions,
  PluginBackendRegistry,
} from "./plugins/pluginBackendRegistry.js";
import { runSessionDaemonShutdown } from "./sessiond/sessionDaemonShutdown.js";
import { sessionServiceDependencies } from "./sessiond/sessionServiceDependencies.js";
import { PiSessionEventConnections } from "./sessions/piSessionEventConnections.js";
import { bindCompanionBackend } from "./sessions/companionBackend.js";
import { registerWorkspaceCatalogRoutes } from "./sessiond/workspaceCatalogRoutes.js";
import { registerPluginBackendChannelRoutes } from "./sessiond/pluginBackendChannelRoutes.js";
import { installPluginBackendChannelWebSocketPayloadLimit } from "./webSocketBridge.js";
import { registerPluginBackendResourceRoutes } from "./sessiond/pluginBackendResourceRoutes.js";
import { registerPairedPluginBackendRoutes } from "./sessiond/pluginBackendRoutes.js";
import { registerWorkspaceRemovalRoutes } from "./sessiond/workspaceRemovalRoutes.js";
import { createWorkspaceProviderRuntimeSnapshot } from "./workspaces/workspaceCatalog.js";
import { WorkspaceRemovalService } from "./workspaces/workspaceRemovalService.js";

const daemonEnvironment: NodeJS.ProcessEnv = Object.freeze({ ...process.env });
const daemonLaunchCwd = process.cwd();
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
installPluginBackendChannelWebSocketPayloadLimit(app.websocketServer);
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
// Capture the prepared child environment, not daemonEnvironment: it includes
// the canonical active profile and nesting marker, without daemon-only keys.
const childProcessEnvironment = Object.freeze({ ...process.env });
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
  // Configure HTTP policy before catalog/session fetches. The result distinguishes
  // applied Node dispatcher settings from unsupported Bun timeout configuration.
  const httpIdleTimeout = applyAgentHttpIdleTimeout({ agentDir: activeAgentProfile.dir, cwd: process.cwd() });
  if (httpIdleTimeout.warning !== undefined) {
    app.log.warn({ requestedHttpIdleTimeoutMs: httpIdleTimeout.timeoutMs, httpIdleTimeoutApplied: httpIdleTimeout.applied }, httpIdleTimeout.warning);
  } else if (httpIdleTimeout.applied) {
    app.log.info({ httpIdleTimeoutMs: httpIdleTimeout.timeoutMs }, "applied agent profile HTTP idle timeout to the session daemon HTTP stack");
  }
  // Reconcile local bundled sources before plugin/resource snapshots can load
  // an obsolete copy. Failures remain non-fatal and are logged per package.
  await reconcileAutoInstallablePiPackages({
    profileDir: activeAgentProfile.dir,
    ...createAutoInstallPiPackageProfile(activeAgentProfile.dir),
    dismissalChecker: new PiPackageDismissalStore(piPackageDismissalStorePath(daemonEnvironment)),
    logger: app.log,
  }).catch((error: unknown) => {
    app.log.warn({ err: error }, "Pi package auto-install reconciliation failed unexpectedly; continuing without it");
  });
  const eventHub = new SessionEventHub();
  const serverNotices = new ServerNoticeService(new ServerNoticeStore(), eventHub);
  const projects = new ProjectService(new ProjectStore(projectStorePath(daemonEnvironment)));
  const initialProjects = await projects.list();
  const projectSettings = new ProjectPluginSettingsSnapshots(projects, { env: daemonEnvironment });
  await projectSettings.initialize(initialProjects);
  const serverPlugins = await createServerPluginRuntime({
    catalog: serverPluginCatalog,
    ...(serverPluginRecovery.safeStart === undefined ? {} : { safeStart: serverPluginRecovery.safeStart }),
    logger: app.log,
    execFile: createServerPluginExecFile({ env: daemonEnvironment }),
    projectSettingsResolver: (pluginId, settings, project, signal) => projectSettings.resolve(pluginId, settings, project, signal),
    workspaceNotificationsFactory: createWorkspaceNotificationCommandFactory({
      env: daemonEnvironment,
      listeningPort: () => {
        const address = app.server.address();
        return typeof address === "object" && address !== null ? address.port : undefined;
      },
    }),
    noticeSink: (source, input) => { serverNotices.record({ ...input, source }); },
    dataDir: piWebDataDir(daemonEnvironment),
    hostCapabilities: [{
      capability: MAINTENANCE_TERMINAL_CAPABILITY,
      value: resolveMaintenanceExecutionContext(childProcessEnvironment, daemonLaunchCwd),
    }],
    lateHostCapabilities: [PI_WEB_HOST_WORKSPACES_CAPABILITY, PI_WEB_HOST_PI_SESSIONS_CAPABILITY, PI_WEB_HOST_PI_SESSION_EVENTS_CAPABILITY, PI_WEB_HOST_CATALOG_CAPABILITY, PI_WEB_HOST_SESSION_LIFECYCLE_CAPABILITY],
  });
  let sessionsForFailedConstruction: PiSessionService | undefined;
  let projectLifecycleForFailedConstruction: ProjectLifecycleService | undefined;
  try {
    const pins = new SessionPinStore(
      sessionPinStorePath(daemonEnvironment),
      navigationPreferenceStorePath(daemonEnvironment),
      (scope, revision) => { eventHub.publishRealtime({ type: "session-pins.changed", ...scope, revision }); },
    );
    // Import before plugin activation; web/API must already have relinquished pin writes.
    await pins.pinnedSessionIds();
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
    // Only dependency-ready providers can define the aggregate topology. The
    // runtime has already rejected any staged provider that depends on late
    // host authority as a cycle, so this snapshot cannot omit a future owner.
    const providerContributions = serverPlugins.providerContributions();
    const providerPluginIds = providerContributions.map(({ pluginId }) => pluginId);
    const providerHealth = await serverPlugins.inspectHealth(providerPluginIds);
    const workspaceProviders = new WorkspaceProviderRegistry({
      contributions: eligibleWorkspaceProviderContributions(providerContributions, providerHealth),
      logger: app.log,
    });
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
    const workspaceChanges = new WorkspaceChangeNotifier({
      attribution: statusAttribution,
      status: machineStatus,
      publish: (event) => { eventHub.publishRealtime(event); },
    });
    const projectLifecycle: ProjectLifecycleService = new ProjectLifecycleService({
      projects,
      workspaces: workspaceProviders,
      hasUnread: () => unreadStore.hasUnread(),
      reconcileUnreadWorkspaces: (cwds): Promise<void> => sessions.reconcileUnreadWorkspaces(cwds),
      logger: app.log,
      onProjectsChanged: () => {
        statusAttribution.invalidate();
        machineStatus.notifyChanged();
      },
    });
    projectLifecycleForFailedConstruction = projectLifecycle;
    const projectWorkspaceDeps = { projects, workspaces: workspaceProviders };
    const messageTargets = new ProjectScopedSpawnTargetResolver(projectWorkspaceDeps);
    const spawnTargets = config.spawnSessions ? messageTargets : undefined;
    // A plugin may open a session during activation. Install discovery before
    // session_start, but publish backend authority only after startup health.
    let companionOptions: {
      backends: PluginBackendRegistry;
      contributions: ReturnType<typeof serverPlugins.pairedBackendContributions>;
      projects: ProjectService;
    } | undefined = undefined;
    const sessionEvents = new PiSessionEventConnections((bus) => bindCompanionBackend(bus, () => {
      if (companionOptions === undefined) throw new Error("PI WEB companion backends are not ready during daemon startup");
      return companionOptions;
    }));
    const sessions = new PiSessionService(eventHub, sessionServiceDependencies({
      modelRuntime: auth.runtime,
      sessionEvents,
      agentDir: activeAgentProfile.dir,
      archiveStore: new SessionArchiveStore(defaultSessionArchiveFilePath(daemonEnvironment), sessionArchiveDirectory(daemonEnvironment, config)),
      sessionPins: pins,
      workspaceActivity,
      logger: app.log,
      ...(spawnTargets === undefined ? {} : { spawnTargets }),
      messageTargets,
      sessionMessagesEnabled: config.sessionMessages,
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
      onUnreadChanged: (hasNewCompletion) => {
        machineStatus.notifyChanged();
        if (hasNewCompletion) projectLifecycle.scheduleCleanup();
      },
      catalogRefreshStatus: catalogRefresher,
      sessionManager: createPiSessionManagerGateway({
        agentDir: activeAgentProfile.dir,
        env: daemonEnvironment,
      }),
    }));
    sessionsForFailedConstruction = sessions;
    await sessions.restoreInterventionState();
    auth.subscribe((change) => { sessions.applyAuthChange(change); });
    // Current workspace authority and session ownership become available at
    // one atomic late boundary, so no dependent can start against a partial host.
    await serverPlugins.resumeWithHostCapabilityFactories([
      createServerPluginWorkspacesCapabilityFactory({ projects, workspaces: workspaceProviders }),
      createServerPluginCatalogCapabilityFactory({ projects, workspaces: workspaceProviders, sessions, pins }),
      createServerPluginSessionLifecycleCapabilityFactory({
        projects, workspaces: workspaceProviders, sessions, pins,
        onMutation: ({ projectId }) => { workspaceChanges.notify(projectId); },
      }),
      createServerPluginPiSessionsCapabilityFactory({ projects, workspaces: workspaceProviders, sessions }),
      createServerPluginPiSessionEventsCapabilityFactory({ projects, workspaces: workspaceProviders, sessions }),
    ]);
    const providerPluginIdSet = new Set(providerPluginIds);
    const remainingActivePluginIds = serverPlugins.healthRecords()
      .filter(({ pluginId, state }) => state === "active" && !providerPluginIdSet.has(pluginId))
      .map(({ pluginId }) => pluginId);
    const remainingHealth = await serverPlugins.inspectHealth(remainingActivePluginIds);
    const pluginHealth = Object.freeze([...providerHealth, ...remainingHealth]
      .sort((left, right) => left.pluginId.localeCompare(right.pluginId)));
    const backendContributions = eligiblePluginBackendContributions(serverPlugins.pairedBackendContributions(), pluginHealth);
    const pluginBackends = new PluginBackendRegistry({
      contributions: backendContributions,
      workspaces: workspaceProviders,
      logger: app.log,
    });
    companionOptions = { backends: pluginBackends, contributions: backendContributions, projects };
    const workspaceProviderRuntime = createWorkspaceProviderRuntimeSnapshot(
      serverPlugins.healthRecords(),
      pluginHealth,
      serverPlugins.safeStartLevel(),
      serverPlugins.catalogDiagnostics(),
    );
    // Render current state immediately; stale unread is collected in the background.
    machineStatus.notifyChanged();
    const terminals = serverPlugins.safeStartLevel() === "none"
      ? unavailableRequiredTerminalService()
      : serverPlugins.resolve(REQUIRED_TERMINAL_SERVICE_CAPABILITY);
    terminals.bindActivitySink({
      updateTerminal: (terminal) => { workspaceActivity.updateTerminal(terminal); },
      removeTerminal: (terminalId, cwd) => { workspaceActivity.removeTerminal(terminalId, cwd); },
    });
    const workspaceRemovals = new WorkspaceRemovalService(workspaceProviders, terminals, { notices: serverNotices });
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
          quiesceServer: async () => {
            serverQuiescing = true;
            await projectLifecycle.closeAll();
          },
          serverPlugins,
          catalogRefresher,
          auth,
          sessions,
          unreadStore,
          pluginBackends,
          workspaceProviders,
          workspaceRemovals,
          closeServer: () => app.close(),
        },
        onFailure: () => { process.exitCode = 1; },
      });
      // Release last: the daemon owns the instance state until everything that
      // writes it is down. Best-effort; a leftover marker goes stale and the
      // next start discards it.
      await stateOwnership.release();
    };
    projectLifecycle.scheduleCleanup(); // One delayed pass for existing persisted unread, if any.
    return { eventHub, machineStatus, statusAttribution, workspaceChanges, projectLifecycle, auth, sessions, pins, serverNotices, unreadStore, activeAgentProfile, runtimeComponent, catalogRefresher, serverPlugins, projects, workspaceProviders, pluginBackends, workspaceProviderRuntime, workspaceRemovals, shutdown };
  } catch (error) {
    await projectLifecycleForFailedConstruction?.closeAll();
    try {
      await serverPlugins.stop();
    } catch (disposeError) {
      app.log.error({ err: disposeError }, "session daemon construction failed and server plugin disposal was incomplete");
    }
    try {
      await sessionsForFailedConstruction?.dispose();
    } catch (disposeError) {
      app.log.error({ err: disposeError }, "session daemon construction failed and PI session disposal was incomplete");
    }
    throw error;
  }
}

function registerSessionDaemonRoutes({ eventHub, machineStatus, statusAttribution, workspaceChanges, projectLifecycle, auth, sessions, pins, serverNotices, runtimeComponent, projects, workspaceProviders, pluginBackends, workspaceProviderRuntime, workspaceRemovals, serverPlugins }: SessionDaemonRuntime): void {
  registerProjectMutationRoutes(app, projectLifecycle);
  registerPluginCatalogRoutes(app, { projects, workspaces: workspaceProviders, sessions, pins });
  registerPluginSessionLifecycleRoutes(app, {
    projects, workspaces: workspaceProviders, sessions, pins,
    onMutation: ({ projectId }) => { workspaceChanges.notify(projectId); },
  });
  registerSessionPinRoutes(app, pins);
  registerMachineStatusRoutes(app, machineStatus);
  registerServerNoticeRoutes(app, serverNotices);
  registerAuthRoutes(app, auth);
  registerMcpAuthRoutes(app, sessions);
  registerSessionRoutes(app, sessions, eventHub);
  registerWorkspaceCatalogRoutes(app, {
    projects,
    workspaces: workspaceProviders,
    providerRuntime: workspaceProviderRuntime,
  });
  registerWorkspaceNotificationRoutes(app, { projects, workspaces: workspaceProviders, changes: workspaceChanges });
  registerPairedPluginBackendRoutes(app, {
    projects,
    backends: pluginBackends,
    onWorkspacesMutated: () => { statusAttribution.invalidate(); },
  });
  registerPluginBackendChannelRoutes(app, { projects, backends: pluginBackends });
  registerPluginBackendResourceRoutes(app, { projects, backends: pluginBackends });
  registerWorkspaceRemovalRoutes(app, {
    projects,
    removals: workspaceRemovals,
    onWorkspacesMutated: () => {
      statusAttribution.invalidate();
      projectLifecycle.scheduleCleanup();
    },
  });

  app.get("/health", () => ({
    ok: true,
    activeSessions: sessions.activeCount(),
    checkedAt: new Date().toISOString(),
    version: {
      component: runtimeComponent.component,
      label: runtimeComponent.label,
      runtime: runtimeComponent.runtime,
      ...(runtimeComponent.runtimeVersion === undefined ? {} : { runtimeVersion: runtimeComponent.runtimeVersion }),
      ...(runtimeComponent.piVersion === undefined ? {} : { piVersion: runtimeComponent.piVersion }),
      stale: false,
      available: runtimeComponent.available,
    },
  }));

  app.get("/runtime", () => runtimeComponent);
  registerTerminalStatusRoutes(app, serverPlugins);
}

async function listenSessionDaemon({ shutdown, projects, workspaceProviders }: SessionDaemonRuntime): Promise<void> {
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
  // Maintain integrations only once the notification ingress is usable, including
  // the actual bound address of an ephemeral TCP listener. Authority reads stay
  // side-effect-free, and each provider callback remains bounded/cancellable.
  try {
    await Promise.all((await projects.list()).map((project) => workspaceProviders.reconcileProject(project)));
  } catch (error) {
    // SIGTERM can arrive as soon as the listener is ready. Quiescing provider
    // ingress cancels maintenance; that is a graceful stop, not failed startup.
    if (!shutdownStarted) throw error;
  }
}
