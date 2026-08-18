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
    registerPluginBackendRoutes(app, { projects: projectReader(), backends: { request }, onWorkspacesMutated: vi.fn() });
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
