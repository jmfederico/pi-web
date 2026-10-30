import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PI_WEB_HOST_CATALOG_CAPABILITY, type PluginSessionSnapshot } from "../../shared/pluginCatalogTypes.js";
import type { WorkspaceListing } from "../../shared/apiTypes.js";
import { createServerPluginCatalogCapabilityFactory } from "./serverPluginCatalogCapability.js";

const repositoryPath = resolve("/repo");
const dates = { created: null, modified: null, archivedAt: null };

function fixture() {
  const project = { id: "project", name: "Project", path: repositoryPath, createdAt: "private" };
  const metadata = { owner: { nested: [true] } };
  const workspace: WorkspaceListing = {
    id: "workspace", projectId: project.id, path: project.path, label: "Main", isMain: true,
    provider: { pluginId: "provider", capabilities: { remove: true }, metadata: { public: true } },
    removal: { actionLabel: "Remove", confirmation: "Remove workspace?", precondition: "private-token" },
  };
  let rows: readonly WorkspaceListing[] = [workspace];
  const projects = { list: vi.fn(() => Promise.resolve([project])), requireProject: vi.fn((id: string) => {
    if (id !== project.id) return Promise.reject(new Error("Project not found"));
    return Promise.resolve(project);
  }) };
  const workspaces = { resolve: vi.fn(() => Promise.resolve({ projectId: project.id, status: "provider" as const, diagnostics: [], workspaces: rows })) };
  const sessions = { listCatalogSessions: vi.fn((cwd: string, signal?: AbortSignal): Promise<readonly Omit<PluginSessionSnapshot, "pinned">[]> => {
    signal?.throwIfAborted();
    return Promise.resolve([
    { id: "cold", cwd, ...dates, archived: true, runtime: "not-hosted", metadata },
    { id: "idle", cwd: repositoryPath, ...dates, archived: false, runtime: "idle" },
    { id: "busy", cwd: repositoryPath, ...dates, archived: false, runtime: "busy", name: "Working" },
  ]);
  }) };
  const pins = { pinnedSessionIds: vi.fn(() => Promise.resolve(["cold"])) };
  const lifetime = new AbortController();
  const instance = createServerPluginCatalogCapabilityFactory({ projects, workspaces, sessions, pins }).create({
    pluginId: "consumer", packageRoot: "/plugins/consumer", lifetimeSignal: lifetime.signal,
  });
  return { project, workspace, metadata, projects, workspaces, sessions, pins, lifetime, instance,
    catalog: PI_WEB_HOST_CATALOG_CAPABILITY.parse(instance.value),
    replaceWorkspaces: (next: readonly WorkspaceListing[]) => { rows = next; },
  };
}
const selection = { projectId: "project", workspaceId: "workspace" };

describe("server plugin catalog capability", () => {
  it("lists and resolves detached public projections without exposing mutation methods", async () => {
    const f = fixture();
    expect(await f.catalog.projects.list()).toEqual([{ id: "project", name: "Project", path: repositoryPath }]);
    expect(await f.catalog.projects.get("project")).not.toHaveProperty("createdAt");
    const workspaces = await f.catalog.workspaces.list("project");
    const publicWorkspace = { ...f.workspace, removal: { actionLabel: "Remove", confirmation: "Remove workspace?" } };
    expect(workspaces).toEqual([publicWorkspace]);
    expect(await f.catalog.workspaces.get(selection)).toEqual(publicWorkspace);
    const sessions = await f.catalog.sessions.list(selection);
    expect(sessions.map(({ runtime }) => runtime)).toEqual(["not-hosted", "idle", "busy"]);
    expect(await f.catalog.sessions.get({ ...selection, sessionId: "busy" })).toMatchObject({ name: "Working", runtime: "busy" });
    f.metadata.owner.nested.push(false);
    expect(sessions[0]?.metadata).toEqual({ owner: { nested: [true] } });
    expect(Object.isFrozen(sessions)).toBe(true);
    expect(Object.isFrozen(sessions[0]?.metadata?.["owner"])).toBe(true);
    expect(Object.isFrozen(workspaces[0]?.provider?.metadata)).toBe(true);
    expect(Object.keys(f.catalog.sessions)).toEqual(["list", "get"]);
    expect(f.sessions.listCatalogSessions).toHaveBeenCalledWith(repositoryPath, expect.any(AbortSignal));
  });

  it("refreshes the native cleanup pin union on every read and fails rather than guessing unpinned", async () => {
    const f = fixture();
    const listed = await f.catalog.sessions.list(selection);
    expect(listed.find(({ id }) => id === "cold")?.pinned).toBe(true);
    expect(listed.find(({ id }) => id === "busy")?.pinned).toBe(false);
    expect(f.pins.pinnedSessionIds).toHaveBeenCalledExactlyOnceWith();
    f.pins.pinnedSessionIds.mockResolvedValue(["busy"]);
    expect(await f.catalog.sessions.get({ ...selection, sessionId: "busy" })).toMatchObject({ pinned: true });
    expect(listed.find(({ id }) => id === "busy")?.pinned).toBe(false);
    f.pins.pinnedSessionIds.mockRejectedValue(new Error("Pin storage unavailable"));
    await expect(f.catalog.sessions.list(selection)).rejects.toThrow("Pin storage unavailable");
  });

  it("re-resolves authority and rejects stale workspaces, missing projects and sessions", async () => {
    const f = fixture();
    await expect(f.catalog.sessions.get({ ...selection, sessionId: "missing" })).rejects.toThrow("session is stale or unavailable");
    await expect(f.catalog.projects.get("missing")).rejects.toThrow("Project not found");
    f.replaceWorkspaces([{ ...f.workspace, id: "replacement" }]);
    await expect(f.catalog.sessions.list(selection)).rejects.toThrow("workspace is stale or unavailable");
    expect(f.sessions.listCatalogSessions).toHaveBeenCalledTimes(1);
    expect((await f.catalog.workspaces.list("project"))[0]?.id).toBe("replacement");
  });

  it("fails closed on mismatched project/workspace/session authority", async () => {
    const f = fixture();
    f.replaceWorkspaces([{ ...f.workspace, projectId: "other" }]);
    await expect(f.catalog.workspaces.list("project")).rejects.toThrow("outside selected project");
    f.replaceWorkspaces([f.workspace]);
    f.sessions.listCatalogSessions.mockResolvedValueOnce([{ id: "cold", cwd: "/other", ...dates, archived: false, runtime: "not-hosted" }]);
    await expect(f.catalog.sessions.list(selection)).rejects.toThrow("outside selected workspace");
  });

  it("rejects in-flight results and future reads after lifetime revocation or disposal", async () => {
    const f = fixture();
    let finish!: (rows: readonly Omit<PluginSessionSnapshot, "pinned">[]) => void;
    f.sessions.listCatalogSessions.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const pending = f.catalog.sessions.list(selection);
    await vi.waitFor(() => { expect(f.sessions.listCatalogSessions).toHaveBeenCalledOnce(); });
    f.lifetime.abort();
    const signal = f.sessions.listCatalogSessions.mock.calls[0]?.[1];
    expect(signal?.aborted).toBe(true);
    finish([]);
    await expect(pending).rejects.toThrow("consumer is no longer active");
    await expect(f.catalog.projects.list()).rejects.toThrow("no longer active");
    expect(f.projects.list).not.toHaveBeenCalled();
    const disposed = fixture();
    await disposed.instance.dispose?.(new AbortController().signal);
    await expect(disposed.catalog.projects.list()).rejects.toThrow("no longer active");
  });

  it("honors caller cancellation without revoking subsequent reads", async () => {
    const f = fixture();
    const caller = new AbortController();
    caller.abort(new Error("Caller cancelled"));
    await expect(f.catalog.projects.list({ signal: caller.signal })).rejects.toThrow("Caller cancelled");
    expect(f.projects.list).not.toHaveBeenCalled();
    expect(await f.catalog.projects.list()).toHaveLength(1);
  });
});
