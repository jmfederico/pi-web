import { mkdtemp, realpath, rm, truncate, writeFile } from "node:fs/promises";
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
import { MAX_IMAGE_PREVIEW_BYTES } from "../shared/workspaceFiles.js";
import type { Project, Workspace } from "./types.js";

let app: FastifyInstance;
let tempDir: string;
let projectDir: string;
let remoteClient: MachineClient | undefined;

beforeEach(async () => {
  tempDir = await realpath(await mkdtemp(join(tmpdir(), "pi-web-app-test-")));
  projectDir = join(tempDir, "project");
  remoteClient = undefined;
  app = await buildApp({
    projects: new ProjectService(new ProjectStore(join(tempDir, "projects.json"))),
    workspaces: new WorkspaceService(),
    machines: new MachineService(new MachineStore(join(tempDir, "machines.json")), {
      remoteClientFactory: () => {
        if (remoteClient === undefined) throw new Error("No remote machine client configured");
        return remoteClient;
      },
      now: () => new Date("2026-05-25T00:00:00.000Z"),
      localStatus: () => Promise.resolve({
        packageName: "@jmfederico/pi-web",
        generatedAt: "2026-05-25T00:00:00.000Z",
        components: {
          web: { component: "web", label: "PI WEB", stale: false, available: true },
          sessiond: { component: "sessiond", label: "PI WEB Session Daemon", stale: false, available: true },
        },
        release: { packageName: "@jmfederico/pi-web", updateAvailable: false },
        commands: { update: "", restart: "", restartSystemd: "", restartDev: "" },
        messages: [],
      }),
    }),
    piWebPlugins: {
      manifest: () => Promise.resolve({ plugins: [{ id: "fake", module: "/pi-web-plugins/fake/plugin.js?v=1", source: "test", scope: "local" }] }),
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

  it("serves local session proxy routes through machine-scoped aliases", async () => {
    const response = await app.inject({ method: "GET", url: `/api/machines/local/sessions?cwd=${encodeURIComponent(projectDir)}` });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toHaveProperty("error");
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
    expect(manifestResponse.json()).toEqual({ plugins: [{ id: "fake", module: "/pi-web-plugins/fake/plugin.js?v=1", source: "test", scope: "local" }] });

    const assetResponse = await app.inject({ method: "GET", url: "/pi-web-plugins/fake/plugin.js?v=1" });
    expect(assetResponse.statusCode).toBe(200);
    expect(assetResponse.headers["content-type"]).toContain("application/javascript");
    expect(assetResponse.body).toBe("export default {};");

    const missingResponse = await app.inject({ method: "GET", url: "/pi-web-plugins/fake/missing.js" });
    expect(missingResponse.statusCode).toBe(404);
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
});

function fakeRemoteClient(overrides: Partial<MachineClient>): MachineClient {
  return {
    request: () => Promise.resolve({ statusCode: 200, headers: {}, body: Readable.from([]) }),
    requestJson: () => Promise.resolve({ statusCode: 200, headers: {}, body: undefined }),
    connectWebSocket: () => { throw new Error("WebSocket not configured for test"); },
    ...overrides,
  };
}
