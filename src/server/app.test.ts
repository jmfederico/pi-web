import { mkdir, mkdtemp, realpath, rm, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "./app.js";
import { ProjectService } from "./projects/projectService.js";
import { ProjectStore } from "./storage/projectStore.js";
import { RemoteMachineRequestError, type MachineClient } from "./machines/machineClient.js";
import { MachineService } from "./machines/machineService.js";
import { MachineStore } from "./machines/machineStore.js";
import { WorkspaceService } from "./workspaces/workspaceService.js";
import type { SessionProxyDaemon } from "./sessiond/sessionProxyRoutes.js";
import { PI_WEB_CAPABILITIES } from "../shared/capabilities.js";
import { machineScopedPluginId } from "../shared/machinePluginIds.js";
import { MAX_IMAGE_PREVIEW_BYTES } from "../shared/workspaceFiles.js";
import type { PiWebConfigResponse, PiWebConfigValues } from "../shared/apiTypes.js";
import type { Project, Workspace } from "./types.js";

let app: FastifyInstance;
let tempDir: string;
let projectDir: string;
let remoteClient: MachineClient | undefined;
let sessionDaemonRequests: CapturedSessionDaemonRequest[];
let piWebConfig: PiWebConfigValues;

beforeEach(async () => {
  tempDir = await realpath(await mkdtemp(join(tmpdir(), "pi-web-app-test-")));
  projectDir = join(tempDir, "project");
  remoteClient = undefined;
  sessionDaemonRequests = [];
  piWebConfig = {};
  app = await buildApp({
    projects: new ProjectService(new ProjectStore(join(tempDir, "projects.json"))),
    workspaces: new WorkspaceService(),
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
          web: { component: "web", label: "PI WEB", available: true, capabilities: [PI_WEB_CAPABILITIES.sessionsDeleteArchived] },
          sessiond: { component: "sessiond", label: "PI WEB Session Daemon", available: true, capabilities: [PI_WEB_CAPABILITIES.sessionsDeleteArchived] },
        },
        capabilities: [PI_WEB_CAPABILITIES.sessionsDeleteArchived],
      }),
    }),
    sessionDaemon: fakeSessionDaemon(),
    config: fakeConfigService(),
    piWebPlugins: {
      manifest: () => Promise.resolve({ plugins: [{ id: "fake", module: "/pi-web-plugins/fake/plugin.js?v=1", source: "test", scope: "local", machineSpecific: false }] }),
      plugins: () => Promise.resolve({ plugins: [{ id: "fake", module: "/pi-web-plugins/fake/plugin.js?v=1", source: "test", scope: "local", machineSpecific: false, enabled: true }] }),
      readAsset: (pluginId, assetPath) => Promise.resolve(pluginId === "fake" && assetPath === "plugin.js" ? { content: Buffer.from("export default {};"), contentType: "application/javascript; charset=utf-8" } : undefined),
    },
    clientDist: false,
    logger: false,
  });
});

afterEach(async () => {
  await app.close();
  await rm(tempDir, { recursive: true, force: true });
});

describe("buildApp", () => {
  it("lists synthesized local machine through the HTTP contract", async () => {
    const response = await app.inject({ method: "GET", url: "/api/machines" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ machines: [{ id: "local", name: "Local", kind: "local", createdAt: "1970-01-01T00:00:00.000Z", updatedAt: "1970-01-01T00:00:00.000Z" }] });
  });

  it("adds remote machines without exposing tokens", async () => {
    const addResponse = await app.inject({ method: "POST", url: "/api/machines", payload: { name: "Remote", baseUrl: "https://remote.example.test/", token: "secret" } });

    expect(addResponse.statusCode).toBe(200);
    expect(addResponse.json()).toMatchObject({ name: "Remote", kind: "remote", baseUrl: "https://remote.example.test" });
    expect(addResponse.json()).not.toHaveProperty("token");
  });

  it("reports machine health for local and remote machines", async () => {
    const addResponse = await app.inject({ method: "POST", url: "/api/machines", payload: { name: "Remote", baseUrl: "https://remote.example.test/" } });
    const remote = addResponse.json<{ id: string }>();
    const requestJson: MachineClient["requestJson"] = () => Promise.resolve({
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: {
        packageName: "@jmfederico/pi-web",
        generatedAt: "2026-05-25T00:00:00.000Z",
        components: {
          web: { component: "web", label: "Remote Web", stale: false, available: true },
          sessiond: { component: "sessiond", label: "Remote Sessiond", stale: false, available: true },
        },
        release: { packageName: "@jmfederico/pi-web", updateAvailable: false },
        commands: { update: "", restart: "", restartSystemd: "", restartDev: "" },
        messages: [],
      },
    });
    remoteClient = fakeRemoteClient({ requestJson });

    const localHealth = await app.inject({ method: "GET", url: "/api/machines/local/health" });
    const remoteHealth = await app.inject({ method: "GET", url: `/api/machines/${remote.id}/health` });

    expect(localHealth.statusCode).toBe(200);
    expect(localHealth.json()).toMatchObject({ machineId: "local", ok: true, status: "online" });
    expect(remoteHealth.statusCode).toBe(200);
    expect(remoteHealth.json()).toMatchObject({ machineId: remote.id, ok: true, status: "online" });
  });

  it("reports effective machine runtime capabilities for remote machines", async () => {
    const addResponse = await app.inject({ method: "POST", url: "/api/machines", payload: { name: "Remote", baseUrl: "https://remote.example.test/" } });
    const remote = addResponse.json<{ id: string }>();
    const requestJson = vi.fn<MachineClient["requestJson"]>(() => Promise.resolve({
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: {
        packageName: "@jmfederico/pi-web",
        generatedAt: "2026-05-25T00:00:00.000Z",
        components: {
          web: { component: "web", label: "Remote Web", runtimeVersion: "1.0.0", available: true, capabilities: [PI_WEB_CAPABILITIES.sessionsDeleteArchived] },
          sessiond: { component: "sessiond", label: "Remote Sessiond", runtimeVersion: "1.0.0", available: true, capabilities: [PI_WEB_CAPABILITIES.sessionsDeleteArchived] },
        },
        capabilities: [PI_WEB_CAPABILITIES.sessionsDeleteArchived],
      },
    }));
    remoteClient = fakeRemoteClient({ requestJson });

    const runtime = await app.inject({ method: "GET", url: `/api/machines/${remote.id}/runtime` });

    expect(runtime.statusCode).toBe(200);
    expect(runtime.json()).toMatchObject({ machineId: remote.id, ok: true, capabilities: [PI_WEB_CAPABILITIES.sessionsDeleteArchived] });
    expect(requestJson).toHaveBeenCalledWith("GET", "/api/pi-web/runtime", undefined, { timeoutMs: 3000 });
  });

  it("proxies allowlisted remote HTTP routes through the selected machine", async () => {
    const addResponse = await app.inject({ method: "POST", url: "/api/machines", payload: { name: "Remote", baseUrl: "https://remote.example.test/" } });
    const remote = addResponse.json<{ id: string }>();
    const request = vi.fn(() => Promise.resolve({
      statusCode: 200,
      headers: { "content-type": "application/json", connection: "close" },
      body: Readable.from([JSON.stringify([{ id: "p1", name: "Remote Project", path: "/repo", createdAt: "now" }])]),
    }));
    remoteClient = fakeRemoteClient({ request });

    const response = await app.inject({ method: "GET", url: `/api/machines/${remote.id}/projects?active=true` });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/json");
    expect(response.json()).toEqual([{ id: "p1", name: "Remote Project", path: "/repo", createdAt: "now" }]);
    expect(request).toHaveBeenCalledWith("GET", "/api/projects?active=true", undefined);
  });

  it("proxies remote workspace effective upload config through the existing federated workspace route", async () => {
    const addResponse = await app.inject({ method: "POST", url: "/api/machines", payload: { name: "Remote", baseUrl: "https://remote.example.test/" } });
    const remote = addResponse.json<{ id: string }>();
    const remoteWorkspaces = [{
      id: "w1",
      projectId: "p1",
      path: "/repo",
      label: "main",
      isMain: true,
      isGitRepo: false,
      isGitWorktree: false,
      effectiveConfig: { uploads: { defaultFolder: "remote-project-uploads" } },
    }];
    const request = vi.fn(() => Promise.resolve({
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: Readable.from([JSON.stringify(remoteWorkspaces)]),
    }));
    remoteClient = fakeRemoteClient({ request });

    const response = await app.inject({ method: "GET", url: `/api/machines/${remote.id}/projects/p1/workspaces` });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(remoteWorkspaces);
    expect(request).toHaveBeenCalledWith("GET", "/api/projects/p1/workspaces", undefined);
  });

  it("preserves remote file preview security headers while proxying safe response metadata", async () => {
    const addResponse = await app.inject({ method: "POST", url: "/api/machines", payload: { name: "Remote", baseUrl: "https://remote.example.test/" } });
    const remote = addResponse.json<{ id: string }>();
    const request = vi.fn(() => Promise.resolve({
      statusCode: 200,
      headers: {
        "content-type": "image/svg+xml",
        "content-security-policy": "sandbox; default-src 'none'; img-src 'self' data: blob:; style-src 'unsafe-inline'",
        "x-content-type-options": "nosniff",
        "set-cookie": "session=secret",
      },
      body: Readable.from(["<svg xmlns=\"http://www.w3.org/2000/svg\" />"]),
    }));
    remoteClient = fakeRemoteClient({ request });

    const response = await app.inject({ method: "GET", url: `/api/machines/${remote.id}/projects/p1/workspaces/w1/file/preview?path=${encodeURIComponent("diagram.svg")}` });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("image/svg+xml");
    expect(response.headers["content-security-policy"]).toContain("sandbox");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(response.body).toBe("<svg xmlns=\"http://www.w3.org/2000/svg\" />");
    expect(request).toHaveBeenCalledWith("GET", "/api/projects/p1/workspaces/w1/file/preview?path=diagram.svg", undefined);
  });

  it("proxies remote workspace file writes as raw request bodies", async () => {
    const addResponse = await app.inject({ method: "POST", url: "/api/machines", payload: { name: "Remote", baseUrl: "https://remote.example.test/" } });
    const remote = addResponse.json<{ id: string }>();
    const payload = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const request = vi.fn(() => Promise.resolve({
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: Readable.from([JSON.stringify({ path: "image.png", size: payload.length, modifiedAt: "now", created: true })]),
    }));
    remoteClient = fakeRemoteClient({ request });

    const response = await app.inject({
      method: "PUT",
      url: `/api/machines/${remote.id}/projects/p1/workspaces/w1/file?path=${encodeURIComponent("image.png")}`,
      payload,
      headers: { "content-type": "application/octet-stream" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ path: "image.png", size: payload.length, modifiedAt: "now", created: true });
    expect(request).toHaveBeenCalledWith("PUT", "/api/projects/p1/workspaces/w1/file?path=image.png", payload, { contentType: "application/octet-stream" });
  });

  it("proxies remote terminal command-run and continue routes", async () => {
    const addResponse = await app.inject({ method: "POST", url: "/api/machines", payload: { name: "Remote", baseUrl: "https://remote.example.test/" } });
    const remote = addResponse.json<{ id: string }>();
    const request = vi.fn((method: string, path: string) => Promise.resolve({
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: Readable.from([JSON.stringify({ method, path })]),
    }));
    remoteClient = fakeRemoteClient({ request });

    const createBody = { origin: "core", title: "Build", command: "npm test", metadata: { "pi.operation": "test" } };
    const deleteWorkspaceResponse = await app.inject({ method: "DELETE", url: `/api/machines/${remote.id}/projects/p1/workspaces/w1` });
    const createResponse = await app.inject({ method: "POST", url: `/api/machines/${remote.id}/projects/p1/workspaces/w1/terminal-command-runs`, payload: createBody });
    const listResponse = await app.inject({ method: "GET", url: `/api/machines/${remote.id}/terminal-command-runs?projectId=p1&statuses=running` });
    const getResponse = await app.inject({ method: "GET", url: `/api/machines/${remote.id}/terminal-command-runs/run1` });
    const cancelResponse = await app.inject({ method: "POST", url: `/api/machines/${remote.id}/terminal-command-runs/run1/cancel` });
    const closeWorkspaceTerminalsResponse = await app.inject({ method: "DELETE", url: `/api/machines/${remote.id}/projects/p1/workspaces/w1/terminals` });
    const continueResponse = await app.inject({ method: "POST", url: `/api/machines/${remote.id}/projects/p1/workspaces/w1/terminals/t1/continue` });

    expect(deleteWorkspaceResponse.json()).toEqual({ method: "DELETE", path: "/api/projects/p1/workspaces/w1" });
    expect(createResponse.json()).toEqual({ method: "POST", path: "/api/projects/p1/workspaces/w1/terminal-command-runs" });
    expect(listResponse.json()).toEqual({ method: "GET", path: "/api/terminal-command-runs?projectId=p1&statuses=running" });
    expect(getResponse.json()).toEqual({ method: "GET", path: "/api/terminal-command-runs/run1" });
    expect(cancelResponse.json()).toEqual({ method: "POST", path: "/api/terminal-command-runs/run1/cancel" });
    expect(closeWorkspaceTerminalsResponse.json()).toEqual({ method: "DELETE", path: "/api/projects/p1/workspaces/w1/terminals" });
    expect(continueResponse.json()).toEqual({ method: "POST", path: "/api/projects/p1/workspaces/w1/terminals/t1/continue" });
    expect(request).toHaveBeenCalledWith("POST", "/api/projects/p1/workspaces/w1/terminal-command-runs", createBody);
  });

  it("proxies remote session reloads through the selected machine", async () => {
    const addResponse = await app.inject({ method: "POST", url: "/api/machines", payload: { name: "Remote", baseUrl: "https://remote.example.test/" } });
    const remote = addResponse.json<{ id: string }>();
    const request = vi.fn(() => Promise.resolve({
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: Readable.from([JSON.stringify({ reloaded: true })]),
    }));
    remoteClient = fakeRemoteClient({ request });

    const response = await app.inject({ method: "POST", url: `/api/machines/${remote.id}/sessions/s1/reload`, payload: { cwd: "/repo" } });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ reloaded: true });
    expect(request).toHaveBeenCalledWith("POST", "/api/sessions/s1/reload", { cwd: "/repo" });
  });

  it("forwards remote JSON request bodies and normalizes remote timeouts", async () => {
    const addResponse = await app.inject({ method: "POST", url: "/api/machines", payload: { name: "Remote", baseUrl: "https://remote.example.test/" } });
    const remote = addResponse.json<{ id: string }>();
    const request = vi.fn(() => Promise.reject(new RemoteMachineRequestError("timed out", 504)));
    remoteClient = fakeRemoteClient({ request });

    const response = await app.inject({ method: "POST", url: `/api/machines/${remote.id}/sessions/s1/prompt`, payload: { text: "hello" } });

    expect(response.statusCode).toBe(504);
    expect(response.json()).toMatchObject({ error: "Remote machine timeout", machineId: remote.id, statusCode: 504 });
    expect(request).toHaveBeenCalledWith("POST", "/api/sessions/s1/prompt", { text: "hello" });
  });

  it("adds, lists, and closes projects through the HTTP contract", async () => {
    const addResponse = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "Example", path: projectDir, create: true },
    });

    expect(addResponse.statusCode).toBe(200);
    const project = addResponse.json<Project>();
    expect(project).toMatchObject({ name: "Example", path: projectDir });
    expect(project.id).not.toBe("");

    const listResponse = await app.inject({ method: "GET", url: "/api/projects" });
    expect(listResponse.statusCode).toBe(200);
    expect(listResponse.json<Project[]>()).toEqual([project]);

    const closeResponse = await app.inject({ method: "DELETE", url: `/api/projects/${project.id}` });
    expect(closeResponse.statusCode).toBe(200);
    expect(closeResponse.json()).toEqual({ closed: true });

    const emptyListResponse = await app.inject({ method: "GET", url: "/api/projects" });
    expect(emptyListResponse.json<Project[]>()).toEqual([]);
  });

  it("serves local session and terminal proxy routes through machine-scoped aliases", async () => {
    const sessionsResponse = await app.inject({ method: "GET", url: `/api/machines/local/sessions?cwd=${encodeURIComponent(projectDir)}` });

    expect(sessionsResponse.statusCode).toBe(200);
    expect(sessionsResponse.json()).toEqual({ method: "GET", path: `/sessions?cwd=${encodeURIComponent(projectDir)}` });
    expect(sessionDaemonRequests).toEqual([{ method: "GET", path: `/sessions?cwd=${encodeURIComponent(projectDir)}` }]);

    const addResponse = await app.inject({
      method: "POST",
      url: "/api/machines/local/projects",
      payload: { name: "Machine Local", path: projectDir, create: true },
    });
    const project = addResponse.json<Project>();
    const workspacesResponse = await app.inject({ method: "GET", url: `/api/machines/local/projects/${project.id}/workspaces` });
    const workspace = workspacesResponse.json<Workspace[]>()[0];
    if (workspace === undefined) throw new Error("Expected workspace");

    const terminalResponse = await app.inject({
      method: "POST",
      url: `/api/machines/local/projects/${project.id}/workspaces/${workspace.id}/terminal-command-runs`,
      payload: { origin: "core", title: "Build", command: "npm test", metadata: { "pi.operation": "test" } },
    });

    const closeTerminalsResponse = await app.inject({ method: "DELETE", url: `/api/machines/local/projects/${project.id}/workspaces/${workspace.id}/terminals` });

    expect(terminalResponse.statusCode).toBe(200);
    expect(terminalResponse.json()).toEqual({
      method: "POST",
      path: "/terminal-command-runs",
      body: {
        origin: "core",
        projectId: project.id,
        workspaceId: workspace.id,
        cwd: projectDir,
        title: "Build",
        command: "npm test",
        metadata: { "pi.operation": "test" },
      },
    });
    expect(closeTerminalsResponse.statusCode).toBe(200);
    expect(closeTerminalsResponse.json()).toEqual({ method: "DELETE", path: `/terminals?cwd=${encodeURIComponent(projectDir)}` });
    expect(sessionDaemonRequests[1]).toEqual({
      method: "POST",
      path: "/terminal-command-runs",
      body: {
        origin: "core",
        projectId: project.id,
        workspaceId: workspace.id,
        cwd: projectDir,
        title: "Build",
        command: "npm test",
        metadata: { "pi.operation": "test" },
      },
    });
    expect(sessionDaemonRequests[2]).toEqual({ method: "DELETE", path: `/terminals?cwd=${encodeURIComponent(projectDir)}` });
  });

  it("serves local projects and workspaces through machine-scoped aliases", async () => {
    const addResponse = await app.inject({
      method: "POST",
      url: "/api/machines/local/projects",
      payload: { name: "Machine Local", path: projectDir, create: true },
    });
    expect(addResponse.statusCode).toBe(200);
    const project = addResponse.json<Project>();

    const listResponse = await app.inject({ method: "GET", url: "/api/machines/local/projects" });
    expect(listResponse.statusCode).toBe(200);
    expect(listResponse.json<Project[]>()).toEqual([project]);

    const workspacesResponse = await app.inject({ method: "GET", url: `/api/machines/local/projects/${project.id}/workspaces` });
    expect(workspacesResponse.statusCode).toBe(200);
    expect(workspacesResponse.json<Workspace[]>()).toEqual([expect.objectContaining({ projectId: project.id, path: projectDir })]);
  });

  it("serves the PI WEB plugin manifest and plugin assets", async () => {
    const manifestResponse = await app.inject({ method: "GET", url: "/pi-web-plugins/manifest.json" });
    expect(manifestResponse.statusCode).toBe(200);
    expect(manifestResponse.json()).toEqual({ plugins: [{ id: "fake", module: "/pi-web-plugins/fake/plugin.js?v=1", source: "test", scope: "local", machineSpecific: false }] });

    const pluginsResponse = await app.inject({ method: "GET", url: "/api/plugins" });
    expect(pluginsResponse.statusCode).toBe(200);
    expect(pluginsResponse.json()).toEqual({ plugins: [{ id: "fake", module: "/pi-web-plugins/fake/plugin.js?v=1", source: "test", scope: "local", machineSpecific: false, enabled: true }] });

    const assetResponse = await app.inject({ method: "GET", url: "/pi-web-plugins/fake/plugin.js?v=1" });
    expect(assetResponse.statusCode).toBe(200);
    expect(assetResponse.headers["content-type"]).toContain("application/javascript");
    expect(assetResponse.body).toBe("export default {};");

    const missingResponse = await app.inject({ method: "GET", url: "/pi-web-plugins/fake/missing.js" });
    expect(missingResponse.statusCode).toBe(404);
  });

  it("rewrites and proxies remote machine plugin manifests and assets", async () => {
    const addResponse = await app.inject({ method: "POST", url: "/api/machines", payload: { name: "Remote", baseUrl: "https://remote.example.test/" } });
    const remote = addResponse.json<{ id: string }>();
    const requestJson = vi.fn(() => Promise.resolve({
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: { plugins: [{ id: "remote-tools", module: "/pi-web-plugins/remote-tools/pi-web-plugin.js?v=123", source: "local", scope: "local", machineSpecific: true }] },
    }));
    const request = vi.fn(() => Promise.resolve({
      statusCode: 200,
      headers: { "content-type": "application/javascript", "set-cookie": "secret=1" },
      body: Readable.from(["export default {};"]),
    }));
    remoteClient = fakeRemoteClient({ requestJson, request });

    const manifestResponse = await app.inject({ method: "GET", url: `/api/machines/${remote.id}/pi-web-plugins/manifest.json` });
    const scopedPluginId = machineScopedPluginId(remote.id, "remote-tools");
    expect(manifestResponse.statusCode).toBe(200);
    expect(manifestResponse.json()).toEqual({
      plugins: [{ id: "remote-tools", module: `/pi-web-plugins/${scopedPluginId}/pi-web-plugin.js?v=123`, source: "local", scope: "local", machineSpecific: true }],
    });
    expect(requestJson).toHaveBeenCalledWith("GET", "/pi-web-plugins/manifest.json", undefined, { timeoutMs: 10000 });

    const assetResponse = await app.inject({ method: "GET", url: `/pi-web-plugins/${scopedPluginId}/pi-web-plugin.js?v=123` });
    expect(assetResponse.statusCode).toBe(200);
    expect(assetResponse.headers["content-type"]).toContain("application/javascript");
    expect(assetResponse.headers["set-cookie"]).toBeUndefined();
    expect(assetResponse.body).toBe("export default {};");
    expect(request).toHaveBeenCalledWith("GET", "/pi-web-plugins/remote-tools/pi-web-plugin.js?v=123");
  });

  it("drops unsafe remote machine plugin manifest modules", async () => {
    const addResponse = await app.inject({ method: "POST", url: "/api/machines", payload: { name: "Remote", baseUrl: "https://remote.example.test/" } });
    const remote = addResponse.json<{ id: string }>();
    remoteClient = fakeRemoteClient({
      requestJson: vi.fn(() => Promise.resolve({
        statusCode: 200,
        headers: { "content-type": "application/json" },
        body: {
          plugins: [
            { id: "safe-tools", module: "nested/pi-web-plugin.js?v=1", source: "local", scope: "local" },
            { id: "traversal-tools", module: "..%2F..%2Fapi%2Fconfig", source: "local", scope: "local" },
            { id: "wrong-root", module: "/pi-web-plugins/other/pi-web-plugin.js", source: "local", scope: "local" },
          ],
        },
      })),
    });

    const manifestResponse = await app.inject({ method: "GET", url: `/api/machines/${remote.id}/pi-web-plugins/manifest.json` });

    expect(manifestResponse.statusCode).toBe(200);
    expect(manifestResponse.json()).toEqual({
      plugins: [{ id: "safe-tools", module: `/pi-web-plugins/${machineScopedPluginId(remote.id, "safe-tools")}/nested/pi-web-plugin.js?v=1`, source: "local", scope: "local" }],
    });
  });

  it("rejects remote machine plugin asset traversal before proxying", async () => {
    const addResponse = await app.inject({ method: "POST", url: "/api/machines", payload: { name: "Remote", baseUrl: "https://remote.example.test/" } });
    const remote = addResponse.json<{ id: string }>();
    const request = vi.fn(() => Promise.resolve({ statusCode: 200, headers: {}, body: Readable.from([]) }));
    remoteClient = fakeRemoteClient({ request });
    const scopedPluginId = machineScopedPluginId(remote.id, "remote-tools");

    const response = await app.inject({ method: "GET", url: `/pi-web-plugins/${scopedPluginId}/..%2F..%2Fapi%2Fconfig` });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "Invalid remote PI WEB plugin asset path" });
    expect(request).not.toHaveBeenCalled();
  });

  it("returns stable errors for invalid project requests", async () => {
    const addResponse = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "Missing", path: join(tempDir, "missing") },
    });

    expect(addResponse.statusCode).toBe(400);
    expect(addResponse.json()).toHaveProperty("error");

    const closeResponse = await app.inject({ method: "DELETE", url: "/api/projects/does-not-exist" });
    expect(closeResponse.statusCode).toBe(404);
    expect(closeResponse.json()).toEqual({ error: "Project not found" });
  });

  it("lists a non-git project as a single workspace", async () => {
    const addResponse = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "Plain", path: projectDir, create: true },
    });
    const project = addResponse.json<Project>();

    const workspacesResponse = await app.inject({ method: "GET", url: `/api/projects/${project.id}/workspaces` });

    expect(workspacesResponse.statusCode).toBe(200);
    expect(workspacesResponse.json<Workspace[]>()).toEqual([
      expect.objectContaining({
        projectId: project.id,
        path: projectDir,
        label: "Plain",
        isMain: true,
        isGitRepo: false,
        isGitWorktree: false,
      }),
    ]);
  });

  it("exposes the default upload config on workspace responses", async () => {
    const addResponse = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "Upload Defaults", path: projectDir, create: true },
    });
    const project = addResponse.json<Project>();

    const workspacesResponse = await app.inject({ method: "GET", url: `/api/projects/${project.id}/workspaces` });

    expect(workspacesResponse.statusCode).toBe(200);
    expect(workspacesResponse.json<Workspace[]>()).toEqual([
      expect.objectContaining({
        projectId: project.id,
        effectiveConfig: { uploads: { defaultFolder: ".pi-web/uploads" } },
      }),
    ]);
  });

  it("lets project-local upload config override global upload config on workspace responses", async () => {
    piWebConfig = { uploads: { defaultFolder: "global-uploads" } };
    const addResponse = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "Project Upload Defaults", path: projectDir, create: true },
    });
    const project = addResponse.json<Project>();
    await mkdir(join(projectDir, ".pi-web"), { recursive: true });
    await writeFile(join(projectDir, ".pi-web", "config.json"), `${JSON.stringify({ version: 1, uploads: { defaultFolder: "project-uploads" } }, null, 2)}\n`);

    const workspacesResponse = await app.inject({ method: "GET", url: `/api/projects/${project.id}/workspaces` });

    expect(workspacesResponse.statusCode).toBe(200);
    expect(workspacesResponse.json<Workspace[]>()).toEqual([
      expect.objectContaining({
        projectId: project.id,
        effectiveConfig: { uploads: { defaultFolder: "project-uploads" } },
      }),
    ]);
  });

  it("serves supported workspace images as previews", async () => {
    const addResponse = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "Images", path: projectDir, create: true },
    });
    const project = addResponse.json<Project>();
    const svg = "<svg xmlns=\"http://www.w3.org/2000/svg\"><rect width=\"1\" height=\"1\" /></svg>";
    await writeFile(join(projectDir, "diagram.svg"), svg);
    await writeFile(join(projectDir, "note.txt"), "hello");
    await writeFile(join(projectDir, "huge.png"), "");
    await truncate(join(projectDir, "huge.png"), MAX_IMAGE_PREVIEW_BYTES + 1);

    const workspacesResponse = await app.inject({ method: "GET", url: `/api/projects/${project.id}/workspaces` });
    const workspace = workspacesResponse.json<Workspace[]>()[0];
    if (workspace === undefined) throw new Error("Expected workspace");

    const previewResponse = await app.inject({ method: "GET", url: `/api/projects/${project.id}/workspaces/${workspace.id}/file/preview?path=${encodeURIComponent("diagram.svg")}` });

    expect(previewResponse.statusCode).toBe(200);
    expect(previewResponse.headers["content-type"]).toContain("image/svg+xml");
    expect(previewResponse.headers["cache-control"]).toBe("private, max-age=3600");
    expect(previewResponse.headers["content-security-policy"]).toContain("sandbox");
    expect(previewResponse.headers["x-content-type-options"]).toBe("nosniff");
    expect(previewResponse.body).toBe(svg);

    const rejectedResponse = await app.inject({ method: "GET", url: `/api/projects/${project.id}/workspaces/${workspace.id}/file/preview?path=${encodeURIComponent("note.txt")}` });
    expect(rejectedResponse.statusCode).toBe(400);
    expect(rejectedResponse.json()).toEqual({ error: "Image preview is not supported for this file type" });

    const tooLargeResponse = await app.inject({ method: "GET", url: `/api/projects/${project.id}/workspaces/${workspace.id}/file/preview?path=${encodeURIComponent("huge.png")}` });
    expect(tooLargeResponse.statusCode).toBe(400);
    expect(tooLargeResponse.json()).toEqual({ error: "Image is too large to preview (limit 10 MB)" });
  });

  it("keeps normal file suggestions workspace-local when path access config is invalid", async () => {
    const addResponse = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "Local Suggestions", path: projectDir, create: true },
    });
    expect(addResponse.statusCode).toBe(200);
    await writeFile(join(projectDir, "sdk.md"), "local sdk\n");
    await mkdir(join(projectDir, ".pi-web"), { recursive: true });
    await writeFile(join(projectDir, ".pi-web", "config.json"), `${JSON.stringify({ version: 1, pathAccess: { allowedPaths: [""] } }, null, 2)}\n`);

    const response = await app.inject({ method: "GET", url: `/api/files?cwd=${encodeURIComponent(projectDir)}&q=sdk&scope=all` });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([{ path: "sdk.md", kind: "other" }]);
  });

  it("serves project-configured allowed external files through the workspace explorer", async () => {
    const addResponse = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "External", path: projectDir, create: true },
    });
    const project = addResponse.json<Project>();
    const externalDir = join(tempDir, "external-docs");
    const deniedFile = join(tempDir, "secret.md");
    await mkdir(externalDir);
    await writeFile(join(externalDir, "sdk.md"), "external sdk\n");
    await writeFile(deniedFile, "secret\n");
    await mkdir(join(projectDir, ".pi-web"), { recursive: true });
    await writeFile(join(projectDir, ".pi-web", "config.json"), `${JSON.stringify({ version: 1, pathAccess: { allowedPaths: [externalDir] } }, null, 2)}\n`);

    const workspacesResponse = await app.inject({ method: "GET", url: `/api/projects/${project.id}/workspaces` });
    const workspace = workspacesResponse.json<Workspace[]>()[0];
    if (workspace === undefined) throw new Error("Expected workspace");

    const fileResponse = await app.inject({ method: "GET", url: `/api/projects/${project.id}/workspaces/${workspace.id}/file?path=${encodeURIComponent(join(externalDir, "sdk.md"))}` });
    const treeResponse = await app.inject({ method: "GET", url: `/api/projects/${project.id}/workspaces/${workspace.id}/tree?path=${encodeURIComponent(externalDir)}` });
    const suggestionResponse = await app.inject({ method: "GET", url: `/api/projects/${project.id}/workspaces/${workspace.id}/files?q=${encodeURIComponent(join(externalDir, "s"))}` });
    const localSuggestionResponse = await app.inject({ method: "GET", url: `/api/projects/${project.id}/workspaces/${workspace.id}/files?q=sdk` });
    const deniedResponse = await app.inject({ method: "GET", url: `/api/projects/${project.id}/workspaces/${workspace.id}/file?path=${encodeURIComponent(deniedFile)}` });

    expect(fileResponse.statusCode).toBe(200);
    expect(fileResponse.json()).toMatchObject({ path: join(externalDir, "sdk.md"), content: "external sdk\n", binary: false });
    expect(treeResponse.statusCode).toBe(200);
    expect(treeResponse.json()).toMatchObject({
      path: externalDir,
      entries: [expect.objectContaining({ name: "sdk.md", path: join(externalDir, "sdk.md"), type: "file" })],
      truncated: false,
    });
    expect(suggestionResponse.statusCode).toBe(200);
    expect(suggestionResponse.json()).toEqual([{ path: join(externalDir, "sdk.md"), kind: "other" }]);
    expect(localSuggestionResponse.statusCode).toBe(200);
    expect(localSuggestionResponse.json()).toEqual([]);
    expect(deniedResponse.statusCode).toBe(400);
    expect(deniedResponse.json()).toEqual({ error: "Path is outside allowed paths" });
  });

  it("writes workspace files through the HTTP contract", async () => {
    const addResponse = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "WriteTest", path: projectDir, create: true },
    });
    const project = addResponse.json<Project>();
    const workspacesResponse = await app.inject({ method: "GET", url: `/api/projects/${project.id}/workspaces` });
    const workspace = workspacesResponse.json<Workspace[]>()[0];
    if (workspace === undefined) throw new Error("Expected workspace");

    const writeTextResponse = await app.inject({
      method: "PUT",
      url: `/api/projects/${project.id}/workspaces/${workspace.id}/file?path=${encodeURIComponent("hello.txt")}`,
      payload: "hello world",
      headers: { "content-type": "text/plain" },
    });
    expect(writeTextResponse.statusCode).toBe(200);
    expect(writeTextResponse.json()).toMatchObject({ path: "hello.txt", created: true });
    expect(typeof writeTextResponse.json<{ size: unknown }>().size).toBe("number");

    const readResponse = await app.inject({ method: "GET", url: `/api/projects/${project.id}/workspaces/${workspace.id}/file?path=${encodeURIComponent("hello.txt")}` });
    expect(readResponse.json<{ content: unknown }>().content).toBe("hello world");

    const writeBinaryResponse = await app.inject({
      method: "PUT",
      url: `/api/projects/${project.id}/workspaces/${workspace.id}/file?path=${encodeURIComponent("image.png")}`,
      payload: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      headers: { "content-type": "application/octet-stream" },
    });
    expect(writeBinaryResponse.statusCode).toBe(200);
    expect(writeBinaryResponse.json()).toMatchObject({ path: "image.png", created: true });

    const writeDeepResponse = await app.inject({
      method: "PUT",
      url: `/api/projects/${project.id}/workspaces/${workspace.id}/file?path=${encodeURIComponent("deep/nested/dir/file.txt")}`,
      payload: "deep content",
      headers: { "content-type": "text/plain" },
    });
    expect(writeDeepResponse.statusCode).toBe(200);

    const readDeepResponse = await app.inject({ method: "GET", url: `/api/projects/${project.id}/workspaces/${workspace.id}/file?path=${encodeURIComponent("deep/nested/dir/file.txt")}` });
    expect(readDeepResponse.json<{ content: unknown }>().content).toBe("deep content");

    const overwriteResponse = await app.inject({
      method: "PUT",
      url: `/api/projects/${project.id}/workspaces/${workspace.id}/file?path=${encodeURIComponent("hello.txt")}`,
      payload: "updated",
      headers: { "content-type": "text/plain" },
    });
    expect(overwriteResponse.json()).toMatchObject({ path: "hello.txt", created: false });

    const noOverwriteResponse = await app.inject({
      method: "PUT",
      url: `/api/projects/${project.id}/workspaces/${workspace.id}/file?path=${encodeURIComponent("hello.txt")}&overwrite=false`,
      payload: "should fail",
      headers: { "content-type": "text/plain" },
    });
    expect(noOverwriteResponse.statusCode).toBe(400);
    expect(noOverwriteResponse.json<{ error: string }>().error).toContain("File already exists");

    const traversalResponse = await app.inject({
      method: "PUT",
      url: `/api/projects/${project.id}/workspaces/${workspace.id}/file?path=${encodeURIComponent("../../etc/passwd")}`,
      payload: "evil",
      headers: { "content-type": "text/plain" },
    });
    expect(traversalResponse.statusCode).toBe(400);
    expect(traversalResponse.json<{ error: string }>().error).toContain("Path traversal");

    const noPathResponse = await app.inject({
      method: "PUT",
      url: `/api/projects/${project.id}/workspaces/${workspace.id}/file`,
      payload: "no path",
      headers: { "content-type": "text/plain" },
    });
    expect(noPathResponse.statusCode).toBe(400);
    expect(noPathResponse.json<{ error: string }>().error).toContain("path query parameter is required");

    const noDirsResponse = await app.inject({
      method: "PUT",
      url: `/api/projects/${project.id}/workspaces/${workspace.id}/file?path=${encodeURIComponent("nonexistent/parent/file.txt")}&createDirs=false`,
      payload: "should fail",
      headers: { "content-type": "text/plain" },
    });
    expect(noDirsResponse.statusCode).toBe(400);

    await mkdir(join(projectDir, "subdir"), { recursive: true });
    const dirWriteResponse = await app.inject({
      method: "PUT",
      url: `/api/projects/${project.id}/workspaces/${workspace.id}/file?path=${encodeURIComponent("subdir")}`,
      payload: "should fail",
      headers: { "content-type": "text/plain" },
    });
    expect(dirWriteResponse.statusCode).toBe(400);
  });

  it("deletes workspace files through the HTTP contract", async () => {
    const addResponse = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "DeleteTest", path: projectDir, create: true },
    });
    const project = addResponse.json<Project>();
    const workspacesResponse = await app.inject({ method: "GET", url: `/api/projects/${project.id}/workspaces` });
    const workspace = workspacesResponse.json<Workspace[]>()[0];
    if (workspace === undefined) throw new Error("Expected workspace");

    await app.inject({
      method: "PUT",
      url: `/api/projects/${project.id}/workspaces/${workspace.id}/file?path=${encodeURIComponent("to-delete.txt")}`,
      payload: "delete me",
      headers: { "content-type": "text/plain" },
    });

    const deleteResponse = await app.inject({
      method: "DELETE",
      url: `/api/projects/${project.id}/workspaces/${workspace.id}/file?path=${encodeURIComponent("to-delete.txt")}`,
    });
    expect(deleteResponse.statusCode).toBe(200);
    expect(deleteResponse.json()).toMatchObject({ path: "to-delete.txt", existed: true });

    const deleteMissingResponse = await app.inject({
      method: "DELETE",
      url: `/api/projects/${project.id}/workspaces/${workspace.id}/file?path=${encodeURIComponent("missing.txt")}`,
    });
    expect(deleteMissingResponse.statusCode).toBe(200);
    expect(deleteMissingResponse.json()).toMatchObject({ path: "missing.txt", existed: false });

    const traversalResponse = await app.inject({
      method: "DELETE",
      url: `/api/projects/${project.id}/workspaces/${workspace.id}/file?path=${encodeURIComponent("../../etc/passwd")}`,
    });
    expect(traversalResponse.statusCode).toBe(400);
    expect(traversalResponse.json<{ error: string }>().error).toContain("Path traversal");

    const noPathResponse = await app.inject({
      method: "DELETE",
      url: `/api/projects/${project.id}/workspaces/${workspace.id}/file`,
    });
    expect(noPathResponse.statusCode).toBe(400);
    expect(noPathResponse.json<{ error: string }>().error).toContain("path query parameter is required");
  });

  it("moves workspace files through the HTTP contract", async () => {
    const addResponse = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "MoveTest", path: projectDir, create: true },
    });
    const project = addResponse.json<Project>();
    const workspacesResponse = await app.inject({ method: "GET", url: `/api/projects/${project.id}/workspaces` });
    const workspace = workspacesResponse.json<Workspace[]>()[0];
    if (workspace === undefined) throw new Error("Expected workspace");

    await app.inject({
      method: "PUT",
      url: `/api/projects/${project.id}/workspaces/${workspace.id}/file?path=${encodeURIComponent("original.txt")}`,
      payload: "move me",
      headers: { "content-type": "text/plain" },
    });

    const moveResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/workspaces/${workspace.id}/file/move?fromPath=${encodeURIComponent("original.txt")}&toPath=${encodeURIComponent("moved.txt")}`,
    });
    expect(moveResponse.statusCode).toBe(200);
    expect(moveResponse.json()).toMatchObject({ fromPath: "original.txt", toPath: "moved.txt" });
    expect(typeof moveResponse.json<{ size: unknown }>().size).toBe("number");

    const readSourceResponse = await app.inject({ method: "GET", url: `/api/projects/${project.id}/workspaces/${workspace.id}/file?path=${encodeURIComponent("original.txt")}` });
    expect(readSourceResponse.statusCode).toBe(400);

    const readTargetResponse = await app.inject({ method: "GET", url: `/api/projects/${project.id}/workspaces/${workspace.id}/file?path=${encodeURIComponent("moved.txt")}` });
    expect(readTargetResponse.statusCode).toBe(200);
    expect(readTargetResponse.json<{ content: unknown }>().content).toBe("move me");

    await app.inject({
      method: "PUT",
      url: `/api/projects/${project.id}/workspaces/${workspace.id}/file?path=${encodeURIComponent("source2.txt")}`,
      payload: "source",
      headers: { "content-type": "text/plain" },
    });
    await app.inject({
      method: "PUT",
      url: `/api/projects/${project.id}/workspaces/${workspace.id}/file?path=${encodeURIComponent("target2.txt")}`,
      payload: "target",
      headers: { "content-type": "text/plain" },
    });

    const overwriteResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/workspaces/${workspace.id}/file/move?fromPath=${encodeURIComponent("source2.txt")}&toPath=${encodeURIComponent("target2.txt")}&overwrite=true`,
    });
    expect(overwriteResponse.statusCode).toBe(200);

    await app.inject({
      method: "PUT",
      url: `/api/projects/${project.id}/workspaces/${workspace.id}/file?path=${encodeURIComponent("source3.txt")}`,
      payload: "s",
      headers: { "content-type": "text/plain" },
    });
    await app.inject({
      method: "PUT",
      url: `/api/projects/${project.id}/workspaces/${workspace.id}/file?path=${encodeURIComponent("target3.txt")}`,
      payload: "t",
      headers: { "content-type": "text/plain" },
    });
    const noOverwriteResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/workspaces/${workspace.id}/file/move?fromPath=${encodeURIComponent("source3.txt")}&toPath=${encodeURIComponent("target3.txt")}`,
    });
    expect(noOverwriteResponse.statusCode).toBe(400);
    expect(noOverwriteResponse.json<{ error: string }>().error).toContain("File already exists");

    const traversalFromResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/workspaces/${workspace.id}/file/move?fromPath=${encodeURIComponent("../../etc/passwd")}&toPath=${encodeURIComponent("safe.txt")}`,
    });
    expect(traversalFromResponse.statusCode).toBe(400);

    const noParamsResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/workspaces/${workspace.id}/file/move`,
    });
    expect(noParamsResponse.statusCode).toBe(400);
    expect(noParamsResponse.json<{ error: string }>().error).toContain("fromPath query parameter is required");
  });
});

interface CapturedSessionDaemonRequest {
  method: string;
  path: string;
  body?: unknown;
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

function piWebConfigResponse(config: PiWebConfigValues): PiWebConfigResponse {
  return {
    path: join(tempDir, "config.json"),
    exists: false,
    config,
    effectiveConfig: config,
    envOverrides: { host: false, port: false, allowedHosts: false, spawnSessions: false, subsessions: false, agentCommand: false, agentDir: false, agentSessionDir: false },
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

function fakeRemoteClient(overrides: Partial<MachineClient>): MachineClient {
  return {
    request: () => Promise.resolve({ statusCode: 200, headers: {}, body: Readable.from([]) }),
    requestJson: () => Promise.resolve({ statusCode: 200, headers: {}, body: undefined }),
    connectWebSocket: () => { throw new Error("WebSocket not configured for test"); },
    ...overrides,
  };
}
