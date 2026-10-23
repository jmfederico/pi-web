import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JsonValue, ProjectInput } from "../../server-plugin-api.js";
import type { Project } from "../types.js";
import { PROJECT_PI_WEB_CONFIG_PATH, type LoadedProjectPiWebConfig } from "../workspaces/projectPiWebConfig.js";
import { ProjectPluginSettingsSnapshots } from "./projectPluginSettings.js";

let root: string;
let project: Project;
let other: Project;
let snapshots: ProjectPluginSettingsSnapshots;
const registered = new Map<string, Project>();
const projects = {
  requireProject: vi.fn((id: string): Promise<Project> => {
    const found = registered.get(id);
    return found === undefined ? Promise.reject(new Error("Project not found")) : Promise.resolve(found);
  }),
};
const signal = new AbortController().signal;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pi-web-project-plugin-settings-"));
  project = { id: "first", name: "First", path: join(root, "first"), createdAt: "2026-01-01" };
  other = { id: "second", name: "Second", path: join(root, "second"), createdAt: "2026-01-01" };
  await Promise.all([mkdir(project.path), mkdir(other.path)]);
  registered.clear();
  registered.set(project.id, project);
  registered.set(other.id, other);
  projects.requireProject.mockClear();
  snapshots = new ProjectPluginSettingsSnapshots(projects);
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

describe("project plugin settings snapshots", () => {
  it("merges top-level keys, replaces nested values, and isolates plugins and projects", async () => {
    await writeConfig(project, { plugins: {
      alpha: { settings: { nested: { projectOnly: true }, list: ["project"], optional: null, flag: false, count: 0, text: "" } },
      beta: { settings: { owner: "beta" } },
    } });
    await writeConfig(other, { plugins: { alpha: { settings: { owner: "other" } } } });
    const global = { inherited: "global", nested: { globalOnly: true }, list: ["global"], optional: "set", flag: true, count: 5, text: "default" };

    const merged = await snapshots.resolve("alpha", global, project, signal);
    expect(merged).toEqual({ inherited: "global", nested: { projectOnly: true }, list: ["project"], optional: null, flag: false, count: 0, text: "" });
    expect(await snapshots.resolve("beta", { inherited: "global" }, project, signal)).toEqual({ inherited: "global", owner: "beta" });
    expect(await snapshots.resolve("alpha", { inherited: "global" }, other, signal)).toEqual({ inherited: "global", owner: "other" });
    expect(await snapshots.resolve("missing", global, project, signal)).toEqual(global);
    expect(global.nested).toEqual({ globalOnly: true });
  });

  it("captures a detached global base before I/O and deeply freezes detached results", async () => {
    await writeConfig(project, { plugins: { alpha: { settings: { override: { list: [{ value: "project" }] } } } } });
    const pending = deferred<Project>();
    const service = new ProjectPluginSettingsSnapshots({ requireProject: () => pending.promise });
    const global = { nested: { list: [{ value: "original" }] } };
    const result = service.resolve("alpha", global, project, signal);
    global.nested.list[0] = { value: "changed while waiting" };
    pending.resolve(project);

    const first = await result;
    expect(first).toEqual({ nested: { list: [{ value: "original" }] }, override: { list: [{ value: "project" }] } });
    expectDeeplyFrozen(first);
    expect(first["nested"]).not.toBe(global.nested);
    expect(Reflect.set(first, "injected", true)).toBe(false);
    const second = await service.resolve("alpha", global, project, signal);
    expect(second["override"]).not.toBe(first["override"]);
    expect(second).toEqual({ nested: { list: [{ value: "changed while waiting" }] }, override: { list: [{ value: "project" }] } });
  });

  it("preloads overrides and keeps them until a new service instance, not a new global base", async () => {
    await writeConfig(project, { plugins: { alpha: { settings: { revision: 1 } } } });
    await snapshots.initialize([project]);
    await writeConfig(project, { plugins: { alpha: { settings: { revision: 2 } } } });
    await snapshots.initialize([project]);

    expect(await snapshots.resolve("alpha", { globalRevision: 1 }, project, signal)).toEqual({ globalRevision: 1, revision: 1 });
    expect(await snapshots.resolve("alpha", { globalRevision: 2 }, project, signal)).toEqual({ globalRevision: 2, revision: 1 });
    const restarted = new ProjectPluginSettingsSnapshots(projects);
    expect(await restarted.resolve("alpha", {}, project, signal)).toEqual({ revision: 2 });
  });

  it("caches absent scopes and loads newly registered projects on first use", async () => {
    await snapshots.initialize([project]);
    await writeConfig(project, { plugins: { alpha: { settings: { added: true } } } });
    expect(await snapshots.resolve("alpha", { base: true }, project, signal)).toEqual({ base: true });

    const added: Project = { id: "added", name: "Added", path: join(root, "added"), createdAt: "2026-01-01" };
    registered.set(added.id, added);
    await writeConfig(added, { plugins: { alpha: { settings: { revision: 1 } } } });
    expect(await snapshots.resolve("alpha", {}, added, signal)).toEqual({ revision: 1 });
    await writeConfig(added, { plugins: { alpha: { settings: { revision: 2 } } } });
    expect(await snapshots.resolve("alpha", {}, added, signal)).toEqual({ revision: 1 });
    const restarted = new ProjectPluginSettingsSnapshots(projects);
    expect(await restarted.resolve("alpha", {}, project, signal)).toEqual({ added: true });
    expect(await restarted.resolve("alpha", {}, added, signal)).toEqual({ revision: 2 });
  });

  it.each([
    { label: "invalid JSON", content: "{" },
    { label: "invalid plugin shape", content: '{"plugins":{"alpha":{"settings":[]}}}' },
    { label: "unsupported project activation", content: '{"plugins":{"alpha":{"enabled":false}}}' },
    { label: "invalid core config", content: '{"version":2}' },
  ])("retains a $label scope error without failing preload or another project", async ({ content }) => {
    await writeConfig(project, {});
    await writeFile(join(project.path, PROJECT_PI_WEB_CONFIG_PATH), content);
    await writeConfig(other, { plugins: { alpha: { settings: { healthy: true } } } });

    await expect(snapshots.initialize([project, other])).resolves.toBeUndefined();
    expect(await snapshots.resolve("alpha", {}, other, signal)).toEqual({ healthy: true });
    await expect(snapshots.resolve("alpha", { fallback: true }, project, signal)).rejects.toThrow(`project ${project.id} (${project.path}) could not be loaded`);
    await writeConfig(project, { plugins: { alpha: { settings: { repaired: true } } } });
    await expect(snapshots.resolve("different-plugin", {}, project, signal)).rejects.toThrow("could not be loaded");
    const restarted = new ProjectPluginSettingsSnapshots(projects);
    expect(await restarted.resolve("alpha", {}, project, signal)).toEqual({ repaired: true });
  });

  it("completes preload with an inaccessible config and retains its scoped error", async () => {
    vi.useFakeTimers();
    const denied = Object.assign(new Error("permission denied"), { code: "EACCES" });
    const loadConfig = vi.fn((path: string): Promise<LoadedProjectPiWebConfig> => path === project.path
      ? Promise.reject(denied)
      : Promise.resolve({ path: join(path, PROJECT_PI_WEB_CONFIG_PATH), exists: true, config: { plugins: { alpha: { settings: { healthy: true } } } } }));
    const service = new ProjectPluginSettingsSnapshots(projects, { loadConfig });

    await expect(service.initialize([project, other])).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    expect(await service.resolve("alpha", {}, other, signal)).toEqual({ healthy: true });
    await expect(service.resolve("alpha", { fallback: true }, project, signal)).rejects.toMatchObject({
      message: `PI WEB plugin settings for project ${project.id} (${project.path}) could not be loaded: permission denied`,
      cause: denied,
    });
    await service.initialize([project]);
    await expect(service.resolve("different-plugin", {}, project, signal)).rejects.toMatchObject({ cause: denied });
    expect(loadConfig).toHaveBeenCalledTimes(2);
  });

  it.each(["success", "failure"])("bounds a stalled preload, cancels its reader, and caches the timeout despite late %s", async (settlement) => {
    const pending = deferred<LoadedProjectPiWebConfig>();
    const started = deferred<AbortSignal>();
    const loadConfig = vi.fn((path: string, readSignal: AbortSignal): Promise<LoadedProjectPiWebConfig> => {
      if (path === project.path) {
        started.resolve(readSignal);
        // Deliberately ignore cancellation: startup still has to finish.
        return pending.promise;
      }
      return Promise.resolve({ path: join(path, PROJECT_PI_WEB_CONFIG_PATH), exists: true, config: { plugins: { alpha: { settings: { healthy: true } } } } });
    });
    vi.useFakeTimers();
    const service = new ProjectPluginSettingsSnapshots(projects, { timeoutMs: 50, loadConfig });
    const completed = vi.fn();
    const preload = service.initialize([project, other]).then(() => { completed(); });
    const readSignal = await started.promise;
    expect(await service.resolve("alpha", {}, other, signal)).toEqual({ healthy: true });
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(49);
    expect(completed).not.toHaveBeenCalled();
    expect(readSignal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(preload).resolves.toBeUndefined();
    expect(readSignal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    const timeoutReason: unknown = readSignal.reason;
    const failure = await service.resolve("alpha", { fallback: true }, project, signal).catch((error: unknown) => error);
    expect(failure).toMatchObject({
      message: `PI WEB plugin settings for project ${project.id} (${project.path}) could not be loaded: Project config read timed out after 50ms`,
      cause: timeoutReason,
    });

    if (settlement === "success") {
      pending.resolve({ path: join(project.path, PROJECT_PI_WEB_CONFIG_PATH), exists: true, config: { plugins: { alpha: { settings: { late: true } } } } });
    } else {
      pending.reject(new Error("late read failure"));
    }
    await pending.promise.catch(() => undefined);
    await service.initialize([project]);
    await expect(service.resolve("different-plugin", { fallback: true }, project, signal)).rejects.toBe(failure);
    expect(loadConfig).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);

    vi.useRealTimers();
    await writeConfig(project, { plugins: { alpha: { settings: { repaired: true } } } });
    const restarted = new ProjectPluginSettingsSnapshots(projects);
    expect(await restarted.resolve("alpha", {}, project, signal)).toEqual({ repaired: true });
  });

  it("caches errors from a project's first lazy load", async () => {
    await writeConfig(project, { plugins: { alpha: { settings: null } } });
    await expect(snapshots.resolve("alpha", {}, project, signal)).rejects.toThrow("must be a JSON object");
    await writeConfig(project, {});
    await expect(snapshots.resolve("alpha", {}, project, signal)).rejects.toThrow("must be a JSON object");
  });

  it("uses current registered id/path authority rather than caller paths or stale cached authority", async () => {
    await writeConfig(project, { plugins: { alpha: { settings: { source: "first" } } } });
    await writeConfig(other, { plugins: { alpha: { settings: { source: "second" } } } });
    expect(await snapshots.resolve("alpha", {}, { ...project, path: other.path }, signal)).toEqual({ source: "first" });
    expect(projects.requireProject).toHaveBeenLastCalledWith(project.id);
    registered.set(project.id, { ...project, path: other.path });
    expect(await snapshots.resolve("alpha", {}, project, signal)).toEqual({ source: "second" });
    registered.delete(project.id);
    await expect(snapshots.resolve("alpha", {}, project, signal)).rejects.toThrow("Project not found");
    await expect(snapshots.resolve("alpha", {}, { ...project, id: "unregistered" }, signal)).rejects.toThrow("Project not found");
  });

  it("rejects mismatched or non-absolute registered project authority", async () => {
    const mismatched = new ProjectPluginSettingsSnapshots({ requireProject: () => Promise.resolve(other) });
    await expect(mismatched.resolve("alpha", {}, project, signal)).rejects.toThrow("mismatched project id");
    const relative = new ProjectPluginSettingsSnapshots({ requireProject: () => Promise.resolve({ ...project, path: "relative" }) });
    await expect(relative.resolve("alpha", {}, project, signal)).rejects.toThrow("absolute registered project path");
  });

  it("checks cancellation before work and after project lookup", async () => {
    const aborted = new AbortController();
    const reason = new Error("request cancelled");
    aborted.abort(reason);
    await expect(snapshots.resolve("alpha", {}, project, aborted.signal)).rejects.toBe(reason);
    expect(projects.requireProject).not.toHaveBeenCalled();

    const pending = deferred<Project>();
    const service = new ProjectPluginSettingsSnapshots({ requireProject: () => pending.promise });
    const controller = new AbortController();
    const result = service.resolve("alpha", {}, project, controller.signal);
    controller.abort(reason);
    pending.resolve(project);
    await expect(result).rejects.toBe(reason);
  });

  it("shares the scope load without letting one caller's cancellation poison the snapshot", async () => {
    const pending = deferred<LoadedProjectPiWebConfig>();
    const started = deferred<boolean>();
    const loader = vi.fn(() => {
      started.resolve(true);
      return pending.promise;
    });
    const service = new ProjectPluginSettingsSnapshots(projects, { loadConfig: loader });
    const controller = new AbortController();
    const cancelled = service.resolve("alpha", { caller: "cancelled" }, project, controller.signal);
    await started.promise;
    const surviving = service.resolve("alpha", { caller: "surviving" }, project, signal);
    controller.abort(new Error("cancelled during scope load"));
    const source = { nested: { revision: 1 } };
    pending.resolve({ path: join(project.path, PROJECT_PI_WEB_CONFIG_PATH), exists: true, config: { plugins: { alpha: { settings: source } } } });

    await expect(cancelled).rejects.toThrow("cancelled during scope load");
    expect(await surviving).toEqual({ caller: "surviving", nested: { revision: 1 } });
    expect(loader).toHaveBeenCalledOnce();
    expect(await service.resolve("alpha", {}, project, signal)).toEqual({ nested: { revision: 1 } });
  });

  it("preserves special setting keys as data without inheriting dictionary entries", async () => {
    await writeConfig(project, { plugins: { alpha: { settings: Object.fromEntries<JsonValue>([["__proto__", { polluted: true }], ["constructor", "setting"]]) } } });
    const result = await snapshots.resolve("alpha", {}, project, signal);
    expect(Object.hasOwn(result, "__proto__")).toBe(true);
    expect(result["__proto__"]).toEqual({ polluted: true });
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(result).toHaveProperty("constructor", "setting");
    expect(await snapshots.resolve("constructor", { inherited: true }, project, signal)).toEqual({ inherited: true });
  });
});

async function writeConfig(project: ProjectInput, value: unknown): Promise<void> {
  const path = join(project.path, PROJECT_PI_WEB_CONFIG_PATH);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value));
}

function expectDeeplyFrozen(value: JsonValue): void {
  if (typeof value !== "object" || value === null) return;
  expect(Object.isFrozen(value)).toBe(true);
  for (const child of Object.values(value)) expectDeeplyFrozen(child);
}

function deferred<Value>() {
  let complete: ((value: Value) => void) | undefined;
  let fail: ((reason: unknown) => void) | undefined;
  const promise = new Promise<Value>((resolve, reject) => { complete = resolve; fail = reject; });
  return {
    promise,
    resolve(value: Value) {
      if (complete === undefined) throw new Error("Deferred promise was not initialized");
      complete(value);
    },
    reject(reason: unknown) {
      if (fail === undefined) throw new Error("Deferred promise was not initialized");
      fail(reason);
    },
  };
}
