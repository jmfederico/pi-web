import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { PluginSessionSnapshot } from "../../shared/pluginCatalogTypes.js";
import { createServerPluginSessionLifecycleCapabilityFactory } from "./serverPluginSessionLifecycleCapability.js";

const cwd = resolve("/repo");
const dates = { created: null, modified: null, archivedAt: null };
const selection = { projectId: "p", workspaceId: "w", sessionId: "child" };
function fixture() {
  const project = { id: "p", name: "Project", path: cwd, createdAt: "now" };
  const projects = { requireProject: vi.fn(() => Promise.resolve(project)) };
  const workspace = { id: "w", projectId: "p", path: cwd, label: "Main", isMain: true };
  const workspaces = { resolve: vi.fn(() => Promise.resolve({ projectId: "p", status: "provider" as const, diagnostics: [], workspaces: [workspace] })) };
  const failures: { sessionId: string; error: string }[] = [];
  const sessions = {
    listCatalogSessions: vi.fn((selectedCwd: string, signal?: AbortSignal): Promise<readonly Omit<PluginSessionSnapshot, "pinned">[]> => {
      signal?.throwIfAborted();
      return Promise.resolve([{ id: "child", cwd: selectedCwd, ...dates, archived: true, runtime: "not-hosted" }]);
    }),
    archiveMany: vi.fn(() => Promise.resolve({ archived: true as const, archivedSessionIds: ["child"], failures, generatedAt: "now" })),
    restore: vi.fn(() => Promise.resolve()),
    deleteArchivedMany: vi.fn(() => Promise.resolve({ deleted: true as const, deletedSessionIds: ["child"], failures, generatedAt: "now" })),
  };
  const pins = { pinnedSessionIds: vi.fn(() => Promise.resolve(["child"])), setPinned: vi.fn(() => Promise.resolve()) };
  const lifetime = new AbortController();
  const onMutation = vi.fn();
  const instance = createServerPluginSessionLifecycleCapabilityFactory({ projects, workspaces, sessions, pins, onMutation }).create({ pluginId: "consumer", packageRoot: "", lifetimeSignal: lifetime.signal });
  return { projects, workspaces, sessions, pins, lifetime, onMutation, instance, value: instance.value };
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

  it("blocks mutations after caller cancellation, disposal or plugin revocation during authority reads", async () => {
    for (const mode of ["caller", "dispose", "lifetime"] as const) {
      const f = fixture();
      const caller = new AbortController();
      let finish!: (rows: readonly Omit<PluginSessionSnapshot, "pinned">[]) => void;
      f.sessions.listCatalogSessions.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
      const pending = f.value.archive(selection, { signal: caller.signal });
      await vi.waitFor(() => { expect(f.sessions.listCatalogSessions).toHaveBeenCalledOnce(); });
      if (mode === "caller") caller.abort(new Error("caller cancelled"));
      else if (mode === "dispose") await f.instance.dispose?.(new AbortController().signal);
      else f.lifetime.abort();
      finish([{ id: "child", cwd, ...dates, archived: true, runtime: "not-hosted" }]);
      await expect(pending).rejects.toThrow(mode === "caller" ? "caller cancelled" : "no longer active");
      expect(f.sessions.archiveMany).not.toHaveBeenCalled();
      if (mode === "caller") await f.value.pin(selection);
      else await expect(f.value.pin(selection)).rejects.toThrow("no longer active");
    }
  });

  it("rejects already-cancelled calls before authority or native work", async () => {
    const f = fixture();
    const caller = new AbortController();
    caller.abort(new Error("cancelled"));
    for (const operation of ["get", "pin", "unpin", "archive", "restore", "delete"] as const) {
      await expect(f.value[operation](selection, { signal: caller.signal })).rejects.toThrow("cancelled");
    }
    expect(f.projects.requireProject).not.toHaveBeenCalled();
    expect(f.pins.setPinned).not.toHaveBeenCalled();
    expect(f.sessions.archiveMany).not.toHaveBeenCalled();
    expect(f.sessions.restore).not.toHaveBeenCalled();
    expect(f.sessions.deleteArchivedMany).not.toHaveBeenCalled();
  });

  it("does not report cancellation as rollback after native admission", async () => {
    const f = fixture();
    let finish!: () => void;
    f.sessions.restore.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const pending = f.value.restore(selection);
    await vi.waitFor(() => { expect(f.sessions.restore).toHaveBeenCalledOnce(); });
    f.lifetime.abort();
    finish();
    await expect(pending).resolves.toBeUndefined();
    expect(f.onMutation).toHaveBeenCalledExactlyOnceWith(selection);
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
