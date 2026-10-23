import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceProvider, WorkspaceProviderIntegration } from "../../server-plugin-api.js";
import type { Project } from "../../shared/apiTypes.js";
import type { ServerPluginProviderContribution } from "../plugins/serverPluginRuntime.js";
import { WorkspaceProviderRegistry } from "./workspaceProviderRegistry.js";

const project: Project = { id: "p1", name: "Repo", path: resolve("/repo"), createdAt: "2026-10-10T00:00:00.000Z" };
const registries: WorkspaceProviderRegistry[] = [];
afterEach(async () => { await Promise.all(registries.splice(0).map((registry) => registry.closeAll())); });

function fixture(integration: WorkspaceProviderIntegration, options: { claimed?: boolean; conflict?: boolean; listFailure?: boolean; timeoutMs?: number } = {}) {
  const provider: WorkspaceProvider = {
    integration,
    probe: () => Promise.resolve(options.claimed === false ? "pass" : "claim"),
    list: () => options.listFailure === true ? Promise.reject(new Error("list unavailable"))
      : Promise.resolve([{ key: "main", path: project.path, label: "Main", isMain: true }]),
  };
  const contribution: ServerPluginProviderContribution = {
    pluginId: "owner", pluginName: "Owner", packageRoot: "/plugins/owner", source: "fixture", scope: "local", moduleRevision: "1", provider,
  };
  const logger = { warn: vi.fn() };
  const registry = new WorkspaceProviderRegistry({
    contributions: options.conflict === true ? [contribution, { ...contribution, pluginId: "other" }] : [contribution],
    pathInspector: () => true,
    logger,
    ...(options.timeoutMs === undefined ? {} : { providerTimeoutMs: options.timeoutMs }),
  });
  registries.push(registry);
  return { registry, logger };
}

function integration() {
  return {
    reconcile: vi.fn<WorkspaceProviderIntegration["reconcile"]>(() => Promise.resolve()),
    acceptNotification: vi.fn<WorkspaceProviderIntegration["acceptNotification"]>(() => Promise.resolve(true)),
  };
}

describe("provider-owned workspace integration orchestration", () => {
  it("keeps probing/listing side-effect-free and reconciles explicitly without a second discovery", async () => {
    const hooks = integration();
    const { registry } = fixture(hooks);
    const resolution = await registry.resolve(project);
    expect(hooks.reconcile).not.toHaveBeenCalled();
    await registry.reconcileProject(project, resolution);
    expect(hooks.reconcile).toHaveBeenCalledExactlyOnceWith({ id: project.id, name: project.name, path: project.path }, expect.any(AbortSignal));
  });

  it("shares overlapping maintenance rather than racing configuration writes", async () => {
    const hooks = integration();
    let finish: (() => void) | undefined;
    let announceStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { announceStarted = resolve; });
    hooks.reconcile.mockImplementation(() => new Promise<void>((resolve) => {
      finish = resolve;
      announceStarted?.();
    }));
    const { registry } = fixture(hooks);
    const resolution = await registry.resolve(project);
    const first = registry.reconcileProject(project, resolution);
    const second = registry.reconcileProject(project, resolution);
    await started;
    expect(hooks.reconcile).toHaveBeenCalledOnce();
    finish?.();
    await Promise.all([first, second]);
  });

  it.each([{ claimed: false }, { conflict: true }, { listFailure: true }])("does not maintain or accept hints without healthy exclusive authority: %j", async (options) => {
    const hooks = integration();
    const { registry } = fixture(hooks, options);
    await registry.reconcileProject(project);
    expect(hooks.reconcile).not.toHaveBeenCalled();
    expect(await registry.acceptNotification(project, "owner")).toBe(false);
    expect(hooks.acceptNotification).not.toHaveBeenCalled();
  });

  it("does not let a hint select another provider", async () => {
    const hooks = integration();
    const { registry } = fixture(hooks);
    expect(await registry.acceptNotification(project, "other")).toBe(false);
    expect(hooks.acceptNotification).not.toHaveBeenCalled();
    expect(await registry.acceptNotification(project, "owner")).toBe(true);
    expect(hooks.acceptNotification).toHaveBeenCalledWith({ id: project.id, name: project.name, path: project.path }, expect.any(AbortSignal));
  });

  it("leaves authority available when maintenance fails", async () => {
    const hooks = integration();
    hooks.reconcile.mockRejectedValue(new Error("configuration is read-only"));
    const { registry, logger } = fixture(hooks);
    await registry.reconcileProject(project);
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ projectId: project.id }), expect.stringContaining("discovery remains available"));
    expect((await registry.resolve(project)).status).toBe("provider");
  });

  it("aborts in-flight maintenance on shutdown", async () => {
    const hooks = integration();
    let operationSignal: AbortSignal | undefined;
    let announceStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { announceStarted = resolve; });
    hooks.reconcile.mockImplementation((_project, signal) => new Promise<void>((_resolve, reject) => {
      operationSignal = signal;
      signal.addEventListener("abort", () => { reject(new Error("integration aborted")); }, { once: true });
      announceStarted?.();
    }));
    const { registry } = fixture(hooks);
    const resolution = await registry.resolve(project);
    const pending = registry.reconcileProject(project, resolution);
    const outcome = pending.then(() => undefined, (error: unknown) => error);
    await started;
    await registry.closeAll();
    expect(await outcome).toMatchObject({ name: "AbortError" });
    expect(operationSignal?.aborted).toBe(true);
  });
});
