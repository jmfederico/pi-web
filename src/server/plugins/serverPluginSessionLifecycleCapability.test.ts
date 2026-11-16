import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { PluginSessionSnapshot } from "../../shared/pluginCatalogTypes.js";
import { PI_WEB_HOST_SESSION_LIFECYCLE_CAPABILITY } from "../../shared/pluginSessionLifecycleTypes.js";
import { createServerPluginSessionLifecycleCapabilityFactory, createServerPluginSessionLifecycleV2CapabilityFactory } from "./serverPluginSessionLifecycleCapability.js";

const cwd = resolve("/repo");
const dates = { created: null, modified: null, archivedAt: null };
const selection = { projectId: "p", workspaceId: "w", sessionId: "child" };
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function fixture() {
  const project = { id: "p", name: "Project", path: cwd, createdAt: "now" };
  const projects = { requireProject: vi.fn(() => Promise.resolve(project)) };
  const workspace = { id: "w", projectId: "p", path: cwd, label: "Main", isMain: true };
  const workspaces = { checkCurrent: vi.fn(() => Promise.resolve({ projectId: "p", status: "provider" as const, diagnostics: [], workspaces: [workspace] })) };
  const failures: { sessionId: string; error: string }[] = [];
  const sessions = {
    listCatalogSessions: vi.fn((selectedCwd: string, signal?: AbortSignal): Promise<readonly Omit<PluginSessionSnapshot, "pinned">[]> => {
      signal?.throwIfAborted();
      return Promise.resolve([{ id: "child", cwd: selectedCwd, ...dates, archived: true, runtime: "not-hosted" }]);
    }),
    archiveMany: vi.fn(() => Promise.resolve({ archived: true as const, archivedSessionIds: ["child"], failures, generatedAt: "now" })),
    abort: vi.fn<(ref: { id: string; cwd: string }) => Promise<void>>(() => Promise.resolve()),
    stop: vi.fn<(ref: { id: string; cwd: string }) => Promise<void>>(() => Promise.resolve()),
    restore: vi.fn(() => Promise.resolve()),
    deleteArchivedMany: vi.fn(() => Promise.resolve({ deleted: true as const, deletedSessionIds: ["child"], failures, generatedAt: "now" })),
  };
  const pins = { pinnedSessionIds: vi.fn(() => Promise.resolve(["child"])), setPinned: vi.fn(() => Promise.resolve()) };
  const lifetime = new AbortController();
  const onMutation = vi.fn();
  const dependencies = { projects, workspaces, sessions, pins, onMutation };
  const context = { pluginId: "consumer", packageRoot: "", lifetimeSignal: lifetime.signal };
  const instance = createServerPluginSessionLifecycleV2CapabilityFactory(dependencies).create(context);
  return { ...dependencies, lifetime, context, dependencies, instance, value: instance.value };
}

describe("server session lifecycle", () => {
  it("reads state and uses exact child refs for explicit native mutations even when pinned", async () => {
    const f = fixture();
    expect(await f.value.get(selection)).toEqual({ sessionId: "child", pinned: true, archived: true });
    await f.value.pin(selection);
    expect(f.onMutation).not.toHaveBeenCalled();
    await f.value.archive(selection);
    await f.value.restore(selection);
    await f.value.delete(selection);
    const ref = { id: "child", cwd };
    expect(f.sessions.archiveMany).toHaveBeenCalledWith([ref]);
    expect(f.sessions.restore).toHaveBeenCalledWith(ref);
    expect(f.sessions.deleteArchivedMany).toHaveBeenCalledWith([ref]);
    expect(f.onMutation.mock.calls).toEqual([[selection], [selection], [selection]]);
    expect(f.pins.setPinned).toHaveBeenCalledWith({ kind: "session-pins", projectId: "p", workspaceId: "w" }, "child", true);
    expect(f.sessions.listCatalogSessions).toHaveBeenCalledWith(cwd, expect.any(AbortSignal));
  });

  it("allows unpinning stale sessions only in a valid workspace", async () => {
    const f = fixture();
    await f.value.unpin({ ...selection, sessionId: "gone" });
    expect(f.sessions.listCatalogSessions).not.toHaveBeenCalled();
    expect(f.pins.setPinned).toHaveBeenCalledWith({ kind: "session-pins", projectId: "p", workspaceId: "w" }, "gone", false);
    await expect(f.value.unpin({ ...selection, workspaceId: "gone" })).rejects.toThrow("stale or unavailable");
    expect(f.pins.setPinned).toHaveBeenCalledTimes(1);
  });

  it("rejects missing/external sessions and non-archived deletion without native effects", async () => {
    const f = fixture();
    await expect(f.value.pin({ ...selection, sessionId: "chi" })).rejects.toThrow("stale or unavailable");
    f.sessions.listCatalogSessions.mockResolvedValueOnce([{ id: "child", cwd: resolve("/outside"), ...dates, archived: true, runtime: "not-hosted" }]);
    await expect(f.value.delete(selection)).rejects.toThrow("outside selected workspace");
    f.sessions.listCatalogSessions.mockResolvedValueOnce([{ id: "child", cwd, ...dates, archived: false, runtime: "idle" }]);
    await expect(f.value.delete(selection)).rejects.toThrow("must be archived");
    expect(f.sessions.deleteArchivedMany).not.toHaveBeenCalled();
    expect(f.pins.setPinned).not.toHaveBeenCalled();
  });

  it("surfaces bulk failure and missing success instead of claiming completion", async () => {
    const f = fixture();
    f.sessions.archiveMany.mockResolvedValueOnce({ archived: true, archivedSessionIds: [], failures: [{ sessionId: "child", error: "busy" }], generatedAt: "now" });
    await expect(f.value.archive(selection)).rejects.toThrow("busy");
    f.sessions.deleteArchivedMany.mockResolvedValueOnce({ deleted: true, deletedSessionIds: [], failures: [], generatedAt: "now" });
    await expect(f.value.delete(selection)).rejects.toThrow("did not complete");
    f.sessions.restore.mockRejectedValueOnce(new Error("restore failed"));
    await expect(f.value.restore(selection)).rejects.toThrow("restore failed");
    expect(f.onMutation).not.toHaveBeenCalled();
  });

  it.each(["archive", "abort", "close"] as const)("blocks %s after caller cancellation, disposal or plugin revocation during authority reads", async (operation) => {
    for (const mode of ["caller", "dispose", "lifetime"] as const) {
      const f = fixture();
      const caller = new AbortController();
      const entered = deferred();
      const rows = deferred<readonly Omit<PluginSessionSnapshot, "pinned">[]>();
      f.sessions.listCatalogSessions.mockImplementationOnce(() => { entered.resolve(); return rows.promise; });
      const pending = f.value[operation](selection, { signal: caller.signal });
      await entered.promise;
      if (mode === "caller") caller.abort(new Error("caller cancelled"));
      else if (mode === "dispose") await f.instance.dispose?.(new AbortController().signal);
      else f.lifetime.abort();
      rows.resolve([{ id: "child", cwd, ...dates, archived: true, runtime: "busy" }]);
      await expect(pending).rejects.toThrow(mode === "caller" ? "caller cancelled" : "no longer active");
      expect(f.sessions.abort).not.toHaveBeenCalled();
      expect(f.sessions.stop).not.toHaveBeenCalled();
      expect(f.sessions.archiveMany).not.toHaveBeenCalled();
      if (mode === "caller") await f.value.pin(selection);
      else await expect(f.value.pin(selection)).rejects.toThrow("no longer active");
    }
  });

  it("rejects already-cancelled calls before authority or native work", async () => {
    const f = fixture();
    const caller = new AbortController();
    caller.abort(new Error("cancelled"));
    for (const operation of ["get", "pin", "unpin", "archive", "restore", "delete", "abort", "close"] as const) {
      await expect(f.value[operation](selection, { signal: caller.signal })).rejects.toThrow("cancelled");
    }
    expect(f.projects.requireProject).not.toHaveBeenCalled();
    expect(f.sessions.abort).not.toHaveBeenCalled();
    expect(f.sessions.stop).not.toHaveBeenCalled();
    expect(f.pins.setPinned).not.toHaveBeenCalled();
    expect(f.sessions.archiveMany).not.toHaveBeenCalled();
    expect(f.sessions.restore).not.toHaveBeenCalled();
    expect(f.sessions.deleteArchivedMany).not.toHaveBeenCalled();
  });

  it("does not report cancellation as rollback after native admission", async () => {
    const f = fixture();
    const entered = deferred();
    const completed = deferred();
    f.sessions.restore.mockImplementationOnce(() => { entered.resolve(); return completed.promise; });
    const pending = f.value.restore(selection);
    await entered.promise;
    f.lifetime.abort();
    completed.resolve();
    await expect(pending).resolves.toBeUndefined();
    expect(f.onMutation).toHaveBeenCalledExactlyOnceWith(selection);
  });

  it("preserves the exact v1 adapter and revokes retained v1 commands", async () => {
    const f = fixture();
    const factory = createServerPluginSessionLifecycleCapabilityFactory(f.dependencies);
    expect(factory.capability).toBe(PI_WEB_HOST_SESSION_LIFECYCLE_CAPABILITY);
    const instance = factory.create(f.context);
    const legacy = PI_WEB_HOST_SESSION_LIFECYCLE_CAPABILITY.parse(instance.value);
    expect(legacy.version).toBe(1);
    expect(legacy).not.toHaveProperty("abort");
    expect(legacy).not.toHaveProperty("close");
    await legacy.archive(selection);
    expect(f.sessions.archiveMany).toHaveBeenCalledExactlyOnceWith([{ id: "child", cwd }]);
    await instance.dispose?.(new AbortController().signal);
    await expect(legacy.restore(selection)).rejects.toThrow("no longer active");
    expect(f.sessions.restore).not.toHaveBeenCalled();
    expect(f.sessions.abort).not.toHaveBeenCalled();
  });

  it("rejects busy targets before destructive mutation but permits pinning", async () => {
    const f = fixture();
    f.sessions.listCatalogSessions.mockResolvedValue([{ id: "child", cwd, ...dates, archived: true, runtime: "busy" }]);
    await f.value.pin(selection);
    for (const operation of ["archive", "restore", "delete"] as const) await expect(f.value[operation](selection)).rejects.toThrow("activity");
    expect(f.sessions.archiveMany).not.toHaveBeenCalled();
    expect(f.sessions.restore).not.toHaveBeenCalled();
    expect(f.sessions.deleteArchivedMany).not.toHaveBeenCalled();
  });
});

describe.each([
  { operation: "abort", native: "abort" },
  { operation: "close", native: "stop" },
] as const)("server session lifecycle $operation admission", ({ operation, native }) => {
  it.each(["busy", "idle", "not-hosted"] as const)("admits a %s target without archive, delete or pin effects", async (runtime) => {
    const f = fixture();
    f.sessions.listCatalogSessions.mockResolvedValue([{ id: "child", cwd, ...dates, archived: runtime === "not-hosted", runtime }]);
    await expect(f.value[operation](selection)).resolves.toBeUndefined();
    expect(f.sessions[native]).toHaveBeenCalledExactlyOnceWith({ id: "child", cwd });
    expect(f.sessions[native === "stop" ? "abort" : "stop"]).not.toHaveBeenCalled();
    expect(f.sessions.archiveMany).not.toHaveBeenCalled();
    expect(f.sessions.restore).not.toHaveBeenCalled();
    expect(f.sessions.deleteArchivedMany).not.toHaveBeenCalled();
    expect(f.pins.setPinned).not.toHaveBeenCalled();
    expect(f.onMutation.mock.calls).toEqual(operation === "close" ? [[selection]] : []);
  });

  it("rejects abbreviated identities, stale scopes and foreign rows before native admission", async () => {
    const f = fixture();
    for (const target of [
      { ...selection, sessionId: "chi" },
      { ...selection, projectId: "other" },
      { ...selection, workspaceId: "other" },
    ]) await expect(f.value[operation](target)).rejects.toThrow();
    f.sessions.listCatalogSessions.mockResolvedValueOnce([{ id: "child", cwd: resolve("/outside"), ...dates, archived: false, runtime: "busy" }]);
    await expect(f.value[operation](selection)).rejects.toThrow("outside selected workspace");
    expect(f.sessions.abort).not.toHaveBeenCalled();
    expect(f.sessions.stop).not.toHaveBeenCalled();
    expect(f.sessions.archiveMany).not.toHaveBeenCalled();
    expect(f.sessions.restore).not.toHaveBeenCalled();
    expect(f.sessions.deleteArchivedMany).not.toHaveBeenCalled();
    expect(f.pins.setPinned).not.toHaveBeenCalled();
  });

  it("cancels while current workspace authority is being resolved", async () => {
    const f = fixture();
    const entered = deferred();
    const authority = deferred<Awaited<ReturnType<typeof f.workspaces.checkCurrent>>>();
    f.workspaces.checkCurrent.mockImplementationOnce(() => { entered.resolve(); return authority.promise; });
    const caller = new AbortController();
    const pending = f.value[operation](selection, { signal: caller.signal });
    await entered.promise;
    caller.abort(new Error("cancelled during workspace resolution"));
    authority.resolve({ projectId: "p", status: "provider", diagnostics: [], workspaces: [] });
    await expect(pending).rejects.toThrow();
    expect(f.sessions.listCatalogSessions).not.toHaveBeenCalled();
    expect(f.sessions.abort).not.toHaveBeenCalled();
    expect(f.sessions.stop).not.toHaveBeenCalled();
  });

  it.each(["caller", "dispose", "lifetime"] as const)("does not roll back admitted work after %s cancellation", async (mode) => {
    const f = fixture();
    const entered = deferred();
    const completed = deferred();
    f.sessions[native].mockImplementationOnce(() => { entered.resolve(); return completed.promise; });
    const caller = new AbortController();
    const pending = f.value[operation](selection, { signal: caller.signal });
    await entered.promise;
    if (mode === "caller") caller.abort();
    else if (mode === "dispose") await f.instance.dispose?.(new AbortController().signal);
    else f.lifetime.abort();
    expect(f.onMutation).not.toHaveBeenCalled();
    completed.resolve();
    await expect(pending).resolves.toBeUndefined();
    expect(f.sessions[native]).toHaveBeenCalledExactlyOnceWith({ id: "child", cwd });
    expect(f.onMutation.mock.calls).toEqual(operation === "close" ? [[selection]] : []);
  });

  it("propagates native failures without falling back to destructive mutations", async () => {
    const f = fixture();
    const error = new Error("native operation failed");
    f.sessions[native].mockRejectedValueOnce(error);
    await expect(f.value[operation](selection)).rejects.toBe(error);
    expect(f.sessions[native]).toHaveBeenCalledOnce();
    expect(f.sessions[native === "stop" ? "abort" : "stop"]).not.toHaveBeenCalled();
    expect(f.sessions.archiveMany).not.toHaveBeenCalled();
    expect(f.sessions.restore).not.toHaveBeenCalled();
    expect(f.sessions.deleteArchivedMany).not.toHaveBeenCalled();
    expect(f.onMutation).not.toHaveBeenCalled();
  });
});
