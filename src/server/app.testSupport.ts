import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach } from "vitest";
import { buildApp } from "./app.js";
import { ProjectService } from "./projects/projectService.js";
import { ProjectStore } from "./storage/projectStore.js";
import type { MachineClient } from "./machines/machineClient.js";
import { MachineService } from "./machines/machineService.js";
import { MachineStore } from "./machines/machineStore.js";
import type { WorkspaceCatalog } from "./workspaces/workspaceCatalog.js";
import type { PiPackageService } from "./piPackageService.js";
import type { SessionProxyDaemon } from "./sessiond/sessionProxyRoutes.js";
import type { ActiveAgentProfileDescriptor, PiPackageInfo, PiWebConfigResponse, PiWebConfigValues, WorkspaceListing, WorkspaceProviderAuthorityResolution } from "../shared/apiTypes.js";
import type { SessionDaemonAgentProfileResult } from "../sessiond/sessionDaemonClient.js";

interface AppTestContext {
  readonly app: FastifyInstance;
  readonly tempDir: string;
  readonly projectDir: string;
  remoteClient: MachineClient | undefined;
  readonly sessionDaemonRequests: CapturedSessionDaemonRequest[];
  readonly piPackageRequests: CapturedPiPackageRequest[];
  readonly workspaceCatalog: AppTestWorkspaceCatalog;
  piWebConfig: PiWebConfigValues;
  agentProfileResult: SessionDaemonAgentProfileResult;
}

let app: FastifyInstance | undefined;
let tempDir: string | undefined;
let projectDir: string | undefined;
let remoteClient: MachineClient | undefined;
let sessionDaemonRequests: CapturedSessionDaemonRequest[] = [];
let piPackageRequests: CapturedPiPackageRequest[] = [];
let workspaceCatalog: AppTestWorkspaceCatalog | undefined;
let piWebConfig: PiWebConfigValues = {};
let agentProfileResult: SessionDaemonAgentProfileResult = { status: "invalid", error: "App test harness was not initialized" };

export const appTestContext: AppTestContext = {
  get app() {
    if (app === undefined) throw new Error("App test harness was not initialized");
    return app;
  },
  get tempDir() {
    if (tempDir === undefined) throw new Error("App test tempDir was not initialized");
    return tempDir;
  },
  get projectDir() {
    if (projectDir === undefined) throw new Error("App test projectDir was not initialized");
    return projectDir;
  },
  get remoteClient() {
    return remoteClient;
  },
  set remoteClient(client) {
    remoteClient = client;
  },
  get sessionDaemonRequests() {
    return sessionDaemonRequests;
  },
  get piPackageRequests() {
    return piPackageRequests;
  },
  get workspaceCatalog() {
    if (workspaceCatalog === undefined) throw new Error("App test workspace catalog was not initialized");
    return workspaceCatalog;
  },
  get piWebConfig() {
    return piWebConfig;
  },
  set piWebConfig(config) {
    piWebConfig = config;
  },
  get agentProfileResult() {
    return agentProfileResult;
  },
  set agentProfileResult(result) {
    agentProfileResult = result;
  },
};

export function registerAppTestHooks(): void {
  beforeEach(async () => {
    tempDir = await realpath(await mkdtemp(join(tmpdir(), "pi-web-app-test-")));
    projectDir = join(tempDir, "project");
    remoteClient = undefined;
    sessionDaemonRequests = [];
    piPackageRequests = [];
    piWebConfig = {};
    agentProfileResult = { status: "available", profile: appTestAgentProfile(join(tempDir, "agent")) };
    const projects = new ProjectService(new ProjectStore(join(tempDir, "projects.json")));
    workspaceCatalog = new AppTestWorkspaceCatalog(projects);
    app = await buildApp({
      projects,
      workspaceCatalog,
      machines: new MachineService(new MachineStore(join(tempDir, "machines.json")), {
        remoteClientFactory: () => {
          if (remoteClient === undefined) throw new Error("No remote machine client configured");
          return remoteClient;
        },
        now: () => new Date("2026-05-25T00:00:00.000Z"),
        localRuntime: () => Promise.resolve({
          packageName: "@jmfederico/pi-web",
          generatedAt: "2026-05-25T00:00:00.000Z",
          components: {
            web: { component: "web", label: "PI WEB", available: true, capabilities: [] },
            sessiond: { component: "sessiond", label: "PI WEB Session Daemon", available: true, capabilities: [] },
          },
          capabilities: [],
        }),
      }),
      sessionDaemon: fakeSessionDaemon(),
      agentProfileProvider: { getActiveAgentProfile: () => Promise.resolve(agentProfileResult) },
      config: fakeConfigService(),
      piPackages: fakePiPackageService(),
      piWebPlugins: {
        manifest: () => Promise.resolve({ lifecycleVersion: 1, plugins: [{ id: "fake", module: "/pi-web-plugins/fake/plugin.js?v=1", source: "test", scope: "local", machineSpecific: false }] }),
        plugins: () => Promise.resolve({
          lifecycleVersion: 1,
          plugins: [{ id: "fake", module: "/pi-web-plugins/fake/plugin.js?v=1", source: "test", scope: "local", machineSpecific: false, enabled: true, discovered: true, conflict: false }],
          diagnostics: [],
          serverRuntime: {
            status: "available",
            restartRequired: false,
            recovery: {
              showSafeStart: "pi-web plugins safe-start show",
              bundledOnly: "pi-web plugins safe-start set bundled-only --restart",
              noServerPlugins: "pi-web plugins safe-start set none --restart",
              clearSafeStart: "pi-web plugins safe-start clear --restart",
            },
          },
        }),
        readAsset: fakePiWebPluginAsset,
      },
      clientDist: false,
      logger: false,
    });
  });

  afterEach(async () => {
    const appToClose = app;
    const tempDirToRemove = tempDir;
    app = undefined;
    tempDir = undefined;
    projectDir = undefined;
    remoteClient = undefined;
    sessionDaemonRequests = [];
    piPackageRequests = [];
    workspaceCatalog = undefined;
    piWebConfig = {};
    agentProfileResult = { status: "invalid", error: "App test harness was not initialized" };

    if (appToClose !== undefined) await appToClose.close();
    if (tempDirToRemove !== undefined) await rm(tempDirToRemove, { recursive: true, force: true });
  });
}

function fakePiWebPluginAsset(pluginId: string, assetPath: string): Promise<{ content: Buffer; contentType: string } | undefined> {
  if (pluginId !== "fake") return Promise.resolve(undefined);
  if (assetPath === "plugin.js") return Promise.resolve({ content: Buffer.from("export default {};"), contentType: "application/javascript; charset=utf-8" });
  if (assetPath === "assets/icon.svg") return Promise.resolve({ content: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), contentType: "image/svg+xml" });
  return Promise.resolve(undefined);
}

export class AppTestWorkspaceCatalog implements WorkspaceCatalog {
  private readonly overrides = new Map<string, readonly WorkspaceListing[]>();
  private readonly resolutionOverrides = new Map<string, WorkspaceProviderAuthorityResolution>();
  private failure: Error | undefined;

  constructor(private readonly projects: ProjectService) {}

  async resolveProject(projectId: string): Promise<WorkspaceProviderAuthorityResolution> {
    if (this.failure !== undefined) throw this.failure;
    const configuredResolution = this.resolutionOverrides.get(projectId);
    if (configuredResolution !== undefined) return cloneWorkspaceResolution(configuredResolution);

    const workspaces = await this.workspaceList(projectId);
    const ownerPluginId = commonWorkspaceOwner(workspaces);
    return {
      status: ownerPluginId === undefined ? "folder" : "provider",
      projectId,
      ...(ownerPluginId === undefined ? {} : { ownerPluginId }),
      workspaces,
      diagnostics: [],
    };
  }

  async list(projectId: string): Promise<WorkspaceListing[]> {
    return [...(await this.resolveProject(projectId)).workspaces];
  }

  async resolve(projectId: string, workspaceId: string): Promise<WorkspaceListing> {
    const workspace = (await this.list(projectId)).find((candidate) => candidate.id === workspaceId);
    if (workspace === undefined) throw new Error("Workspace not found");
    return workspace;
  }

  set(projectId: string, workspaces: readonly WorkspaceListing[]): void {
    this.resolutionOverrides.delete(projectId);
    this.overrides.set(projectId, workspaces.map((workspace) => ({ ...workspace })));
  }

  setResolution(resolution: WorkspaceProviderAuthorityResolution): void {
    this.overrides.delete(resolution.projectId);
    this.resolutionOverrides.set(resolution.projectId, cloneWorkspaceResolution(resolution));
  }

  fail(error: Error): void {
    this.failure = error;
  }

  private async workspaceList(projectId: string): Promise<WorkspaceListing[]> {
    const configured = this.overrides.get(projectId);
    if (configured !== undefined) return configured.map((workspace) => ({ ...workspace }));
    const project = await this.projects.requireProject(projectId);
    return [{
      id: createHash("sha1").update(`${project.id}:${project.path}`).digest("hex").slice(0, 12),
      projectId: project.id,
      path: project.path,
      label: project.name,
      isMain: true,
    }];
  }
}

function commonWorkspaceOwner(workspaces: readonly WorkspaceListing[]): string | undefined {
  const owner = workspaces[0]?.provider?.pluginId;
  return owner !== undefined && workspaces.every((workspace) => workspace.provider?.pluginId === owner)
    ? owner
    : undefined;
}

function cloneWorkspaceResolution(resolution: WorkspaceProviderAuthorityResolution): WorkspaceProviderAuthorityResolution {
  return {
    ...resolution,
    workspaces: resolution.workspaces.map((workspace) => ({ ...workspace })),
    diagnostics: resolution.diagnostics.map((diagnostic) => ({
      ...diagnostic,
      ...(diagnostic.pluginIds === undefined ? {} : { pluginIds: [...diagnostic.pluginIds] }),
    })),
  };
}

export interface CapturedSessionDaemonRequest {
  method: string;
  path: string;
  body?: unknown;
}

interface CapturedPiPackageRequest {
  action: "list" | "install" | "remove" | "update";
  source?: string;
  scope?: "user" | "project";
}

function fakeConfigService() {
  return {
    read: () => piWebConfigResponse(piWebConfig),
    write: (config: PiWebConfigValues) => {
      piWebConfig = config;
      return piWebConfigResponse(config);
    },
  };
}

function appTestAgentProfile(dir: string): ActiveAgentProfileDescriptor {
  return {
    schemaVersion: 1,
    revision: `sha256:${"a".repeat(64)}`,
    command: "pi",
    dir,
    sessionDirEnvKeys: ["PI_WEB_AGENT_SESSION_DIR", "PI_CODING_AGENT_SESSION_DIR"],
  };
}

export function fullPiWebConfig(): PiWebConfigValues {
  return {
    host: "127.0.0.1",
    port: 8504,
    allowedHosts: ["gateway.example.test"],
    shortcuts: { "core:view.chat": "mod+1" },
    plugins: { info: { enabled: true, settings: { note: "remote" } } },
    pathAccess: { allowedPaths: ["/srv/repos"] },
    uploads: { defaultFolder: "uploads" },
    maxUploadBytes: 1024,
    spawnSessions: false,
    subsessions: false,
    agent: { command: "agent-lab", dir: "/srv/agent-lab" },
  };
}

export function selectedMachinePiWebConfig(): PiWebConfigValues {
  return {
    plugins: { info: { enabled: true, settings: { note: "remote" } } },
    pathAccess: { allowedPaths: ["/srv/repos"] },
    uploads: { defaultFolder: "uploads" },
    maxUploadBytes: 1024,
    spawnSessions: false,
    subsessions: false,
    agent: { command: "agent-lab", dir: "/srv/agent-lab" },
  };
}

export function piWebConfigResponse(config: PiWebConfigValues): PiWebConfigResponse {
  return {
    path: join(appTestContext.tempDir, "config.json"),
    exists: false,
    config,
    effectiveConfig: config,
    envOverrides: { host: false, port: false, allowedHosts: false, spawnSessions: false, subsessions: false, askUser: false, agentCommand: false, agentDir: false, agentSessionDir: false },
  };
}

interface MachineConfigWriteBody {
  config: PiWebConfigValues;
}

export function configFromMachineConfigWriteBody(body: unknown): PiWebConfigValues {
  if (!isMachineConfigWriteBody(body)) throw new Error("Expected machine config write body");
  return body.config;
}

function isMachineConfigWriteBody(value: unknown): value is MachineConfigWriteBody {
  if (!isRecord(value)) return false;
  return isRecord(value["config"]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function fakePiPackageService(): PiPackageService {
  const packages: PiPackageInfo[] = [{ source: "npm:@acme/tools", scope: "user", filtered: false, installedPath: "/tmp/pi-tools" }];
  return {
    list: () => {
      piPackageRequests.push({ action: "list" });
      return Promise.resolve({ packages });
    },
    install: (source) => {
      piPackageRequests.push({ action: "install", source });
      return Promise.resolve({ action: "install", source, packages });
    },
    remove: (source, scope = "user") => {
      piPackageRequests.push({ action: "remove", source, scope });
      return Promise.resolve({ action: "remove", source, scope, removed: true, packages });
    },
    update: (source) => {
      piPackageRequests.push({ action: "update", ...(source === undefined ? {} : { source }) });
      return Promise.resolve({ action: "update", ...(source === undefined ? {} : { source }), packages });
    },
  };
}

function fakeSessionDaemon(): SessionProxyDaemon {
  return {
    request: (method, path, body) => {
      const captured = { method, path, ...(body === undefined ? {} : { body }) } satisfies CapturedSessionDaemonRequest;
      sessionDaemonRequests.push(captured);
      return Promise.resolve({
        statusCode: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(captured),
      });
    },
    connectWebSocket: () => { throw new Error("WebSocket not configured for test"); },
  };
}

export function fakeRemoteClient(overrides: Partial<MachineClient>): MachineClient {
  return {
    request: () => Promise.resolve({ statusCode: 200, headers: {}, body: Readable.from([]) }),
    requestJson: () => Promise.resolve({ statusCode: 200, headers: {}, body: undefined }),
    connectWebSocket: () => { throw new Error("WebSocket not configured for test"); },
    ...overrides,
  };
}
