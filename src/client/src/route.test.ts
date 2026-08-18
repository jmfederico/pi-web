import { afterEach, describe, expect, it, vi } from "vitest";
import { readRoute, resolveAppRoute, writeRoute, type AppRoute } from "./route";

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
});
