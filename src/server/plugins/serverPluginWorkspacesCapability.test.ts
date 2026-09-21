import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PI_WEB_HOST_WORKSPACES_CAPABILITY } from "../../server-plugin-api.js";
import type { ProviderWorkspace, WorkspaceProvider } from "../../server-plugin-api.js";
import type { Project } from "../types.js";
import {
  WorkspaceProviderRegistry,
  type WorkspaceProviderRegistryLogger,
} from "../workspaces/workspaceProviderRegistry.js";
import type { ServerPluginProviderContribution } from "./serverPluginRuntime.js";
import { createServerPluginWorkspacesCapabilityFactory } from "./serverPluginWorkspacesCapability.js";

const project: Project = {
  id: "project-1",
  name: "Project",
  path: resolve("/repo"),
  createdAt: "2026-09-10T00:00:00.000Z",
};

describe("server plugin workspaces capability", () => {
  it("re-resolves ids against current provider authority and returns only detached public projections", async () => {
    let owner: "alpha" | "beta" = "alpha";
    const alphaMetadata = { revision: 1, nested: [true] };
    const probes: string[] = [];
    const registry = workspaceRegistry([
      contribution("alpha", provider({
        probe: () => {
          probes.push("alpha");
          return Promise.resolve(owner === "alpha" ? "claim" : "pass");
        },
        list: () => Promise.resolve([
          workspace("alpha-main", project.path, true, {
            data: { providerPrivate: "secret" },
            publicMetadata: alphaMetadata,
            removal: { actionLabel: "Remove", confirmation: "Remove it?" },
          }),
        ]),
        prepareRemove: () => Promise.resolve({ title: "Remove", command: "true" }),
      })),
      contribution("beta", provider({
        probe: () => {
          probes.push("beta");
          return Promise.resolve(owner === "beta" ? "claim" : "pass");
        },
        list: () => Promise.resolve([workspace("beta-main", project.path, true)]),
      })),
    ]);
    const projects = {
      requireProject: vi.fn((projectId: string) => projectId === project.id
        ? Promise.resolve({ ...project })
        : Promise.reject(new Error("Project not found"))),
    };
    const lifetimeController = new AbortController();
    const factory = createServerPluginWorkspacesCapabilityFactory({ projects, workspaces: registry });
    const instance = factory.create({
      pluginId: "workspace-consumer",
      packageRoot: "/plugins/workspace-consumer",
      lifetimeSignal: lifetimeController.signal,
    });
    const workspaces = PI_WEB_HOST_WORKSPACES_CAPABILITY.parse(instance.value);

    const alphaId = (await registry.resolve(project)).workspaces[0]?.id;
    if (alphaId === undefined) throw new Error("Expected alpha workspace id");
    probes.splice(0);
    const first = await workspaces.resolve({ projectId: project.id, workspaceId: alphaId });
    alphaMetadata.revision = 99;
    alphaMetadata.nested.push(false);

    expect(first).toEqual({
      project: { id: project.id, name: project.name, path: project.path },
      workspace: {
        id: alphaId,
        projectId: project.id,
        path: project.path,
        label: "alpha-main",
        isMain: true,
        provider: {
          pluginId: "alpha",
          capabilities: { remove: true },
          metadata: { revision: 1, nested: [true] },
        },
      },
    });
    expect(first.project).not.toHaveProperty("createdAt");
    expect(first.workspace).not.toHaveProperty("data");
    expect(first.workspace).not.toHaveProperty("removal");
    expect(probes).toEqual(["alpha", "beta"]);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.project)).toBe(true);
    expect(Object.isFrozen(first.workspace)).toBe(true);
    expect(Object.isFrozen(first.workspace.provider?.metadata)).toBe(true);

    await expect(Reflect.apply(workspaces.resolve, workspaces, [{
      projectId: project.id,
      workspaceId: alphaId,
      path: project.path,
    }])).rejects.toThrow("Unsupported PI WEB host workspaces capability v1 selection field: path");
    await expect(Reflect.apply(workspaces.resolve, workspaces, [{
      projectId: project.id,
      workspaceId: alphaId,
      ownerPluginId: "alpha",
    }])).rejects.toThrow("Unsupported PI WEB host workspaces capability v1 selection field: ownerPluginId");

    owner = "beta";
    probes.splice(0);
    await expect(workspaces.resolve({ projectId: project.id, workspaceId: alphaId }))
      .rejects.toThrow("workspace-consumer selected workspace is stale or unavailable");
    expect(probes).toEqual(["alpha", "beta"]);
    const betaId = (await registry.resolve(project)).workspaces[0]?.id;
    if (betaId === undefined) throw new Error("Expected beta workspace id");
    const current = await workspaces.resolve({ projectId: project.id, workspaceId: betaId });
    expect(current.workspace.provider?.pluginId).toBe("beta");
    expect(current.workspace.id).toBe(betaId);
    expect(betaId).not.toBe(alphaId);

    await expect(workspaces.resolve({ projectId: "other-project", workspaceId: betaId }))
      .rejects.toThrow("workspace-consumer could not resolve the selected project");
    expect(projects.requireProject).toHaveBeenCalledTimes(4);
    expect(Object.isFrozen(factory)).toBe(true);
    expect(Object.isFrozen(instance)).toBe(true);
  });

  it("cancels in-flight resolution and rejects later calls when the plugin lifetime is revoked", async () => {
    let hang = false;
    let observedSignal: AbortSignal | undefined;
    const registry = workspaceRegistry([contribution("owner", provider({
      probe: () => Promise.resolve("claim"),
      list: (_project, signal) => {
        if (!hang) return Promise.resolve([workspace("main", project.path, true)]);
        observedSignal = signal;
        return new Promise((_resolve, rejectPromise) => {
          signal.addEventListener("abort", () => {
            const reason: unknown = signal.reason;
            rejectPromise(reason instanceof Error ? reason : new Error("Resolution aborted", { cause: reason }));
          }, { once: true });
        });
      },
    }))]);
    const workspaceId = (await registry.resolve(project)).workspaces[0]?.id;
    if (workspaceId === undefined) throw new Error("Expected workspace id");
    const projects = { requireProject: vi.fn(() => Promise.resolve(project)) };
    const lifetimeController = new AbortController();
    const instance = createServerPluginWorkspacesCapabilityFactory({ projects, workspaces: registry }).create({
      pluginId: "cancelled-consumer",
      packageRoot: "/plugins/cancelled-consumer",
      lifetimeSignal: lifetimeController.signal,
    });
    const workspaces = PI_WEB_HOST_WORKSPACES_CAPABILITY.parse(instance.value);

    hang = true;
    const resolving = workspaces.resolve({ projectId: project.id, workspaceId });
    await vi.waitFor(() => { expect(observedSignal).toBeInstanceOf(AbortSignal); });
    const rejected = expect(resolving).rejects.toThrow("cancelled-consumer is no longer active");
    lifetimeController.abort(new DOMException("Plugin stopped", "AbortError"));
    await rejected;

    expect(observedSignal?.aborted).toBe(true);
    await expect(workspaces.resolve({ projectId: project.id, workspaceId }))
      .rejects.toThrow("cancelled-consumer is no longer active");
    expect(projects.requireProject).toHaveBeenCalledOnce();
  });
});

function workspaceRegistry(contributions: readonly ServerPluginProviderContribution[]): WorkspaceProviderRegistry {
  const logger: WorkspaceProviderRegistryLogger = { warn: vi.fn() };
  return new WorkspaceProviderRegistry({
    contributions,
    logger,
    pathInspector: () => true,
  });
}

function contribution(pluginId: string, workspaceProvider: WorkspaceProvider): ServerPluginProviderContribution {
  return {
    pluginId,
    pluginName: pluginId,
    packageRoot: `/plugins/${pluginId}`,
    source: "fixture",
    scope: "local",
    moduleRevision: "1",
    provider: workspaceProvider,
  };
}

function provider(overrides: Partial<WorkspaceProvider> = {}): WorkspaceProvider {
  return {
    probe: () => Promise.resolve("pass"),
    list: () => Promise.resolve([]),
    ...overrides,
  };
}

function workspace(
  key: string,
  path: string,
  isMain: boolean,
  extras: Partial<ProviderWorkspace> = {},
): ProviderWorkspace {
  return { key, path, label: key, isMain, ...extras };
}
