import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SESSION_UNREAD_LIMIT, SESSION_UNREAD_SESSION_ID_MAX_LENGTH } from "../../shared/apiTypes.js";
import {
  FileSessionUnreadPersistence,
  SessionUnreadStore,
  defaultSessionUnreadFilePath,
  type SessionUnreadPersistedState,
  type SessionUnreadPersistence,
} from "./sessionUnreadStore.js";

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("SessionUnreadStore", () => {
  it("marks only known active-to-idle transitions unread", () => {
    const store = storeAt("2026-07-20T00:00:00.000Z", "catalog-a");

    expect(store.observeActivityState("session-1", "/repo", false)).toEqual([]);
    expect(store.observeActivityState("session-1", "/repo", true)).toEqual([]);
    expect(store.observeActivityState("session-1", "/repo", true)).toEqual([]);
    const completed = store.observeActivityState("session-1", "/repo", false);

    expect(completed).toMatchObject([{
      event: {
        type: "sessions.unread",
        catalogId: "catalog-a",
        catalogRevision: 1,
        sessionId: "session-1",
        cwd: "/repo",
        unread: { completionOrder: 1, completedAt: "2026-07-20T00:00:00.000Z" },
      },
    }]);
    expect(store.catalogSnapshot()).toMatchObject({
      catalogId: "catalog-a",
      catalogRevision: 1,
      sessions: [{ sessionId: "session-1", cwd: "/repo", completionOrder: 1 }],
    });
    expect(store.observeActivityState("session-1", "/repo", false)).toEqual([]);
  });

  it("uses monotonic completion orders so stale acknowledgements cannot clear newer work", () => {
    const store = storeAt("2026-07-20T00:00:00.000Z", "catalog-a");
    complete(store, "session-1", "/repo");
    const firstOrder = currentOrder(store, "session-1", "/repo");

    complete(store, "session-1", "/repo");
    const secondOrder = currentOrder(store, "session-1", "/repo");

    expect(secondOrder).toBeGreaterThan(firstOrder);
    expect(store.acknowledge("session-1", {
      cwd: "/repo",
      catalogId: "catalog-a",
      throughCompletionOrder: firstOrder,
    }).mutations).toEqual([]);
    expect(currentOrder(store, "session-1", "/repo")).toBe(secondOrder);

    const acknowledged = store.acknowledge("session-1", {
      cwd: "/repo",
      catalogId: "catalog-a",
      throughCompletionOrder: secondOrder,
    });
    expect(acknowledged.mutations).toMatchObject([{
      event: {
        type: "sessions.unread",
        catalogId: "catalog-a",
        catalogRevision: 3,
        sessionId: "session-1",
        unread: null,
      },
    }]);
    expect(store.catalogSnapshot().sessions).toEqual([]);
    expect(store.acknowledge("session-1", {
      cwd: "/repo",
      catalogId: "catalog-a",
      throughCompletionOrder: secondOrder,
    }).mutations).toEqual([]);
  });

  it("rejects stale acknowledgements from a reset catalog epoch", () => {
    const store = storeAt("2026-07-20T00:00:00.000Z", "catalog-new");
    complete(store, "session-1", "/repo");
    const current = currentOrder(store, "session-1", "/repo");

    const stale = store.acknowledge("session-1", {
      cwd: "/repo",
      catalogId: "catalog-old",
      throughCompletionOrder: Number.MAX_SAFE_INTEGER,
    });

    expect(stale.mutations).toEqual([]);
    expect(currentOrder(store, "session-1", "/repo")).toBe(current);
  });

  it("scopes lifecycle and acknowledgements to the canonical id and cwd pair", () => {
    const store = storeAt("2026-07-20T00:00:00.000Z", "catalog-a");
    complete(store, "session-1", "/repo-a");
    complete(store, "session-1", "/repo-b");

    const repoBOrder = currentOrder(store, "session-1", "/repo-b");
    store.acknowledge("session-1", {
      cwd: "/repo-b",
      catalogId: "catalog-a",
      throughCompletionOrder: repoBOrder,
    });

    expect(store.catalogSnapshot().sessions).toMatchObject([
      { sessionId: "session-1", cwd: "/repo-a", completionOrder: 1 },
    ]);
  });

  it("forgets a closing runtime's active latch without manufacturing a completion", () => {
    const store = storeAt("2026-07-20T00:00:00.000Z", "catalog-a");
    store.observeActivityState("session-1", "/repo", true);

    store.forgetActivity("session-1", "/repo");

    expect(store.observeActivityState("session-1", "/repo", false)).toEqual([]);
    expect(store.catalogSnapshot().sessions).toEqual([]);
  });

  it("persists replacement completion without an empty intermediate snapshot", async () => {
    const persistence = new BlockingPersistence({
      version: 1,
      catalogId: "catalog-a",
      catalogRevision: 1,
      nextCompletionOrder: 1,
      sessions: [{
        sessionId: "session-old",
        cwd: "/repo",
        completionOrder: 1,
        completedAt: "2026-07-20T00:00:00.000Z",
      }],
    });
    const store = persistedStore(persistence, "unused-catalog", "2026-07-20T00:01:00.000Z");
    await store.load();

    store.observeActivityState("session-new", "/repo", true);
    const mutations = store.completeSessionIdentityReplacement("session-old", "/repo", "session-new", "/repo");

    expect(mutations).toMatchObject([
      { event: { catalogRevision: 2, sessionId: "session-old", unread: null } },
      { event: { catalogRevision: 3, sessionId: "session-new", unread: { completionOrder: 2 } } },
    ]);
    expect(store.catalogSnapshot().sessions).toMatchObject([
      { sessionId: "session-new", cwd: "/repo", completionOrder: 2 },
    ]);
    expect(persistence.savedStates).toHaveLength(1);
    expect(persistence.savedStates[0]?.sessions).toMatchObject([
      { sessionId: "session-new", cwd: "/repo", completionOrder: 2 },
    ]);

    persistence.releaseNextSave();
    await store.flush();
  });

  it("excludes verified tracked sub-sessions and clears accidental lifecycle state", () => {
    const store = storeAt("2026-07-20T00:00:00.000Z", "catalog-a");
    store.observeActivityState("tracked", "/repo", true);

    expect(store.excludeSession("tracked", "/repo")).toEqual([]);
    expect(store.observeActivityState("tracked", "/repo", false)).toEqual([]);
    expect(store.observeActivityState("tracked", "/repo", true)).toEqual([]);
    expect(store.observeActivityState("tracked", "/repo", false)).toEqual([]);

    store.forgetSession("tracked", "/repo");
    complete(store, "tracked", "/repo");
    const removed = store.excludeSession("tracked", "/repo");

    expect(removed).toMatchObject([{
      event: { catalogId: "catalog-a", sessionId: "tracked", cwd: "/repo", unread: null },
    }]);
    expect(store.catalogSnapshot().sessions).toEqual([]);
  });

  it("removes durable and transient state when a cwd is reconciled", () => {
    const store = storeAt("2026-07-20T00:00:00.000Z", "catalog-a");
    complete(store, "keep", "/repo");
    complete(store, "remove", "/repo");
    store.observeActivityState("active-orphan", "/repo", true);
    store.excludeSession("excluded-orphan", "/repo");

    const mutations = store.reconcileCwd("/repo", ["keep"]);

    expect(mutations).toMatchObject([{ event: { sessionId: "remove", unread: null } }]);
    expect(store.catalogSnapshot().sessions.map((summary) => summary.sessionId)).toEqual(["keep"]);
    expect(store.observeActivityState("active-orphan", "/repo", false)).toEqual([]);
    complete(store, "excluded-orphan", "/repo");
    expect(currentOrder(store, "excluded-orphan", "/repo")).toBeGreaterThan(0);
  });

  it("bounds the catalog and emits an authoritative removal when pruning", () => {
    const store = storeAt("2026-07-20T00:00:00.000Z", "catalog-a");
    let finalMutations = store.observeActivityState("baseline", "/repo", false);
    for (let index = 0; index <= SESSION_UNREAD_LIMIT; index += 1) {
      const sessionId = `session-${index.toString()}`;
      store.observeActivityState(sessionId, "/repo", true);
      finalMutations = store.observeActivityState(sessionId, "/repo", false);
    }

    const snapshot = store.catalogSnapshot();
    expect(snapshot.sessions).toHaveLength(SESSION_UNREAD_LIMIT);
    expect(snapshot.sessions.some((summary) => summary.sessionId === "session-0")).toBe(false);
    expect(snapshot.sessions[0]).toMatchObject({ sessionId: `session-${SESSION_UNREAD_LIMIT.toString()}`, completionOrder: SESSION_UNREAD_LIMIT + 1 });
    expect(finalMutations).toMatchObject([
      { event: { unread: { sessionId: `session-${SESSION_UNREAD_LIMIT.toString()}` } } },
      { event: { sessionId: "session-0", unread: null } },
    ]);
  });

  it("persists the catalog epoch, revisions, and completion order across store instances", async () => {
    const persistence = new MemoryPersistence(undefined);
    const first = persistedStore(persistence, "catalog-a", "2026-07-20T00:00:00.000Z");
    await Promise.all([first.load(), first.load()]);
    expect(persistence.loadCalls).toBe(1);
    complete(first, "session-1", "/repo");
    await first.flush();

    const second = persistedStore(persistence, "unused-catalog-b", "2026-07-20T01:00:00.000Z");
    await second.load();
    expect(second.catalogSnapshot()).toEqual(first.catalogSnapshot());

    const order = currentOrder(second, "session-1", "/repo");
    second.acknowledge("session-1", {
      cwd: "/repo",
      catalogId: "catalog-a",
      throughCompletionOrder: order,
    });
    await second.flush();

    const third = persistedStore(persistence, "unused-catalog-c", "2026-07-20T02:00:00.000Z");
    await third.load();
    expect(third.catalogSnapshot()).toMatchObject({ catalogId: "catalog-a", catalogRevision: 2, sessions: [] });
    complete(third, "session-1", "/repo");
    expect(currentOrder(third, "session-1", "/repo")).toBe(2);
  });

  it("repairs malformed persistence with a fresh epoch and keeps stale old-epoch acks harmless", async () => {
    const errors: { operation: "load" | "save"; error: unknown }[] = [];
    const persistence = new MemoryPersistence({ version: 999, catalogId: "catalog-old" });
    const store = new SessionUnreadStore({
      persistence,
      createCatalogId: () => "catalog-reset",
      onPersistenceError: (operation, error) => { errors.push({ operation, error }); },
      now: () => new Date("2026-07-20T00:00:00.000Z"),
    });

    expect(() => store.catalogSnapshot()).toThrow("must be loaded");
    await store.load();
    expect(errors).toHaveLength(1);
    expect(errors[0]?.operation).toBe("load");
    expect(errors[0]?.error).toBeInstanceOf(Error);
    expect(store.catalogSnapshot()).toEqual({ catalogId: "catalog-reset", catalogRevision: 0, sessions: [] });
    expect(persistence.valueSnapshot()).toMatchObject({
      version: 1,
      catalogId: "catalog-reset",
      catalogRevision: 0,
      nextCompletionOrder: 0,
      sessions: [],
    });

    complete(store, "session-1", "/repo");
    expect(store.acknowledge("session-1", {
      cwd: "/repo",
      catalogId: "catalog-old",
      throughCompletionOrder: Number.MAX_SAFE_INTEGER,
    }).mutations).toEqual([]);
    expect(store.catalogSnapshot().sessions).toHaveLength(1);
  });

  it("resets persisted protocol fields that exceed shared bounds and rejects oversized runtime identities", async () => {
    const persistence = new MemoryPersistence({
      version: 1,
      catalogId: "catalog-old",
      catalogRevision: 1,
      nextCompletionOrder: 1,
      sessions: [{
        sessionId: "x".repeat(SESSION_UNREAD_SESSION_ID_MAX_LENGTH + 1),
        cwd: "/repo",
        completionOrder: 1,
        completedAt: "2026-07-20T00:00:00.000Z",
      }],
    });
    const errors: unknown[] = [];
    const store = new SessionUnreadStore({
      persistence,
      createCatalogId: () => "catalog-reset",
      onPersistenceError: (_operation, error) => { errors.push(error); },
    });

    await store.load();

    expect(errors).toHaveLength(1);
    expect(store.catalogSnapshot()).toEqual({ catalogId: "catalog-reset", catalogRevision: 0, sessions: [] });
    expect(() => store.observeActivityState(
      "x".repeat(SESSION_UNREAD_SESSION_ID_MAX_LENGTH + 1),
      "/repo",
      true,
    )).toThrow("sessionId exceeds its length limit");
  });

  it("rejects an oversized persisted catalog instead of loading unbounded state", async () => {
    const sessions = Array.from({ length: SESSION_UNREAD_LIMIT + 1 }, (_, index) => ({
      sessionId: `session-${index.toString()}`,
      cwd: "/repo",
      completionOrder: index + 1,
      completedAt: "2026-07-20T00:00:00.000Z",
    }));
    const persistence = new MemoryPersistence({
      version: 1,
      catalogId: "catalog-old",
      catalogRevision: sessions.length,
      nextCompletionOrder: sessions.length,
      sessions,
    });
    const errors: unknown[] = [];
    const store = new SessionUnreadStore({
      persistence,
      createCatalogId: () => "catalog-reset",
      onPersistenceError: (_operation, error) => { errors.push(error); },
    });

    await store.load();

    expect(errors).toHaveLength(1);
    expect(store.catalogSnapshot()).toEqual({ catalogId: "catalog-reset", catalogRevision: 0, sessions: [] });
  });

  it("serializes writes and captures each mutation's state", async () => {
    const persistence = new BlockingPersistence(emptyPersistedState("catalog-a"));
    const store = persistedStore(persistence, "unused-catalog", "2026-07-20T00:00:00.000Z");
    await store.load();
    complete(store, "session-1", "/repo");
    const order = currentOrder(store, "session-1", "/repo");
    store.acknowledge("session-1", {
      cwd: "/repo",
      catalogId: "catalog-a",
      throughCompletionOrder: order,
    });

    await vi.waitFor(() => { expect(persistence.savedStates).toHaveLength(1); });
    expect(persistence.maximumConcurrentSaves).toBe(1);
    expect(persistence.savedStates[0]?.sessions).toHaveLength(1);

    persistence.releaseNextSave();
    await vi.waitFor(() => { expect(persistence.savedStates).toHaveLength(2); });
    expect(persistence.maximumConcurrentSaves).toBe(1);
    expect(persistence.savedStates[1]?.sessions).toEqual([]);

    const flushed = store.flush();
    persistence.releaseNextSave();
    await flushed;
  });

  it("coalesces a mutation burst behind one in-flight persistence write", async () => {
    const persistence = new BlockingPersistence(emptyPersistedState("catalog-a"));
    const store = persistedStore(persistence, "unused-catalog", "2026-07-20T00:00:00.000Z");
    await store.load();

    complete(store, "session-0", "/repo");
    for (let index = 1; index <= 200; index += 1) complete(store, `session-${index.toString()}`, "/repo");

    await vi.waitFor(() => { expect(persistence.savedStates).toHaveLength(1); });
    expect(persistence.savedStates[0]).toMatchObject({ catalogRevision: 1, nextCompletionOrder: 1 });

    persistence.releaseNextSave();
    await vi.waitFor(() => { expect(persistence.savedStates).toHaveLength(2); });
    expect(persistence.savedStates[1]).toMatchObject({ catalogRevision: 201, nextCompletionOrder: 201 });

    persistence.releaseNextSave();
    await store.flush();
    expect(persistence.savedStates).toHaveLength(2);
  });

  it("holds one latest snapshot without retrying every mutation during a storage outage", async () => {
    const saveError = new Error("storage unavailable");
    const save = vi.fn<SessionUnreadPersistence["save"]>(() => Promise.reject(saveError));
    const store = persistedStore({
      load: () => Promise.resolve(emptyPersistedState("catalog-a")),
      save,
    }, "unused-catalog", "2026-07-20T00:00:00.000Z");
    await store.load();

    complete(store, "session-0", "/repo");
    await vi.waitFor(() => { expect(save).toHaveBeenCalledOnce(); });
    for (let index = 1; index <= 100; index += 1) complete(store, `session-${index.toString()}`, "/repo");
    await Promise.resolve();

    expect(save).toHaveBeenCalledOnce();
    await expect(store.flush()).rejects.toBe(saveError);
    expect(save).toHaveBeenCalledTimes(2);
  });

  it("retries the latest snapshot before exposing state after a transient save failure", async () => {
    const persistence = new FailOncePersistence(emptyPersistedState("catalog-a"));
    const errors: unknown[] = [];
    const store = new SessionUnreadStore({
      persistence,
      createCatalogId: () => "unused-catalog",
      now: () => new Date("2026-07-20T00:00:00.000Z"),
      onPersistenceError: (_operation, error) => { errors.push(error); },
    });
    await store.load();
    complete(store, "session-1", "/repo");

    const snapshot = await store.durableCatalogSnapshot();

    expect(errors).toHaveLength(1);
    expect(persistence.saveCalls).toBe(2);
    expect(persistence.valueSnapshot()).toMatchObject({
      catalogId: "catalog-a",
      catalogRevision: 1,
      nextCompletionOrder: 1,
      sessions: [{ sessionId: "session-1", completionOrder: 1 }],
    });
    expect(snapshot.sessions).toHaveLength(1);
  });

  it("rejects operational load failures without overwriting the unread file", async () => {
    const loadError = Object.assign(new Error("read failed"), { code: "EIO" });
    const save = vi.fn<SessionUnreadPersistence["save"]>(() => Promise.resolve());
    const errors: { operation: "load" | "save"; error: unknown }[] = [];
    const store = new SessionUnreadStore({
      persistence: { load: () => Promise.reject(loadError), save },
      createCatalogId: () => "catalog-reset",
      onPersistenceError: (operation, error) => { errors.push({ operation, error }); },
    });

    await expect(store.load()).rejects.toBe(loadError);

    expect(save).not.toHaveBeenCalled();
    expect(errors).toEqual([{ operation: "load", error: loadError }]);
    expect(() => store.catalogSnapshot()).toThrow("must be loaded");
  });

  it("rejects startup when a missing or corrupt catalog cannot persist its fresh epoch", async () => {
    const saveError = new Error("disk full");
    const errors: { operation: "load" | "save"; error: unknown }[] = [];
    const store = new SessionUnreadStore({
      persistence: {
        load: () => Promise.resolve(undefined),
        save: () => Promise.reject(saveError),
      },
      createCatalogId: () => "catalog-reset",
      onPersistenceError: (operation, error) => { errors.push({ operation, error }); },
    });

    await expect(store.load()).rejects.toBe(saveError);

    expect(errors).toEqual([{ operation: "save", error: saveError }]);
    expect(() => store.catalogSnapshot()).toThrow("must be loaded");
  });
});

describe("FileSessionUnreadPersistence", () => {
  it("repairs malformed JSON with a fresh persisted catalog epoch", async () => {
    const root = await temporaryRoot();
    const filePath = join(root, "session-unread.json");
    await writeFile(filePath, "{not-json", "utf8");
    const errors: unknown[] = [];
    const store = new SessionUnreadStore({
      persistence: new FileSessionUnreadPersistence(filePath),
      createCatalogId: () => "catalog-reset",
      onPersistenceError: (_operation, error) => { errors.push(error); },
    });

    await store.load();

    expect(errors).toHaveLength(1);
    expect(store.catalogSnapshot()).toEqual({ catalogId: "catalog-reset", catalogRevision: 0, sessions: [] });
    expect(JSON.parse(await readFile(filePath, "utf8"))).toMatchObject({ catalogId: "catalog-reset", sessions: [] });
  });

  it("uses PI_WEB_DATA_DIR and atomically reloads a private state file", async () => {
    const root = await temporaryRoot();
    expect(defaultSessionUnreadFilePath({ PI_WEB_DATA_DIR: "state" }, root)).toBe(join(root, "state", "session-unread.json"));
    const filePath = join(root, "state", "custom-unread.json");
    const persistence = new FileSessionUnreadPersistence(filePath);
    const store = new SessionUnreadStore({
      persistence,
      createCatalogId: () => "catalog-a",
      now: () => new Date("2026-07-20T00:00:00.000Z"),
    });
    await store.load();
    complete(store, "session-1", "/repo");
    await store.flush();

    const persisted: unknown = JSON.parse(await readFile(filePath, "utf8"));
    expect(persisted).toMatchObject({
      version: 1,
      catalogId: "catalog-a",
      catalogRevision: 1,
      nextCompletionOrder: 1,
      sessions: [{ sessionId: "session-1", cwd: "/repo", completionOrder: 1 }],
    });
    if (process.platform !== "win32") {
      expect((await stat(filePath)).mode & 0o777).toBe(0o600);
    }
    expect((await readdir(join(root, "state"))).filter((name) => name.endsWith(".tmp"))).toEqual([]);

    const reloaded = new SessionUnreadStore({ persistence, createCatalogId: () => "unused-catalog" });
    await reloaded.load();
    expect(reloaded.catalogSnapshot()).toMatchObject({
      catalogId: "catalog-a",
      sessions: [{ sessionId: "session-1", completionOrder: 1 }],
    });
  });
});

function storeAt(iso: string, catalogId: string): SessionUnreadStore {
  return new SessionUnreadStore({ now: () => new Date(iso), createCatalogId: () => catalogId });
}

function persistedStore(
  persistence: SessionUnreadPersistence,
  catalogId: string,
  iso: string,
): SessionUnreadStore {
  return new SessionUnreadStore({
    persistence,
    createCatalogId: () => catalogId,
    now: () => new Date(iso),
  });
}

function complete(store: SessionUnreadStore, sessionId: string, cwd: string): void {
  store.observeActivityState(sessionId, cwd, true);
  store.observeActivityState(sessionId, cwd, false);
}

function currentOrder(store: SessionUnreadStore, sessionId: string, cwd: string): number {
  return store.catalogSnapshot().sessions.find((summary) => summary.sessionId === sessionId && summary.cwd === cwd)?.completionOrder ?? 0;
}

function emptyPersistedState(catalogId: string): SessionUnreadPersistedState {
  return {
    version: 1,
    catalogId,
    catalogRevision: 0,
    nextCompletionOrder: 0,
    sessions: [],
  };
}

class MemoryPersistence implements SessionUnreadPersistence {
  loadCalls = 0;

  constructor(private value: unknown) {}

  load(): Promise<unknown> {
    this.loadCalls += 1;
    return Promise.resolve(structuredClone(this.value));
  }

  save(state: SessionUnreadPersistedState): Promise<void> {
    this.value = structuredClone(state);
    return Promise.resolve();
  }

  valueSnapshot(): unknown {
    return structuredClone(this.value);
  }
}

class FailOncePersistence implements SessionUnreadPersistence {
  saveCalls = 0;
  private value: SessionUnreadPersistedState;

  constructor(initial: SessionUnreadPersistedState) {
    this.value = structuredClone(initial);
  }

  load(): Promise<unknown> {
    return Promise.resolve(structuredClone(this.value));
  }

  save(state: SessionUnreadPersistedState): Promise<void> {
    this.saveCalls += 1;
    if (this.saveCalls === 1) return Promise.reject(new Error("transient save failure"));
    this.value = structuredClone(state);
    return Promise.resolve();
  }

  valueSnapshot(): unknown {
    return structuredClone(this.value);
  }
}

class BlockingPersistence implements SessionUnreadPersistence {
  readonly savedStates: SessionUnreadPersistedState[] = [];
  maximumConcurrentSaves = 0;
  private concurrentSaves = 0;
  private readonly releases: (() => void)[] = [];

  constructor(private readonly initial: SessionUnreadPersistedState) {}

  load(): Promise<unknown> {
    return Promise.resolve(structuredClone(this.initial));
  }

  save(state: SessionUnreadPersistedState): Promise<void> {
    this.concurrentSaves += 1;
    this.maximumConcurrentSaves = Math.max(this.maximumConcurrentSaves, this.concurrentSaves);
    this.savedStates.push(structuredClone(state));
    return new Promise<void>((resolve) => {
      this.releases.push(() => {
        this.concurrentSaves -= 1;
        resolve();
      });
    });
  }

  releaseNextSave(): void {
    const release = this.releases.shift();
    if (release === undefined) throw new Error("No blocked persistence save to release");
    release();
  }
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-web-unread-"));
  roots.push(root);
  return root;
}
