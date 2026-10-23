import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpRequestError } from "./http";
import { navigationOrderPort, navigationOrderPath, parseNavigationOrderSnapshot } from "./navigationOrder";

const scope = { kind: "sessionPins" as const, machineId: "remote/a", projectId: "p /", workspaceId: "w?#" };
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("navigation order API", () => {
  it("encodes scope IDs into remote-compatible application references", () => {
    expect(navigationOrderPath({ kind: "projects", machineId: "local" })).toBe("api/machines/local/navigation/projects");
    expect(navigationOrderPath({ kind: "workspaces", machineId: "remote/a", projectId: "p /" }))
      .toBe("api/machines/remote%2Fa/navigation/projects/p%20%2F/workspaces");
    expect(navigationOrderPath(scope)).toBe("api/machines/remote%2Fa/navigation/projects/p%20%2F/workspaces/w%3F%23/session-pins");
  });

  it("sends the complete sequence with its revision precondition", async () => {
    vi.stubGlobal("document", { baseURI: "https://example.test/nested/" });
    vi.stubEnv("BASE_URL", "/nested/");
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ids: ["hidden", "visible"], revision: 3 })));
    vi.stubGlobal("fetch", fetch);
    await expect(navigationOrderPort.save(scope, ["hidden", "visible"], 2)).resolves.toEqual({ ids: ["hidden", "visible"], revision: 3 });
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining("/nested/api/machines/remote%2Fa/"), expect.objectContaining({
      method: "PUT", body: JSON.stringify({ ids: ["hidden", "visible"], revision: 2 }),
    }));
  });

  it("preserves conflicts as errors", async () => {
    vi.stubGlobal("document", { baseURI: "https://example.test/" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "conflict" }), { status: 409 })));
    await expect(navigationOrderPort.save(scope, [], 1)).rejects.toMatchObject({ status: 409 });
    await expect(navigationOrderPort.save(scope, [], 1)).rejects.toBeInstanceOf(HttpRequestError);
  });

  it.each([{ ids: [] }, { ids: ["a", "a"], revision: 0 }, { ids: [""], revision: 0 }, { ids: [], revision: -1 }])("rejects malformed or revision-less responses %j", (value) => {
      expect(() => parseNavigationOrderSnapshot(value)).toThrow();
    });
});
