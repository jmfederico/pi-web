import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyServerOptions } from "fastify";
import fastifyCompress from "@fastify/compress";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import { ProjectStore } from "./storage/projectStore.js";
import { ProjectService } from "./projects/projectService.js";
import type { WorkspaceCatalog } from "./workspaces/workspaceCatalog.js";
import { SessionDaemonWorkspaceCatalog } from "./workspaces/sessionDaemonWorkspaceCatalog.js";
import { sendWorkspaceRequestError } from "./workspaces/workspaceRouteErrors.js";
import { loadEffectiveProjectUploadsConfig } from "./workspaces/projectPiWebConfig.js";
import { listDirectorySuggestions } from "./projects/directorySuggestions.js";
import { SessionDaemonClient } from "../sessiond/sessionDaemonClient.js";
import { loadServerPluginRecoveryConfig } from "../serverPluginRecovery.js";
import { registerSessionProxyRoutes, type SessionProxyDaemon } from "./sessiond/sessionProxyRoutes.js";
import { registerWorkspaceExplorerRoutes } from "./workspaceExplorerRoutes.js";
import { registerProjectTrustRoutes } from "./projectTrustRoutes.js";
import { registerTerminalProxyRoutes } from "./terminalProxyRoutes.js";
import { registerWorkspaceDeletionRoutes } from "./workspaces/workspaceDeletionRoutes.js";
import { createFilePiWebConfigService, registerConfigRoutes, registerLocalMachineConfigRoutes, type PiWebConfigService } from "./configRoutes.js";
import { PiWebPluginService } from "./piWebPluginService.js";
import { createActiveProfilePiPackageService, type PiPackageService } from "./piPackageService.js";
import { registerPiPackageRoutes } from "./piPackageRoutes.js";
import { createPiWebStatusCache, type PiWebStatusCache } from "./piWebStatusCache.js";
import { getPiWebRuntime, getPiWebStatus, getPiWebVersionStatus } from "./piWebStatus.js";
import { PI_WEB_CAPABILITIES, WEB_RUNTIME_CAPABILITIES } from "../shared/capabilities.js";
import {
  ActiveAgentProfileAccessError,
  requireActiveAgentProfile,
  SessionDaemonActiveAgentProfileProvider,
  type ActiveAgentProfileProvider,
} from "./activeAgentProfileProvider.js";
import { MachineService } from "./machines/machineService.js";
import { registerMachineRoutes } from "./machines/machineRoutes.js";
import { registerMachineProxyRoutes } from "./machines/machineProxyRoutes.js";
import { registerPluginBackendProxyRoutes } from "./plugins/pluginBackendProxyRoutes.js";
import { proxyMachinePluginAsset, registerMachinePluginProxyRoutes } from "./machines/machinePluginProxyRoutes.js";
import type { Project, WorkspaceEffectiveConfig, WorkspaceProviderResolution } from "./types.js";
import type { SafeTunnelBridgeService } from "./safeTunnel/safeTunnelBridgeService.js";

export interface SafeTunnelMutationHostConfig {
  listenerHost?: string;
  allowedHosts?: readonly string[] | true;
}

export interface AppDependencies {
  projects?: ProjectService;
  workspaceCatalog?: WorkspaceCatalog;
  machines?: MachineService;
  sessionDaemon?: SessionProxyDaemon;
  agentProfileProvider?: ActiveAgentProfileProvider;
  piWebPlugins?: Pick<PiWebPluginService, "manifest" | "plugins" | "readAsset">;
  piPackages?: PiPackageService;
  piWebStatusCache?: PiWebStatusCache;
  config?: PiWebConfigService;
  /** Present only when startup opted in and composed the web-owned Safe Tunnel graph. */
  safeTunnel?: SafeTunnelBridgeService;
  /** Startup-snapshot host trust inputs used by Safe Tunnel reads and mutations. */
  safeTunnelMutationHosts?: SafeTunnelMutationHostConfig;
  clientDist?: string | false;
  logger?: FastifyServerOptions["logger"];
  /** Maximum accepted HTTP request body size in bytes. */
  bodyLimit?: number;
}

interface LocalProjectRouteOptions {
  config?: Pick<PiWebConfigService, "read">;
}

function registerLocalProjectRoutes(app: FastifyInstance, projects: ProjectService, workspaces: WorkspaceCatalog, prefix: string, options: LocalProjectRouteOptions = {}): void {
  app.get(`${prefix}/projects`, async () => projects.list());

  app.post<{ Body: { name?: string; path: string; create?: boolean } }>(`${prefix}/projects`, async (request, reply) => {
    try {
      return await projects.add(request.body);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.delete<{ Params: { projectId: string } }>(`${prefix}/projects/:projectId`, async (request, reply) => {
    try {
      await projects.close(request.params.projectId);
      return { closed: true };
    } catch (error) {
      return reply.code(404).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get<{ Querystring: { q?: string } }>(`${prefix}/project-directories`, async (request, reply) => {
    try {
      return await listDirectorySuggestions(request.query.q ?? "");
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get<{ Params: { projectId: string } }>(`${prefix}/projects/:projectId/workspaces`, async (request, reply) => {
    try {
      const project = await projects.requireProject(request.params.projectId);
      return await resolveWorkspacesWithEffectiveConfig(project, workspaces, options.config);
    } catch (error) {
      return sendWorkspaceRequestError(reply, error, 404);
    }
  });
}

async function resolveWorkspacesWithEffectiveConfig(
  project: Project,
  workspaces: WorkspaceCatalog,
  config?: Pick<PiWebConfigService, "read">,
): Promise<WorkspaceProviderResolution> {
  const [resolution, effectiveConfig] = await Promise.all([
    workspaces.resolveProject(project.id),
    workspaceEffectiveConfig(project.path, config),
  ]);
  return {
    ...resolution,
    workspaces: resolution.workspaces.map((workspace) => ({ ...workspace, effectiveConfig })),
  };
}

async function workspaceEffectiveConfig(projectPath: string, config?: Pick<PiWebConfigService, "read">): Promise<WorkspaceEffectiveConfig> {
  const globalConfig = config === undefined ? {} : (await config.read()).effectiveConfig;
  return { uploads: await loadEffectiveProjectUploadsConfig(projectPath, globalConfig) };
}

async function readEffectiveConfig(config: Pick<PiWebConfigService, "read">) {
  return (await config.read()).effectiveConfig;
}

async function desiredPluginAgentDir(
  profiles: ActiveAgentProfileProvider,
  config: Pick<PiWebConfigService, "read">,
): Promise<string> {
  try {
    return (await requireActiveAgentProfile(profiles)).dir;
  } catch (error) {
    if (!(error instanceof ActiveAgentProfileAccessError)) throw error;
    const desiredDir = (await config.read()).effectiveConfig.agent?.dir;
    if (desiredDir === undefined || desiredDir === "") throw error;
    return desiredDir;
  }
}

function invalidatePiWebStatusOnWrite(config: PiWebConfigService, statusCache: Pick<PiWebStatusCache, "invalidate">): PiWebConfigService {
  return {
    read: () => config.read(),
    write: async (nextConfig) => {
      const response = await config.write(nextConfig);
      statusCache.invalidate();
      return response;
    },
  };
}

async function withProfileDependency<T>(reply: FastifyReply, operation: () => Promise<T>): Promise<T | FastifyReply> {
  try {
    return await operation();
  } catch (error) {
    if (!(error instanceof ActiveAgentProfileAccessError)) throw error;
    return reply.code(503).send({ error: error.message });
  }
}

async function registerSafeTunnelFeature(
  app: FastifyInstance,
  bridge: SafeTunnelBridgeService,
  mutationHosts: SafeTunnelMutationHostConfig,
): Promise<void> {
  const { registerSafeTunnelRoutes } = await import("./safeTunnel/safeTunnelRoutes.js");
  registerSafeTunnelRoutes(app, bridge, mutationHosts);
  app.addHook("onReady", async () => {
    await bridge.startup();
  });
  app.addHook("onClose", async () => {
    await bridge.shutdown();
  });
}

export async function buildApp(deps: AppDependencies = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: deps.logger ?? true, ...(deps.bodyLimit === undefined ? {} : { bodyLimit: deps.bodyLimit }) });
  // Vite proxies development API requests here, while production and machine-scoped
  // API requests already terminate here, so this is the shared browser HTTP edge.
  await app.register(fastifyCompress, {
    globalCompression: true,
    globalDecompression: false,
    threshold: 1024,
  });
  await app.register(fastifyWebsocket);

  const projects = deps.projects ?? new ProjectService(new ProjectStore());
  const configService = deps.config ?? createFilePiWebConfigService();
  const readConfig = () => readEffectiveConfig(configService);
  const sessionDaemon = deps.sessionDaemon ?? new SessionDaemonClient();
  const daemonWorkspaces = new SessionDaemonWorkspaceCatalog(sessionDaemon);
  const workspaces = deps.workspaceCatalog ?? daemonWorkspaces;
  const agentProfileProvider = deps.agentProfileProvider ?? new SessionDaemonActiveAgentProfileProvider(sessionDaemon);
  const piWebPlugins = deps.piWebPlugins ?? new PiWebPluginService({
    configProvider: readConfig,
    agentDirProvider: () => desiredPluginAgentDir(agentProfileProvider, configService),
    runtimeProvider: daemonWorkspaces,
    recoveryProvider: () => loadServerPluginRecoveryConfig(),
  });
  const piPackages = deps.piPackages ?? createActiveProfilePiPackageService(agentProfileProvider);
  const safeTunnel = deps.safeTunnel;
  const webRuntimeCapabilities = safeTunnel === undefined
    ? WEB_RUNTIME_CAPABILITIES
    : [...WEB_RUNTIME_CAPABILITIES, PI_WEB_CAPABILITIES.safeTunnel];
  const localRuntime = () => getPiWebRuntime(sessionDaemon, { webCapabilities: webRuntimeCapabilities });
  const piWebStatusCache = deps.piWebStatusCache ?? createPiWebStatusCache(
    async ({ force }) => {
      const activeAgentProfile = await agentProfileProvider.getActiveAgentProfile();
      return getPiWebStatus(sessionDaemon, {
        forceReleaseCheck: force,
        ...(activeAgentProfile.status === "available" ? { activeAgentProfile: activeAgentProfile.profile } : {}),
      });
    },
    { onError: (error) => { app.log.warn({ err: error }, "failed to refresh PI WEB status cache"); } },
  );
  const machines = deps.machines ?? new MachineService(undefined, { localRuntime });

  if (safeTunnel !== undefined) {
    await registerSafeTunnelFeature(
      app,
      safeTunnel,
      deps.safeTunnelMutationHosts ?? {},
    );
  }

  app.get("/pi-web-plugins/manifest.json", async (_request, reply) => withProfileDependency(reply, () => piWebPlugins.manifest()));

  app.get<{ Params: { pluginId: string; "*": string } }>("/pi-web-plugins/:pluginId/*", async (request, reply) => {
    if (await proxyMachinePluginAsset(machines, request.params.pluginId, request.params["*"], request.url, reply)) return;

    return withProfileDependency(reply, async () => {
      const asset = await piWebPlugins.readAsset(
        request.params.pluginId,
        request.params["*"],
        new URL(request.url, "http://pi-web.local").searchParams.get("v") ?? undefined,
      );
      if (asset === undefined) return reply.code(404).send({ error: "Plugin asset not found" });
      return reply.type(asset.contentType).send(asset.content);
    });
  });

  app.get<{ Querystring: { refresh?: string } }>("/api/pi-web/status", async (request) => request.query.refresh === "1"
    ? piWebStatusCache.refresh({ force: true })
    : piWebStatusCache.get());
  app.get("/api/pi-web/version", async () => {
    const activeAgentProfile = await agentProfileProvider.getActiveAgentProfile();
    return getPiWebVersionStatus(sessionDaemon, activeAgentProfile.status === "available" ? { activeAgentProfile: activeAgentProfile.profile } : {});
  });
  app.get("/api/pi-web/runtime", localRuntime);
  app.get("/api/plugins", async (_request, reply) => withProfileDependency(reply, () => piWebPlugins.plugins()));
  app.get("/api/machines/local/plugins", async (_request, reply) => withProfileDependency(reply, () => piWebPlugins.plugins()));
  registerPiPackageRoutes(app, piPackages);
  registerPiPackageRoutes(app, piPackages, "/api/machines/local");
  const invalidatingConfigService = invalidatePiWebStatusOnWrite(configService, piWebStatusCache);
  registerConfigRoutes(app, invalidatingConfigService);
  registerLocalMachineConfigRoutes(app, invalidatingConfigService);

  registerMachineRoutes(app, machines);
  registerMachinePluginProxyRoutes(app, machines);

  registerLocalProjectRoutes(app, projects, workspaces, "/api", { config: configService });
  registerLocalProjectRoutes(app, projects, workspaces, "/api/machines/local", { config: configService });

  registerSessionProxyRoutes(app, sessionDaemon);
  registerSessionProxyRoutes(app, sessionDaemon, "/api/machines/local");
  registerPluginBackendProxyRoutes(app, sessionDaemon);
  registerWorkspaceExplorerRoutes(app, projects, workspaces, "/api", { config: configService });
  registerWorkspaceExplorerRoutes(app, projects, workspaces, "/api/machines/local", { config: configService });
  const projectTrustDeps = {
    agentDir: async () => (await requireActiveAgentProfile(agentProfileProvider)).dir,
  };
  registerProjectTrustRoutes(app, projects, workspaces, projectTrustDeps);
  registerProjectTrustRoutes(app, projects, workspaces, projectTrustDeps, "/api/machines/local");
  registerTerminalProxyRoutes(app, projects, workspaces, sessionDaemon);
  registerTerminalProxyRoutes(app, projects, workspaces, sessionDaemon, "/api/machines/local");
  registerWorkspaceDeletionRoutes(app, sessionDaemon);
  registerWorkspaceDeletionRoutes(app, sessionDaemon, "/api/machines/local");

  registerMachineProxyRoutes(app, machines);

  const packagedClientDist = join(dirname(fileURLToPath(import.meta.url)), "..", "client");
  const clientDist = deps.clientDist ?? (existsSync(packagedClientDist) ? packagedClientDist : join(process.cwd(), "dist", "client"));
  if (clientDist !== false && existsSync(clientDist)) {
    await app.register(fastifyStatic, { root: clientDist });
    app.setNotFoundHandler((request, reply) => {
      if (request.url === "/api" || request.url.startsWith("/api/")) {
        return reply.code(404).send({
          message: `Route ${request.method}:${request.url} not found`,
          error: "Not Found",
          statusCode: 404,
        });
      }
      return reply.sendFile("index.html");
    });
  }

  return app;
}
