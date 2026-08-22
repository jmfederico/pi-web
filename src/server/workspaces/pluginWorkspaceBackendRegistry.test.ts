import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { JsonValue, WorkspaceBackendRequestContext } from "../../server-plugin-api.js";
import type { WorkspaceProviderAuthorityResolution } from "../../shared/apiTypes.js";
import type { ServerPluginWorkspaceBackendContribution } from "../plugins/serverPluginRuntime.js";
import type { Project } from "../types.js";
import { WorkspaceProviderRequestError } from "./workspaceProviderRegistry.js";
import { PluginWorkspaceBackendRegistry } from "./pluginWorkspaceBackendRegistry.js";

const project: Project = { id: "p1", name: "Project", path: "/repo", createdAt: "2026-08-01T00:00:00.000Z" };
const workspace = {
  id: "w1",
  projectId: project.id,
  path: "/repo/worktree",
  label: "feature",
  isMain: false,
  provider: { pluginId: "git", capabilities: { request: true, remove: false }, metadata: { branch: "feature", public: true } },
};

function resolution(status: "provider" | "degraded" = "provider"): WorkspaceProviderAuthorityResolution {
  return status === "provider"
    ? { status, projectId: project.id, ownerPluginId: "git", workspaces: [workspace], diagnostics: [] }
    : { status, projectId: project.id, ownerPluginId: "git", workspaces: [workspace], diagnostics: [{ code: "list-failed", message: "failed", tier: "fallback", pluginId: "git" }] };
}

function contribution(request: (context: WorkspaceBackendRequestContext) => Promise<JsonValue>): ServerPluginWorkspaceBackendContribution {
  return {
    pluginId: "workspace-service",
    pluginName: "Workspace Service",
    packageRoot: "/plugins/workspace-service",
    source: "bundled",
    scope: "bundled",
    moduleRevision: "server-r1",
    backend: { request },
  };
}

function request(overrides: Partial<{ moduleRevision: string; workspaceId: string }> = {}) {
  return {
    pluginId: "workspace-service",
    moduleRevision: overrides.moduleRevision ?? "server-r1",
    project,
    workspaceId: overrides.workspaceId ?? workspace.id,
    operation: "runs.list",
    input: { limit: 5 },
  };
}

describe("PluginWorkspaceBackendRegistry", () => {
  it("authorizes a non-owner backend and passes only a frozen provider-neutral snapshot", async () => {
    const callback = vi.fn((context: WorkspaceBackendRequestContext): Promise<JsonValue> => Promise.resolve({
      workspace: { id: context.workspace.id, projectId: context.workspace.projectId, path: context.workspace.path, label: context.workspace.label, isMain: context.workspace.isMain },
      project: { id: context.project.id, name: context.project.name, path: context.project.path },
    }));
    const providers = { request: vi.fn() };
    const registry = new PluginWorkspaceBackendRegistry({
      contributions: [contribution(callback)],
      authority: { resolve: () => Promise.resolve(resolution()) },
      providers,
    });

    const result = await registry.request(request());

    expect(registry.workspaceTopologyMayChange("workspace-service")).toBe(false);
    expect(result.workspaceTopologyChanged).toBe(false);
    expect(result.value).toEqual({
      workspace: { id: "w1", projectId: "p1", path: "/repo/worktree", label: "feature", isMain: false },
      project: { id: "p1", name: "Project", path: resolve("/repo") },
    });
    const context = callback.mock.calls[0]?.[0];
    expect(context).toBeDefined();
    expect(Object.isFrozen(context)).toBe(true);
    expect(Object.isFrozen(context?.workspace)).toBe(true);
    expect(context?.workspace).not.toHaveProperty("provider");
    expect(context?.workspace).not.toHaveProperty("data");
    expect(providers.request).not.toHaveBeenCalled();
  });

  it("rejects stale revisions, stale workspace ids, and degraded authority", async () => {
    const callback = vi.fn(() => Promise.resolve(null));
    let current = resolution();
    const registry = new PluginWorkspaceBackendRegistry({
      contributions: [contribution(callback)],
      authority: { resolve: () => Promise.resolve(current) },
      providers: { request: vi.fn() },
    });

    await expect(registry.request(request({ moduleRevision: "old" }))).rejects.toMatchObject({ code: "stale-plugin-revision", statusCode: 409 });
    await expect(registry.request(request({ workspaceId: "stale" }))).rejects.toMatchObject({ code: "workspace-not-found", statusCode: 404 });
    current = resolution("degraded");
    await expect(registry.request(request())).rejects.toMatchObject({ code: "resolution-failed", statusCode: 409 });
    expect(callback).not.toHaveBeenCalled();
  });

  it("retains owner-only provider dispatch compatibility", async () => {
    const providerRequest = vi.fn(() => Promise.resolve({ owner: true }));
    const registry = new PluginWorkspaceBackendRegistry({
      contributions: [],
      authority: { resolve: () => Promise.resolve(resolution()) },
      providers: { request: providerRequest },
    });

    const result = await registry.request({ ...request(), pluginId: "git" });

    expect(registry.workspaceTopologyMayChange("git")).toBe(true);
    expect(result).toEqual({ value: { owner: true }, workspaceTopologyChanged: true });
    expect(providerRequest).toHaveBeenCalledOnce();
  });

  it("preserves attributed errors from owner dispatch", async () => {
    const failure = new WorkspaceProviderRequestError("owner-mismatch", 409, "not owner");
    const registry = new PluginWorkspaceBackendRegistry({
      contributions: [],
      authority: { resolve: () => Promise.resolve(resolution()) },
      providers: { request: () => Promise.reject(failure) },
    });
    await expect(registry.request({ ...request(), pluginId: "other" })).rejects.toBe(failure);
  });
});
