import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PiSessionService, type PiAgentSession, type PiSessionRuntime } from "./piSessionService.js";
import { SessionNotificationStore } from "./sessionNotificationStore.js";
import { CapturingSessionEventHub, createTestModelRuntime, emptyArchiveStore, fakeRuntime, fakeSessionManager, runtimeCreator, sessionGateway, sessionRecord, sessionRef, testModelRuntime, type RuntimeCreator } from "./piSessionService.testSupport.js";

const TEST_AGENT_DIR = "/tmp/pi-web-test-agent";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function runtimeSequence(...runtimes: PiSessionRuntime[]): RuntimeCreator {
  let index = 0;
  return async () => {
    await Promise.resolve();
    const runtime = runtimes[index++];
    if (runtime === undefined) throw new Error("unexpected runtime creation");
    return runtime;
  };
}

function notificationStore() {
  let tick = 0;
  return new SessionNotificationStore({
    daemonInstanceId: "daemon-lifecycle-test",
    now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)),
  });
}

function boundNotify(fake: { calls: { bindExtensions: unknown[] } }, index = -1) {
  const bindings = fake.calls.bindExtensions.at(index);
  if (typeof bindings !== "object" || bindings === null || !("uiContext" in bindings) || !hasNotify(bindings.uiContext)) {
    throw new Error("Expected bound extension UI context");
  }
  const uiContext = bindings.uiContext;
  return (message: string, type?: "info" | "warning" | "error") => { uiContext.notify(message, type); };
}

function hasNotify(value: unknown): value is { notify(message: string, type?: "info" | "warning" | "error"): void } {
  return typeof value === "object" && value !== null && "notify" in value && typeof value.notify === "function";
}

describe("PiSessionService lifecycle, listing, and reload", () => {
  it("starts sessions through an injected runtime creator", async () => {
    const hub = new CapturingSessionEventHub();
    const fake = fakeRuntime();
    let sessionStartText: string | undefined;
    const bindExtensions = fake.session.bindExtensions.bind(fake.session);
    fake.session.bindExtensions = (bindings) => {
      sessionStartText = bindings.uiContext?.theme.fg("accent", "session started");
      return bindExtensions(bindings);
    };
    let createCalls = 0;
    let runtimeAgentDir: string | undefined;
    const createAgentRuntime: RuntimeCreator = async (_createRuntime, options) => {
      createCalls += 1;
      runtimeAgentDir = options.agentDir;
      await Promise.resolve();
      return fake.runtime;
    };
    const service = new PiSessionService(hub, {
      agentDir: TEST_AGENT_DIR,
      sessionModelRuntimeFactory: () => Promise.resolve(testModelRuntime),
      createAgentRuntime,
      sessionManager: sessionGateway([]),
      heartbeatIntervalMs: 60_000,
    });

    const session = await service.start("/workspace");

    expect(createCalls).toBe(1);
    expect(runtimeAgentDir).toBe(TEST_AGENT_DIR);
    expect(fake.calls.bindExtensions).toHaveLength(1);
    expect(sessionStartText).toBe("session started");
    expect(session).toMatchObject({ id: "session-1", cwd: "/workspace", messageCount: 0 });
    expect(service.activeCount()).toBe(1);
    expect(hub.globalEvents.some((event) => event.type === "status.update" && event.status.sessionId === "session-1")).toBe(true);
    expect(hub.globalEvents.some((event) => event.type === "session.created" && event.session.id === "session-1" && event.session.cwd === "/workspace")).toBe(true);

    await service.dispose();
    expect(fake.calls.abort).toBe(1);
    expect(fake.calls.dispose).toBe(1);
  });

  it("reports persistence from actual session-file existence for fresh active sessions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-web-persisted-"));
    const sessionFile = join(dir, "new-session.jsonl");
    const hub = new CapturingSessionEventHub();
    const fake = fakeRuntime("new-session", { sessionFile });
    let service: PiSessionService | undefined;
    try {
      service = new PiSessionService(hub, {
        agentDir: TEST_AGENT_DIR,
        sessionModelRuntimeFactory: () => Promise.resolve(testModelRuntime),
        createAgentRuntime: runtimeCreator(fake.runtime),
        sessionManager: sessionGateway([]),
        heartbeatIntervalMs: 60_000,
      });

      const session = await service.start("/workspace");
      const createdEvent = hub.globalEvents.find((event) => event.type === "session.created");

      expect(session).toMatchObject({ id: "new-session", path: sessionFile, persisted: false });
      expect(createdEvent).toMatchObject({ type: "session.created", session: { id: "new-session", persisted: false } });
      await expect(service.status(sessionRef("new-session"))).resolves.toMatchObject({ sessionId: "new-session", persisted: false });

      await writeFile(sessionFile, '{"type":"session","id":"new-session"}\n', "utf8");

      await expect(service.status(sessionRef("new-session"))).resolves.toMatchObject({ sessionId: "new-session", persisted: true });
    } finally {
      await service?.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("opens legacy id-only lookups from the default session store gateway", async () => {
    const hub = new CapturingSessionEventHub();
    const fake = fakeRuntime("legacy-session");
    const open = vi.fn(() => fakeSessionManager());
    const service = new PiSessionService(hub, {
      agentDir: TEST_AGENT_DIR,
      sessionModelRuntimeFactory: () => Promise.resolve(testModelRuntime),
      createAgentRuntime: runtimeCreator(fake.runtime),
      sessionManager: {
        create: () => fakeSessionManager(),
        list: () => Promise.resolve([]),
        listAll: () => Promise.resolve([sessionRecord("legacy-session")]),
        open,
      },
      heartbeatIntervalMs: 60_000,
    });

    await expect(service.status("legacy")).resolves.toMatchObject({ sessionId: "legacy-session" });
    expect(open).toHaveBeenCalledWith("/sessions/legacy-session.jsonl");

    await service.dispose();
  });

  it("shares one runtime when concurrent cold lookups resolve to the same session", async () => {
    const sessionId = "single-flight-session";
    const createStarted = deferred();
    const releaseCreate = deferred();
    const winnerUnsubscribe = vi.fn();
    const loserUnsubscribe = vi.fn();
    const winnerSubscribe = vi.fn(() => winnerUnsubscribe);
    const loserSubscribe = vi.fn(() => loserUnsubscribe);
    const winner = fakeRuntime(sessionId, {
      sessionManager: fakeSessionManager("/workspace", {
        getSessionId: () => sessionId,
        getBranch: () => [{ type: "message", message: { role: "user", content: "shared runtime" } }],
      }),
      subscribe: winnerSubscribe,
    });
    const loser = fakeRuntime(sessionId, {
      sessionManager: fakeSessionManager("/workspace", { getSessionId: () => sessionId }),
      subscribe: loserSubscribe,
    });
    const runtimes = [winner.runtime, loser.runtime];
    let createCalls = 0;
    const createAgentRuntime: RuntimeCreator = async () => {
      const runtime = runtimes[createCalls];
      createCalls += 1;
      createStarted.resolve();
      await releaseCreate.promise;
      if (runtime === undefined) throw new Error("unexpected runtime creation");
      return runtime;
    };
    const gateway = sessionGateway([sessionRecord(sessionId)]);
    const open = vi.spyOn(gateway, "open");
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: TEST_AGENT_DIR,
      sessionModelRuntimeFactory: () => Promise.resolve(testModelRuntime),
      archiveStore: emptyArchiveStore(),
      createAgentRuntime,
      sessionManager: gateway,
      heartbeatIntervalMs: 60_000,
    });

    const messagesPromise = service.messages(sessionRef(sessionId));
    await createStarted.promise;
    const statusPromise = service.status(sessionRef("single-flight"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    const callsWhileOpening = createCalls;
    releaseCreate.resolve();

    const [messages, status] = await Promise.all([messagesPromise, statusPromise]);
    const activeCount = service.activeCount();
    await service.dispose();

    expect(callsWhileOpening).toBe(1);
    expect(createCalls).toBe(1);
    expect(open).toHaveBeenCalledOnce();
    expect(activeCount).toBe(1);
    expect(messages).toEqual([{ role: "user", content: "shared runtime" }]);
    expect(status).toMatchObject({ sessionId });
    expect(winnerSubscribe).toHaveBeenCalledOnce();
    expect(winnerUnsubscribe).toHaveBeenCalledOnce();
    expect(winner.calls.dispose).toBe(1);
    expect(loserSubscribe).not.toHaveBeenCalled();
    expect(loserUnsubscribe).not.toHaveBeenCalled();
    expect(loser.calls.dispose).toBe(0);
  });

  it("clears a failed pending open so the session can be retried", async () => {
    const sessionId = "retry-open-session";
    const bindStarted = deferred();
    const bindResult = deferred();
    const openingError = new Error("extension binding failed");
    const failedModelRuntime = await createTestModelRuntime();
    const retriedModelRuntime = await createTestModelRuntime();
    const failed = fakeRuntime(sessionId, {
      modelRuntime: failedModelRuntime,
      bindExtensions: () => {
        bindStarted.resolve();
        return bindResult.promise;
      },
    });
    const retried = fakeRuntime(sessionId, { modelRuntime: retriedModelRuntime });
    const runtimes = [failed.runtime, retried.runtime];
    let createCalls = 0;
    const createAgentRuntime: RuntimeCreator = () => {
      const runtime = runtimes[createCalls];
      createCalls += 1;
      return runtime === undefined
        ? Promise.reject(new Error("unexpected runtime creation"))
        : Promise.resolve(runtime);
    };
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: TEST_AGENT_DIR,
      sessionModelRuntimeFactory: () => Promise.resolve(testModelRuntime),
      archiveStore: emptyArchiveStore(),
      createAgentRuntime,
      sessionManager: sessionGateway([sessionRecord(sessionId)]),
      heartbeatIntervalMs: 60_000,
    });

    const messagesPromise = service.messages(sessionRef(sessionId));
    await bindStarted.promise;
    const statusPromise = service.status(sessionRef("retry-open"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    const callsWhileOpening = createCalls;
    const failedLookups = Promise.allSettled([messagesPromise, statusPromise]);
    bindResult.reject(openingError);

    const outcomes = await failedLookups;
    expect(callsWhileOpening).toBe(1);
    expect(outcomes).toHaveLength(2);
    for (const outcome of outcomes) {
      expect(outcome.status).toBe("rejected");
      if (outcome.status === "rejected") expect(outcome.reason).toBe(openingError);
    }
    expect(service.activeCount()).toBe(0);
    expect(failed.calls.abort).toBe(1);
    expect(failed.calls.dispose).toBe(1);

    await expect(service.status(sessionRef(sessionId))).resolves.toMatchObject({ sessionId });
    expect(createCalls).toBe(2);
    expect(service.activeCount()).toBe(1);
    expect(retried.session.modelRuntime).toBe(retriedModelRuntime);
    expect(retried.session.modelRuntime).not.toBe(failedModelRuntime);

    await service.dispose();
    expect(retried.calls.dispose).toBe(1);
  });

  it("waits for an in-flight open before disposing the service", async () => {
    const sessionId = "dispose-opening-session";
    const createStarted = deferred();
    const runtimeResult = deferred<PiSessionRuntime>();
    const fake = fakeRuntime(sessionId);
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: TEST_AGENT_DIR,
      sessionModelRuntimeFactory: () => Promise.resolve(testModelRuntime),
      archiveStore: emptyArchiveStore(),
      createAgentRuntime: () => {
        createStarted.resolve();
        return runtimeResult.promise;
      },
      sessionManager: sessionGateway([sessionRecord(sessionId)]),
      heartbeatIntervalMs: 60_000,
    });

    const statusPromise = service.status(sessionRef(sessionId));
    await createStarted.promise;
    let disposeSettled = false;
    const disposePromise = service.dispose().then(() => { disposeSettled = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const settledWhileOpening = disposeSettled;
    runtimeResult.resolve(fake.runtime);

    await expect(statusPromise).rejects.toThrow("Session service is shutting down");
    await disposePromise;

    expect(settledWhileOpening).toBe(false);
    expect(service.activeCount()).toBe(0);
    expect(fake.calls.abort).toBe(1);
    expect(fake.calls.dispose).toBe(1);
  });

  it("lets disposal cancel a pending direct start before candidate binding", async () => {
    const creationStarted = deferred();
    const runtimeResult = deferred<PiSessionRuntime>();
    const fake = fakeRuntime("dispose-pending-start");
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: TEST_AGENT_DIR,
      sessionModelRuntimeFactory: () => Promise.resolve(testModelRuntime),
      createAgentRuntime: () => {
        creationStarted.resolve();
        return runtimeResult.promise;
      },
      sessionManager: sessionGateway([]),
      heartbeatIntervalMs: 60_000,
    });

    const starting = service.start("/workspace");
    void starting.catch(() => undefined);
    await creationStarted.promise;
    const disposing = service.dispose();
    runtimeResult.resolve(fake.runtime);

    await expect(starting).rejects.toThrow("Session service is shutting down");
    await disposing;
    expect(service.activeCount()).toBe(0);
    expect(fake.calls.bindExtensions).toHaveLength(0);
    expect(fake.calls.abort).toBe(1);
    expect(fake.calls.dispose).toBe(1);
  });

  it("lets stop cancel a cwd-qualified cold open before candidate binding", async () => {
    const sessionId = "stop-pending-open";
    const creationStarted = deferred();
    const runtimeResult = deferred<PiSessionRuntime>();
    const fake = fakeRuntime(sessionId);
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: TEST_AGENT_DIR,
      sessionModelRuntimeFactory: () => Promise.resolve(testModelRuntime),
      createAgentRuntime: () => {
        creationStarted.resolve();
        return runtimeResult.promise;
      },
      sessionManager: sessionGateway([sessionRecord(sessionId)]),
      heartbeatIntervalMs: 60_000,
    });

    const opening = service.status(sessionRef(sessionId));
    void opening.catch(() => undefined);
    await creationStarted.promise;
    const stopping = service.stop(sessionRef(sessionId));
    runtimeResult.resolve(fake.runtime);

    await expect(opening).rejects.toThrow("Session is stopping");
    await stopping;
    expect(service.activeCount()).toBe(0);
    expect(fake.calls.bindExtensions).toHaveLength(0);
    expect(fake.calls.abort).toBe(1);
    expect(fake.calls.dispose).toBe(1);
    await service.dispose();
  });

  it("lets stop cancel a cold lookup before archive/list I/O registers an open", async () => {
    const sessionId = "stop-cold-lookup";
    const listingStarted = deferred();
    const gateway = sessionGateway([sessionRecord(sessionId)]);
    const listed = deferred<Awaited<ReturnType<typeof gateway.list>>>();
    gateway.list = async () => {
      listingStarted.resolve();
      return listed.promise;
    };
    const createAgentRuntime = vi.fn();
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: TEST_AGENT_DIR,
      sessionModelRuntimeFactory: () => Promise.resolve(testModelRuntime),
      archiveStore: emptyArchiveStore(),
      createAgentRuntime,
      sessionManager: gateway,
      heartbeatIntervalMs: 60_000,
    });

    const opening = service.status(sessionRef(sessionId));
    void opening.catch(() => undefined);
    await listingStarted.promise;
    let stopSettled = false;
    const stopping = service.stop(sessionRef(sessionId)).finally(() => { stopSettled = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(stopSettled).toBe(false);
    listed.resolve([sessionRecord(sessionId)]);

    await expect(opening).rejects.toThrow("Session is stopping");
    await stopping;
    expect(service.activeCount()).toBe(0);
    expect(createAgentRuntime).not.toHaveBeenCalled();
    await service.dispose();
  });

  it("tracks writable archive preflight so stop cannot race the following open", async () => {
    const sessionId = "stop-writable-preflight";
    const archiveLookupStarted = deferred();
    const archiveLookup = deferred<undefined>();
    const archiveStore = emptyArchiveStore();
    archiveStore.get = () => {
      archiveLookupStarted.resolve();
      return archiveLookup.promise;
    };
    const createAgentRuntime = vi.fn();
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: TEST_AGENT_DIR,
      sessionModelRuntimeFactory: () => Promise.resolve(testModelRuntime),
      archiveStore,
      createAgentRuntime,
      sessionManager: sessionGateway([sessionRecord(sessionId)]),
      heartbeatIntervalMs: 60_000,
    });

    const clearing = service.clearQueue(sessionRef(sessionId));
    void clearing.catch(() => undefined);
    await archiveLookupStarted.promise;
    const stopping = service.stop(sessionRef(sessionId));
    archiveLookup.resolve(undefined);

    await expect(clearing).rejects.toThrow("Session is stopping");
    await stopping;
    expect(service.activeCount()).toBe(0);
    expect(createAgentRuntime).not.toHaveBeenCalled();
    await service.dispose();
  });

  it("does not let a qualified stop claim an id-only lookup with unknown cwd", async () => {
    const sessionId = "unknown-cwd-lookup";
    const listingStarted = deferred();
    const records = [sessionRecord(sessionId)];
    const gateway = sessionGateway(records);
    const listed = deferred<typeof records>();
    gateway.listAll = async () => {
      listingStarted.resolve();
      return listed.promise;
    };
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: TEST_AGENT_DIR,
      sessionModelRuntimeFactory: () => Promise.resolve(testModelRuntime),
      archiveStore: emptyArchiveStore(),
      createAgentRuntime: vi.fn(),
      sessionManager: gateway,
      heartbeatIntervalMs: 60_000,
    });

    const opening = service.status(sessionId);
    void opening.catch(() => undefined);
    await listingStarted.promise;
    await expect(service.stop(sessionRef(sessionId, "/wrong-workspace"))).rejects.toThrow("Session cwd mismatch");
    const stopping = service.stop(sessionId);
    listed.resolve(records);

    await expect(opening).rejects.toThrow("Session is stopping");
    await stopping;
    expect(service.activeCount()).toBe(0);
    await service.dispose();
  });

  it("rejects a wrong-cwd stop without cancelling a pending cold open", async () => {
    const sessionId = "wrong-cwd-pending-open";
    const creationStarted = deferred();
    const runtimeResult = deferred<PiSessionRuntime>();
    const fake = fakeRuntime(sessionId);
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: TEST_AGENT_DIR,
      sessionModelRuntimeFactory: () => Promise.resolve(testModelRuntime),
      createAgentRuntime: () => {
        creationStarted.resolve();
        return runtimeResult.promise;
      },
      sessionManager: sessionGateway([sessionRecord(sessionId)]),
      heartbeatIntervalMs: 60_000,
    });

    const opening = service.status(sessionRef(sessionId));
    await creationStarted.promise;
    await expect(service.stop(sessionRef(sessionId, "/wrong-workspace"))).rejects.toThrow("Session cwd mismatch");
    runtimeResult.resolve(fake.runtime);
    await expect(opening).resolves.toMatchObject({ sessionId });
    expect(service.activeCount()).toBe(1);

    await service.stop(sessionRef(sessionId));
    await service.dispose();
  });

  it("awaits every active runtime disposal before reporting aggregate teardown failures", async () => {
    const first = fakeRuntime("dispose-failure-a", { abort: () => Promise.reject(new Error("abort A failed")) });
    const second = fakeRuntime("dispose-failure-b");
    const releaseSecond = deferred();
    const originalSecondDispose = second.runtime.dispose.bind(second.runtime);
    second.runtime.dispose = async () => {
      await releaseSecond.promise;
      await originalSecondDispose();
    };
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: TEST_AGENT_DIR,
      sessionModelRuntimeFactory: () => Promise.resolve(testModelRuntime),
      createAgentRuntime: runtimeSequence(first.runtime, second.runtime),
      sessionManager: sessionGateway([]),
      heartbeatIntervalMs: 60_000,
    });

    await service.start("/workspace-a");
    await service.start("/workspace-b");
    let disposeSettled = false;
    const disposing = service.dispose().finally(() => { disposeSettled = true; });
    void disposing.catch(() => undefined);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(disposeSettled).toBe(false);

    releaseSecond.resolve();
    await expect(disposing).rejects.toThrow("Failed to dispose every active session runtime");
    expect(first.calls.dispose).toBe(1);
    expect(second.calls.dispose).toBe(1);
    expect(service.activeCount()).toBe(0);
  });

  it("binds extensions again when the SDK runtime replaces the active session", async () => {
    const hub = new CapturingSessionEventHub();
    const fake = fakeRuntime("session-1");
    const replacement = fakeRuntime("session-2");
    let replacementSessionStartText: string | undefined;
    const bindReplacementExtensions = replacement.session.bindExtensions.bind(replacement.session);
    replacement.session.bindExtensions = (bindings) => {
      replacementSessionStartText = bindings.uiContext?.theme.fg("success", "replacement started");
      return bindReplacementExtensions(bindings);
    };
    let rebindSession: ((session: PiAgentSession) => Promise<void>) | undefined;
    fake.runtime.setRebindSession = (callback) => { rebindSession = callback; };
    const service = new PiSessionService(hub, {
      agentDir: TEST_AGENT_DIR,
      sessionModelRuntimeFactory: () => Promise.resolve(testModelRuntime),
      createAgentRuntime: runtimeCreator(fake.runtime),
      sessionManager: sessionGateway([]),
      heartbeatIntervalMs: 60_000,
    });

    await service.start("/workspace");
    Object.defineProperty(fake.runtime, "session", { configurable: true, value: replacement.session });
    await rebindSession?.(replacement.session);

    expect(fake.calls.bindExtensions).toHaveLength(1);
    expect(replacement.calls.bindExtensions).toHaveLength(1);
    expect(replacementSessionStartText).toBe("replacement started");
    expect(service.activeCount()).toBe(1);
    expect(await service.status("session-2")).toMatchObject({ sessionId: "session-2" });

    await service.dispose();
  });

  it("publishes extension errors reported while binding session extensions", async () => {
    const hub = new CapturingSessionEventHub();
    const fake = fakeRuntime("extension-session", {
      bindExtensions: (bindings) => {
        bindings.onError?.({ extensionPath: "pi-mcp-adapter", event: "session_start", error: "MCP failed" });
        return Promise.resolve();
      },
    });
    const service = new PiSessionService(hub, {
      agentDir: TEST_AGENT_DIR,
      sessionModelRuntimeFactory: () => Promise.resolve(testModelRuntime),
      createAgentRuntime: runtimeCreator(fake.runtime),
      sessionManager: sessionGateway([]),
      heartbeatIntervalMs: 60_000,
    });

    await service.start("/workspace");

    expect(hub.sessionEvents).toContainEqual({
      sessionId: "extension-session",
      event: { type: "session.error", message: "pi-mcp-adapter: MCP failed" },
    });
    const extensionErrorActivity = hub.globalEvents.find((event) => event.type === "activity.update" && event.activity.sessionId === "extension-session");
    expect(extensionErrorActivity).toMatchObject({
      type: "activity.update",
      activity: { sessionId: "extension-session", phase: "error", label: "extension error", detail: "pi-mcp-adapter: MCP failed" },
    });

    await service.dispose();
  });

  it("surfaces notifications when an extension command shares a bare name with a skill", async () => {
    const hub = new CapturingSessionEventHub();
    const fake = fakeRuntime("extension-command-session", {
      resourceLoader: { getSkills: () => ({ skills: [{ name: "ctx-stats" }] }) },
    });
    let extensionNotify: ((message: string, type?: "info" | "warning" | "error") => void) | undefined;
    let extensionMode: string | undefined;
    fake.session.extensionRunner.getRegisteredCommands = () => [{ invocationName: "ctx-stats" }];
    fake.session.bindExtensions = (bindings) => {
      const uiContext = bindings.uiContext;
      extensionNotify = uiContext === undefined
        ? undefined
        : (message, type) => { uiContext.notify(message, type); };
      extensionMode = bindings.mode;
      return Promise.resolve();
    };
    fake.session.prompt = (text) => {
      if (text === "/ctx-stats") extensionNotify?.("context-mode stats", "info");
      return Promise.resolve();
    };
    const service = new PiSessionService(hub, {
      agentDir: TEST_AGENT_DIR,
      sessionModelRuntimeFactory: () => Promise.resolve(testModelRuntime),
      createAgentRuntime: runtimeCreator(fake.runtime),
      sessionManager: sessionGateway([]),
      heartbeatIntervalMs: 60_000,
    });

    await service.start("/workspace");
    await expect(service.runCommand(sessionRef("extension-command-session"), "/ctx-stats")).resolves.toEqual({ type: "done" });

    expect(extensionMode).toBe("rpc");
    const legacyEvent = hub.sessionEvents.find(({ event }) => event.type === "command.output" && event.message === "context-mode stats");
    expect(legacyEvent).toMatchObject({
      sessionId: "extension-command-session",
      event: { type: "command.output", level: "info", message: "context-mode stats" },
    });
    expect(legacyEvent?.event.type === "command.output" ? typeof legacyEvent.event.notificationId : undefined).toBe("string");
    const inboxEvent = hub.sessionEvents.find(({ event }) => event.type === "notifications.inbox");
    expect(inboxEvent).toMatchObject({
      sessionId: "extension-command-session",
      event: {
        type: "notifications.inbox",
        delta: { kind: "added", notification: { message: "context-mode stats", severity: "info" } },
      },
    });
    expect(hub.notificationSummaryEvents.at(-1)).toMatchObject({
      type: "notifications.summary",
      summary: { sessionId: "extension-command-session", retainedCount: 1, highestSeverity: "info" },
    });

    await service.dispose();
  });

  it("stores every extension notification without touching Pi session history", async () => {
    const hub = new CapturingSessionEventHub();
    const store = notificationStore();
    const branch = [{ type: "message", message: { role: "user", content: "existing" } }];
    const canonicalCwd = resolve(tmpdir(), "pi-web-notification-workspace");
    const rawEquivalentCwd = `${canonicalCwd}${sep}nested${sep}..`;
    const fake = fakeRuntime("notification-session", {
      sessionManager: fakeSessionManager(rawEquivalentCwd, {
        getSessionId: () => "notification-session",
        getBranch: () => branch,
      }),
    });
    const service = new PiSessionService(hub, {
      agentDir: TEST_AGENT_DIR,
      sessionModelRuntimeFactory: () => Promise.resolve(testModelRuntime),
      notificationStore: store,
      createAgentRuntime: runtimeCreator(fake.runtime),
      sessionManager: sessionGateway([]),
      heartbeatIntervalMs: 60_000,
    });

    await service.start(canonicalCwd);
    const notify = boundNotify(fake);
    notify("duplicate", "warning");
    notify("duplicate", "error");

    const snapshot = service.notificationInbox({ id: "notification-session", cwd: canonicalCwd });
    expect(snapshot.summary.cwd).toBe(canonicalCwd);
    expect(snapshot.notifications).toMatchObject([
      { id: "daemon-lifecycle-test:2", message: "duplicate", severity: "error" },
      { id: "daemon-lifecycle-test:1", message: "duplicate", severity: "warning" },
    ]);
    expect(fake.session.sessionManager.getBranch()).toBe(branch);
    expect(fake.session.messages).toEqual([]);
    expect(hub.sessionEvents.filter(({ event }) => event.type === "command.output")).toHaveLength(2);
    expect(hub.sessionEvents.filter(({ event }) => event.type === "notifications.inbox")).toHaveLength(2);

    await service.dispose();
  });

  it("commits clean /reload only after replacement session_start notifications use the plain-text theme", async () => {
    const hub = new CapturingSessionEventHub();
    const store = notificationStore();
    const sessionId = "runtime-reload-notifications";
    const manager = fakeSessionManager("/workspace", { getSessionId: () => sessionId });
    const first = fakeRuntime(sessionId, { sessionManager: manager });
    const second = fakeRuntime(sessionId, {
      sessionManager: manager,
      bindExtensions: (bindings) => {
        const replacementStartup = bindings.uiContext?.theme.fg("error", "replacement startup") ?? "replacement startup";
        bindings.uiContext?.notify(replacementStartup, "error");
        return Promise.resolve();
      },
    });
    const createAgentRuntime = runtimeSequence(first.runtime, second.runtime);
    const service = new PiSessionService(hub, {
      agentDir: TEST_AGENT_DIR,
      sessionModelRuntimeFactory: () => Promise.resolve(testModelRuntime),
      notificationStore: store,
      createAgentRuntime,
      sessionManager: sessionGateway([sessionRecord(sessionId)]),
      heartbeatIntervalMs: 60_000,
    });

    await service.status(sessionRef(sessionId));
    const oldNotify = boundNotify(first);
    oldNotify("old notification", "warning");
    const disposeForReload = first.runtime.disposeForReload.bind(first.runtime);
    first.runtime.disposeForReload = async () => {
      oldNotify("shutdown notification", "info");
      await disposeForReload();
    };

    await expect(service.runCommand(sessionRef(sessionId), "/reload")).resolves.toMatchObject({ type: "done" });

    expect(service.notificationInbox(sessionRef(sessionId))).toMatchObject({
      summary: { retainedCount: 1, discardedCount: 0, highestSeverity: "error" },
      notifications: [{ message: "replacement startup", severity: "error" }],
    });
    expect(first.calls.bindExtensions).toHaveLength(1);
    const revision = service.notificationInbox(sessionRef(sessionId)).summary.inboxRevision;
    oldNotify("stale old runner", "error");
    expect(service.notificationInbox(sessionRef(sessionId)).summary.inboxRevision).toBe(revision);

    await service.dispose();
  });

  it("preserves prior and candidate notifications but removes a failed clean reload candidate", async () => {
    const store = notificationStore();
    const sessionId = "failed-runtime-reload";
    const manager = fakeSessionManager("/workspace", { getSessionId: () => sessionId });
    const first = fakeRuntime(sessionId, { sessionManager: manager });
    let notifyFromFailedCandidate: (() => void) | undefined;
    const failed = fakeRuntime(sessionId, {
      sessionManager: manager,
      bindExtensions: (bindings) => {
        bindings.uiContext?.notify("candidate before failure", "warning");
        notifyFromFailedCandidate = () => { bindings.uiContext?.notify("stale disposed candidate", "error"); };
        return Promise.reject(new Error("reload failed after rotation"));
      },
    });
    const failedRecovery = fakeRuntime(sessionId, {
      sessionManager: manager,
      bindExtensions: () => Promise.reject(new Error("recovery bind failed")),
    });
    const recovered = fakeRuntime(sessionId, { sessionManager: manager });
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: TEST_AGENT_DIR,
      sessionModelRuntimeFactory: () => Promise.resolve(testModelRuntime),
      notificationStore: store,
      createAgentRuntime: runtimeSequence(first.runtime, failed.runtime, failedRecovery.runtime, recovered.runtime),
      sessionManager: sessionGateway([sessionRecord(sessionId)]),
      heartbeatIntervalMs: 60_000,
    });

    await service.status(sessionRef(sessionId));
    boundNotify(first)("prior", "info");

    await expect(service.runCommand(sessionRef(sessionId), "/reload")).resolves.toEqual({
      type: "unsupported",
      message: "Reload failed: reload failed after rotation",
    });
    expect(service.notificationInbox(sessionRef(sessionId)).notifications.map((notification) => notification.message)).toEqual([
      "candidate before failure",
      "prior",
    ]);
    expect(service.activeCount()).toBe(0);
    expect(failed.calls.abort).toBe(1);
    expect(failed.calls.dispose).toBe(1);
    const failedInboxRevision = service.notificationInbox(sessionRef(sessionId)).summary.inboxRevision;
    notifyFromFailedCandidate?.();
    expect(service.notificationInbox(sessionRef(sessionId)).summary.inboxRevision).toBe(failedInboxRevision);
    await expect(service.status(sessionRef(sessionId))).rejects.toThrow("recovery bind failed");
    const failedRecoveryRevision = service.notificationInbox(sessionRef(sessionId)).summary.inboxRevision;
    notifyFromFailedCandidate?.();
    expect(service.notificationInbox(sessionRef(sessionId)).summary.inboxRevision).toBe(failedRecoveryRevision);
    await expect(service.status(sessionRef(sessionId))).resolves.toMatchObject({ sessionId });
    expect(service.activeCount()).toBe(1);

    await service.dispose();
  });

  it("leaves the prior runtime and inbox unchanged when reload shutdown fails before invalidation", async () => {
    const store = notificationStore();
    const sessionId = "failed-before-rotation";
    const first = fakeRuntime(sessionId);
    const createAgentRuntime = vi.fn(runtimeCreator(first.runtime));
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: TEST_AGENT_DIR,
      sessionModelRuntimeFactory: () => Promise.resolve(testModelRuntime),
      notificationStore: store,
      createAgentRuntime,
      sessionManager: sessionGateway([sessionRecord(sessionId)]),
      heartbeatIntervalMs: 60_000,
    });

    await service.status(sessionRef(sessionId));
    boundNotify(first)("prior", "warning");
    const before = service.notificationInbox(sessionRef(sessionId));
    first.runtime.disposeForReload = () => Promise.reject(new Error("reload failed before invalidation"));

    await expect(service.runCommand(sessionRef(sessionId), "/reload")).resolves.toEqual({
      type: "unsupported",
      message: "Reload failed: reload failed before invalidation",
    });
    expect(service.notificationInbox(sessionRef(sessionId))).toEqual(before);
    expect(service.activeCount()).toBe(1);
    expect(createAgentRuntime).toHaveBeenCalledOnce();

    await service.dispose();
  });

  it("rejects clean /reload without side effects when the active Pi context has no messages", async () => {
    const sessionId = "empty-runtime-reload";
    const manager = fakeSessionManager("/workspace", {
      getSessionId: () => sessionId,
      buildSessionContext: () => ({ messages: [] }),
    });
    const first = fakeRuntime(sessionId, { sessionManager: manager });
    const createAgentRuntime = vi.fn(runtimeCreator(first.runtime));
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: TEST_AGENT_DIR,
      sessionModelRuntimeFactory: () => Promise.resolve(testModelRuntime),
      createAgentRuntime,
      sessionManager: sessionGateway([sessionRecord(sessionId)]),
      heartbeatIntervalMs: 60_000,
    });

    await service.status(sessionRef(sessionId));
    await expect(service.runCommand(sessionRef(sessionId), "/reload")).resolves.toEqual({
      type: "unsupported",
      message: "Reload failed: Cannot reload while the active session context has no messages. Close and reopen a new session, or navigate to a message-bearing tree entry, reload, then navigate back.",
    });

    expect(createAgentRuntime).toHaveBeenCalledOnce();
    expect(first.calls.disposeForReload).toBe(0);
    expect(first.calls.dispose).toBe(0);
    expect(first.calls.bindExtensions).toHaveLength(1);
    expect(service.activeCount()).toBe(1);
    await service.dispose();
  });

  it("keeps replacement candidates read-invisible until clean reload activation is stable", async () => {
    const sessionId = "read-gated-reload";
    const manager = fakeSessionManager("/workspace", { getSessionId: () => sessionId });
    const first = fakeRuntime(sessionId, { sessionManager: manager, sessionName: "prior" });
    const bindStarted = deferred();
    const releaseBind = deferred();
    const second = fakeRuntime(sessionId, {
      sessionManager: manager,
      sessionName: "candidate",
      thinkingLevel: "high",
      bindExtensions: async () => {
        bindStarted.resolve();
        await releaseBind.promise;
      },
    });
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: TEST_AGENT_DIR,
      sessionModelRuntimeFactory: () => Promise.resolve(testModelRuntime),
      createAgentRuntime: runtimeSequence(first.runtime, second.runtime),
      sessionManager: sessionGateway([sessionRecord(sessionId)]),
      heartbeatIntervalMs: 60_000,
    });

    await service.status(sessionRef(sessionId));
    const reloading = service.runCommand(sessionRef(sessionId), "/reload");
    await bindStarted.promise;
    let readSettled = false;
    const reading = service.status(sessionRef(sessionId)).finally(() => { readSettled = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(readSettled).toBe(false);

    releaseBind.resolve();
    await expect(reloading).resolves.toMatchObject({ type: "done" });
    await expect(reading).resolves.toMatchObject({ sessionId, thinkingLevel: "high" });
    await service.dispose();
  });

  it("lets stop win permanently over a clean reload candidate", async () => {
    const sessionId = "stop-wins-reload";
    const manager = fakeSessionManager("/workspace", { getSessionId: () => sessionId });
    const first = fakeRuntime(sessionId, { sessionManager: manager });
    const bindStarted = deferred();
    const releaseBind = deferred();
    const second = fakeRuntime(sessionId, {
      sessionManager: manager,
      bindExtensions: async () => {
        bindStarted.resolve();
        await releaseBind.promise;
      },
    });
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: TEST_AGENT_DIR,
      sessionModelRuntimeFactory: () => Promise.resolve(testModelRuntime),
      createAgentRuntime: runtimeSequence(first.runtime, second.runtime),
      sessionManager: sessionGateway([sessionRecord(sessionId)]),
      heartbeatIntervalMs: 60_000,
    });

    await service.status(sessionRef(sessionId));
    const reloading = service.runCommand(sessionRef(sessionId), "/reload");
    await bindStarted.promise;
    const stopping = service.stop(sessionRef(sessionId));
    await expect(service.status(sessionRef(sessionId))).rejects.toThrow("Session is stopping");
    releaseBind.resolve();

    await expect(reloading).resolves.toEqual({ type: "unsupported", message: "Reload failed: Session is stopping" });
    await stopping;
    expect(service.activeCount()).toBe(0);
    expect(second.calls.abort).toBe(1);
    expect(second.calls.dispose).toBe(1);
    await service.dispose();
  });

  it("disposes every candidate exactly once when daemon disposal overlaps clean reload", async () => {
    const sessionId = "dispose-overlap-reload";
    const manager = fakeSessionManager("/workspace", { getSessionId: () => sessionId });
    const first = fakeRuntime(sessionId, { sessionManager: manager });
    const bindStarted = deferred();
    const releaseBind = deferred();
    const second = fakeRuntime(sessionId, {
      sessionManager: manager,
      bindExtensions: async () => {
        bindStarted.resolve();
        await releaseBind.promise;
      },
    });
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: TEST_AGENT_DIR,
      sessionModelRuntimeFactory: () => Promise.resolve(testModelRuntime),
      createAgentRuntime: runtimeSequence(first.runtime, second.runtime),
      sessionManager: sessionGateway([sessionRecord(sessionId)]),
      heartbeatIntervalMs: 60_000,
    });

    await service.status(sessionRef(sessionId));
    const reloading = service.runCommand(sessionRef(sessionId), "/reload");
    await bindStarted.promise;
    const disposing = service.dispose();
    releaseBind.resolve();

    await expect(reloading).resolves.toEqual({ type: "unsupported", message: "Reload failed: Session service is shutting down" });
    await disposing;
    expect(service.activeCount()).toBe(0);
    expect(first.calls.disposeForReload).toBe(1);
    expect(second.calls.abort).toBe(1);
    expect(second.calls.dispose).toBe(1);
  });

  it("drops the invalidated generation when clean reload construction fails", async () => {
    const sessionId = "reload-construction-failure";
    const store = notificationStore();
    const first = fakeRuntime(sessionId);
    let createCalls = 0;
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: TEST_AGENT_DIR,
      sessionModelRuntimeFactory: () => Promise.resolve(testModelRuntime),
      notificationStore: store,
      createAgentRuntime: () => {
        createCalls += 1;
        return createCalls === 1
          ? Promise.resolve(first.runtime)
          : Promise.reject(new Error("replacement construction failed"));
      },
      sessionManager: sessionGateway([sessionRecord(sessionId)]),
      heartbeatIntervalMs: 60_000,
    });

    await service.status(sessionRef(sessionId));
    const staleNotify = boundNotify(first);
    staleNotify("prior", "info");
    await expect(service.runCommand(sessionRef(sessionId), "/reload")).resolves.toEqual({
      type: "unsupported",
      message: "Reload failed: replacement construction failed",
    });
    expect(service.activeCount()).toBe(0);
    expect(first.calls.disposeForReload).toBe(1);
    expect(first.calls.dispose).toBe(0);
    const failedRevision = service.notificationInbox(sessionRef(sessionId)).summary.inboxRevision;
    staleNotify("stale after construction failure", "error");
    expect(service.notificationInbox(sessionRef(sessionId)).summary.inboxRevision).toBe(failedRevision);
    await service.dispose();
  });

  it("commits changed-id SDK rebind notifications only after binding succeeds", async () => {
    const store = notificationStore();
    const first = fakeRuntime("session-1");
    const replacement = fakeRuntime("session-2", {
      bindExtensions: (bindings) => {
        bindings.uiContext?.notify("replacement startup", "error");
        return Promise.resolve();
      },
    });
    let rebindSession: ((session: PiAgentSession) => Promise<void>) | undefined;
    first.runtime.setRebindSession = (callback) => { rebindSession = callback; };
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: TEST_AGENT_DIR,
      sessionModelRuntimeFactory: () => Promise.resolve(testModelRuntime),
      notificationStore: store,
      createAgentRuntime: runtimeCreator(first.runtime),
      sessionManager: sessionGateway([]),
      heartbeatIntervalMs: 60_000,
    });

    await service.start("/workspace");
    const staleNotify = boundNotify(first);
    staleNotify("old", "warning");
    Object.defineProperty(first.runtime, "session", { configurable: true, value: replacement.session });
    await rebindSession?.(replacement.session);

    expect(() => service.notificationInbox(sessionRef("session-1"))).toThrow("Session not found");
    expect(service.notificationInbox(sessionRef("session-2"))).toMatchObject({
      notifications: [{ message: "replacement startup", severity: "error" }],
    });
    const revision = service.notificationInbox(sessionRef("session-2")).summary.inboxRevision;
    staleNotify("stale", "error");
    expect(service.notificationInbox(sessionRef("session-2")).summary.inboxRevision).toBe(revision);

    await service.dispose();
  });

  it("removes an invalidated SDK runtime when changed-id replacement binding fails", async () => {
    const store = notificationStore();
    const first = fakeRuntime("session-1");
    const bindStarted = deferred();
    const releaseBind = deferred();
    let notifyFromFailedReplacement: (() => void) | undefined;
    const replacement = fakeRuntime("session-2");
    replacement.session.bindExtensions = async (bindings) => {
      replacement.session.extensionRunner.setUIContext(bindings.uiContext, "rpc");
      bindings.uiContext?.notify("candidate before bind failure", "warning");
      notifyFromFailedReplacement = () => { bindings.uiContext?.notify("stale changed-id candidate", "error"); };
      bindStarted.resolve();
      await releaseBind.promise;
      throw new Error("replacement bind failed");
    };
    let rebindSession: ((session: PiAgentSession) => Promise<void>) | undefined;
    let beforeSessionInvalidate: (() => void) | undefined;
    first.runtime.setRebindSession = (callback) => { rebindSession = callback; };
    first.runtime.setBeforeSessionInvalidate = (callback) => { beforeSessionInvalidate = callback; };
    first.runtime.fork = async () => {
      beforeSessionInvalidate?.();
      Object.defineProperty(first.runtime, "session", { configurable: true, value: replacement.session });
      await rebindSession?.(replacement.session);
      return { cancelled: false };
    };
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: TEST_AGENT_DIR,
      sessionModelRuntimeFactory: () => Promise.resolve(testModelRuntime),
      notificationStore: store,
      createAgentRuntime: runtimeCreator(first.runtime),
      sessionManager: sessionGateway([]),
      heartbeatIntervalMs: 60_000,
    });

    await service.start("/workspace");
    boundNotify(first)("prior", "info");
    const replacing = service.runCommand(sessionRef("session-1"), "/clone");
    await bindStarted.promise;
    let readSettled = false;
    const readingReplacement = service.status(sessionRef("session-2")).finally(() => { readSettled = true; });
    void readingReplacement.catch(() => undefined);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(readSettled).toBe(false);
    releaseBind.resolve();
    await expect(replacing).rejects.toThrow("replacement bind failed");
    await expect(readingReplacement).rejects.toThrow("replacement bind failed");

    expect(service.activeCount()).toBe(0);
    expect(service.notificationInbox(sessionRef("session-1")).notifications.map((notification) => notification.message)).toEqual([
      "candidate before bind failure",
      "prior",
    ]);
    expect(() => service.notificationInbox(sessionRef("session-2"))).toThrow("Session not found");
    const failedReplacementRevision = service.notificationInbox(sessionRef("session-1")).summary.inboxRevision;
    notifyFromFailedReplacement?.();
    expect(service.notificationInbox(sessionRef("session-1")).summary.inboxRevision).toBe(failedReplacementRevision);
    expect(first.calls.dispose).toBe(1);

    await service.dispose();
  });

  it("discovers a changed-id lifecycle alias before Pi reaches invalidation and rebind", async () => {
    const first = fakeRuntime("pre-rebind-origin");
    const replacement = fakeRuntime("pre-rebind-target");
    const managerMutated = deferred();
    const releaseInvalidation = deferred();
    let rebindSession: ((session: PiAgentSession) => Promise<void>) | undefined;
    let beforeSessionInvalidate: (() => void) | undefined;
    first.runtime.setRebindSession = (callback) => { rebindSession = callback; };
    first.runtime.setBeforeSessionInvalidate = (callback) => { beforeSessionInvalidate = callback; };
    first.runtime.fork = async () => {
      Object.defineProperty(first.runtime, "session", { configurable: true, value: replacement.session });
      managerMutated.resolve();
      await releaseInvalidation.promise;
      beforeSessionInvalidate?.();
      await rebindSession?.(replacement.session);
      return { cancelled: false };
    };
    const createAgentRuntime = vi.fn(runtimeCreator(first.runtime));
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: TEST_AGENT_DIR,
      sessionModelRuntimeFactory: () => Promise.resolve(testModelRuntime),
      createAgentRuntime,
      sessionManager: sessionGateway([]),
      heartbeatIntervalMs: 60_000,
    });

    await service.start("/workspace");
    const replacing = service.runCommand(sessionRef("pre-rebind-origin"), "/clone");
    await managerMutated.promise;
    const readingTarget = service.status(sessionRef("pre-rebind-target"));
    void readingTarget.catch(() => undefined);
    const stopping = service.stop(sessionRef("pre-rebind-target"));
    releaseInvalidation.resolve();

    await expect(replacing).rejects.toThrow("Session is stopping");
    await expect(readingTarget).rejects.toThrow("Session is stopping");
    await stopping;
    expect(service.activeCount()).toBe(0);
    expect(createAgentRuntime).toHaveBeenCalledTimes(1);
    await service.dispose();
  });

  it("holds a listable changed-id target behind the cwd lifecycle before rebind reveals it", async () => {
    const first = fakeRuntime("hidden-target-origin");
    const replacement = fakeRuntime("hidden-target");
    const replacementPaused = deferred();
    const releaseReplacement = deferred();
    let rebindSession: ((session: PiAgentSession) => Promise<void>) | undefined;
    let beforeSessionInvalidate: (() => void) | undefined;
    first.runtime.setRebindSession = (callback) => { rebindSession = callback; };
    first.runtime.setBeforeSessionInvalidate = (callback) => { beforeSessionInvalidate = callback; };
    first.runtime.fork = async () => {
      replacementPaused.resolve();
      await releaseReplacement.promise;
      beforeSessionInvalidate?.();
      Object.defineProperty(first.runtime, "session", { configurable: true, value: replacement.session });
      await rebindSession?.(replacement.session);
      return { cancelled: false };
    };
    const createAgentRuntime = vi.fn(runtimeCreator(first.runtime));
    const listStarted = deferred();
    const gateway = sessionGateway([sessionRecord("hidden-target")]);
    gateway.list = () => {
      listStarted.resolve();
      return Promise.resolve([sessionRecord("hidden-target")]);
    };
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: TEST_AGENT_DIR,
      sessionModelRuntimeFactory: () => Promise.resolve(testModelRuntime),
      createAgentRuntime,
      sessionManager: gateway,
      heartbeatIntervalMs: 60_000,
    });

    await service.start("/workspace");
    const replacing = service.runCommand(sessionRef("hidden-target-origin"), "/clone");
    await replacementPaused.promise;
    const readingTarget = service.status(sessionRef("hidden-target"));
    void readingTarget.catch(() => undefined);
    await listStarted.promise;
    const stopping = service.stop(sessionRef("hidden-target"));
    releaseReplacement.resolve();

    await expect(replacing).rejects.toThrow("Session is stopping");
    await expect(readingTarget).rejects.toThrow("Session is stopping");
    await stopping;
    expect(service.activeCount()).toBe(0);
    expect(createAgentRuntime).toHaveBeenCalledTimes(1);
    await service.dispose();
  });

  it("propagates origin stop intent across a synchronously applied changed-id replacement", async () => {
    const first = fakeRuntime("stop-origin");
    const replacement = fakeRuntime("stop-target");
    const replacementApplied = deferred();
    const releaseReplacement = deferred();
    let rebindSession: ((session: PiAgentSession) => Promise<void>) | undefined;
    let beforeSessionInvalidate: (() => void) | undefined;
    first.runtime.setRebindSession = (callback) => { rebindSession = callback; };
    first.runtime.setBeforeSessionInvalidate = (callback) => { beforeSessionInvalidate = callback; };
    first.runtime.fork = async () => {
      // Pi may expose the new manager/session before firing the host boundary.
      Object.defineProperty(first.runtime, "session", { configurable: true, value: replacement.session });
      beforeSessionInvalidate?.();
      await rebindSession?.(replacement.session);
      replacementApplied.resolve();
      await releaseReplacement.promise;
      return { cancelled: false };
    };
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: TEST_AGENT_DIR,
      sessionModelRuntimeFactory: () => Promise.resolve(testModelRuntime),
      createAgentRuntime: runtimeCreator(first.runtime),
      sessionManager: sessionGateway([]),
      heartbeatIntervalMs: 60_000,
    });

    await service.start("/workspace");
    const replacing = service.runCommand(sessionRef("stop-origin"), "/clone");
    await replacementApplied.promise;
    const readingTarget = service.status(sessionRef("stop-target"));
    void readingTarget.catch(() => undefined);
    const stopping = service.stop(sessionRef("stop-origin"));
    releaseReplacement.resolve();

    await expect(replacing).resolves.toMatchObject({ type: "done" });
    await expect(readingTarget).rejects.toThrow("Session is stopping");
    await stopping;
    expect(service.activeCount()).toBe(0);
    expect(first.calls.dispose).toBe(1);
    await service.dispose();
  });

  it("clears stale active activity once a previously active session becomes idle", async () => {
    vi.useFakeTimers();
    let service: PiSessionService | undefined;
    try {
      const hub = new CapturingSessionEventHub();
      let listener: ((event: unknown) => void) | undefined;
      const fake = fakeRuntime("idle-session", {
        isStreaming: true,
        subscribe: (next) => {
          listener = next;
          return () => undefined;
        },
      });
      service = new PiSessionService(hub, {
        agentDir: TEST_AGENT_DIR,
        sessionModelRuntimeFactory: () => Promise.resolve(testModelRuntime),
        createAgentRuntime: runtimeCreator(fake.runtime),
        sessionManager: sessionGateway([sessionRecord("idle-session")]),
        heartbeatIntervalMs: 1_000,
      });

      await service.status(sessionRef("idle-session"));
      hub.globalEvents.length = 0;
      listener?.({ type: "agent_start" });

      const activityPhases = () => hub.globalEvents
        .filter((event) => event.type === "activity.update")
        .map((event) => event.activity.phase);
      expect(activityPhases()).toEqual(["active"]);

      fake.session.isStreaming = false;
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.advanceTimersByTimeAsync(1_000);

      expect(activityPhases()).toEqual(["active", "idle"]);
    } finally {
      await service?.dispose();
      vi.useRealTimers();
    }
  });

  it("publishes idle activity for SDK completion events", async () => {
    const hub = new CapturingSessionEventHub();
    let listener: ((event: unknown) => void) | undefined;
    const fake = fakeRuntime("completion-session", {
      subscribe: (next) => {
        listener = next;
        return () => undefined;
      },
    });
    const service = new PiSessionService(hub, {
      agentDir: TEST_AGENT_DIR,
      sessionModelRuntimeFactory: () => Promise.resolve(testModelRuntime),
      createAgentRuntime: runtimeCreator(fake.runtime),
      sessionManager: sessionGateway([sessionRecord("completion-session")]),
      heartbeatIntervalMs: 60_000,
    });

    await service.status(sessionRef("completion-session"));
    hub.globalEvents.length = 0;
    listener?.({ type: "tool_execution_end", toolName: "read", isError: false });

    expect(hub.globalEvents.filter((event) => event.type === "activity.update")).toMatchObject([
      { activity: { sessionId: "completion-session", phase: "idle", label: "tool complete", detail: "read" } },
    ]);

    await service.dispose();
  });

  it("uses injected archive and session-manager gateways for listing", async () => {
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: TEST_AGENT_DIR,
      sessionModelRuntimeFactory: () => Promise.resolve(testModelRuntime),
      archiveStore: {
        list: () => Promise.resolve([{ sessionId: "archived", cwd: "/workspace", archivedAt: "2026-01-01T00:00:00.000Z" }]),
        get: () => Promise.resolve(undefined),
        archive: () => Promise.resolve({ sessionId: "archived", cwd: "/workspace", archivedAt: "2026-01-01T00:00:00.000Z" }),
        restore: () => Promise.resolve(),
        isArchived: () => Promise.resolve(false),
      },
      sessionManager: {
        create: () => fakeSessionManager(),
        list: () => Promise.resolve([
          { ...sessionRecord("active"), messageCount: 1, firstMessage: "hello", allMessagesText: "hello" },
          { ...sessionRecord("archived"), messageCount: 2, firstMessage: "bye", allMessagesText: "bye" },
        ]),
        open: () => fakeSessionManager(),
      },
      heartbeatIntervalMs: 60_000,
    });

    const sessions = await service.list("/workspace");
    expect(sessions).toHaveLength(2);
    expect(sessions[0]).toMatchObject({ id: "active", persisted: true });
    expect(sessions[0]?.archived).toBeUndefined();
    expect(sessions[1]).toMatchObject({ id: "archived", archived: true, archivedAt: "2026-01-01T00:00:00.000Z" });

    await service.dispose();
  });

  it("lists archived records that have been moved out of the active session directory", async () => {
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: TEST_AGENT_DIR,
      sessionModelRuntimeFactory: () => Promise.resolve(testModelRuntime),
      archiveStore: {
        list: () => Promise.resolve([{ sessionId: "archived", cwd: "/workspace", archivedAt: "2026-01-02T00:00:00.000Z", originalPath: "/sessions/archived.jsonl", archivePath: "/archive/archived.jsonl", created: "2026-01-01T00:00:00.000Z", modified: "2026-01-01T00:01:00.000Z", messageCount: 2, firstMessage: "bye" }]),
        get: () => Promise.resolve(undefined),
        archive: () => { throw new Error("archive should not be called for moved records"); },
        restore: () => Promise.resolve(),
        isArchived: () => Promise.resolve(false),
      },
      sessionManager: {
        create: () => fakeSessionManager(),
        list: () => Promise.resolve([{ ...sessionRecord("active"), messageCount: 1, firstMessage: "hello", allMessagesText: "hello" }]),
        open: () => fakeSessionManager(),
      },
      heartbeatIntervalMs: 60_000,
    });

    const sessions = await service.list("/workspace");

    expect(sessions).toHaveLength(2);
    expect(sessions[0]).toMatchObject({ id: "active" });
    expect(sessions[0]?.archived).toBeUndefined();
    expect(sessions[1]).toMatchObject({ id: "archived", path: "/sessions/archived.jsonl", archived: true, archivedAt: "2026-01-02T00:00:00.000Z" });

    await service.dispose();
  });


  it("keeps notifications on abort but clears and unregisters them on stop", async () => {
    const hub = new CapturingSessionEventHub();
    const store = notificationStore();
    const fake = fakeRuntime("stop-notification-session");
    const service = new PiSessionService(hub, {
      agentDir: TEST_AGENT_DIR,
      sessionModelRuntimeFactory: () => Promise.resolve(testModelRuntime),
      notificationStore: store,
      createAgentRuntime: runtimeCreator(fake.runtime),
      sessionManager: sessionGateway([sessionRecord("stop-notification-session")]),
      heartbeatIntervalMs: 60_000,
    });

    await service.status(sessionRef("stop-notification-session"));
    boundNotify(fake)("keep through abort", "warning");
    await service.abort(sessionRef("stop-notification-session"));
    expect(service.notificationInbox(sessionRef("stop-notification-session")).summary.retainedCount).toBe(1);
    await expect(service.stop(sessionRef("stop-notification-session", "/other"))).rejects.toThrow("Session cwd mismatch");
    expect(service.activeCount()).toBe(1);

    await service.stop(sessionRef("stop-notification-session"));
    expect(() => service.notificationInbox(sessionRef("stop-notification-session"))).toThrow("Session not found");
    expect(service.notificationCatalog().sessions).toEqual([]);
    expect(hub.notificationSummaryEvents.at(-1)).toMatchObject({ summary: { sessionId: "stop-notification-session", retainedCount: 0 } });

    await service.dispose();
  });

  it("runs /reload by replacing the active runtime with a clean generation", async () => {
    const hub = new CapturingSessionEventHub();
    const sessionId = "runtime-reload-session";
    const manager = fakeSessionManager("/workspace", { getSessionId: () => sessionId });
    const first = fakeRuntime(sessionId, { sessionManager: manager });
    const second = fakeRuntime(sessionId, { sessionManager: manager });
    const createAgentRuntime = vi.fn(runtimeSequence(first.runtime, second.runtime));
    const service = new PiSessionService(hub, {
      agentDir: TEST_AGENT_DIR,
      sessionModelRuntimeFactory: () => Promise.resolve(testModelRuntime),
      createAgentRuntime,
      sessionManager: sessionGateway([sessionRecord(sessionId)]),
      heartbeatIntervalMs: 60_000,
    });

    await service.status(sessionRef(sessionId));
    await expect(service.runCommand(sessionRef(sessionId), "/reload")).resolves.toEqual({
      type: "done",
      message: "Session runtime resources reloaded. Extensions, skills, prompt templates, themes, and context/system prompt files are refreshed for this session. Reload the browser page separately for PI WEB browser plugin changes.",
    });

    expect(createAgentRuntime).toHaveBeenCalledTimes(2);
    expect(createAgentRuntime.mock.calls[1]?.[1]).toMatchObject({
      sessionManager: manager,
      sessionStartEvent: { type: "session_start", reason: "reload" },
      activeToolNames: ["read", "bash", "edit", "write"],
    });
    expect(first.calls.disposeForReload).toBe(1);
    expect(first.calls.abort).toBe(0);
    expect(first.calls.dispose).toBe(0);
    expect(second.calls.bindExtensions).toHaveLength(1);
    expect(hub.globalEvents.some((event) => event.type === "activity.update" && event.activity.sessionId === sessionId && event.activity.label === "resources reloaded")).toBe(true);
    expect(hub.globalEvents.some((event) => event.type === "status.update" && event.status.sessionId === sessionId)).toBe(true);

    await service.dispose();
    expect(second.calls.dispose).toBe(1);
  });

  it("reloads a session by closing the active runtime and re-opening it from disk", async () => {
    const first = fakeRuntime("reload-session");
    const second = fakeRuntime("reload-session");
    const runtimes = [first.runtime, second.runtime];
    let createCalls = 0;
    const createAgentRuntime: RuntimeCreator = async () => {
      await Promise.resolve();
      const runtime = runtimes[createCalls];
      createCalls += 1;
      if (runtime === undefined) throw new Error("unexpected runtime creation");
      return runtime;
    };
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: TEST_AGENT_DIR,
      sessionModelRuntimeFactory: () => Promise.resolve(testModelRuntime),
      createAgentRuntime,
      sessionManager: sessionGateway([sessionRecord("reload-session")]),
      heartbeatIntervalMs: 60_000,
    });

    // Open once so there is an active runtime to reload.
    await service.status(sessionRef("reload-session"));
    expect(createCalls).toBe(1);

    await expect(service.reload(sessionRef("reload-session"))).resolves.toBeUndefined();

    // The original runtime was torn down and a fresh one opened from disk.
    expect(first.calls.abort).toBe(1);
    expect(first.calls.dispose).toBe(1);
    expect(createCalls).toBe(2);
    expect(service.activeCount()).toBe(1);

    await service.dispose();
  });

  it("lets stop win over a route-level close-and-reopen reload", async () => {
    const sessionId = "stop-wins-disk-reload";
    const first = fakeRuntime(sessionId);
    const second = fakeRuntime(sessionId);
    const disposalStarted = deferred();
    const releaseDisposal = deferred();
    const originalDispose = first.runtime.dispose.bind(first.runtime);
    first.runtime.dispose = async () => {
      disposalStarted.resolve();
      await releaseDisposal.promise;
      await originalDispose();
    };
    const createAgentRuntime = vi.fn(runtimeSequence(first.runtime, second.runtime));
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: TEST_AGENT_DIR,
      sessionModelRuntimeFactory: () => Promise.resolve(testModelRuntime),
      createAgentRuntime,
      sessionManager: sessionGateway([sessionRecord(sessionId)]),
      heartbeatIntervalMs: 60_000,
    });

    await service.status(sessionRef(sessionId));
    const reloading = service.reload(sessionRef(sessionId));
    await disposalStarted.promise;
    const stopping = service.stop(sessionRef(sessionId));
    releaseDisposal.resolve();

    await expect(reloading).rejects.toThrow("Session is stopping");
    await stopping;
    expect(createAgentRuntime).toHaveBeenCalledOnce();
    expect(service.activeCount()).toBe(0);
    expect(first.calls.dispose).toBe(1);
    expect(second.calls.dispose).toBe(0);
    await service.dispose();
  });

  it("reload-from-disk keeps replacement startup notifications and clears the old inbox on success", async () => {
    const store = notificationStore();
    const first = fakeRuntime("reload-notification-session");
    const second = fakeRuntime("reload-notification-session", {
      bindExtensions: (bindings) => {
        bindings.uiContext?.notify("replacement startup", "error");
        return Promise.resolve();
      },
    });
    const runtimes = [first.runtime, second.runtime];
    let createCalls = 0;
    const hub = new CapturingSessionEventHub();
    const service = new PiSessionService(hub, {
      agentDir: TEST_AGENT_DIR,
      sessionModelRuntimeFactory: () => Promise.resolve(testModelRuntime),
      notificationStore: store,
      createAgentRuntime: () => {
        const runtime = runtimes[createCalls++];
        return runtime === undefined ? Promise.reject(new Error("unexpected runtime creation")) : Promise.resolve(runtime);
      },
      sessionManager: sessionGateway([sessionRecord("reload-notification-session")]),
      heartbeatIntervalMs: 60_000,
    });

    await service.status(sessionRef("reload-notification-session"));
    const oldNotify = boundNotify(first);
    oldNotify("old", "warning");
    const disposeFirst = first.runtime.dispose.bind(first.runtime);
    first.runtime.dispose = async () => {
      oldNotify("old shutdown", "info");
      await disposeFirst();
    };
    await service.reload(sessionRef("reload-notification-session"));

    expect(service.notificationInbox(sessionRef("reload-notification-session"))).toMatchObject({
      summary: { retainedCount: 1, highestSeverity: "error" },
      notifications: [{ message: "replacement startup", severity: "error" }],
    });
    expect(hub.sessionEvents.some(({ event }) => event.type === "notifications.inbox" && event.delta.kind === "added" && event.delta.notification.message === "old shutdown")).toBe(true);
    const successRevision = service.notificationInbox(sessionRef("reload-notification-session")).summary.inboxRevision;
    oldNotify("stale old disk runtime", "error");
    expect(service.notificationInbox(sessionRef("reload-notification-session")).summary.inboxRevision).toBe(successRevision);
    await service.dispose();
  });

  it("reload-from-disk preserves prior and candidate notifications when replacement binding fails", async () => {
    const store = notificationStore();
    const first = fakeRuntime("failed-disk-reload");
    const failed = fakeRuntime("failed-disk-reload", {
      bindExtensions: (bindings) => {
        bindings.uiContext?.notify("candidate before open failure", "warning");
        return Promise.reject(new Error("replacement open failed"));
      },
    });
    const runtimes = [first.runtime, failed.runtime];
    let createCalls = 0;
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: TEST_AGENT_DIR,
      sessionModelRuntimeFactory: () => Promise.resolve(testModelRuntime),
      notificationStore: store,
      createAgentRuntime: () => {
        const runtime = runtimes[createCalls++];
        return runtime === undefined ? Promise.reject(new Error("unexpected runtime creation")) : Promise.resolve(runtime);
      },
      sessionManager: sessionGateway([sessionRecord("failed-disk-reload")]),
      heartbeatIntervalMs: 60_000,
    });

    await service.status(sessionRef("failed-disk-reload"));
    const oldNotify = boundNotify(first);
    oldNotify("prior", "info");
    const disposeFirst = first.runtime.dispose.bind(first.runtime);
    first.runtime.dispose = async () => {
      oldNotify("old shutdown", "info");
      await disposeFirst();
    };
    await expect(service.reload(sessionRef("failed-disk-reload"))).rejects.toThrow("replacement open failed");

    expect(service.notificationInbox(sessionRef("failed-disk-reload")).notifications.map((notification) => notification.message)).toEqual([
      "candidate before open failure",
      "old shutdown",
      "prior",
    ]);
    expect(service.activeCount()).toBe(0);
    const failedRevision = service.notificationInbox(sessionRef("failed-disk-reload")).summary.inboxRevision;
    oldNotify("stale after disk reload failure", "error");
    expect(service.notificationInbox(sessionRef("failed-disk-reload")).summary.inboxRevision).toBe(failedRevision);
    await service.stop(sessionRef("failed-disk-reload"));
    expect(() => service.notificationInbox(sessionRef("failed-disk-reload"))).toThrow("Session not found");
    await service.dispose();
  });

  it("reload-from-disk preserves the prior inbox when deferred close fails", async () => {
    const store = notificationStore();
    const first = fakeRuntime("failed-close-reload");
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: TEST_AGENT_DIR,
      sessionModelRuntimeFactory: () => Promise.resolve(testModelRuntime),
      notificationStore: store,
      createAgentRuntime: runtimeCreator(first.runtime),
      sessionManager: sessionGateway([sessionRecord("failed-close-reload")]),
      heartbeatIntervalMs: 60_000,
    });

    await service.status(sessionRef("failed-close-reload"));
    const oldNotify = boundNotify(first);
    oldNotify("prior", "warning");
    first.runtime.dispose = () => {
      oldNotify("shutdown before close failure", "info");
      return Promise.reject(new Error("close failed"));
    };

    await expect(service.reload(sessionRef("failed-close-reload"))).rejects.toThrow("close failed");

    expect(service.notificationInbox(sessionRef("failed-close-reload")).notifications.map((notification) => notification.message)).toEqual([
      "shutdown before close failure",
      "prior",
    ]);
    expect(store.currentGeneration("failed-close-reload", resolve("/workspace"))).toBeDefined();
    const failedCloseRevision = service.notificationInbox(sessionRef("failed-close-reload")).summary.inboxRevision;
    oldNotify("stale after close failure", "error");
    expect(service.notificationInbox(sessionRef("failed-close-reload")).summary.inboxRevision).toBe(failedCloseRevision);
    await service.stop(sessionRef("failed-close-reload"));
    await service.dispose();
  });

  it("refuses to reload a session that has active work in progress", async () => {
    const fake = fakeRuntime("busy-session", { isStreaming: true });
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: TEST_AGENT_DIR,
      sessionModelRuntimeFactory: () => Promise.resolve(testModelRuntime),
      createAgentRuntime: runtimeCreator(fake.runtime),
      sessionManager: sessionGateway([sessionRecord("busy-session")]),
      heartbeatIntervalMs: 60_000,
    });

    await expect(service.reload(sessionRef("busy-session"))).rejects.toThrow("Stop current session activity before reloading");
    expect(fake.calls.abort).toBe(0);
    expect(fake.calls.dispose).toBe(0);

    await service.dispose();
  });

  it("refuses to reload an archived session", async () => {
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: TEST_AGENT_DIR,
      sessionModelRuntimeFactory: () => Promise.resolve(testModelRuntime),
      archiveStore: {
        list: () => Promise.resolve([]),
        get: (sessionId) => Promise.resolve(sessionId === "archived" || "archived".startsWith(sessionId)
          ? { sessionId: "archived", cwd: "/workspace", archivedAt: "2026-01-02T00:00:00.000Z", archivePath: "/archive/archived.jsonl" }
          : undefined),
        archive: () => Promise.resolve({ sessionId: "archived", cwd: "/workspace", archivedAt: "2026-01-02T00:00:00.000Z" }),
        restore: () => Promise.resolve(),
        isArchived: () => Promise.resolve(true),
      },
      sessionManager: sessionGateway([]),
      heartbeatIntervalMs: 60_000,
    });

    await expect(service.reload(sessionRef("archived"))).rejects.toThrow("Archived sessions are read-only");

    await service.dispose();
  });

  it("reconciles workspace activity when listing only archived sessions", async () => {
    const reconciliations: { cwd: string; sessionIds: string[] }[] = [];
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: TEST_AGENT_DIR,
      sessionModelRuntimeFactory: () => Promise.resolve(testModelRuntime),
      archiveStore: {
        list: () => Promise.resolve([{ sessionId: "archived", cwd: "/workspace", archivedAt: "2026-01-02T00:00:00.000Z", originalPath: "/sessions/archived.jsonl", archivePath: "/archive/archived.jsonl", created: "2026-01-01T00:00:00.000Z", modified: "2026-01-01T00:01:00.000Z", messageCount: 2, firstMessage: "bye" }]),
        get: () => Promise.resolve(undefined),
        archive: () => { throw new Error("archive should not be called for moved records"); },
        restore: () => Promise.resolve(),
        isArchived: () => Promise.resolve(false),
      },
      sessionManager: {
        create: () => fakeSessionManager(),
        list: () => Promise.resolve([]),
        open: () => fakeSessionManager(),
      },
      workspaceActivity: {
        applySessionStatus: () => undefined,
        applySessionActivity: () => undefined,
        removeSession: () => undefined,
        reconcileSessionActivity: (cwd, sessionIds) => { reconciliations.push({ cwd, sessionIds: [...sessionIds] }); },
      },
      heartbeatIntervalMs: 60_000,
    });

    const sessions = await service.list("/workspace");

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ id: "archived", archived: true });
    expect(reconciliations).toEqual([{ cwd: "/workspace", sessionIds: [] }]);

    await service.dispose();
  });
});

describe("PiSessionService.streamSnapshot", () => {
  it("returns a null partial with the current watermark when idle", async () => {
    const hub = new CapturingSessionEventHub();
    const fake = fakeRuntime("snap-idle");
    const service = new PiSessionService(hub, {
      agentDir: TEST_AGENT_DIR,
      sessionModelRuntimeFactory: () => Promise.resolve(testModelRuntime),
      createAgentRuntime: runtimeCreator(fake.runtime),
      sessionManager: sessionGateway([]),
      heartbeatIntervalMs: 60_000,
    });
    try {
      await service.start("/workspace");

      const snapshot = await service.streamSnapshot(sessionRef("snap-idle"));

      expect(snapshot).toEqual({ seq: 0, partial: null });
    } finally {
      await service.dispose();
    }
  });

  it("projects the in-flight partial and matches the event watermark mid-stream", async () => {
    const hub = new CapturingSessionEventHub();
    const streamingMessage = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "weighing options", thinkingSignature: "opaque" },
        { type: "text", text: "partial answer" },
        { type: "toolCall", id: "call-1", name: "edit", arguments: { path: "a.ts" } },
      ],
    };
    const fake = fakeRuntime("snap-live", { state: { streamingMessage } });
    const service = new PiSessionService(hub, {
      agentDir: TEST_AGENT_DIR,
      sessionModelRuntimeFactory: () => Promise.resolve(testModelRuntime),
      createAgentRuntime: runtimeCreator(fake.runtime),
      sessionManager: sessionGateway([]),
      heartbeatIntervalMs: 60_000,
    });
    try {
      await service.start("/workspace");
      // Advance the per-session watermark to a known value.
      hub.setSeq("snap-live", 5);

      const snapshot = await service.streamSnapshot(sessionRef("snap-live"));

      expect(snapshot.seq).toBe(5);
      expect(snapshot.partial).toEqual({
        role: "assistant",
        content: [
          { type: "thinking", thinking: "weighing options" },
          { type: "text", text: "partial answer" },
          { type: "toolCall", id: "call-1", name: "edit", arguments: { path: "a.ts" } },
        ],
      });
      // The runtime message is not mutated by the browser projection.
      expect(streamingMessage.content[0]).toHaveProperty("thinkingSignature", "opaque");
    } finally {
      await service.dispose();
    }
  });
});
