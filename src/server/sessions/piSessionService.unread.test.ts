import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PiSessionService, type PiAgentSession } from "./piSessionService.js";
import {
  CapturingSessionEventHub,
  emptyArchiveStore,
  fakeRuntime,
  fakeSessionManager,
  resolveSessionFileFromList,
  runtimeCreator,
  sessionGateway,
  sessionRecord,
  sessionRef,
  testModelRuntime,
  type RuntimeCreator,
} from "./piSessionService.testSupport.js";
import {
  SessionUnreadStore,
  type SessionUnreadPersistedState,
  type SessionUnreadPersistence,
} from "./sessionUnreadStore.js";

const TEST_AGENT_DIR = "/tmp/pi-web-test-agent";
// Unread identities are persisted after platform-native cwd canonicalization.
const WORKSPACE_CWD = resolve("/workspace");
const FEATURE_CWD = resolve("/workspace-feature");
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("PiSessionService daemon-owned unread state", () => {
  it("records one durable completion and keeps stale acknowledgements from clearing newer work", async () => {
    const unreadStore = new SessionUnreadStore({ createCatalogId: () => "catalog-test" });
    const hub = new CapturingSessionEventHub();
    const fake = fakeRuntime("session-1");
    const service = new PiSessionService(hub, {
      agentDir: TEST_AGENT_DIR,
      modelRuntime: testModelRuntime,
      createAgentRuntime: runtimeCreator(fake.runtime),
      sessionManager: sessionGateway([sessionRecord("session-1")]),
      archiveStore: emptyArchiveStore(),
      heartbeatIntervalMs: 60_000,
      unreadStore,
    });

    try {
      await service.status(sessionRef("session-1"));
      completeRuntimeWork(fake);
      completeRuntimeWork(fake);

      const secondSnapshot = await service.unreadCatalog();
      const current = secondSnapshot.sessions[0];
      expect(current).toMatchObject({ sessionId: "session-1", cwd: WORKSPACE_CWD, completionOrder: 2 });
      expect(unreadEvents(hub).map((event) => event.catalogRevision)).toEqual([1, 2]);

      const staleSnapshot = await service.acknowledgeUnread("session-1", {
        cwd: WORKSPACE_CWD,
        catalogId: "catalog-test",
        throughCompletionOrder: 1,
      });
      expect(staleSnapshot.sessions).toEqual(secondSnapshot.sessions);
      expect(unreadEvents(hub).map((event) => event.catalogRevision)).toEqual([1, 2]);

      const acknowledged = await service.acknowledgeUnread("session-1", {
        cwd: WORKSPACE_CWD,
        catalogId: "catalog-test",
        throughCompletionOrder: current?.completionOrder ?? 0,
      });
      expect(acknowledged.sessions).toEqual([]);
      expect(unreadEvents(hub).at(-1)).toMatchObject({ catalogRevision: 3, sessionId: "session-1", unread: null });
    } finally {
      await service.dispose();
    }
  });

  it("tracks service-owned activity even while runtime status flags look idle", async () => {
    const unreadStore = new SessionUnreadStore({ createCatalogId: () => "catalog-test" });
    const fake = fakeRuntime("session-1");
    let finishBash: (() => void) | undefined;
    fake.session.executeBash = () => new Promise((resolve) => {
      finishBash = () => { resolve({ output: "done", exitCode: 0, cancelled: false, truncated: false }); };
    });
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: TEST_AGENT_DIR,
      modelRuntime: testModelRuntime,
      createAgentRuntime: runtimeCreator(fake.runtime),
      sessionManager: sessionGateway([sessionRecord("session-1")]),
      archiveStore: emptyArchiveStore(),
      heartbeatIntervalMs: 60_000,
      unreadStore,
    });

    try {
      await service.status(sessionRef("session-1"));
      await service.shell(sessionRef("session-1"), "!echo done");
      expect(fake.session.isStreaming).toBe(false);
      expect(fake.session.isBashRunning).toBe(false);
      expect((await service.unreadCatalog()).sessions).toEqual([]);

      finishBash?.();
      await Promise.resolve();

      expect((await service.unreadCatalog()).sessions).toMatchObject([{ sessionId: "session-1", cwd: WORKSPACE_CWD, completionOrder: 1 }]);
    } finally {
      await service.dispose();
    }
  });

  it("publishes completion revisions in order only after their captured state is durable", async () => {
    const persistence = new BlockingUnreadPersistence();
    const unreadStore = new SessionUnreadStore({ persistence, createCatalogId: () => "catalog-test" });
    await unreadStore.load();
    const hub = new CapturingSessionEventHub();
    const fake = fakeRuntime("session-1");
    const service = new PiSessionService(hub, {
      agentDir: TEST_AGENT_DIR,
      modelRuntime: testModelRuntime,
      createAgentRuntime: runtimeCreator(fake.runtime),
      sessionManager: sessionGateway([sessionRecord("session-1")]),
      archiveStore: emptyArchiveStore(),
      heartbeatIntervalMs: 60_000,
      unreadStore,
    });

    try {
      await service.status(sessionRef("session-1"));
      const blockedSave = persistence.blockNextSave();
      completeRuntimeWork(fake);
      completeRuntimeWork(fake);
      await Promise.resolve();

      expect(unreadEvents(hub)).toEqual([]);

      blockedSave.resolve();
      const snapshot = await service.unreadCatalog();

      expect(snapshot.sessions).toMatchObject([{ sessionId: "session-1", completionOrder: 2 }]);
      expect(unreadEvents(hub).map((event) => event.catalogRevision)).toEqual([1, 2]);
      expect(persistence.savedStates.at(-1)).toMatchObject({ catalogRevision: 2, nextCompletionOrder: 2 });
    } finally {
      await service.dispose();
    }
  });

  it("does not publish a mutation queued after the current batch became durable", async () => {
    const persistence = new BlockingUnreadPersistence();
    const unreadStore = new SessionUnreadStore({ persistence, createCatalogId: () => "catalog-test" });
    await unreadStore.load();
    const hub = new CapturingSessionEventHub();
    const fake = fakeRuntime("session-1");
    const service = new PiSessionService(hub, {
      agentDir: TEST_AGENT_DIR,
      modelRuntime: testModelRuntime,
      createAgentRuntime: runtimeCreator(fake.runtime),
      sessionManager: sessionGateway([sessionRecord("session-1")]),
      archiveStore: emptyArchiveStore(),
      heartbeatIntervalMs: 60_000,
      unreadStore,
    });
    const flush = unreadStore.flush.bind(unreadStore);
    let blockedSecondSave: Deferred | undefined;
    let injectedSecondCompletion = false;
    vi.spyOn(unreadStore, "flush").mockImplementation(async () => {
      await flush();
      if (injectedSecondCompletion) return;
      injectedSecondCompletion = true;
      blockedSecondSave = persistence.blockNextSave();
      completeRuntimeWork(fake);
    });

    try {
      await service.status(sessionRef("session-1"));
      completeRuntimeWork(fake);
      await drainMicrotasks();

      expect(persistence.savedStates.at(-1)).toMatchObject({ catalogRevision: 1, nextCompletionOrder: 1 });
      expect(unreadEvents(hub).map((event) => event.catalogRevision)).toEqual([1]);

      if (blockedSecondSave === undefined) throw new Error("Expected the second unread save to be blocked");
      blockedSecondSave.resolve();
      await service.unreadCatalog();

      expect(persistence.savedStates.at(-1)).toMatchObject({ catalogRevision: 2, nextCompletionOrder: 2 });
      expect(unreadEvents(hub).map((event) => event.catalogRevision)).toEqual([1, 2]);
    } finally {
      await service.dispose();
    }
  });

  it("retries failed durable publication without waiting for another client request", async () => {
    vi.useFakeTimers();
    const persistence = new RecoveringUnreadPersistence(2);
    const unreadStore = new SessionUnreadStore({ persistence, createCatalogId: () => "unused-catalog" });
    await unreadStore.load();
    const hub = new CapturingSessionEventHub();
    const fake = fakeRuntime("session-1");
    const service = new PiSessionService(hub, {
      agentDir: TEST_AGENT_DIR,
      modelRuntime: testModelRuntime,
      createAgentRuntime: runtimeCreator(fake.runtime),
      sessionManager: sessionGateway([sessionRecord("session-1")]),
      archiveStore: emptyArchiveStore(),
      heartbeatIntervalMs: 60_000,
      unreadStore,
      unreadPublicationRetryDelayMs: 100,
    });

    try {
      await service.status(sessionRef("session-1"));
      completeRuntimeWork(fake);
      await drainMicrotasks();

      expect(persistence.saveCalls).toBe(2);
      expect(unreadEvents(hub)).toEqual([]);

      await vi.advanceTimersByTimeAsync(100);
      await drainMicrotasks();

      expect(persistence.saveCalls).toBe(3);
      expect(persistence.persistedState()).toMatchObject({ catalogRevision: 1, nextCompletionOrder: 1 });
      expect(unreadEvents(hub)).toMatchObject([{ catalogRevision: 1, sessionId: "session-1" }]);
    } finally {
      try {
        await service.dispose();
      } finally {
        vi.useRealTimers();
      }
    }
  });

  it("forgets a closing runtime latch without manufacturing a stop completion and preserves unread across reload work", async () => {
    const unreadStore = new SessionUnreadStore({ createCatalogId: () => "catalog-test" });
    const hub = new CapturingSessionEventHub();
    const runtimes = [fakeRuntime("session-1"), fakeRuntime("session-1"), fakeRuntime("session-1")];
    let runtimeIndex = 0;
    const createAgentRuntime: RuntimeCreator = () => {
      const next = runtimes[runtimeIndex++];
      if (next === undefined) throw new Error("Unexpected extra runtime creation");
      return Promise.resolve(next.runtime);
    };
    const service = new PiSessionService(hub, {
      agentDir: TEST_AGENT_DIR,
      modelRuntime: testModelRuntime,
      createAgentRuntime,
      sessionManager: sessionGateway([sessionRecord("session-1")]),
      archiveStore: emptyArchiveStore(),
      heartbeatIntervalMs: 60_000,
      unreadStore,
    });

    try {
      await service.status(sessionRef("session-1"));
      const initial = runtimes[0];
      if (initial === undefined) throw new Error("Expected an initial runtime");
      initial.session.isStreaming = true;
      initial.emit({ type: "agent_start" });
      await service.stop(sessionRef("session-1"));
      initial.session.isStreaming = false;
      expect((await service.unreadCatalog()).sessions).toEqual([]);

      completeStoreWork(unreadStore, "session-1", WORKSPACE_CWD);
      const beforeReload = (await service.unreadCatalog()).sessions[0];
      await service.reload(sessionRef("session-1"));
      const afterReload = (await service.unreadCatalog()).sessions[0];

      expect(beforeReload).toBeDefined();
      expect(afterReload).toMatchObject({ sessionId: "session-1", cwd: WORKSPACE_CWD });
      expect(afterReload?.completionOrder).toBeGreaterThan(beforeReload?.completionOrder ?? 0);
    } finally {
      await service.dispose();
    }
  });

  it("clears stale unread when a runtime rebind changes logical session identity", async () => {
    const unreadStore = new SessionUnreadStore({ createCatalogId: () => "catalog-test" });
    completeStoreWork(unreadStore, "session-old", WORKSPACE_CWD);
    const original = fakeRuntime("session-old");
    let rebindSession: ((session: PiAgentSession) => Promise<void>) | undefined;
    original.runtime.setRebindSession = (callback) => { rebindSession = callback; };
    const replacement = fakeRuntime("session-new");
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: TEST_AGENT_DIR,
      modelRuntime: testModelRuntime,
      createAgentRuntime: runtimeCreator(original.runtime),
      sessionManager: sessionGateway([sessionRecord("session-old")]),
      archiveStore: emptyArchiveStore(),
      heartbeatIntervalMs: 60_000,
      unreadStore,
    });

    try {
      await service.status(sessionRef("session-old"));
      if (rebindSession === undefined) throw new Error("Expected runtime rebind callback");
      await rebindSession(replacement.session);

      expect((await service.unreadCatalog()).sessions).toEqual([]);
    } finally {
      await service.dispose();
    }
  });

  it("cleans unread state through archive, restore, delete, and cwd reconciliation", async () => {
    const unreadStore = new SessionUnreadStore({ createCatalogId: () => "catalog-test" });
    for (const sessionId of ["archive-me", "restore-me", "delete-me", "orphan"]) {
      completeStoreWork(unreadStore, sessionId, WORKSPACE_CWD);
    }
    const archived = new Map([
      ["restore-me", { sessionId: "restore-me", cwd: "/workspace", archivedAt: "2026-07-01T00:00:00.000Z", archivePath: "/archive/restore-me.jsonl" }],
      ["delete-me", { sessionId: "delete-me", cwd: "/workspace", archivedAt: "2026-07-01T00:00:00.000Z", archivePath: "/archive/delete-me.jsonl" }],
    ]);
    const fake = fakeRuntime("archive-me");
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: TEST_AGENT_DIR,
      modelRuntime: testModelRuntime,
      createAgentRuntime: runtimeCreator(fake.runtime),
      sessionManager: sessionGateway([sessionRecord("archive-me")]),
      archiveStore: {
        list: () => Promise.resolve([...archived.values()]),
        get: (sessionId) => Promise.resolve([...archived.values()].find((record) => record.sessionId.startsWith(sessionId))),
        archive: (input) => {
          const record = { sessionId: input.sessionId, cwd: input.cwd, archivedAt: "2026-07-20T00:00:00.000Z", archivePath: `/archive/${input.sessionId}.jsonl` };
          archived.set(input.sessionId, record);
          return Promise.resolve(record);
        },
        restore: (sessionId) => { archived.delete(sessionId); return Promise.resolve(); },
        deleteArchived: (sessionId) => { archived.delete(sessionId); return Promise.resolve(); },
        isArchived: (sessionId) => Promise.resolve(archived.has(sessionId)),
      },
      heartbeatIntervalMs: 60_000,
      unreadStore,
    });

    try {
      await service.status(sessionRef("archive-me"));
      await service.archive(sessionRef("archive-me"));
      expect((await service.unreadCatalog()).sessions.map((summary) => summary.sessionId)).toEqual([
        "orphan",
        "delete-me",
        "restore-me",
      ]);

      await service.restore(sessionRef("restore-me"));
      expect((await service.unreadCatalog()).sessions.map((summary) => summary.sessionId)).toEqual([
        "orphan",
        "delete-me",
      ]);

      await service.deleteArchivedMany([{ id: "delete-me", cwd: "/workspace" }]);
      expect((await service.unreadCatalog()).sessions.map((summary) => summary.sessionId)).toEqual(["orphan"]);

      await service.list(WORKSPACE_CWD);
      expect((await service.unreadCatalog()).sessions).toEqual([]);
    } finally {
      await service.dispose();
    }
  });

  it("excludes live tracked sub-sessions, then restores ordinary tracking after detach", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-web-unread-live-subsessions-"));
    tempRoots.push(root);
    const parentFile = join(root, "parent.jsonl");
    const childFile = join(root, "child.jsonl");
    await writeFile(childFile, `${JSON.stringify({ type: "session", version: 3, id: "child-1", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/workspace-feature", parentSession: parentFile })}\n`, "utf8");
    const unreadStore = new SessionUnreadStore({ createCatalogId: () => "catalog-test" });
    const hub = new CapturingSessionEventHub();
    const parent = fakeRuntime("parent-1", { sessionFile: parentFile });
    const child = fakeRuntime("child-1", {
      sessionFile: childFile,
      sessionManager: fakeSessionManager("/workspace-feature"),
    });
    child.session.prompt = () => {
      completeRuntimeWork(child);
      return Promise.resolve();
    };
    const runtimes = [parent.runtime, child.runtime];
    let runtimeIndex = 0;
    const createAgentRuntime: RuntimeCreator = () => Promise.resolve(runtimes[runtimeIndex++] ?? child.runtime);
    const service = new PiSessionService(hub, {
      agentDir: TEST_AGENT_DIR,
      modelRuntime: testModelRuntime,
      createAgentRuntime,
      sessionManager: sessionGateway([]),
      archiveStore: emptyArchiveStore(),
      spawnTargets: { resolveSpawnTarget: () => Promise.resolve({ allowed: true, cwd: "/workspace-feature" }) },
      heartbeatIntervalMs: 60_000,
      unreadStore,
    });

    try {
      await service.start("/workspace");
      await service.spawnSubsession({
        spawningCwd: "/workspace",
        parentSessionId: "parent-1",
        parentSessionFile: parentFile,
        prompt: "do the slice",
      });
      completeRuntimeWork(child);

      expect((await service.unreadCatalog()).sessions.some((summary) => summary.sessionId === "child-1")).toBe(false);
      expect(unreadEvents(hub).some((event) => event.sessionId === "child-1" && event.unread !== null)).toBe(false);

      await service.detachParent(sessionRef("child-1", "/workspace-feature"));
      completeRuntimeWork(child);
      expect((await service.unreadCatalog()).sessions).toContainEqual(expect.objectContaining({
        sessionId: "child-1",
        cwd: FEATURE_CWD,
      }));
    } finally {
      await service.dispose();
    }
  });

  it("clears accidental unread when a reciprocal persisted tracked link is verified after restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-web-unread-subsessions-"));
    tempRoots.push(root);
    const parentFile = join(root, "parent.jsonl");
    const childFile = join(root, "child.jsonl");
    await writeFile(parentFile, `${JSON.stringify({ type: "session", version: 3, id: "parent-1", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/workspace" })}\n`, "utf8");
    await writeFile(childFile, `${JSON.stringify({ type: "session", version: 3, id: "child-1", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/workspace-feature", parentSession: parentFile })}\n`, "utf8");

    const unreadStore = new SessionUnreadStore({ createCatalogId: () => "catalog-test" });
    completeStoreWork(unreadStore, "child-1", FEATURE_CWD);
    const hub = new CapturingSessionEventHub();
    const parentManager = fakeSessionManager("/workspace", {
      getEntries: () => [{
        type: "custom",
        customType: "pi-web.subsession.link",
        data: { version: 1, spawnedBySessionId: "parent-1", spawnedSessionId: "child-1", spawnedSessionFile: childFile, cwd: "/workspace-feature" },
      }],
    });
    const parent = fakeRuntime("parent-1", { sessionFile: parentFile, sessionManager: parentManager });
    const service = new PiSessionService(hub, {
      agentDir: TEST_AGENT_DIR,
      modelRuntime: testModelRuntime,
      createAgentRuntime: runtimeCreator(parent.runtime),
      sessionManager: {
        create: () => parentManager,
        list: () => Promise.resolve([]),
        listAll: () => Promise.resolve([]),
        invalidateSessionFile: () => undefined,
        resolveSessionFile: () => Promise.resolve(undefined),
        open: () => fakeSessionManager("/workspace-feature"),
      },
      archiveStore: emptyArchiveStore(),
      heartbeatIntervalMs: 60_000,
      unreadStore,
    });

    try {
      await service.start("/workspace");
      await expect(service.listSubsessions("parent-1", parentFile)).resolves.toEqual([
        { sessionId: "child-1", cwd: "/workspace-feature", status: "idle" },
      ]);

      expect((await service.unreadCatalog()).sessions).toEqual([]);
      expect(unreadEvents(hub).at(-1)).toMatchObject({ sessionId: "child-1", cwd: FEATURE_CWD, unread: null });
    } finally {
      await service.dispose();
    }
  });

  it("retries tracked-child hydration after a linked child is temporarily unavailable", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-web-unread-subsessions-retry-"));
    tempRoots.push(root);
    const parentFile = join(root, "parent.jsonl");
    const childFile = join(root, "child.jsonl");
    await writeFile(parentFile, `${JSON.stringify({ type: "session", version: 3, id: "parent-1", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/workspace" })}\n`, "utf8");

    const unreadStore = new SessionUnreadStore({ createCatalogId: () => "catalog-test" });
    completeStoreWork(unreadStore, "child-1", FEATURE_CWD);
    const parentManager = fakeSessionManager("/workspace", {
      getEntries: () => [{
        type: "custom",
        customType: "pi-web.subsession.link",
        data: { version: 1, spawnedBySessionId: "parent-1", spawnedSessionId: "child-1", spawnedSessionFile: childFile, cwd: "/workspace-feature" },
      }],
    });
    const parent = fakeRuntime("parent-1", { sessionFile: parentFile, sessionManager: parentManager });
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: TEST_AGENT_DIR,
      modelRuntime: testModelRuntime,
      createAgentRuntime: runtimeCreator(parent.runtime),
      sessionManager: {
        create: () => parentManager,
        list: () => Promise.resolve([]),
        listAll: () => Promise.resolve([]),
        invalidateSessionFile: () => undefined,
        resolveSessionFile: () => Promise.resolve(undefined),
        open: () => fakeSessionManager("/workspace-feature"),
      },
      archiveStore: emptyArchiveStore(),
      heartbeatIntervalMs: 60_000,
      unreadStore,
    });

    try {
      await service.start("/workspace");
      await expect(service.listSubsessions("parent-1", parentFile)).resolves.toEqual([]);

      await writeFile(childFile, `${JSON.stringify({ type: "session", version: 3, id: "child-1", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/workspace-feature", parentSession: parentFile })}\n`, "utf8");
      await expect(service.listSubsessions("parent-1", parentFile)).resolves.toEqual([
        { sessionId: "child-1", cwd: "/workspace-feature", status: "idle" },
      ]);
      expect((await service.unreadCatalog()).sessions).toEqual([]);
    } finally {
      await service.dispose();
    }
  });

  it("does not re-exclude a detached child from persisted markers after restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-web-unread-detached-subsessions-"));
    tempRoots.push(root);
    const parentFile = join(root, "parent.jsonl");
    const childFile = join(root, "child.jsonl");
    await writeFile(parentFile, `${JSON.stringify({ type: "session", version: 3, id: "parent-1", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/workspace" })}\n`, "utf8");
    await writeFile(childFile, `${JSON.stringify({ type: "session", version: 3, id: "child-1", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/workspace-feature" })}\n`, "utf8");

    const parentManager = fakeSessionManager("/workspace", {
      getSessionId: () => "parent-1",
      getSessionFile: () => parentFile,
      getEntries: () => [{
        type: "custom",
        customType: "pi-web.subsession.link",
        data: { version: 1, spawnedBySessionId: "parent-1", spawnedSessionId: "child-1", spawnedSessionFile: childFile, cwd: "/workspace-feature" },
      }],
    });
    const childManager = fakeSessionManager("/workspace-feature", {
      getSessionId: () => "child-1",
      getSessionFile: () => childFile,
      getEntries: () => [{
        type: "custom",
        customType: "pi-web.subsession.spawned",
        data: { version: 1, spawnedBySessionId: "parent-1", spawnedSessionId: "child-1" },
      }],
    });
    const childRecord = { ...sessionRecord("child-1", "/workspace-feature"), path: childFile };
    const child = fakeRuntime("child-1", { sessionFile: childFile, sessionManager: childManager });
    const unreadStore = new SessionUnreadStore({ createCatalogId: () => "catalog-test" });
    completeStoreWork(unreadStore, "child-1", "/workspace-feature");
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: TEST_AGENT_DIR,
      modelRuntime: testModelRuntime,
      createAgentRuntime: runtimeCreator(child.runtime),
      sessionManager: {
        create: () => childManager,
        list: () => Promise.resolve([childRecord]),
        listAll: () => Promise.resolve([childRecord]),
        invalidateSessionFile: () => undefined,
        resolveSessionFile: resolveSessionFileFromList(() => Promise.resolve([childRecord])),
        open: (path) => path === parentFile ? parentManager : childManager,
      },
      archiveStore: emptyArchiveStore(),
      heartbeatIntervalMs: 60_000,
      unreadStore,
    });

    try {
      await service.status(sessionRef("child-1", "/workspace-feature"));
      await expect(service.listSubsessions("parent-1", parentFile)).resolves.toEqual([]);
      expect((await service.unreadCatalog()).sessions).toMatchObject([
        { sessionId: "child-1", cwd: "/workspace-feature" },
      ]);
    } finally {
      await service.dispose();
    }
  });

  it("does not exclude a generic parentSessionPath descendant without verified tracked markers", async () => {
    const unreadStore = new SessionUnreadStore({ createCatalogId: () => "catalog-test" });
    completeStoreWork(unreadStore, "branch-1", "/workspace");
    const branch = fakeRuntime("branch-1", {
      sessionFile: "/tmp/branch-1.jsonl",
      sessionManager: fakeSessionManager("/workspace", { getBranch: () => [] }),
    });
    const genericDescendant = { ...sessionRecord("branch-1"), parentSessionPath: "/tmp/parent.jsonl" };
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: TEST_AGENT_DIR,
      modelRuntime: testModelRuntime,
      createAgentRuntime: runtimeCreator(branch.runtime),
      sessionManager: sessionGateway([genericDescendant]),
      archiveStore: emptyArchiveStore(),
      heartbeatIntervalMs: 60_000,
      unreadStore,
    });

    try {
      await service.status(sessionRef("branch-1"));
      expect((await service.unreadCatalog()).sessions).toMatchObject([{ sessionId: "branch-1", cwd: "/workspace" }]);
    } finally {
      await service.dispose();
    }
  });

  it("clears unread on bulk archive for listed, active, and already-archived sessions while busy failures keep unread", async () => {
    const unreadStore = new SessionUnreadStore({ createCatalogId: () => "catalog-test" });
    for (const sessionId of ["listed-idle", "active-idle", "busy", "already-archived"]) {
      completeStoreWork(unreadStore, sessionId, WORKSPACE_CWD);
    }
    const archivedRecord = { sessionId: "already-archived", cwd: "/workspace", archivedAt: "2026-01-02T00:00:00.000Z", archivePath: "/archive/already-archived.jsonl" };
    const activeIdle = fakeRuntime("active-idle");
    const busy = fakeRuntime("busy", { isStreaming: true });
    const runtimes = new Map([["active-idle", activeIdle.runtime], ["busy", busy.runtime]]);
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: TEST_AGENT_DIR,
      modelRuntime: testModelRuntime,
      createAgentRuntime: (_createRuntime, options) => {
        const runtime = runtimes.get(options.sessionManager.getSessionId());
        if (runtime === undefined) throw new Error("Unexpected runtime creation");
        return Promise.resolve(runtime);
      },
      sessionManager: {
        create: () => fakeSessionManager(),
        list: () => Promise.resolve([sessionRecord("listed-idle"), sessionRecord("active-idle"), sessionRecord("busy")]),
        listAll: () => Promise.resolve([]),
        invalidateSessionFile: () => undefined,
        resolveSessionFile: resolveSessionFileFromList(() => Promise.resolve([sessionRecord("listed-idle"), sessionRecord("active-idle"), sessionRecord("busy")])),
        open: (path) => fakeSessionManager("/workspace", { getSessionId: () => path.replace(/^\/sessions\/|\.jsonl$/g, "") }),
      },
      archiveStore: {
        list: () => Promise.resolve([archivedRecord]),
        get: (sessionId) => Promise.resolve(sessionId === "already-archived" ? archivedRecord : undefined),
        archive: () => Promise.reject(new Error("bulk archive should use archiveMany")),
        archiveMany: (inputs: readonly { sessionId: string; cwd: string }[]) => Promise.resolve(inputs.map((input) => ({ sessionId: input.sessionId, cwd: input.cwd, archivedAt: "2026-01-03T00:00:00.000Z" }))),
        restore: () => Promise.resolve(),
        isArchived: (sessionId) => Promise.resolve(sessionId === "already-archived"),
      },
      heartbeatIntervalMs: 60_000,
      unreadStore,
    });

    try {
      await service.status(sessionRef("active-idle"));
      await service.status(sessionRef("busy"));
      const result = await service.archiveMany([
        { id: "already-archived", cwd: "/workspace" },
        { id: "listed-idle", cwd: "/workspace" },
        { id: "active-idle", cwd: "/workspace" },
        { id: "busy", cwd: "/workspace" },
      ]);

      expect(result.archivedSessionIds).toEqual(["already-archived", "listed-idle", "active-idle"]);
      expect(result.failures).toEqual([{ sessionId: "busy", error: "Stop current session activity before archiving" }]);
      expect(activeIdle.calls.dispose).toBe(1);
      expect(busy.calls.abort).toBe(0);
      expect((await service.unreadCatalog()).sessions).toMatchObject([{ sessionId: "busy", cwd: WORKSPACE_CWD }]);
    } finally {
      await service.dispose();
    }
  });

  it("clears unread for the whole subtree when archiving with descendants", async () => {
    const unreadStore = new SessionUnreadStore({ createCatalogId: () => "catalog-test" });
    for (const sessionId of ["root", "direct-child", "archived-child", "grandchild"]) {
      completeStoreWork(unreadStore, sessionId, WORKSPACE_CWD);
    }
    const root = sessionRecord("root");
    const directChild = { ...sessionRecord("direct-child"), parentSessionPath: root.path };
    const archivedChild = { ...sessionRecord("archived-child"), parentSessionPath: root.path };
    const grandchild = { ...sessionRecord("grandchild"), parentSessionPath: archivedChild.path };
    const archivedChildRecord = {
      sessionId: "archived-child",
      cwd: "/workspace",
      archivedAt: "2026-01-02T00:00:00.000Z",
      originalPath: archivedChild.path,
      archivePath: "/archive/archived-child.jsonl",
      parentSessionPath: root.path,
    };
    const fake = fakeRuntime("root", { sessionFile: root.path });
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: TEST_AGENT_DIR,
      modelRuntime: testModelRuntime,
      createAgentRuntime: runtimeCreator(fake.runtime),
      sessionManager: {
        create: () => fakeSessionManager(),
        list: () => Promise.resolve([root, directChild, archivedChild, grandchild]),
        listAll: () => Promise.resolve([]),
        invalidateSessionFile: () => undefined,
        resolveSessionFile: resolveSessionFileFromList(() => Promise.resolve([root, directChild, archivedChild, grandchild])),
        open: () => fakeSessionManager(),
      },
      archiveStore: {
        list: () => Promise.resolve([archivedChildRecord]),
        get: () => Promise.resolve(undefined),
        archive: (input: { sessionId: string; cwd: string }) => Promise.resolve({ sessionId: input.sessionId, cwd: input.cwd, archivedAt: "2026-01-03T00:00:00.000Z" }),
        restore: () => Promise.resolve(),
        isArchived: () => Promise.resolve(false),
      },
      heartbeatIntervalMs: 60_000,
      unreadStore,
    });

    try {
      const result = await service.archiveTree(sessionRef("root"));

      expect(result.sessionIds).toEqual(["root", "direct-child", "grandchild"]);
      expect(result.skippedAlreadyArchivedCount).toBe(1);
      expect((await service.unreadCatalog()).sessions).toEqual([]);
    } finally {
      await service.dispose();
    }
  });

  it("clears unread for sessions archived and deleted by cleanup", async () => {
    const unreadStore = new SessionUnreadStore({ createCatalogId: () => "catalog-test" });
    // Resolved because the service canonicalizes cwds before forgetting unread:
    // a bare "/old-project" is drive-relative on Windows and would land on the
    // runner's current drive, so the seeded marker would never match.
    const oldProjectCwd = resolve("/old-project");
    completeStoreWork(unreadStore, "cleanup-archive", oldProjectCwd);
    completeStoreWork(unreadStore, "cleanup-delete", oldProjectCwd);
    const archivedRecord = { sessionId: "cleanup-delete", cwd: oldProjectCwd, archivedAt: "2026-04-01T00:00:00.000Z", archivePath: "/archive/cleanup-delete.jsonl" };
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: TEST_AGENT_DIR,
      modelRuntime: testModelRuntime,
      now: () => new Date("2026-06-25T00:00:00.000Z"),
      createAgentRuntime: () => Promise.reject(new Error("cleanup should not open runtimes")),
      sessionManager: {
        create: () => fakeSessionManager(),
        list: () => Promise.resolve([]),
        listAll: () => Promise.resolve([sessionRecord("cleanup-archive", oldProjectCwd)]),
        invalidateSessionFile: () => undefined,
        resolveSessionFile: () => Promise.resolve(undefined),
        open: () => fakeSessionManager(),
      },
      archiveStore: {
        list: () => Promise.resolve([archivedRecord]),
        get: () => Promise.resolve(undefined),
        archive: () => Promise.reject(new Error("cleanup should use archiveMany")),
        archiveMany: (inputs: readonly { sessionId: string; cwd: string }[]) => Promise.resolve(inputs.map((input) => ({ sessionId: input.sessionId, cwd: input.cwd, archivedAt: "2026-06-25T00:00:00.000Z" }))),
        restore: () => Promise.resolve(),
        isArchived: () => Promise.resolve(false),
        deleteArchived: () => Promise.reject(new Error("cleanup should use deleteArchivedMany")),
        deleteArchivedMany: (sessionIds: readonly string[]) => Promise.resolve([...sessionIds]),
      },
      heartbeatIntervalMs: 60_000,
      unreadStore,
    });

    try {
      const result = await service.cleanup({ thresholds: { archiveIdleDays: 30, deleteArchivedDays: 30 } });

      expect(result.archivedSessionIds).toEqual(["cleanup-archive"]);
      expect(result.deletedSessionIds).toEqual(["cleanup-delete"]);
      expect((await service.unreadCatalog()).sessions).toEqual([]);
    } finally {
      await service.dispose();
    }
  });

  it("clears unread only for archived records actually removed by bulk delete", async () => {
    const unreadStore = new SessionUnreadStore({ createCatalogId: () => "catalog-test" });
    completeStoreWork(unreadStore, "busy-archived", WORKSPACE_CWD);
    completeStoreWork(unreadStore, "idle-archived", WORKSPACE_CWD);
    const busyRecord = { sessionId: "busy-archived", cwd: "/workspace", archivedAt: "2026-01-02T00:00:00.000Z", archivePath: "/archive/busy.jsonl" };
    const idleRecord = { sessionId: "idle-archived", cwd: "/workspace", archivedAt: "2026-01-02T00:00:00.000Z", archivePath: "/archive/idle.jsonl" };
    const busy = fakeRuntime("busy-archived", { isStreaming: true });
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: TEST_AGENT_DIR,
      modelRuntime: testModelRuntime,
      createAgentRuntime: runtimeCreator(busy.runtime),
      sessionManager: sessionGateway([]),
      archiveStore: {
        list: () => Promise.resolve([busyRecord, idleRecord]),
        get: (sessionId) => Promise.resolve(sessionId === "busy-archived" ? busyRecord : undefined),
        archive: () => Promise.reject(new Error("archive should not be called")),
        restore: () => Promise.resolve(),
        isArchived: () => Promise.resolve(false),
        deleteArchived: () => Promise.reject(new Error("bulk delete should use deleteArchivedMany")),
        deleteArchivedMany: (sessionIds: readonly string[]) => Promise.resolve([...sessionIds]),
      },
      heartbeatIntervalMs: 60_000,
      unreadStore,
    });

    try {
      await service.status(sessionRef("busy-archived"));
      const result = await service.deleteArchivedMany([
        { id: "busy-archived", cwd: "/workspace" },
        { id: "idle-archived", cwd: "/workspace" },
      ]);

      expect(result).toMatchObject({
        deletedSessionIds: ["idle-archived"],
        failures: [{ sessionId: "busy-archived", error: "Stop current session activity before deleting archived session" }],
      });
      expect((await service.unreadCatalog()).sessions).toMatchObject([{ sessionId: "busy-archived", cwd: WORKSPACE_CWD }]);
    } finally {
      await service.dispose();
    }
  });

  it("does not resurrect unread when archiving an active session with a pending activity latch", async () => {
    const unreadStore = new SessionUnreadStore({ createCatalogId: () => "catalog-test" });
    const hub = new CapturingSessionEventHub();
    const fake = fakeRuntime("archive-active");
    const service = new PiSessionService(hub, {
      agentDir: TEST_AGENT_DIR,
      modelRuntime: testModelRuntime,
      createAgentRuntime: runtimeCreator(fake.runtime),
      sessionManager: sessionGateway([sessionRecord("archive-active")]),
      archiveStore: {
        ...emptyArchiveStore(),
        archive: (input: { sessionId: string; cwd: string }) => Promise.resolve({ sessionId: input.sessionId, cwd: input.cwd, archivedAt: "2026-01-03T00:00:00.000Z" }),
      },
      heartbeatIntervalMs: 60_000,
      unreadStore,
    });

    try {
      await service.status(sessionRef("archive-active"));
      completeRuntimeWork(fake);
      expect((await service.unreadCatalog()).sessions).toMatchObject([{ sessionId: "archive-active", completionOrder: 1 }]);

      // Leave a set activity latch behind: work started, then stopped without an
      // observable end event. The archive path must not let that latch record a
      // completion after the forget clears unread state.
      fake.session.isStreaming = true;
      fake.emit({ type: "agent_start" });
      fake.session.isStreaming = false;

      await service.archive(sessionRef("archive-active"));
      expect((await service.unreadCatalog()).sessions).toEqual([]);
      expect(unreadEvents(hub).at(-1)).toMatchObject({ sessionId: "archive-active", unread: null });

      // The disposed runtime is unsubscribed before the forget, so late events
      // cannot re-latch and manufacture a completion for the archived session.
      fake.emit({ type: "agent_start" });
      fake.emit({ type: "turn_end" });
      await drainMicrotasks();
      expect((await service.unreadCatalog()).sessions).toEqual([]);
      expect(unreadEvents(hub).at(-1)).toMatchObject({ sessionId: "archive-active", unread: null });
    } finally {
      await service.dispose();
    }
  });
  it("reports unread changes to the machine status projection as they are recorded", async () => {
    const onUnreadChanged = vi.fn();
    const unreadStore = new SessionUnreadStore({ createCatalogId: () => "catalog-test" });
    const fake = fakeRuntime("session-1");
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: TEST_AGENT_DIR,
      modelRuntime: testModelRuntime,
      createAgentRuntime: runtimeCreator(fake.runtime),
      sessionManager: sessionGateway([sessionRecord("session-1")]),
      archiveStore: emptyArchiveStore(),
      heartbeatIntervalMs: 60_000,
      unreadStore,
      onUnreadChanged,
    });

    try {
      await service.status(sessionRef("session-1"));
      expect(onUnreadChanged).not.toHaveBeenCalled();

      completeRuntimeWork(fake);

      // The projection reads in-memory unread state, so it is told as soon as
      // the completion is recorded rather than after the durable flush.
      expect(onUnreadChanged).toHaveBeenCalledTimes(1);

      await service.acknowledgeUnread("session-1", {
        cwd: WORKSPACE_CWD,
        catalogId: "catalog-test",
        throughCompletionOrder: 1,
      });

      expect(onUnreadChanged).toHaveBeenCalledTimes(2);

      await service.acknowledgeUnread("session-1", {
        cwd: WORKSPACE_CWD,
        catalogId: "catalog-test",
        throughCompletionOrder: 1,
      });

      // Nothing changed, so the projection is not asked to recompute again.
      expect(onUnreadChanged).toHaveBeenCalledTimes(2);
    } finally {
      await service.dispose();
    }
  });
});

function completeRuntimeWork(runtime: ReturnType<typeof fakeRuntime>): void {
  runtime.session.isStreaming = true;
  runtime.emit({ type: "agent_start" });
  runtime.session.isStreaming = false;
  runtime.emit({ type: "turn_end" });
}

function completeStoreWork(store: SessionUnreadStore, sessionId: string, cwd: string): void {
  store.observeActivityState(sessionId, cwd, true);
  store.observeActivityState(sessionId, cwd, false);
}

function unreadEvents(hub: CapturingSessionEventHub) {
  return hub.globalEvents.filter((event) => event.type === "sessions.unread");
}

interface Deferred {
  promise: Promise<void>;
  resolve(): void;
}

class RecoveringUnreadPersistence implements SessionUnreadPersistence {
  saveCalls = 0;
  private value: SessionUnreadPersistedState = {
    version: 1,
    catalogId: "catalog-test",
    catalogRevision: 0,
    nextCompletionOrder: 0,
    sessions: [],
  };

  constructor(private readonly failures: number) {}

  load(): Promise<unknown> {
    return Promise.resolve(structuredClone(this.value));
  }

  save(state: SessionUnreadPersistedState): Promise<void> {
    this.saveCalls += 1;
    if (this.saveCalls <= this.failures) return Promise.reject(new Error("unread persistence unavailable"));
    this.value = structuredClone(state);
    return Promise.resolve();
  }

  persistedState(): SessionUnreadPersistedState {
    return structuredClone(this.value);
  }
}

class BlockingUnreadPersistence implements SessionUnreadPersistence {
  readonly savedStates: SessionUnreadPersistedState[] = [];
  private persistedState: SessionUnreadPersistedState | undefined;
  private nextSaveGate: Deferred | undefined;

  load(): Promise<unknown> {
    return Promise.resolve(this.persistedState);
  }

  async save(state: SessionUnreadPersistedState): Promise<void> {
    const gate = this.nextSaveGate;
    this.nextSaveGate = undefined;
    if (gate !== undefined) await gate.promise;
    const saved = structuredClone(state);
    this.persistedState = saved;
    this.savedStates.push(saved);
  }

  blockNextSave(): Deferred {
    const gate = deferred();
    this.nextSaveGate = gate;
    return gate;
  }
}

async function drainMicrotasks(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
}

function deferred(): Deferred {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => { resolvePromise = resolve; });
  return {
    promise,
    resolve() { resolvePromise?.(); },
  };
}
