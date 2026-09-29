import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PluginBackendRegistry } from "../plugins/pluginBackendRegistry.js";
import type { ServerPluginPairedBackendContribution } from "../plugins/serverPluginRuntime.js";
import type { Project } from "../types.js";
import { WorkspaceProviderRegistry } from "../workspaces/workspaceProviderRegistry.js";
import { registerPairedPluginBackendRoutes } from "./pluginBackendRoutes.js";

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

describe("session daemon paired plugin backend routes", () => {
  it("routes a package peer against host-resolved workspace authority with an operation-scoped signal", async () => {
    let observedSignal: AbortSignal | undefined;
    const backends = registryFor(({ operation, input, signal }) => {
      observedSignal = signal;
      return { operation, input };
    });
    const workspaceId = await folderWorkspaceId();
    const onWorkspacesMutated = vi.fn();
    registerPairedPluginBackendRoutes(app, { projects: projectReader(), backends, onWorkspacesMutated });

    const response = await app.inject({
      method: "POST",
      url: `/paired-plugin-backends/board/projects/${encodeURIComponent(project.id)}/workspaces/${workspaceId}/cards.summary`,
      payload: { revision: "server-r1", input: { cards: 2 } },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/json");
    expect(response.json()).toEqual({ operation: "cards.summary", input: { cards: 2 } });
    expect(observedSignal).toBeInstanceOf(AbortSignal);
    expect(observedSignal?.aborted).toBe(true);
    expect(onWorkspacesMutated).toHaveBeenCalledOnce();
  });

  it("does not dispatch a request admitted before quiesce after backend shutdown", async () => {
    let quiescing = false;
    app.addHook("onRequest", (_request, reply, done) => {
      if (!quiescing) done();
      else void reply.code(503).send({ error: "Session daemon is shutting down" });
    });
    const projectResolution = deferred<Project>();
    const projects = { requireProject: vi.fn(() => projectResolution.promise) };
    const peerRequest = vi.fn(() => ({ shouldNotRun: true }));
    const backends = registryFor(peerRequest);
    const workspaceId = await folderWorkspaceId();
    registerPairedPluginBackendRoutes(app, { projects, backends, onWorkspacesMutated: vi.fn() });
    const response = app.inject({
      method: "POST",
      url: `/paired-plugin-backends/board/projects/${encodeURIComponent(project.id)}/workspaces/${workspaceId}/cards.summary`,
      payload: { revision: "server-r1", input: null },
    });
    await vi.waitFor(() => { expect(projects.requireProject).toHaveBeenCalledOnce(); });

    quiescing = true;
    await backends.closeAll("test quiesce");
    projectResolution.resolve(project);

    await expect(response).resolves.toMatchObject({ statusCode: 503 });
    expect((await response).json()).toMatchObject({ code: "shutdown", pluginId: "board" });
    expect(peerRequest).not.toHaveBeenCalled();
  });

  it("does not register the retired owner-backed route", async () => {
    const request = vi.fn<PluginBackendRegistry["request"]>();
    registerPairedPluginBackendRoutes(app, { projects: projectReader(), backends: { request }, onWorkspacesMutated: vi.fn() });

    const response = await app.inject({
      method: "POST",
      url: "/plugin-backends/board/projects/project%20one/workspaces/w1/cards.summary",
      payload: { revision: "server-r1", input: null },
    });

    expect(response.statusCode).toBe(404);
    expect(request).not.toHaveBeenCalled();
  });

  it("serializes invalid, stale, and thrown operation failures without a stack", async () => {
    const backends = registryFor(() => Promise.reject(new Error("neutral handler failed")));
    const workspaceId = await folderWorkspaceId();
    registerPairedPluginBackendRoutes(app, { projects: projectReader(), backends, onWorkspacesMutated: vi.fn() });
    const base = `/paired-plugin-backends/board/projects/${encodeURIComponent(project.id)}/workspaces/${workspaceId}`;

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
    const request = vi.fn<PluginBackendRegistry["request"]>();
    registerPairedPluginBackendRoutes(app, { projects: projectReader(), backends: { request }, onWorkspacesMutated: vi.fn() });
    const path = "/paired-plugin-backends/board/projects/missing/workspaces/w1/cards.summary";

    const malformed = await app.inject({ method: "POST", url: path, payload: { input: null } });
    const missing = await app.inject({ method: "POST", url: path, payload: { revision: "server-r1", input: null } });

    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toMatchObject({ code: "invalid-request" });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ code: "project-not-found" });
    expect(request).not.toHaveBeenCalled();
  });

  it("passes an inbound cancellation signal to the dispatcher", async () => {
    let observedSignal: AbortSignal | undefined;
    const request = vi.fn((_backendRequest, signal?: AbortSignal) => {
      observedSignal = signal;
      return Promise.resolve(null);
    });
    registerPairedPluginBackendRoutes(app, { projects: projectReader(), backends: { request }, onWorkspacesMutated: vi.fn() });

    const response = await app.inject({
      method: "POST",
      url: "/paired-plugin-backends/board/projects/project%20one/workspaces/w1/cards.summary",
      payload: { revision: "server-r1", input: null },
    });

    expect(response.statusCode).toBe(200);
    expect(observedSignal).toBeInstanceOf(AbortSignal);
    expect(observedSignal?.aborted).toBe(false);
  });
});

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => { resolvePromise = resolve; });
  if (resolvePromise === undefined) throw new Error("Deferred promise was not initialized");
  return { promise, resolve: resolvePromise };
}

function projectReader() {
  return {
    requireProject: (projectId: string) => projectId === project.id
      ? Promise.resolve(project)
      : Promise.reject(new Error("Project not found")),
  };
}

async function folderWorkspaceId(): Promise<string> {
  const workspaceId = (await workspaceRegistry().resolve(project)).workspaces[0]?.id;
  if (workspaceId === undefined) throw new Error("Expected folder workspace");
  return workspaceId;
}

function registryFor(
  request: NonNullable<ServerPluginPairedBackendContribution["backend"]["request"]>,
): PluginBackendRegistry {
  return new PluginBackendRegistry({
    contributions: [{
      pluginId: "board",
      pluginName: "Board",
      packageRoot: "/plugins/board",
      source: "test fixture",
      scope: "local",
      moduleRevision: "server-r1",
      backend: { request },
    }],
    workspaces: workspaceRegistry(),
  });
}

function workspaceRegistry(): WorkspaceProviderRegistry {
  return new WorkspaceProviderRegistry({
    contributions: [],
    logger: { warn: vi.fn() },
    pathInspector: () => true,
  });
}
