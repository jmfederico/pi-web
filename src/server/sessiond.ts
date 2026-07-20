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
import { ProfileCredentialStore } from "./sessions/profileCredentialStore.js";
import { SessionAuthRuntimeRegistry } from "./sessions/sessionAuthRuntimeRegistry.js";
import { createSessionModelRuntimeFactory } from "./sessions/sessionModelRuntimeFactory.js";
import { createPiSessionManagerGateway } from "./sessions/piSessionManagerGateway.js";
import { registerSessionRoutes } from "./sessions/sessionRoutes.js";
import { SessionNotificationStore } from "./sessions/sessionNotificationStore.js";
import { FileSessionUnreadPersistence, SessionUnreadStore } from "./sessions/sessionUnreadStore.js";
import { ProjectScopedSpawnTargetResolver } from "./sessions/spawnTargetResolver.js";
import { ProjectService } from "./projects/projectService.js";
import { ProjectStore } from "./storage/projectStore.js";
import { WorkspaceService } from "./workspaces/workspaceService.js";
import { sessiondSocketPath } from "../sessiond/config.js";
import { TerminalService } from "./terminals/terminalService.js";
import { registerTerminalRoutes } from "./terminals/terminalRoutes.js";
import { getPiWebRuntimeComponent } from "./piWebStatus.js";
import { SESSIOND_RUNTIME_CAPABILITIES } from "../shared/capabilities.js";
import { agentSessionDirEnvKeys, effectivePiWebConfig, maxUploadBytes } from "../config.js";
import { createActiveAgentProfileDescriptor } from "../sessiond/activeAgentProfile.js";
import { runSessionDaemonStartup } from "./sessiond/sessionDaemonStartup.js";

const daemonEnvironment: NodeJS.ProcessEnv = Object.freeze({ ...process.env });
const { config } = effectivePiWebConfig({ env: daemonEnvironment });
const activeAgentProfile = createActiveAgentProfileDescriptor({
  command: config.agent.command,
  dir: config.agent.dir,
  sessionDirEnvKeys: agentSessionDirEnvKeys(config.agent.command),
});
const app = Fastify({ logger: true, bodyLimit: maxUploadBytes(daemonEnvironment, config) });
await app.register(fastifyWebsocket);

await runSessionDaemonStartup({
  logger: app.log,
  async createRuntime() {
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
    const credentials = await ProfileCredentialStore.create({
      agentDir: activeAgentProfile.dir,
      env: daemonEnvironment,
      logger: app.log,
    });
    await credentials.startExternalObservation();
    const authRuntimeRegistry = new SessionAuthRuntimeRegistry(credentials);
    const auth = await AuthService.create({
      agentDir: activeAgentProfile.dir,
      credentials,
      authRuntimeRegistry,
      logger: app.log,
    });
    const sessionModelRuntimeFactory = createSessionModelRuntimeFactory({
      agentDir: activeAgentProfile.dir,
      credentials,
      authRuntimeRegistry,
    });
    const spawnTargets = config.spawnSessions
      ? new ProjectScopedSpawnTargetResolver({ projects: new ProjectService(new ProjectStore()), workspaces: new WorkspaceService() })
      : undefined;
    const sessions = new PiSessionService(eventHub, {
      sessionModelRuntimeFactory,
      authRuntimeRegistry,
      credentialRevisions: credentials,
      agentDir: activeAgentProfile.dir,
      workspaceActivity,
      logger: app.log,
      ...(spawnTargets === undefined ? {} : { spawnTargets }),
      subsessionsEnabled: spawnTargets !== undefined && config.subsessions,
      notificationStore,
      unreadStore,
      sessionManager: createPiSessionManagerGateway({
        agentDir: activeAgentProfile.dir,
        env: daemonEnvironment,
        sessionDirEnvKeys: activeAgentProfile.sessionDirEnvKeys,
      }),
    });
    auth.subscribe((change) => sessions.applyAuthChange(change));
    const terminals = new TerminalService(eventHub, workspaceActivity);
    const runtimeComponent = Object.freeze({
      ...getPiWebRuntimeComponent("sessiond", SESSIOND_RUNTIME_CAPABILITIES),
      activeAgentProfile,
    });
    return {
      eventHub,
      workspaceActivity,
      credentials,
      authRuntimeRegistry,
      auth,
      sessions,
      terminals,
      unreadStore,
      activeAgentProfile,
      runtimeComponent,
    };
  },
  registerRoutes({ eventHub, workspaceActivity, auth, sessions, terminals, runtimeComponent }) {
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
  },
  async listen({ credentials, authRuntimeRegistry, auth, sessions, terminals, unreadStore }) {
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
      await attempt("dispose auth", () => { auth.dispose(); });
      await attempt("dispose sessions", () => sessions.dispose());
      await attempt("dispose session auth runtimes", () => { authRuntimeRegistry.dispose(); });
      await attempt("dispose profile credentials", () => { credentials.dispose(); });
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
  },
});
