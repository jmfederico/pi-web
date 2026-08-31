import { afterEach, describe, expect, it, vi } from "vitest";
import { readRoute, resolveAppRoute, resolveNotificationRoute, writeRoute, findNotifiedWorkspace, type AppRoute, type ParsedAppRoute } from "./route";

const originalWindow = globalThis.window;

afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(globalThis, "window", { value: originalWindow, configurable: true });
});

function installWindow(href: string): { pushed: string[]; replaced: string[] } {
  const url = new URL(href);
  const pushed: string[] = [];
  const replaced: string[] = [];
  const fakeWindow = {
    location: {
      href: url.href,
      pathname: url.pathname,
      search: url.search,
      hash: url.hash,
    },
    history: {
      pushState: vi.fn((_state: object, _title: string, next: URL | string) => {
        pushed.push(String(next));
      }),
      replaceState: vi.fn((_state: object, _title: string, next: URL | string) => {
        replaced.push(String(next));
      }),
    },
  };
  Object.defineProperty(globalThis, "window", { value: fakeWindow, configurable: true });
  return { pushed, replaced };
}

const routeAliases: Record<string, AppRoute["tool"]> = {
  files: "core:workspace.files",
  "core:workspace.files": "core:workspace.files",
  git: "git:workspace.git",
  "core:workspace.git": "git:workspace.git",
  "git:workspace.git": "git:workspace.git",
};

function resolveWorkspacePanel(value: string): AppRoute["tool"] {
  return routeAliases[value];
}

describe("route helpers", () => {
  it("reads only supported route fields from the current URL", () => {
    installWindow("http://localhost/app?machine=remote&project=p1&workspace=w1&session=s1&tool=git%3Aworkspace.git&view=files&core.workspace.files--file=src%2Fmain.ts&git.workspace.git--diff=README.md");

    expect(resolveAppRoute(readRoute(), resolveWorkspacePanel)).toEqual({
      machineId: "remote",
      projectId: "p1",
      workspaceId: "w1",
      sessionId: "s1",
      tool: "git:workspace.git",
      view: "core:workspace.files",
    });
  });

  it("ignores unsupported aliases while retaining qualified ids for retryable plugin loads", () => {
    installWindow("http://localhost/app?tool=terminal&view=settings");
    expect(resolveAppRoute(readRoute(), resolveWorkspacePanel)).toMatchObject({ tool: undefined, view: undefined });

    installWindow("http://localhost/app?tool=retryable%3Aworkspace.panel&view=retryable%3Aworkspace.panel");
    expect(resolveAppRoute(readRoute(), resolveWorkspacePanel)).toMatchObject({
      tool: "retryable:workspace.panel",
      view: "retryable:workspace.panel",
    });
  });

  it("keeps legacy workspace-panel values until plugins can migrate them", () => {
    installWindow("http://localhost/app?tool=git&view=core%3Aworkspace.git");

    expect(readRoute()).toMatchObject({ tool: "git", view: "core:workspace.git" });
    expect(resolveAppRoute(readRoute(), resolveWorkspacePanel)).toMatchObject({
      tool: "git:workspace.git",
      view: "git:workspace.git",
    });
  });

  it("writes compact URLs with push history and preserves path/hash", () => {
    const { pushed, replaced } = installWindow("http://localhost/app?old=1#section");
    const route: AppRoute = {
      machineId: "remote",
      projectId: "project/id",
      workspaceId: "workspace id",
      sessionId: "",
      tool: "core:workspace.files",
      view: "chat",
    };

    writeRoute(route);

    expect(pushed).toEqual(["http://localhost/app?old=1&machine=remote&project=project%2Fid&workspace=workspace+id&tool=core%3Aworkspace.files&view=chat#section"]);
    expect(replaced).toEqual([]);
  });

  it("does not write history when the route is unchanged", () => {
    const { pushed, replaced } = installWindow("http://localhost/app?project=p1&tool=git%3Aworkspace.git");

    writeRoute({ machineId: undefined, projectId: "p1", workspaceId: undefined, sessionId: undefined, tool: "git:workspace.git", view: undefined });

    expect(pushed).toEqual([]);
    expect(replaced).toEqual([]);
  });

  it("writes the notification cwd parameter alongside the session", () => {
    const { pushed } = installWindow("http://localhost/app");

    writeRoute({ machineId: undefined, projectId: undefined, workspaceId: undefined, sessionId: "s1", cwd: "/repo/app", tool: undefined, view: undefined });

    expect(pushed).toEqual(["http://localhost/app?session=s1&cwd=%2Frepo%2Fapp"]);
  });

  it("clears a stale cwd parameter when the new route has none", () => {
    const { pushed } = installWindow("http://localhost/app?session=s1&cwd=%2Frepo");

    writeRoute({ machineId: undefined, projectId: "p1", workspaceId: undefined, sessionId: "s2", tool: undefined, view: undefined });

    expect(pushed[0]?.includes("cwd")).toBe(false);
    expect(pushed[0]).toContain("session=s2");
  });

  it("reads the cwd parameter", () => {
    installWindow("http://localhost/app?session=s1&cwd=%2Frepo%2Fapp");

    expect(readRoute()).toMatchObject({ sessionId: "s1", cwd: "/repo/app" });
  });
});

describe("findNotifiedWorkspace", () => {
  it("matches the workspace whose path equals the notified session cwd", () => {
    const workspaces = [{ id: "w1", path: "/other" }, { id: "w2", path: "/repo/app" }];
    expect(findNotifiedWorkspace(workspaces, "/repo/app")).toBe("w2");
  });

  it("returns undefined when no workspace path matches", () => {
    expect(findNotifiedWorkspace([{ id: "w1", path: "/other" }], "/repo/app")).toBeUndefined();
  });
});

describe("resolveNotificationRoute", () => {
  const sessionRoute: ParsedAppRoute = {
    machineId: undefined,
    projectId: undefined,
    workspaceId: undefined,
    sessionId: "target-session",
    tool: undefined,
    view: undefined,
  };

  it("resolves a session-only link from workspace session lists", async () => {
    const loadWorkspaces = vi.fn().mockResolvedValue([{ id: "w1", path: "/repo" }]);
    const loadSessions = vi.fn().mockResolvedValue([{ id: "target-session" }]);

    const route = await resolveNotificationRoute(sessionRoute, [{ id: "p1" }], {}, loadWorkspaces, loadSessions);

    expect(route).toEqual({ ...sessionRoute, projectId: "p1", workspaceId: "w1" });
    expect(loadSessions).toHaveBeenCalledWith("/repo");
  });

  it("keeps cwd matching as the direct path without loading sessions", async () => {
    const loadSessions = vi.fn();

    const route = await resolveNotificationRoute(
      { ...sessionRoute, cwd: "/repo" },
      [{ id: "p1" }],
      { p1: [{ id: "w1", path: "/repo" }] },
      vi.fn(),
      loadSessions,
    );

    expect(route).toEqual({ ...sessionRoute, cwd: "/repo", projectId: "p1", workspaceId: "w1" });
    expect(loadSessions).not.toHaveBeenCalled();
  });
});
