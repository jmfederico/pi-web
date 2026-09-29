import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project, WorkspaceProviderAuthorityResolution } from "../../shared/apiTypes.js";
import { SessionUnreadStore, type SessionUnreadMutation } from "../sessions/sessionUnreadStore.js";
import { MachineStatusService } from "../status/machineStatusService.js";
import { CachedWorkspaceAttribution } from "../status/workspaceAttribution.js";
import { ProjectLifecycleService } from "./projectLifecycleService.js";

const root = project("root", "/");
const removed = project("removed", "/srv/removed");
const kept = project("kept", "/srv/kept");
const MINUTE = 60_000;

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe("eventual project unread cleanup", () => {
  it("does no discovery for an empty catalog, including project add/remove", async () => {
    const fixture = lifecycle([removed]);
    fixture.service.scheduleCleanup();
    await fixture.service.close(removed.id);
    await fixture.service.add({ path: removed.path });
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    expect(fixture.projects.list).not.toHaveBeenCalled();
    expect(fixture.workspaces.resolve).not.toHaveBeenCalled();
    expect(fixture.reconcile).not.toHaveBeenCalled();
  });

  it("coalesces startup/completion signals into one delayed pass and clears ancestor indicators", async () => {
    const fixture = lifecycle([root, kept]);
    complete(fixture.unread, removed.path);
    complete(fixture.unread, kept.path);
    for (let index = 0; index < 10; index += 1) fixture.service.scheduleCleanup();
    await vi.advanceTimersByTimeAsync(MINUTE - 1);
    expect(fixture.workspaces.resolve).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fixture.projects.list).toHaveBeenCalledOnce();
    expect(fixture.reconcile).toHaveBeenCalledOnce();
    expect(fixture.unread.catalogSnapshot().sessions.map((entry) => entry.cwd)).toEqual([kept.path]);
    expect(fixture.mutations[0]?.event).toMatchObject({ cwd: removed.path, unread: null });

    const status = new MachineStatusService({
      activity: { snapshot: () => ({ workspaces: [] }) },
      unread: fixture.unread,
      attribution: new CachedWorkspaceAttribution({
        projects: fixture.projects,
        workspaces: { list: async (owner) => [...(await fixture.workspaces.resolve(owner)).workspaces] },
        logger: fixture.logger,
      }),
      publisher: { publish: vi.fn() },
      logger: fixture.logger,
    });
    await status.refresh();
    expect(status.snapshot().projects).toEqual({ kept: { "core:unread": true } });
    expect(status.snapshot().unattributed).toEqual({});

    // Retained unread alone does not cause perpetual periodic discovery.
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    expect(fixture.reconcile).toHaveBeenCalledOnce();
  });

  it("skips the scheduled pass if the user has read everything meanwhile", async () => {
    const fixture = lifecycle([kept]);
    complete(fixture.unread, kept.path);
    fixture.service.scheduleCleanup();
    fixture.unread.forgetSession(kept.path, kept.path);
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(fixture.projects.list).not.toHaveBeenCalled();
  });

  it("removes registration immediately, then collects unread while preserving shared external worktrees", async () => {
    const fixture = lifecycle([removed, kept], new Map([
      [removed.id, [removed.path, "/external/shared"]],
      [kept.id, [kept.path, "/external/shared"]],
    ]));
    complete(fixture.unread, removed.path);
    complete(fixture.unread, "/external/shared");
    await fixture.service.close(removed.id);
    expect(await fixture.projects.list()).toEqual([kept]);
    expect(fixture.unread.catalogSnapshot().sessions).toHaveLength(2);
    expect(fixture.workspaces.resolve).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(fixture.unread.catalogSnapshot().sessions.map((entry) => entry.cwd)).toEqual(["/external/shared"]);
  });

  it("cleans before a quick re-add rather than reviving historical unread", async () => {
    const fixture = lifecycle([root, removed]);
    complete(fixture.unread, removed.path);
    await fixture.service.close(removed.id);
    await fixture.service.add({ path: removed.path });
    expect(fixture.unread.catalogSnapshot().sessions).toEqual([]);
    expect(fixture.reconcile).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    expect(fixture.reconcile).toHaveBeenCalledOnce();

    complete(fixture.unread, removed.path);
    fixture.service.scheduleCleanup();
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(fixture.unread.catalogSnapshot().sessions).toHaveLength(1); // New work is retained.
  });

  it("eventually collects another completion from a runtime whose project was removed", async () => {
    const fixture = lifecycle([root]);
    for (let index = 0; index < 2; index += 1) {
      complete(fixture.unread, removed.path);
      expect(fixture.unread.hasUnread()).toBe(true); // No permanent tracking eligibility state.
      fixture.service.scheduleCleanup();
      await vi.advanceTimersByTimeAsync(MINUTE);
      expect(fixture.unread.hasUnread()).toBe(false);
    }
  });

  it.each(["projects", "provider", "degraded"])("logs and retries failed %s lookup without deleting state", async (failure) => {
    const fixture = lifecycle([root]);
    complete(fixture.unread, removed.path);
    if (failure === "projects") fixture.projects.list.mockRejectedValueOnce(new Error("catalog unreadable"));
    if (failure === "provider") fixture.workspaces.resolve.mockRejectedValueOnce(new Error("lookup failed"));
    if (failure === "degraded") fixture.workspaces.resolve.mockResolvedValueOnce({ ...resolution(root, [root.path]), status: "degraded" });
    fixture.service.scheduleCleanup();
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(fixture.unread.hasUnread()).toBe(true);
    expect(fixture.reconcile).not.toHaveBeenCalled();
    expect(fixture.logger.warn).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(fixture.unread.hasUnread()).toBe(false);
  });

  it("does not register a project if pre-add durable cleanup fails", async () => {
    const fixture = lifecycle([root]);
    complete(fixture.unread, removed.path);
    fixture.reconcile.mockRejectedValueOnce(new Error("disk full"));
    await expect(fixture.service.add({ path: removed.path })).rejects.toThrow("disk full");
    expect(fixture.projects.add).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(fixture.unread.hasUnread()).toBe(false);
  });

  it("cancels pending cleanup on shutdown", async () => {
    const fixture = lifecycle([root]);
    complete(fixture.unread, removed.path);
    fixture.service.scheduleCleanup();
    await fixture.service.closeAll();
    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    expect(fixture.projects.list).not.toHaveBeenCalled();
    await expect(fixture.service.add({ path: kept.path })).rejects.toThrow("shutting down");
  });
});

function lifecycle(initial: Project[], paths = new Map<string, string[]>()) {
  let registered = [...initial];
  const projects = {
    list: vi.fn(() => Promise.resolve([...registered])),
    add: vi.fn((input: { path: string }) => {
      const added = project(`new-${String(registered.length)}`, input.path);
      registered.push(added);
      return Promise.resolve(added);
    }),
    close: vi.fn((id: string) => {
      registered = registered.filter((entry) => entry.id !== id);
      return Promise.resolve();
    }),
  };
  const workspaces = {
    resolve: vi.fn((owner: Project) => Promise.resolve(resolution(owner, paths.get(owner.id) ?? [owner.path]))),
  };
  const unread = new SessionUnreadStore();
  const mutations: SessionUnreadMutation[] = [];
  const reconcile = vi.fn(async (cwds: Iterable<string>) => {
    mutations.push(...unread.reconcileWorkspaces(cwds));
    await unread.flush();
  });
  const logger = { warn: vi.fn() };
  const service = new ProjectLifecycleService({
    projects, workspaces, reconcileUnreadWorkspaces: reconcile,
    hasUnread: () => unread.hasUnread(), onProjectsChanged: vi.fn(), logger,
  });
  return { service, projects, workspaces, unread, mutations, reconcile, logger };
}

function resolution(owner: Project, paths: string[]): WorkspaceProviderAuthorityResolution {
  return {
    projectId: owner.id, status: "folder", diagnostics: [],
    workspaces: paths.map((path) => ({ id: path, projectId: owner.id, path, isMain: path === owner.path, label: path })),
  };
}

function project(id: string, path: string): Project {
  return { id, path, name: id, createdAt: "2026-09-01T00:00:00Z" };
}

function complete(store: SessionUnreadStore, cwd: string): void {
  store.observeActivityState(cwd, cwd, true);
  store.observeActivityState(cwd, cwd, false);
}
