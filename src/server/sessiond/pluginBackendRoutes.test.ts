import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceProvider } from "../../server-plugin-api.js";
import type { ServerPluginProviderContribution } from "../plugins/serverPluginRuntime.js";
import type { Project } from "../types.js";
import { WorkspaceProviderRegistry } from "../workspaces/workspaceProviderRegistry.js";
import { registerPluginBackendRoutes } from "./pluginBackendRoutes.js";

const project: Project = {
  id: "project one",
  name: "Board project",
  path: "/repo",
  createdAt: "2026-07-27T00:00:00.000Z",
};

let app: FastifyInstance;

beforeEach(() => {
  app = Fastify({ logger: false });
});

afterEach(async () => {
  await app.close();
});

describe("session daemon plugin backend routes", () => {
  it("returns a JSON-only neutral provider result with attributable identity", async () => {
    const registry = registryFor({
      probe: () => Promise.resolve("claim"),
      list: () => Promise.resolve([{
        key: "main",
        path: "/repo",
        label: "main",
        isMain: true,
        data: { privateBoard: "roadmap" },
      }]),
      request: ({ operation, input, workspace }) => Promise.resolve({
        operation,
        input,
        board: workspace.data ?? null,
      }),
    });
    const workspaceId = (await registry.resolve(project)).workspaces[0]?.id;
    if (workspaceId === undefined) throw new Error("Expected workspace");
    const onWorkspacesMutated = vi.fn();
    registerPluginBackendRoutes(app, { projects: projectReader(), backends: registry, onWorkspacesMutated });

    const response = await app.inject({
      method: "POST",
      url: `/plugin-backends/board/projects/${encodeURIComponent(project.id)}/workspaces/${workspaceId}/cards.summary`,
      payload: { revision: "server-r1", input: { cards: ["alpha"], includeClosed: false } },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/json");
    expect(response.json()).toEqual({
      operation: "cards.summary",
      input: { cards: ["alpha"], includeClosed: false },
      board: { privateBoard: "roadmap" },
    });
    // A provider operation is opaque here, so a completed request always
    // reports that the project's workspace listing may have changed.
    expect(onWorkspacesMutated).toHaveBeenCalledTimes(1);
  });

  it("serializes invalid, stale, and thrown operation failures without a stack", async () => {
    const registry = registryFor({
      probe: () => Promise.resolve("claim"),
      list: () => Promise.resolve([{ key: "main", path: "/repo", label: "main", isMain: true }]),
      request: () => Promise.reject(new Error("neutral handler failed")),
    });
    const workspaceId = (await registry.resolve(project)).workspaces[0]?.id;
    if (workspaceId === undefined) throw new Error("Expected workspace");
    registerPluginBackendRoutes(app, { projects: projectReader(), backends: registry, onWorkspacesMutated: vi.fn() });
    const base = `/plugin-backends/board/projects/${encodeURIComponent(project.id)}/workspaces/${workspaceId}`;

    const invalid = await app.inject({ method: "POST", url: `${base}/Invalid`, payload: { revision: "server-r1", input: null } });
    const stale = await app.inject({ method: "POST", url: `${base}/cards.summary`, payload: { revision: "old", input: null } });
    const failed = await app.inject({ method: "POST", url: `${base}/cards.summary`, payload: { revision: "server-r1", input: null } });

    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ code: "invalid-request", pluginId: "board", operation: "Invalid" });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: "stale-plugin-revision", pluginId: "board", operation: "cards.summary" });
    expect(failed.statusCode).toBe(502);
    expect(failed.json()).toEqual({
      error: "Server plugin board operation cards.summary failed: neutral handler failed",
      code: "request-failed",
      pluginId: "board",
      operation: "cards.summary",
    });
    expect(failed.body).not.toContain("stack");
  });

  it("rejects a missing project and malformed request envelope before dispatch", async () => {
    const request = vi.fn<WorkspaceProviderRegistry["request"]>();
    const requestBinary = vi.fn<WorkspaceProviderRegistry["requestBinary"]>();
    registerPluginBackendRoutes(app, { projects: projectReader(), backends: { request, requestBinary }, onWorkspacesMutated: vi.fn() });
    const path = "/plugin-backends/board/projects/missing/workspaces/w1/cards.summary";

    const malformed = await app.inject({ method: "POST", url: path, payload: { input: null } });
    const missing = await app.inject({ method: "POST", url: path, payload: { revision: "server-r1", input: null } });

    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toMatchObject({ code: "invalid-request" });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ code: "project-not-found" });
    expect(request).not.toHaveBeenCalled();
  });
});

describe("session daemon plugin backend binary route", () => {
  it("delivers the raw body and revision header to the owning provider", async () => {
    const registry = registryFor({
      probe: () => Promise.resolve("claim"),
      list: () => Promise.resolve([{
        key: "main",
        path: "/repo",
        label: "main",
        isMain: true,
        data: { privateBoard: "roadmap" },
      }]),
      requestBinary: ({ operation, body, workspace }) => Promise.resolve({
        operation,
        received: body.byteLength,
        board: workspace.data ?? null,
      }),
    });
    const workspaceId = (await registry.resolve(project)).workspaces[0]?.id;
    if (workspaceId === undefined) throw new Error("Expected workspace");
    const onWorkspacesMutated = vi.fn();
    registerPluginBackendRoutes(app, { projects: projectReader(), backends: registry, onWorkspacesMutated });

    const response = await app.inject({
      method: "POST",
      url: `/plugin-backends/board/projects/${encodeURIComponent(project.id)}/workspaces/${workspaceId}/secrets.store/binary`,
      headers: { "content-type": "application/octet-stream", "x-pi-web-plugin-backend-revision": "server-r1" },
      payload: Buffer.from([0x73, 0x65, 0x63, 0x72, 0x65, 0x74]),
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/json");
    expect(response.json()).toEqual({
      operation: "secrets.store",
      received: 6,
      board: { privateBoard: "roadmap" },
    });
    expect(onWorkspacesMutated).toHaveBeenCalledTimes(1);
  });

  it("rejects missing revision headers and non-binary bodies before dispatch", async () => {
    const registry = registryFor({
      probe: () => Promise.resolve("claim"),
      list: () => Promise.resolve([{ key: "main", path: "/repo", label: "main", isMain: true }]),
    });
    const workspaceId = (await registry.resolve(project)).workspaces[0]?.id;
    if (workspaceId === undefined) throw new Error("Expected workspace");
    registerPluginBackendRoutes(app, { projects: projectReader(), backends: registry, onWorkspacesMutated: vi.fn() });
    const base = `/plugin-backends/board/projects/${encodeURIComponent(project.id)}/workspaces/${workspaceId}/secrets.store/binary`;

    const missingRevision = await app.inject({ method: "POST", url: base, headers: { "content-type": "application/octet-stream" }, payload: Buffer.from("opaque") });
    const invalidRevision = await app.inject({ method: "POST", url: base, headers: { "content-type": "application/octet-stream", "x-pi-web-plugin-backend-revision": "" }, payload: Buffer.from("opaque") });
    const json = await app.inject({ method: "POST", url: base, headers: { "x-pi-web-plugin-backend-revision": "server-r1" }, payload: { revision: "server-r1", input: null } });
    const staleRevision = await app.inject({ method: "POST", url: base, headers: { "content-type": "application/octet-stream", "x-pi-web-plugin-backend-revision": "old" }, payload: Buffer.from("opaque") });

    expect(missingRevision.statusCode).toBe(400);
    expect(missingRevision.json()).toMatchObject({ code: "invalid-request", pluginId: "board", operation: "secrets.store" });
    expect(invalidRevision.statusCode).toBe(400);
    expect(invalidRevision.json()).toMatchObject({ code: "invalid-request" });
    expect(json.statusCode).toBe(400);
    expect(json.json()).toMatchObject({ code: "invalid-request" });
    expect(staleRevision.statusCode).toBe(409);
    expect(staleRevision.json()).toMatchObject({ code: "stale-plugin-revision" });
  });

  it("reports provider absence and thrown failures without payload details", async () => {
    const withoutBinary = registryFor({
      probe: () => Promise.resolve("claim"),
      list: () => Promise.resolve([{ key: "main", path: "/repo", label: "main", isMain: true }]),
      request: () => Promise.resolve(null),
    });
    const workspaceId = (await withoutBinary.resolve(project)).workspaces[0]?.id;
    if (workspaceId === undefined) throw new Error("Expected workspace");
    const path = `/plugin-backends/board/projects/${encodeURIComponent(project.id)}/workspaces/${workspaceId}/secrets.store/binary`;

    registerPluginBackendRoutes(app, { projects: projectReader(), backends: withoutBinary, onWorkspacesMutated: vi.fn() });
    const unavailable = await app.inject({
      method: "POST",
      url: path,
      headers: { "content-type": "application/octet-stream", "x-pi-web-plugin-backend-revision": "server-r1" },
      payload: Buffer.from("sensitive-bytes"),
    });

    expect(unavailable.statusCode).toBe(501);
    expect(unavailable.json()).toMatchObject({ code: "operation-unavailable" });
    expect(unavailable.body).not.toContain("sensitive-bytes");
  });

  it("maps thrown binary provider failures to 502 without echoing the payload", async () => {
    const failing = registryFor({
      probe: () => Promise.resolve("claim"),
      list: () => Promise.resolve([{ key: "main", path: "/repo", label: "main", isMain: true }]),
      requestBinary: () => Promise.reject(new Error("receiver exited early")),
    });
    const workspaceId = (await failing.resolve(project)).workspaces[0]?.id;
    if (workspaceId === undefined) throw new Error("Expected workspace");
    const path = `/plugin-backends/board/projects/${encodeURIComponent(project.id)}/workspaces/${workspaceId}/secrets.store/binary`;

    registerPluginBackendRoutes(app, { projects: projectReader(), backends: failing, onWorkspacesMutated: vi.fn() });
    const failed = await app.inject({
      method: "POST",
      url: path,
      headers: { "content-type": "application/octet-stream", "x-pi-web-plugin-backend-revision": "server-r1" },
      payload: Buffer.from("sensitive-bytes"),
    });

    expect(failed.statusCode).toBe(502);
    expect(failed.json()).toMatchObject({ code: "request-failed" });
    expect(failed.body).toContain("receiver exited early");
    expect(failed.body).not.toContain("sensitive-bytes");
  });
});

function projectReader() {
  return {
    requireProject: (projectId: string) => projectId === project.id
      ? Promise.resolve(project)
      : Promise.reject(new Error("Project not found")),
  };
}

function registryFor(provider: WorkspaceProvider): WorkspaceProviderRegistry {
  return new WorkspaceProviderRegistry({
    contributions: [contribution("board", provider)],
    logger: { warn: vi.fn() },
    pathInspector: () => true,
  });
}

function contribution(pluginId: string, provider: WorkspaceProvider): ServerPluginProviderContribution {
  return {
    pluginId,
    pluginName: "Board",
    packageRoot: "/plugins/board",
    source: "test fixture",
    scope: "local",
    moduleRevision: "server-r1",
    provider,
  };
}
