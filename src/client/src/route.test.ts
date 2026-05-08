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
    },
  };
  Object.defineProperty(globalThis, "window", { value: fakeWindow, configurable: true });
  return { pushed };
}

describe("route helpers", () => {
  it("reads only supported route fields from the current URL", () => {
    installWindow("http://localhost/app?project=p1&workspace=w1&session=s1&tool=git&view=files&file=src%2Fmain.ts&diff=README.md");

    expect(readRoute()).toEqual({
      projectId: "p1",
      workspaceId: "w1",
      sessionId: "s1",
      tool: "git",
      view: "files",
      file: "src/main.ts",
      diff: "README.md",
    });
  });

  it("ignores unsupported tool and view values", () => {
    installWindow("http://localhost/app?tool=terminal&view=settings");

    expect(readRoute()).toMatchObject({ tool: undefined, view: undefined });
  });

  it("writes compact URLs and preserves path/hash", () => {
    const { pushed } = installWindow("http://localhost/app?old=1#section");
    const route: AppRoute = {
      projectId: "project/id",
      workspaceId: "workspace id",
      sessionId: "",
      tool: "files",
      view: "chat",
      file: "src/main.ts",
      diff: undefined,
    };

    writeRoute(route);

    expect(pushed).toEqual(["http://localhost/app?old=1&project=project%2Fid&workspace=workspace+id&tool=files&view=chat&file=src%2Fmain.ts#section"]);
  });

  it("does not push history when the route is unchanged", () => {
    const { pushed } = installWindow("http://localhost/app?project=p1&tool=git");

    writeRoute({ projectId: "p1", workspaceId: undefined, sessionId: undefined, tool: "git", view: undefined, file: undefined, diff: undefined });

    expect(pushed).toEqual([]);
  });
});
