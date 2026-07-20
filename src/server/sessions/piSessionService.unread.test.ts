import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PiSessionService, type PiAgentSession } from "./piSessionService.js";
import {
  CapturingSessionEventHub,
  emptyArchiveStore,
  fakeRuntime,
  fakeSessionManager,
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
      sessionModelRuntimeFactory: () => Promise.resolve(testModelRuntime),
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
      expect(current).toMatchObject({ sessionId: "session-1", cwd: "/workspace", completionOrder: 2 });
      expect(unreadEvents(hub).map((event) => event.catalogRevision)).toEqual([1, 2]);

      const staleSnapshot = await service.acknowledgeUnread("session-1", {
        cwd: "/workspace",
        catalogId: "catalog-test",
        throughCompletionOrder: 1,
      });
      expect(staleSnapshot.sessions).toEqual(secondSnapshot.sessions);
      expect(unreadEvents(hub).map((event) => event.catalogRevision)).toEqual([1, 2]);

      const acknowledged = await service.acknowledgeUnread("session-1", {
        cwd: "/workspace",
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
      sessionModelRuntimeFactory: () => Promise.resolve(testModelRuntime),
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

      expect((await service.unreadCatalog()).sessions).toMatchObject([{ sessionId: "session-1", cwd: "/workspace", completionOrder: 1 }]);
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
      sessionModelRuntimeFactory: () => Promise.resolve(testModelRuntime),
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
      sessionModelRuntimeFactory: () => Promise.resolve(testModelRuntime),
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
      sessionModelRuntimeFactory: () => Promise.resolve(testModelRuntime),
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
      sessionModelRuntimeFactory: () => Promise.resolve(testModelRuntime),
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

      completeStoreWork(unreadStore, "session-1", "/workspace");
      const beforeReload = (await service.unreadCatalog()).sessions[0];
      await service.reload(sessionRef("session-1"));
      const afterReload = (await service.unreadCatalog()).sessions[0];

      expect(beforeReload).toBeDefined();
      expect(afterReload).toMatchObject({ sessionId: "session-1", cwd: "/workspace" });
      expect(afterReload?.completionOrder).toBeGreaterThan(beforeReload?.completionOrder ?? 0);
    } finally {
      await service.dispose();
    }
  });

  it("settles clean reload unread work on the replacement generation before returning", async () => {
    const unreadStore = new SessionUnreadStore({ createCatalogId: () => "catalog-test" });
    const manager = fakeSessionManager("/workspace", { getSessionId: () => "session-1" });
    const runtimes = [
      fakeRuntime("session-1", { sessionManager: manager }),
      fakeRuntime("session-1", { sessionManager: manager }),
    ];
    let runtimeIndex = 0;
    const createAgentRuntime: RuntimeCreator = () => {
      const runtime = runtimes[runtimeIndex++];
      if (runtime === undefined) throw new Error("Unexpected extra runtime creation");
      return Promise.resolve(runtime.runtime);
    };
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: TEST_AGENT_DIR,
      sessionModelRuntimeFactory: () => Promise.resolve(testModelRuntime),
      createAgentRuntime,
      sessionManager: sessionGateway([sessionRecord("session-1")]),
      archiveStore: emptyArchiveStore(),
      heartbeatIntervalMs: 60_000,
      unreadStore,
    });

    try {
      await service.status(sessionRef("session-1"));
      completeStoreWork(unreadStore, "session-1", "/workspace");
      const beforeReload = await service.unreadCatalog();
      const priorCompletion = beforeReload.sessions[0]?.completionOrder;
      expect(priorCompletion).toBeDefined();

      await expect(service.runCommand(sessionRef("session-1"), "/reload")).resolves.toMatchObject({ type: "done" });

      const afterReload = await service.unreadCatalog();
      const replacementCompletion = afterReload.sessions[0]?.completionOrder;
      expect(replacementCompletion).toBeGreaterThan(priorCompletion ?? 0);
      if (replacementCompletion === undefined) throw new Error("Expected replacement reload completion");
      await service.acknowledgeUnread("session-1", {
        cwd: "/workspace",
        catalogId: afterReload.catalogId,
        throughCompletionOrder: replacementCompletion,
      });
      await service.status(sessionRef("session-1"));
      expect((await service.unreadCatalog()).sessions).toEqual([]);
    } finally {
      await service.dispose();
    }
  });

  it("ignores delayed activity callbacks from a replaced same-id generation", async () => {
    vi.useFakeTimers();
    const unreadStore = new SessionUnreadStore({ createCatalogId: () => "catalog-test" });
    const manager = fakeSessionManager("/workspace", { getSessionId: () => "session-1" });
    const original = fakeRuntime("session-1", { sessionManager: manager });
    const replacement = fakeRuntime("session-1", { sessionManager: manager });
    let runtimeIndex = 0;
    const createAgentRuntime: RuntimeCreator = () => {
      const runtime = [original, replacement][runtimeIndex++];
      if (runtime === undefined) throw new Error("Unexpected extra runtime creation");
      return Promise.resolve(runtime.runtime);
    };
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: TEST_AGENT_DIR,
      sessionModelRuntimeFactory: () => Promise.resolve(testModelRuntime),
      createAgentRuntime,
      sessionManager: sessionGateway([sessionRecord("session-1")]),
      archiveStore: emptyArchiveStore(),
      heartbeatIntervalMs: 60_000,
      unreadStore,
    });

    try {
      await service.status(sessionRef("session-1"));
      original.emit({ type: "agent_end" });
      await service.runCommand(sessionRef("session-1"), "/reload");
      const reloadCatalog = await service.unreadCatalog();
      const reloadCompletion = reloadCatalog.sessions[0]?.completionOrder;
      if (reloadCompletion === undefined) throw new Error("Expected reload completion");
      await service.acknowledgeUnread("session-1", {
        cwd: "/workspace",
        catalogId: reloadCatalog.catalogId,
        throughCompletionOrder: reloadCompletion,
      });

      replacement.session.isStreaming = true;
      replacement.emit({ type: "agent_start" });
      await vi.advanceTimersByTimeAsync(250);
      expect((await service.unreadCatalog()).sessions).toEqual([]);

      replacement.session.isStreaming = false;
      replacement.emit({ type: "agent_end" });
      expect((await service.unreadCatalog()).sessions).toMatchObject([
        { sessionId: "session-1", cwd: "/workspace" },
      ]);
    } finally {
      await service.dispose();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("clears stale unread when a runtime rebind changes logical session identity", async () => {
    const unreadStore = new SessionUnreadStore({ createCatalogId: () => "catalog-test" });
    completeStoreWork(unreadStore, "session-old", "/workspace");
    const original = fakeRuntime("session-old");
    let rebindSession: ((session: PiAgentSession) => Promise<void>) | undefined;
    original.runtime.setRebindSession = (callback) => { rebindSession = callback; };
    const replacement = fakeRuntime("session-new");
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: TEST_AGENT_DIR,
      sessionModelRuntimeFactory: () => Promise.resolve(testModelRuntime),
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

  it("moves unread completion to the replacement identity when Pi mutates a shared session manager", async () => {
    const unreadStore = new SessionUnreadStore({ createCatalogId: () => "catalog-test" });
    completeStoreWork(unreadStore, "session-old", "/workspace");
    let managerSessionId = "session-old";
    const manager = fakeSessionManager("/workspace", {
      getSessionId: () => managerSessionId,
      getLeafId: () => "leaf-1",
    });
    const original = fakeRuntime("session-old", { sessionManager: manager });
    const replacement = fakeRuntime("session-new", { sessionManager: manager });
    for (const session of [original.session, replacement.session]) {
      Object.defineProperty(session, "sessionId", {
        configurable: true,
        get: () => managerSessionId,
      });
    }
    let rebindSession: ((session: PiAgentSession) => Promise<void>) | undefined;
    let beforeSessionInvalidate: (() => void) | undefined;
    original.runtime.setRebindSession = (callback) => { rebindSession = callback; };
    original.runtime.setBeforeSessionInvalidate = (callback) => { beforeSessionInvalidate = callback; };
    original.runtime.fork = async () => {
      if (rebindSession === undefined || beforeSessionInvalidate === undefined) {
        throw new Error("Expected runtime lifecycle callbacks");
      }
      managerSessionId = "session-new";
      beforeSessionInvalidate();
      Object.defineProperty(original.runtime, "session", { configurable: true, value: replacement.session });
      await rebindSession(replacement.session);
      return { cancelled: false };
    };
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: TEST_AGENT_DIR,
      sessionModelRuntimeFactory: () => Promise.resolve(testModelRuntime),
      createAgentRuntime: runtimeCreator(original.runtime),
      sessionManager: sessionGateway([sessionRecord("session-old")]),
      archiveStore: emptyArchiveStore(),
      heartbeatIntervalMs: 60_000,
      unreadStore,
    });

    try {
      await service.status(sessionRef("session-old"));
      await expect(service.runCommand(sessionRef("session-old"), "/clone")).resolves.toMatchObject({
        type: "done",
        session: { id: "session-new" },
      });

      const catalog = await service.unreadCatalog();
      expect(catalog.sessions.map(({ sessionId, cwd }) => ({ sessionId, cwd }))).toEqual([
        { sessionId: "session-new", cwd: "/workspace" },
      ]);
      expect(catalog.sessions[0]?.completionOrder).toBe(2);
    } finally {
      await service.dispose();
    }
  });

  it("retains prior unread when a changed-id runtime rebind fails before activation", async () => {
    const unreadStore = new SessionUnreadStore({ createCatalogId: () => "catalog-test" });
    completeStoreWork(unreadStore, "session-old", "/workspace");
    const original = fakeRuntime("session-old");
    const replacement = fakeRuntime("session-new", {
      bindExtensions: () => Promise.reject(new Error("replacement bind failed")),
    });
    let rebindSession: ((session: PiAgentSession) => Promise<void>) | undefined;
    let beforeSessionInvalidate: (() => void) | undefined;
    original.runtime.setRebindSession = (callback) => { rebindSession = callback; };
    original.runtime.setBeforeSessionInvalidate = (callback) => { beforeSessionInvalidate = callback; };
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: TEST_AGENT_DIR,
      sessionModelRuntimeFactory: () => Promise.resolve(testModelRuntime),
      createAgentRuntime: runtimeCreator(original.runtime),
      sessionManager: sessionGateway([sessionRecord("session-old")]),
      archiveStore: emptyArchiveStore(),
      heartbeatIntervalMs: 60_000,
      unreadStore,
    });

    try {
      await service.status(sessionRef("session-old"));
      if (rebindSession === undefined || beforeSessionInvalidate === undefined) {
        throw new Error("Expected runtime lifecycle callbacks");
      }
      beforeSessionInvalidate();
      Object.defineProperty(original.runtime, "session", { configurable: true, value: replacement.session });
      await expect(rebindSession(replacement.session)).rejects.toThrow("replacement bind failed");

      expect((await service.unreadCatalog()).sessions).toMatchObject([
        { sessionId: "session-old", cwd: "/workspace" },
      ]);
    } finally {
      await service.dispose();
    }
  });

  it("cleans unread state through archive, restore, delete, and cwd reconciliation", async () => {
    const unreadStore = new SessionUnreadStore({ createCatalogId: () => "catalog-test" });
    for (const sessionId of ["archive-me", "restore-me", "delete-me", "orphan"]) {
      completeStoreWork(unreadStore, sessionId, "/workspace");
    }
    const archived = new Map([
      ["restore-me", { sessionId: "restore-me", cwd: "/workspace", archivedAt: "2026-07-01T00:00:00.000Z", archivePath: "/archive/restore-me.jsonl" }],
      ["delete-me", { sessionId: "delete-me", cwd: "/workspace", archivedAt: "2026-07-01T00:00:00.000Z", archivePath: "/archive/delete-me.jsonl" }],
    ]);
    const fake = fakeRuntime("archive-me");
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: TEST_AGENT_DIR,
      sessionModelRuntimeFactory: () => Promise.resolve(testModelRuntime),
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

      await service.deleteArchived(sessionRef("delete-me"));
      expect((await service.unreadCatalog()).sessions.map((summary) => summary.sessionId)).toEqual(["orphan"]);

      await service.list("/workspace");
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
      sessionModelRuntimeFactory: () => Promise.resolve(testModelRuntime),
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
        cwd: "/workspace-feature",
      });
      completeRuntimeWork(child);

      expect((await service.unreadCatalog()).sessions.some((summary) => summary.sessionId === "child-1")).toBe(false);
      expect(unreadEvents(hub).some((event) => event.sessionId === "child-1" && event.unread !== null)).toBe(false);

      await service.detachParent(sessionRef("child-1", "/workspace-feature"));
      completeRuntimeWork(child);
      expect((await service.unreadCatalog()).sessions).toContainEqual(expect.objectContaining({
        sessionId: "child-1",
        cwd: "/workspace-feature",
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
    completeStoreWork(unreadStore, "child-1", "/workspace-feature");
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
      sessionModelRuntimeFactory: () => Promise.resolve(testModelRuntime),
      createAgentRuntime: runtimeCreator(parent.runtime),
      sessionManager: {
        create: () => parentManager,
        list: () => Promise.resolve([]),
        listAll: () => Promise.resolve([]),
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
      expect(unreadEvents(hub).at(-1)).toMatchObject({ sessionId: "child-1", cwd: "/workspace-feature", unread: null });
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
    completeStoreWork(unreadStore, "child-1", "/workspace-feature");
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
      sessionModelRuntimeFactory: () => Promise.resolve(testModelRuntime),
      createAgentRuntime: runtimeCreator(parent.runtime),
      sessionManager: {
        create: () => parentManager,
        list: () => Promise.resolve([]),
        listAll: () => Promise.resolve([]),
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
      sessionModelRuntimeFactory: () => Promise.resolve(testModelRuntime),
      createAgentRuntime: runtimeCreator(child.runtime),
      sessionManager: {
        create: () => childManager,
        list: () => Promise.resolve([childRecord]),
        listAll: () => Promise.resolve([childRecord]),
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
      sessionModelRuntimeFactory: () => Promise.resolve(testModelRuntime),
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
