import { afterEach, describe, expect, it, vi } from "vitest";
import { parseMainView, readRoute, resolveAppRoute, routeMatchesWorkspaceIdentity, writeRoute, type AppRoute } from "./route";

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
  files: "files:workspace.files",
  "core:workspace.files": "files:workspace.files",
  git: "git:workspace.git",
  "core:workspace.git": "git:workspace.git",
  "git:workspace.git": "git:workspace.git",
};

function resolveWorkspacePanel(value: string): AppRoute["tool"] {
  return routeAliases[value];
}

describe("route helpers", () => {
  it("reads only supported route fields from the current URL", () => {
    installWindow("http://localhost/app?machine=remote&project=p1&workspace=w1&session=s1&tool=git%3Aworkspace.git&view=workspace&core.workspace.files--file=src%2Fmain.ts&git.workspace.git--diff=README.md");

    expect(resolveAppRoute(readRoute(), resolveWorkspacePanel)).toEqual({
      machineId: "remote",
      projectId: "p1",
      workspaceId: "w1",
      sessionId: "s1",
      tool: "git:workspace.git",
      view: "workspace",
    });
  });

  it("ignores unsupported aliases while retaining qualified ids for retryable plugin loads", () => {
    installWindow("http://localhost/app?tool=terminal&view=settings");
    expect(resolveAppRoute(readRoute(), resolveWorkspacePanel)).toMatchObject({ tool: undefined, view: undefined });

    installWindow("http://localhost/app?tool=retryable%3Aworkspace.panel&view=retryable%3Aworkspace.panel");
    expect(resolveAppRoute(readRoute(), resolveWorkspacePanel)).toMatchObject({
      tool: "retryable:workspace.panel",
      view: undefined,
    });
  });

  it("keeps legacy tool values for plugin resolution but rejects contribution-valued views", () => {
    installWindow("http://localhost/app?tool=git&view=core%3Aworkspace.git");

    expect(readRoute()).toMatchObject({ tool: "git", view: "core:workspace.git" });
    expect(resolveAppRoute(readRoute(), resolveWorkspacePanel)).toMatchObject({
      tool: "git:workspace.git",
      view: undefined,
    });
  });

  it.each(["navigation", "chat", "workspace"] as const)("preserves explicit %s independently of tool resolution", (view) => {
    for (const tool of [undefined, "git", "retryable:workspace.panel"]) {
      const params = new URLSearchParams({ view });
      if (tool !== undefined) params.set("tool", tool);
      installWindow(`http://localhost/app?${params}`);
      const parsed = readRoute();
      const resolver = vi.fn(resolveWorkspacePanel);
      const resolved = resolveAppRoute(parsed, resolver);
      expect(parsed.view).toBe(view);
      expect(resolved.view).toBe(view);
      expect(resolver.mock.calls).toEqual(tool === undefined ? [] : [[tool]]);

      const { pushed } = installWindow("http://localhost/app");
      writeRoute(resolved);
      expect(pushed).toHaveLength(1);
      const written = new URL(pushed[0] ?? "");
      expect(written.searchParams.get("view")).toBe(view);
      installWindow(written.href);
      expect(readRoute().view).toBe(view);
    }
  });

  it.each(["files", "git", "core:workspace.git", "git:workspace.git", "retryable:workspace.panel", "settings", "", "Workspace"])("rejects invalid view %j without changing the tool", (view) => {
    installWindow(`http://localhost/app?tool=files&view=${encodeURIComponent(view)}`);
    // Raw values survive parsing for warnings; only resolved state is structural.
    expect(readRoute().view).toBe(view === "" ? undefined : view);
    expect(resolveAppRoute(readRoute(), resolveWorkspacePanel)).toMatchObject({
      tool: "files:workspace.files",
      view: undefined,
    });
    expect(parseMainView(view)).toBeUndefined();
  });

  it.each([undefined, null, 1, {}, []])("rejects non-string view %j", (view) => {
    expect(parseMainView(view)).toBeUndefined();
  });

  it("matches contribution navigation to the exact machine, project, and workspace route", () => {
    expect(routeMatchesWorkspaceIdentity(
      { machineId: undefined, projectId: "p1", workspaceId: "w1" },
      { machineId: "local", projectId: "p1", workspaceId: "w1" },
    )).toBe(true);
    expect(routeMatchesWorkspaceIdentity(
      { machineId: "remote", projectId: "p1", workspaceId: "w1" },
      { machineId: "local", projectId: "p1", workspaceId: "w1" },
    )).toBe(false);
    expect(routeMatchesWorkspaceIdentity(
      { machineId: "remote", projectId: "p1", workspaceId: "other" },
      { machineId: "remote", projectId: "p1", workspaceId: "w1" },
    )).toBe(false);
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
});
