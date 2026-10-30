import { describe, expect, it } from "vitest";
import { PI_WEB_HOST_CATALOG_CAPABILITY } from "./pluginCatalogTypes.js";

const metadata = { created: null, modified: null, archivedAt: null, pinned: false };

function provider() {
  return {
    version: 1,
    projects: { list: () => Promise.resolve([{ id: "p", name: "Project", path: "/repo", private: "secret" }]), get: () => Promise.resolve({ id: "p", name: "Project", path: "/repo" }) },
    workspaces: { list: () => Promise.resolve([]), get: () => Promise.resolve({ id: "w", projectId: "p", path: "/repo", label: "Main", isMain: true, data: { secret: true } }) },
    sessions: { list: () => Promise.resolve([]), get: () => Promise.resolve({ id: "s", cwd: "/repo", ...metadata, archived: false, runtime: "idle", transcript: "secret", path: "/private/session.jsonl" }) },
  };
}

describe("catalog public contract", () => {
  it("captures functions and strips private data from every projection", async () => {
    const source = provider();
    const catalog = PI_WEB_HOST_CATALOG_CAPABILITY.parse(source);
    source.projects.list = () => Promise.resolve([]);
    expect(await catalog.projects.list()).toEqual([{ id: "p", name: "Project", path: "/repo" }]);
    expect(await catalog.workspaces.get({ projectId: "p", workspaceId: "w" })).toEqual({ id: "w", projectId: "p", path: "/repo", label: "Main", isMain: true });
    expect(await catalog.sessions.get({ projectId: "p", workspaceId: "w", sessionId: "s" })).toEqual({ id: "s", cwd: "/repo", ...metadata, archived: false, runtime: "idle" });
    expect(Object.isFrozen(catalog.projects)).toBe(true);
  });

  it("preserves required lifecycle metadata with explicit null dates when unknown", async () => {
    const session = {
      id: "s", cwd: "/repo", archived: true, runtime: "not-hosted",
      created: "2026-01-01T00:00:00.000Z", modified: "2026-02-01T00:00:00.000Z",
      archivedAt: "2026-03-01T00:00:00.000Z", pinned: false,
    };
    const catalog = PI_WEB_HOST_CATALOG_CAPABILITY.parse({ ...provider(), sessions: {
      list: () => Promise.resolve([session]), get: () => Promise.resolve(session),
    } });
    expect(await catalog.sessions.list({ projectId: "p", workspaceId: "w" })).toEqual([session]);
    expect(await catalog.sessions.get({ projectId: "p", workspaceId: "w", sessionId: "s" })).toEqual(session);
    const unknownDates = await PI_WEB_HOST_CATALOG_CAPABILITY.parse(provider()).sessions.get({ projectId: "p", workspaceId: "w", sessionId: "s" });
    expect(unknownDates.pinned).toBe(false);
    expect(unknownDates.modified).toBeNull();
  });

  it.each([
    { created: 123 }, { modified: "not a timestamp" }, { archivedAt: "invalid" }, { pinned: "false" },
    { created: undefined }, { modified: undefined }, { archivedAt: undefined }, { pinned: undefined },
    { archived: false, archivedAt: "2026-03-01T00:00:00.000Z" },
  ])("rejects malformed or contradictory lifecycle metadata %j", async (fields) => {
    const catalog = PI_WEB_HOST_CATALOG_CAPABILITY.parse({ ...provider(), sessions: {
      list: () => Promise.resolve([]),
      get: () => Promise.resolve({ id: "s", cwd: "/repo", ...metadata, archived: true, runtime: "not-hosted", ...fields }),
    } });
    await expect(catalog.sessions.get({ projectId: "p", workspaceId: "w", sessionId: "s" })).rejects.toThrow("Invalid");
  });

  it("validates function groups, selections, returned identities and runtime values", async () => {
    expect(() => PI_WEB_HOST_CATALOG_CAPABILITY.parse({ ...provider(), version: 2 })).toThrow("Invalid");
    expect(() => PI_WEB_HOST_CATALOG_CAPABILITY.parse({ ...provider(), sessions: { list: () => [] } })).toThrow("Invalid");
    const source = provider();
    source.sessions.get = () => Promise.resolve({ id: "s", cwd: "/repo", ...metadata, archived: false, runtime: "invalid", transcript: "", path: "" });
    const catalog = PI_WEB_HOST_CATALOG_CAPABILITY.parse(source);
    await expect(catalog.projects.get("other")).rejects.toThrow("Invalid");
    await expect(catalog.workspaces.get({ projectId: "other", workspaceId: "w" })).rejects.toThrow("Invalid");
    await expect(catalog.sessions.get({ projectId: "p", workspaceId: "w", sessionId: "s" })).rejects.toThrow("Invalid");
    await expect(Reflect.apply(catalog.workspaces.get, undefined, [{ projectId: "p", workspaceId: "w", path: "/injected" }])).rejects.toThrow("Invalid");
  });
});
