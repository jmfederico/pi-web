import { resolve } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderWorkspace, WorkspaceProvider } from "../../server-plugin-api.js";
import type { Workspace } from "../../shared/apiTypes.js";
import type { ServerPluginProviderContribution } from "../plugins/serverPluginRuntime.js";
import { ProjectScopedSpawnTargetResolver } from "../sessions/spawnTargetResolver.js";
import type { Project } from "../types.js";
import { createWorkspaceProviderRuntimeSnapshot } from "../workspaces/workspaceCatalog.js";
import { WorkspaceProviderRegistry } from "../workspaces/workspaceProviderRegistry.js";
import { registerWorkspaceCatalogRoutes } from "./workspaceCatalogRoutes.js";

const project: Project = {
  id: "p1",
  name: "Project",
  path: hostPath("/repo"),
  createdAt: "2026-07-27T00:00:00.000Z",
};

/**
 * The registry resolves every project/provider path into the host's absolute
 * form, so fixture paths must be compared in their resolved platform form.
 */
function hostPath(path: string): string {
  return resolve(path);
}

let app: FastifyInstance;

beforeEach(() => {
  app = Fastify({ logger: false });
});

afterEach(async () => {
  await app.close();
});

describe("session daemon workspace catalog routes", () => {
  it("serves the same live provider registry used by spawned-session validation", async () => {
    let listed: ProviderWorkspace[] = [providerWorkspace("root", hostPath("/repo"), true)];
    const registry = registryFor({
      probe: () => Promise.resolve("claim"),
      list: () => Promise.resolve(listed),
    });
    const projects = projectReader();
    registerWorkspaceCatalogRoutes(app, {
      projects,
      workspaces: registry,
      providerRuntime: createWorkspaceProviderRuntimeSnapshot([], []),
    });
    const spawnTargets = new ProjectScopedSpawnTargetResolver({ projects, workspaces: registry });

    await expect(spawnTargets.resolveSpawnTarget(hostPath("/repo"), hostPath("/linked"))).resolves.toEqual({
      allowed: false,
      reason: "out-of-project",
      allowedCwds: [hostPath("/repo")],
    });

    listed = [
      providerWorkspace("root", hostPath("/repo"), true),
      providerWorkspace("linked", hostPath("/linked"), false, { branch: "feature/linked" }),
    ];
    const [response, spawnDecision] = await Promise.all([
      app.inject({ method: "GET", url: "/workspace-catalog/projects/p1/workspaces" }),
      spawnTargets.resolveSpawnTarget(hostPath("/repo"), hostPath("/linked")),
    ]);

    expect(response.statusCode).toBe(200);
    const resolution = response.json<{ status: string; ownerPluginId: string; workspaces: Workspace[] }>();
    expect(resolution).toMatchObject({ status: "provider", ownerPluginId: "owner" });
    expect(resolution.workspaces.map(({ path }) => path)).toEqual([hostPath("/repo"), hostPath("/linked")]);
    expect(spawnDecision).toEqual({ allowed: true, cwd: hostPath("/linked") });

    const linked = resolution.workspaces.find(({ path }) => path === hostPath("/linked"));
    if (linked === undefined) throw new Error("Expected linked workspace");
    expect(linked).toMatchObject({
      label: "linked",
      provider: { metadata: { branch: "feature/linked" } },
    });
    expect(linked).not.toHaveProperty("branch");

    const current = await app.inject({ method: "GET", url: `/workspace-catalog/projects/p1/workspaces/${linked.id}` });
    expect(current.statusCode).toBe(200);
    const currentWorkspace = current.json<Workspace>();
    expect(currentWorkspace).toMatchObject({ id: linked.id, path: hostPath("/linked") });
    expect(currentWorkspace).not.toHaveProperty("branch");

    listed = [providerWorkspace("root", hostPath("/repo"), true)];
    const stale = await app.inject({ method: "GET", url: `/workspace-catalog/projects/p1/workspaces/${linked.id}` });
    expect(stale.statusCode).toBe(404);
    expect(stale.json()).toEqual({ error: "Workspace not found" });
  });

  it("returns safe degraded and not-found responses rather than switching after a claimed provider fails", async () => {
    const fallbackProbe = vi.fn(() => Promise.resolve<"claim">("claim"));
    const registry = new WorkspaceProviderRegistry({
      contributions: [
        contribution("owner", {
          probe: () => Promise.resolve("claim"),
          list: () => Promise.reject(new Error("provider list failed")),
        }),
        contribution("fallback", {
          fallback: true,
          probe: fallbackProbe,
          list: () => Promise.resolve([providerWorkspace("fallback", hostPath("/fallback"), true)]),
        }),
      ],
      logger: { warn: vi.fn() },
      pathInspector: () => true,
    });
    registerWorkspaceCatalogRoutes(app, {
      projects: projectReader(),
      workspaces: registry,
      providerRuntime: createWorkspaceProviderRuntimeSnapshot([], []),
    });

    const degraded = await app.inject({ method: "GET", url: "/workspace-catalog/projects/p1/workspaces" });
    const missingProject = await app.inject({ method: "GET", url: "/workspace-catalog/projects/missing/workspaces" });

    expect(degraded.statusCode).toBe(200);
    expect(degraded.json()).toMatchObject({
      status: "degraded",
      ownerPluginId: "owner",
      workspaces: [{ projectId: "p1", path: hostPath("/repo"), isMain: true }],
      diagnostics: [{ code: "list-failed", pluginId: "owner" }],
    });
    expect(fallbackProbe).not.toHaveBeenCalled();
    expect(missingProject.statusCode).toBe(404);
    expect(missingProject.json()).toEqual({ error: "Project not found" });
  });

  it("exposes the immutable startup runtime and health snapshot", async () => {
    const snapshot = createWorkspaceProviderRuntimeSnapshot(
      [{ pluginId: "git", source: "bundled", scope: "bundled", moduleRevision: "sha256:abc", settingsRevision: "sha256:settings", machineSpecific: true, state: "active", name: "Git" }],
      [{ pluginId: "git", health: { status: "healthy" } }],
      "bundled-only",
      [{ code: "duplicate-id", source: "local", message: "Duplicate PI WEB plugin id: git", pluginId: "git" }],
    );
    registerWorkspaceCatalogRoutes(app, {
      projects: projectReader(),
      workspaces: registryFor({ probe: () => Promise.resolve("pass"), list: () => Promise.resolve([]) }),
      providerRuntime: snapshot,
    });

    const response = await app.inject({ method: "GET", url: "/workspace-catalog/provider-runtime" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      protocolVersion: 1,
      safeStart: "bundled-only",
      records: [{ pluginId: "git", source: "bundled", scope: "bundled", moduleRevision: "sha256:abc", settingsRevision: "sha256:settings", machineSpecific: true, state: "active", name: "Git" }],
      health: [{ pluginId: "git", health: { status: "healthy" } }],
      diagnostics: [{ code: "duplicate-id", source: "local", message: "Duplicate PI WEB plugin id: git", pluginId: "git" }],
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
  });
});

function projectReader() {
  return {
    list: () => Promise.resolve([project]),
    requireProject: (projectId: string) => projectId === project.id
      ? Promise.resolve(project)
      : Promise.reject(new Error("Project not found")),
  };
}

function registryFor(workspaceProvider: WorkspaceProvider): WorkspaceProviderRegistry {
  return new WorkspaceProviderRegistry({
    contributions: [contribution("owner", workspaceProvider)],
    logger: { warn: vi.fn() },
    pathInspector: () => true,
  });
}

function contribution(pluginId: string, workspaceProvider: WorkspaceProvider): ServerPluginProviderContribution {
  return {
    pluginId,
    pluginName: pluginId,
    packageRoot: `/plugins/${pluginId}`,
    source: "test fixture",
    scope: "local",
    moduleRevision: "1",
    provider: workspaceProvider,
  };
}

function providerWorkspace(
  key: string,
  path: string,
  isMain: boolean,
  publicMetadata?: ProviderWorkspace["publicMetadata"],
): ProviderWorkspace {
  return { key, path, label: key, isMain, ...(publicMetadata === undefined ? {} : { publicMetadata }) };
}
