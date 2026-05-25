import { afterEach, describe, expect, it, vi } from "vitest";
import { readRoute, writeRoute, type AppRoute } from "./route";

const originalWindow = globalThis.window;

afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(globalThis, "window", { value: originalWindow, configurable: true });
});

function installWindow(href: string): { pushed: string[] } {
  const url = new URL(href);
  const pushed: string[] = [];
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
        pushed.push(String(next));
      }),
    },
  };
  Object.defineProperty(globalThis, "window", { value: fakeWindow, configurable: true });
  return { pushed };
}

describe("route helpers", () => {
  it("reads only supported route fields from the current URL", () => {
    installWindow("http://localhost/app?machine=remote&project=p1&workspace=w1&session=s1&tool=git&view=files&core.workspace.files--file=src%2Fmain.ts&core.workspace.git--diff=README.md");

    expect(readRoute()).toEqual({
      machineId: "remote",
      projectId: "p1",
      workspaceId: "w1",
      sessionId: "s1",
      tool: "core:workspace.git",
      view: "core:workspace.files",
    });
  });

  it("ignores unsupported tool and view values", () => {
    installWindow("http://localhost/app?tool=terminal&view=settings");

    expect(readRoute()).toMatchObject({ tool: undefined, view: undefined });
  });

  it("writes compact URLs and preserves path/hash", () => {
    const { pushed } = installWindow("http://localhost/app?old=1#section");
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
  });

  it("does not push history when the route is unchanged", () => {
    const { pushed } = installWindow("http://localhost/app?project=p1&tool=core%3Aworkspace.git");

    writeRoute({ machineId: undefined, projectId: "p1", workspaceId: undefined, sessionId: undefined, tool: "core:workspace.git", view: undefined });

    expect(pushed).toEqual([]);
  });
});
