import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NavigationPreferenceStore, navigationPreferenceStorePath, parseNavigationPreference } from "./navigationPreferenceStore.js";

describe("navigation preference state", () => {
  let directory: string;
  let path: string;
  let store: NavigationPreferenceStore;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "navigation-state-"));
    path = join(directory, "state.json");
    store = new NavigationPreferenceStore(path);
  });
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

  it("uses managed data rather than user configuration", () => {
    expect(navigationPreferenceStorePath({ PI_WEB_DATA_DIR: "state", PI_WEB_CONFIG: "config.json" }, "/tmp/app"))
      .toBe(resolve("/tmp/app/state/navigation-preferences.json"));
  });

  it("persists full replacement order and clearing across new store instances", async () => {
    const scope = { kind: "projects" } as const;
    expect(await store.get(scope)).toEqual({ ids: [], revision: 0 });
    await store.put(scope, { ids: ["offline", "p2", "p1"] });
    expect(await new NavigationPreferenceStore(path).get(scope)).toEqual({ ids: ["offline", "p2", "p1"], revision: 1 });
    await store.put(scope, { ids: ["p1"] });
    expect(await store.get(scope)).toEqual({ ids: ["p1"], revision: 2 });
    await store.put(scope, { ids: [] });
    expect(await new NavigationPreferenceStore(path).get(scope)).toEqual({ ids: [], revision: 3 });
  });

  it("serializes concurrent writes without losing independent scopes", async () => {
    const scopes = [
      { kind: "projects" },
      { kind: "workspaces", projectId: "__proto__" },
      { kind: "session-pins", projectId: "a/b", workspaceId: "c" },
      { kind: "session-pins", projectId: "a", workspaceId: "b/c" },
    ] as const;
    await Promise.all(scopes.map((scope, index) => store.put(scope, { ids: [String(index)] })));
    const reopened = new NavigationPreferenceStore(path);
    for (const [index, scope] of scopes.entries()) expect(await reopened.get(scope)).toEqual({ ids: [String(index)], revision: 1 });
  });

  it("rejects concurrent stale writes and preserves revisions after clearing", async () => {
    const scope = { kind: "projects" } as const;
    const results = await Promise.allSettled([
      store.put(scope, { ids: ["a"], revision: 0 }),
      store.put(scope, { ids: ["b"], revision: 0 }),
    ]);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
    await store.put(scope, { ids: [], revision: 1 });
    await expect(new NavigationPreferenceStore(path).put(scope, { ids: ["stale"], revision: 1 })).rejects.toThrow("revision conflict");
    expect(await store.get(scope)).toEqual({ ids: [], revision: 2 });
  });

  it.each([null, {}, { ids: "a" }, { ids: [1] }, { ids: [""] }, { ids: ["  "] }, { ids: ["a", "a"] }])("rejects invalid preferences %j", (value) => {
    expect(() => parseNavigationPreference(value)).toThrow();
  });

  it("does not overwrite corrupt state and can retry after a failure", async () => {
    await writeFile(path, "broken");
    await expect(store.put({ kind: "projects" }, { ids: ["p1"] })).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe("broken");
    await expect(store.get({ kind: "projects" })).rejects.toThrow();
    await rm(path);
    await store.put({ kind: "projects" }, { ids: ["p2"] });
    expect(await store.get({ kind: "projects" })).toEqual({ ids: ["p2"], revision: 1 });
  });
});
