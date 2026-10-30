import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerSessionPinRoutes } from "../navigationPreferenceRoutes.js";
import { NavigationPreferenceConflictError, NavigationPreferenceStore } from "./navigationPreferenceStore.js";
import { SessionPinStore } from "./sessionPinStore.js";

let directory: string;
let file: string;
let legacy: string;
const scope = { projectId: "p/one", workspaceId: "w/one" };

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "session-pins-"));
  file = join(directory, "session-pins.json");
  legacy = join(directory, "navigation-preferences.json");
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

describe("daemon session pins", () => {
  it("imports every pin scope, preserving order, revisions and cleared tombstones without modifying legacy state", async () => {
    const navigation = new NavigationPreferenceStore(legacy);
    await navigation.put({ kind: "projects" }, { ids: ["not-a-pin"] });
    await navigation.put({ kind: "session-pins", ...scope }, { ids: ["two", "one"] });
    const cleared = { projectId: "offline", workspaceId: "stale" };
    await navigation.put({ kind: "session-pins", ...cleared }, { ids: ["old"] });
    await navigation.put({ kind: "session-pins", ...cleared }, { ids: [] });
    const original = await readFile(legacy, "utf8");
    const pins = new SessionPinStore(file, legacy);
    expect(await pins.get(scope)).toEqual({ ids: ["two", "one"], revision: 1 });
    expect(await pins.get(cleared)).toEqual({ ids: [], revision: 2 });
    expect(await pins.pinnedSessionIds()).toEqual(["one", "two"]);
    expect(await readFile(legacy, "utf8")).toBe(original);
    expect(await readFile(file, "utf8")).not.toContain("not-a-pin");
    await expect(pins.put(cleared, { ids: ["resurrect"], revision: 1 })).rejects.toBeInstanceOf(NavigationPreferenceConflictError);
    await navigation.put({ kind: "session-pins", ...scope }, { ids: ["late-legacy"] });
    expect(await new SessionPinStore(file, legacy).get(scope)).toEqual({ ids: ["two", "one"], revision: 1 });
  });

  it("persists an empty import so later legacy writes cannot be reimported", async () => {
    expect(await new SessionPinStore(file, legacy).pinnedSessionIds()).toEqual([]);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ version: 1, entries: [] });
    await new NavigationPreferenceStore(legacy).put({ kind: "session-pins", ...scope }, { ids: ["late"] });
    expect(await new SessionPinStore(file, legacy).get(scope)).toEqual({ ids: [], revision: 0 });
  });

  it("fails closed on corrupt legacy or authoritative state and allows retry after repair", async () => {
    await writeFile(legacy, "broken");
    const pins = new SessionPinStore(file, legacy);
    await expect(pins.get(scope)).rejects.toThrow();
    await expect(readFile(file, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await rm(legacy);
    expect(await pins.get(scope)).toEqual({ ids: [], revision: 0 });
    await writeFile(file, "broken");
    await expect(new SessionPinStore(file, legacy).pinnedSessionIds()).rejects.toThrow();
    expect(await readFile(file, "utf8")).toBe("broken");
  });

  it("serializes atomic pin changes with revisioned replacements and isolates opaque scope IDs", async () => {
    const pins = new SessionPinStore(file, legacy);
    await Promise.all([pins.setPinned(scope, "one", true), pins.setPinned(scope, "two", true)]);
    expect(await pins.get(scope)).toEqual({ ids: ["one", "two"], revision: 2 });
    expect(await pins.setPinned(scope, "one", true)).toEqual({ ids: ["one", "two"], revision: 2 });
    await expect(pins.put(scope, { ids: ["stale"], revision: 1 })).rejects.toBeInstanceOf(NavigationPreferenceConflictError);
    expect(await pins.setPinned(scope, "one", false)).toEqual({ ids: ["two"], revision: 3 });
    expect(await pins.get({ projectId: "p", workspaceId: "one/w/one" })).toEqual({ ids: [], revision: 0 });
    expect(await new SessionPinStore(file, legacy).get(scope)).toEqual({ ids: ["two"], revision: 3 });
  });

  it("publishes scoped invalidation only after committed writes, not import, no-op or failed CAS", async () => {
    const changed = vi.fn<(scope: { projectId: string; workspaceId: string }, revision: number) => void>();
    const pins = new SessionPinStore(file, legacy, changed);
    await pins.get(scope);
    expect(changed).not.toHaveBeenCalled();
    await pins.setPinned(scope, "one", true);
    expect(changed).toHaveBeenLastCalledWith(scope, 1);
    expect(await new SessionPinStore(file, legacy).get(scope)).toEqual({ ids: ["one"], revision: 1 });
    await pins.setPinned(scope, "one", true);
    await expect(pins.put(scope, { ids: [], revision: 0 })).rejects.toBeInstanceOf(NavigationPreferenceConflictError);
    expect(changed).toHaveBeenCalledTimes(1);
    await pins.put(scope, { ids: ["two"], revision: 1 });
    expect(changed).toHaveBeenCalledTimes(2);
    await pins.setPinned(scope, "two", false);
    expect(changed).toHaveBeenCalledTimes(3);
  });

  it("keeps native navigation GET/PUT revisions and conflict responses compatible", async () => {
    const app = Fastify();
    registerSessionPinRoutes(app, new SessionPinStore(file, legacy));
    try {
      const url = "/navigation/projects/p%2Fone/workspaces/w%2Fone/session-pins";
      expect((await app.inject({ method: "GET", url })).json()).toEqual({ ids: [], revision: 0 });
      expect((await app.inject({ method: "PUT", url, payload: { ids: ["one"], revision: 0 } })).json()).toEqual({ ids: ["one"], revision: 1 });
      const stale = await app.inject({ method: "PUT", url, payload: { ids: [], revision: 0 } });
      expect(stale.statusCode).toBe(409);
      expect(stale.json()).toMatchObject({ ids: ["one"], revision: 1 });
      expect((await app.inject({ method: "PUT", url, payload: { ids: ["one", "one"] } })).statusCode).toBe(400);
      expect((await app.inject({ method: "GET", url: "/navigation/projects" })).statusCode).toBe(404);
    } finally { await app.close(); }
  });
});
