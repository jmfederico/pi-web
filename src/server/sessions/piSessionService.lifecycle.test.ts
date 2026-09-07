import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createPiSessionManagerGateway } from "./piSessionManagerGateway.js";
import { PiSessionService, type PiAgentSession, type PiSessionRuntime, type ResolvedSessionFile } from "./piSessionService.js";
import { SessionNotificationStore } from "./sessionNotificationStore.js";
import { CapturingSessionEventHub, emptyArchiveStore, fakeRuntime, fakeSessionManager, runtimeCreator, sessionGateway, sessionRecord, sessionRef, testModelRuntime, type RuntimeCreator, type SessionGateway } from "./piSessionService.testSupport.js";

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

function currentNotify(fake: { session: Pick<PiAgentSession, "extensionRunner"> }) {
  const uiContext = fake.session.extensionRunner.getUIContext();
  return (message: string, type?: "info" | "warning" | "error") => { uiContext.notify(message, type); };
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
      modelRuntime: testModelRuntime,
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
      modelRuntime: testModelRuntime,
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
      modelRuntime: testModelRuntime,
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
    expect(messages).toEqual({ messages: [{ role: "user", content: "shared runtime" }], start: 0, total: 1 });
    expect(status).toMatchObject({ sessionId });
    expect(winnerSubscribe).toHaveBeenCalledOnce();
    expect(winnerUnsubscribe).toHaveBeenCalledOnce();
    expect(winner.calls.dispose).toBe(1);
    expect(loserSubscribe).not.toHaveBeenCalled();
    expect(loserUnsubscribe).not.toHaveBeenCalled();
    expect(loser.calls.dispose).toBe(0);
  });

  it("reads externally appended transcript entries without replacing or aborting the idle runtime", async () => {
    const sessionId = "externally-growing-session";
    const staleBranch = [{ type: "message", message: { role: "user", content: "before" } }];
    let diskBranch = [...staleBranch];
    const runtimeManager = fakeSessionManager("/workspace", {
      getSessionId: () => sessionId,
      getSessionFile: () => `/sessions/${sessionId}.jsonl`,
      getBranch: () => staleBranch,
    });
    const fake = fakeRuntime(sessionId, { sessionFile: `/sessions/${sessionId}.jsonl`, sessionManager: runtimeManager });
    const open = vi.fn(() => fakeSessionManager("/workspace", {
      getSessionId: () => sessionId,
      getSessionFile: () => `/sessions/${sessionId}.jsonl`,
      getBranch: () => diskBranch,
    }));
    const gateway: SessionGateway = {
      create: () => fakeSessionManager(),
      list: () => Promise.resolve([sessionRecord(sessionId)]),
      listAll: () => Promise.resolve([sessionRecord(sessionId)]),
      invalidateSessionFile: () => undefined,
      resolveSessionFile: () => Promise.resolve({ id: sessionId, cwd: "/workspace", path: `/sessions/${sessionId}.jsonl` }),
      readBranch: () => Promise.resolve(open().getBranch()),
      open,
    };
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: TEST_AGENT_DIR,
      modelRuntime: testModelRuntime,
      archiveStore: emptyArchiveStore(),
      createAgentRuntime: runtimeCreator(fake.runtime),
      sessionManager: gateway,
      heartbeatIntervalMs: 60_000,
    });

    await expect(service.messages(sessionRef(sessionId))).resolves.toMatchObject({
      messages: [{ role: "user", content: "before" }],
      total: 1,
    });
    diskBranch = [
      ...staleBranch,
      { type: "message", message: { role: "assistant", content: "after" } },
    ];

    await expect(service.messages(sessionRef(sessionId))).resolves.toMatchObject({
      messages: [{ role: "user", content: "before" }, { role: "assistant", content: "after" }],
      total: 2,
    });
    expect(fake.calls.abort).toBe(0);
    expect(fake.calls.dispose).toBe(0);
    expect(service.activeCount()).toBe(1);

    await service.dispose();
  });

  it("serves the live runtime branch when the known transcript file is absent on disk", async () => {
    // A session created in memory and never persisted knows its future file
    // path, but nothing exists on disk: messages/status must serve the runtime
    // branch instead of failing on the missing disk snapshot.
    const sessionId = "unpersisted-session";
    const runtimeBranch = [{ type: "message", message: { role: "user", content: "in memory only" } }];
    const fake = fakeRuntime(sessionId, {
      sessionFile: `/sessions/${sessionId}.jsonl`,
      sessionManager: fakeSessionManager("/workspace", {
        getSessionId: () => sessionId,
        getSessionFile: () => `/sessions/${sessionId}.jsonl`,
        getBranch: () => runtimeBranch,
      }),
    });
    const readBranch = vi.fn(() => Promise.resolve(undefined));
    const gateway: SessionGateway = {
      create: () => fakeSessionManager(),
      list: () => Promise.resolve([sessionRecord(sessionId)]),
      listAll: () => Promise.resolve([sessionRecord(sessionId)]),
      invalidateSessionFile: () => undefined,
      resolveSessionFile: () => Promise.resolve({ id: sessionId, cwd: "/workspace", path: `/sessions/${sessionId}.jsonl` }),
      readBranch,
      open: () => fake.session.sessionManager,
    };
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: TEST_AGENT_DIR,
      modelRuntime: testModelRuntime,
      archiveStore: emptyArchiveStore(),
      createAgentRuntime: runtimeCreator(fake.runtime),
      sessionManager: gateway,
      heartbeatIntervalMs: 60_000,
    });

    await expect(service.messages(sessionRef(sessionId))).resolves.toMatchObject({
      messages: [{ role: "user", content: "in memory only" }],
      total: 1,
    });
    await expect(service.status(sessionRef(sessionId))).resolves.toMatchObject({ sessionId, messageCount: 1 });
    expect(readBranch).toHaveBeenCalled();
    expect(fake.calls.abort).toBe(0);
    expect(fake.calls.dispose).toBe(0);

    await service.dispose();
  });

  it("resolves a file-less idle session's transcript file at most once per throttle window", async () => {
    // A session created in memory and never persisted has no transcript file:
    // each 5 s poll tick calls messages() and status(), and every call used to
    // rescan the session directory. Resolution is throttled per runtime, so
    // steady-state polling of a file-less session stays O(1).
    const sessionId = "never-persisted-session";
    const runtimeBranch = [{ type: "message", message: { role: "user", content: "in memory only" } }];
    const fake = fakeRuntime(sessionId, {
      sessionFile: undefined,
      sessionManager: fakeSessionManager("/workspace", {
        getSessionId: () => sessionId,
        getSessionFile: () => undefined,
        getBranch: () => runtimeBranch,
      }),
    });
    const resolveSessionFile = vi.fn(() => Promise.resolve(undefined));
    const readBranch = vi.fn(() => Promise.resolve(undefined));
    const gateway: SessionGateway = {
      create: () => fakeSessionManager(),
      list: () => Promise.resolve([]),
      listAll: () => Promise.resolve([]),
      invalidateSessionFile: () => undefined,
      resolveSessionFile,
      readBranch,
      open: () => fake.session.sessionManager,
    };
    let nowMs = 1_000_000;
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: TEST_AGENT_DIR,
      modelRuntime: testModelRuntime,
      archiveStore: emptyArchiveStore(),
      createAgentRuntime: runtimeCreator(fake.runtime),
      sessionManager: gateway,
      heartbeatIntervalMs: 60_000,
      now: () => new Date(nowMs),
    });
    // Activate the runtime the way a UI-created session is: in memory, never persisted.
    await service.start("/workspace");

    // Two poll ticks, each a messages() plus a status() call: one resolution total.
    await expect(service.messages(sessionRef(sessionId))).resolves.toMatchObject({ total: 1 });
    await expect(service.status(sessionRef(sessionId))).resolves.toMatchObject({ sessionId, messageCount: 1 });
    await service.messages(sessionRef(sessionId));
    await service.status(sessionRef(sessionId));
    expect(resolveSessionFile).toHaveBeenCalledTimes(1);
    expect(readBranch).not.toHaveBeenCalled();

    nowMs += 30_000;
    await service.messages(sessionRef(sessionId));
    expect(resolveSessionFile).toHaveBeenCalledTimes(2);

    await service.dispose();
  });

  it("notices a transcript file that appears after a throttled file-less resolution", async () => {
    // The throttle must not become a permanent negative cache: once the
    // window lapses, polling re-resolves and serves the new disk snapshot.
    const sessionId = "late-persisted-session";
    const runtimeBranch = [{ type: "message", message: { role: "user", content: "in memory only" } }];
    const diskBranch = [{ type: "message", message: { role: "user", content: "now on disk" } }];
    const fake = fakeRuntime(sessionId, {
      sessionFile: undefined,
      sessionManager: fakeSessionManager("/workspace", {
        getSessionId: () => sessionId,
        getSessionFile: () => undefined,
        getBranch: () => runtimeBranch,
      }),
    });
    let resolvedPath: string | undefined = undefined;
    const resolveSessionFile = vi.fn(() => Promise.resolve(
      resolvedPath === undefined ? undefined : { id: sessionId, cwd: "/workspace", path: resolvedPath },
    ));
    const readBranch = vi.fn(() => Promise.resolve(diskBranch));
    const gateway: SessionGateway = {
      create: () => fakeSessionManager(),
      list: () => Promise.resolve([]),
      listAll: () => Promise.resolve([]),
      invalidateSessionFile: () => undefined,
      resolveSessionFile,
      readBranch,
      open: () => fake.session.sessionManager,
    };
    let nowMs = 1_000_000;
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: TEST_AGENT_DIR,
      modelRuntime: testModelRuntime,
      archiveStore: emptyArchiveStore(),
      createAgentRuntime: runtimeCreator(fake.runtime),
      sessionManager: gateway,
      heartbeatIntervalMs: 60_000,
      now: () => new Date(nowMs),
    });
    await service.start("/workspace");

    await expect(service.messages(sessionRef(sessionId))).resolves.toMatchObject({
      messages: [{ role: "user", content: "in memory only" }],
    });

    // The file appears within the window: the throttled negative result still
    // serves the runtime branch, and no new resolution runs.
    resolvedPath = `/sessions/${sessionId}.jsonl`;
    await expect(service.messages(sessionRef(sessionId))).resolves.toMatchObject({
      messages: [{ role: "user", content: "in memory only" }],
    });
    expect(resolveSessionFile).toHaveBeenCalledTimes(1);
    expect(readBranch).not.toHaveBeenCalled();

    // After the window, polling re-resolves once and reads the disk snapshot;
    // the positive resolution is throttled too, while reads stay live.
    nowMs += 30_000;
    await expect(service.messages(sessionRef(sessionId))).resolves.toMatchObject({
      messages: [{ role: "user", content: "now on disk" }],
    });
    await service.messages(sessionRef(sessionId));
    expect(resolveSessionFile).toHaveBeenCalledTimes(2);
    expect(readBranch).toHaveBeenCalledTimes(2);
    expect(readBranch).toHaveBeenCalledWith(resolvedPath);

    await service.dispose();
  });

  it("keeps the live runtime authoritative when work starts during disk resolution", async () => {
    const sessionId = "becomes-active-session";
    let streaming = false;
    let finishResolve: ((match: ResolvedSessionFile) => void) | undefined;
    const resolved = new Promise<ResolvedSessionFile>((resolve) => { finishResolve = resolve; });
    const runtimeBranch = [{ type: "message", message: { role: "user", content: "live runtime" } }];
    const fake = fakeRuntime(sessionId, {
      sessionFile: undefined,
      sessionManager: fakeSessionManager("/workspace", {
        getSessionId: () => sessionId,
        getSessionFile: () => undefined,
        getBranch: () => runtimeBranch,
      }),
    });
    Object.defineProperty(fake.session, "isStreaming", { get: () => streaming });
    const readBranch = vi.fn(() => Promise.resolve([{ type: "message", message: { role: "user", content: "external disk" } }]));
    const gateway: SessionGateway = {
      create: () => fakeSessionManager(),
      list: () => Promise.resolve([sessionRecord(sessionId)]),
      listAll: () => Promise.resolve([sessionRecord(sessionId)]),
      invalidateSessionFile: () => undefined,
      resolveSessionFile: () => resolved,
      readBranch,
      open: () => fake.session.sessionManager,
    };
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: TEST_AGENT_DIR,
      modelRuntime: testModelRuntime,
      archiveStore: emptyArchiveStore(),
      createAgentRuntime: runtimeCreator(fake.runtime),
      sessionManager: gateway,
      heartbeatIntervalMs: 60_000,
    });

    const messages = service.messages(sessionRef(sessionId));
    await vi.waitFor(() => { expect(finishResolve).toBeTypeOf("function"); });
    streaming = true;
    finishResolve?.({ id: sessionId, cwd: "/workspace", path: `/sessions/${sessionId}.jsonl` });

    await expect(messages).resolves.toMatchObject({
      messages: [{ role: "user", content: "live runtime" }],
      total: 1,
    });
    expect(readBranch).not.toHaveBeenCalled();
    expect(fake.calls.abort).toBe(0);
    expect(fake.calls.dispose).toBe(0);

    await service.dispose();
  });

  it("keeps reading the live runtime while it reports active work", async () => {
    const sessionId = "active-growing-session";
    const runtimeBranch = [{ type: "message", message: { role: "user", content: "live runtime" } }];
    const fake = fakeRuntime(sessionId, {
      isStreaming: true,
      sessionFile: `/sessions/${sessionId}.jsonl`,
      sessionManager: fakeSessionManager("/workspace", {
        getSessionId: () => sessionId,
        getSessionFile: () => `/sessions/${sessionId}.jsonl`,
        getBranch: () => runtimeBranch,
      }),
    });
    const open = vi.fn(() => fakeSessionManager("/workspace", {
      getSessionId: () => sessionId,
      getBranch: () => [{ type: "message", message: { role: "user", content: "external disk" } }],
    }));
    const gateway: SessionGateway = {
      create: () => fakeSessionManager(),
      list: () => Promise.resolve([sessionRecord(sessionId)]),
      listAll: () => Promise.resolve([sessionRecord(sessionId)]),
      invalidateSessionFile: () => undefined,
      resolveSessionFile: () => Promise.resolve({ id: sessionId, cwd: "/workspace", path: `/sessions/${sessionId}.jsonl` }),
      readBranch: () => Promise.resolve(open().getBranch()),
      open,
    };
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: TEST_AGENT_DIR,
      modelRuntime: testModelRuntime,
      archiveStore: emptyArchiveStore(),
      createAgentRuntime: runtimeCreator(fake.runtime),
      sessionManager: gateway,
      heartbeatIntervalMs: 60_000,
    });

    await expect(service.messages(sessionRef(sessionId))).resolves.toMatchObject({
      messages: [{ role: "user", content: "live runtime" }],
      total: 1,
    });
    expect(open).toHaveBeenCalledOnce();
    expect(fake.calls.abort).toBe(0);
    expect(fake.calls.dispose).toBe(0);

    await service.dispose();
  });

  /**
   * Opening one known session must not depend on — or wait behind — a listing of
   * its whole workspace: `getActive` routes prompt/shell/runCommand, so a
   * `list` call here would let an in-flight listing serialize unrelated sends.
   * The rejecting `list` fake fails loudly if that coupling ever comes back.
   * Requested with an id prefix so the resolved full id, not the caller's
   * prefix, is what the session is opened under.
   */
  it("opens an inactive session by direct id resolution without listing its workspace", async () => {
    const sessionId = "direct-resolve-session";
    const fake = fakeRuntime(sessionId, {
      sessionManager: fakeSessionManager("/workspace", {
        getSessionId: () => sessionId,
        getBranch: () => [{ type: "message", message: { role: "user", content: "resolved directly" } }],
      }),
    });
    const list = vi.fn(() => Promise.reject(new Error("opening one session must not list its workspace")));
    const resolveSessionFile = vi.fn((refCwd: string, refId: string) => Promise.resolve(
      sessionId.startsWith(refId) ? { id: sessionId, cwd: refCwd, path: `/sessions/${sessionId}.jsonl` } : undefined,
    ));
    const open = vi.fn(() => fakeSessionManager());
    const gateway: SessionGateway = {
      create: () => fakeSessionManager(),
      list,
      listAll: () => Promise.resolve([]),
      invalidateSessionFile: () => undefined,
      resolveSessionFile,
      open,
    };
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: TEST_AGENT_DIR,
      modelRuntime: testModelRuntime,
      createAgentRuntime: runtimeCreator(fake.runtime),
      archiveStore: emptyArchiveStore(),
      sessionManager: gateway,
      heartbeatIntervalMs: 60_000,
    });

    const page = await service.messages(sessionRef(sessionId.slice(0, 6)));

    expect(page.messages).toEqual([{ role: "user", content: "resolved directly" }]);
    expect(resolveSessionFile).toHaveBeenCalledWith("/workspace", sessionId.slice(0, 6));
    expect(open).toHaveBeenCalledWith(`/sessions/${sessionId}.jsonl`);
    expect(list).not.toHaveBeenCalled();
    await service.dispose();
  });

  /**
   * Charter-level invariant: an id-prefix ref must never act on a different,
   * prefix-extended session. This runs through the real gateway so the whole
   * open path is covered — the service wiring and the resolver's
   * exact-before-prefix precedence — rather than a fake that could agree with
   * a broken rule. The exact session's file is the *older* one on purpose:
   * every ambiguity tie-break the resolver has (creation-time order) points at
   * the extended session, so only the exact-id rule can produce this outcome.
   */
  it("opens the exact session for a full id even when a newer prefix-extended session exists", async () => {
    const sessionId = "abc123";
    const sessionDir = await mkdtemp(join(tmpdir(), "pi-web-exact-id-"));
    const workspace = await mkdtemp(join(tmpdir(), "pi-web-exact-id-workspace-"));
    const header = (id: string) =>
      `${JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00.000Z", cwd: workspace })}\n`;
    const exactPath = join(sessionDir, `2026-01-01T00-00-00-000Z_${sessionId}.jsonl`);
    await writeFile(exactPath, header(sessionId), "utf8");
    await writeFile(join(sessionDir, `2026-01-02T00-00-00-000Z_${sessionId}-extended.jsonl`), header(`${sessionId}-extended`), "utf8");

    const fake = fakeRuntime(sessionId, {
      sessionManager: fakeSessionManager(workspace, {
        getSessionId: () => sessionId,
        getBranch: () => [{ type: "message", message: { role: "user", content: "exact session" } }],
      }),
    });
    const realGateway = createPiSessionManagerGateway({
      agentDir: TEST_AGENT_DIR,
      env: { PI_CODING_AGENT_SESSION_DIR: sessionDir },
    });
    const open = vi.fn(() => fakeSessionManager(workspace, { getSessionId: () => sessionId }));
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: TEST_AGENT_DIR,
      modelRuntime: testModelRuntime,
      createAgentRuntime: runtimeCreator(fake.runtime),
      archiveStore: emptyArchiveStore(),
      sessionManager: {
        create: (createCwd: string) => realGateway.create(createCwd),
        list: (listCwd: string) => realGateway.list(listCwd),
        listAll: () => realGateway.listAll(),
        resolveSessionFile: (refCwd: string, refId: string) => realGateway.resolveSessionFile(refCwd, refId),
        invalidateSessionFile: (sessionFile: string) => {
          realGateway.invalidateSessionFile(sessionFile);
        },
        open,
      },
      heartbeatIntervalMs: 60_000,
    });

    const page = await service.messages(sessionRef(sessionId, workspace));

    expect(page.messages).toEqual([{ role: "user", content: "exact session" }]);
    expect(open).toHaveBeenCalledWith(exactPath);
    await service.dispose();
    await rm(sessionDir, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  });

  it("still reports a missing session when direct resolution finds nothing", async () => {
    const gateway: SessionGateway = {
      create: () => fakeSessionManager(),
      list: () => Promise.resolve([]),
      listAll: () => Promise.resolve([]),
      invalidateSessionFile: () => undefined,
      resolveSessionFile: () => Promise.resolve(undefined),
      open: () => fakeSessionManager(),
    };
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: TEST_AGENT_DIR,
      modelRuntime: testModelRuntime,
      archiveStore: emptyArchiveStore(),
      sessionManager: gateway,
      heartbeatIntervalMs: 60_000,
    });

    await expect(service.messages(sessionRef("missing-session"))).rejects.toThrow("Session not found");
    await service.dispose();
  });

  it("clears a failed pending open so the session can be retried", async () => {
    const sessionId = "retry-open-session";
    const bindStarted = deferred();
    const bindResult = deferred();
    const openingError = new Error("extension binding failed");
    const failed = fakeRuntime(sessionId, {
      bindExtensions: () => {
        bindStarted.resolve();
        return bindResult.promise;
      },
    });
    const retried = fakeRuntime(sessionId);
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
      modelRuntime: testModelRuntime,
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
    const [messagesOutcome, statusOutcome] = outcomes;
    expect(messagesOutcome.status).toBe("rejected");
    if (messagesOutcome.status === "rejected") expect(messagesOutcome.reason).toBe(openingError);
    // Status no longer parks behind the in-flight open: a session still
    // binding its extensions is statusable (its session_start dialogs must
    // stay answerable for startup to be unblockable at all), so the lookup
    // resolves from the startup window rather than sharing the open's fate.
    expect(statusOutcome.status).toBe("fulfilled");
    if (statusOutcome.status === "fulfilled") expect(statusOutcome.value).toMatchObject({ sessionId });
    expect(service.activeCount()).toBe(0);
    expect(failed.calls.abort).toBe(1);
    expect(failed.calls.dispose).toBe(1);

    await expect(service.status(sessionRef(sessionId))).resolves.toMatchObject({ sessionId });
    expect(createCalls).toBe(2);
    expect(service.activeCount()).toBe(1);

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
      modelRuntime: testModelRuntime,
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

    await expect(statusPromise).resolves.toMatchObject({ sessionId });
    await disposePromise;

    expect(settledWhileOpening).toBe(false);
    expect(service.activeCount()).toBe(0);
    expect(fake.calls.abort).toBe(1);
    expect(fake.calls.dispose).toBe(1);
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
      modelRuntime: testModelRuntime,
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
    expect(await service.status(sessionRef("session-2"))).toMatchObject({ sessionId: "session-2" });

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
      modelRuntime: testModelRuntime,
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
      modelRuntime: testModelRuntime,
      createAgentRuntime: runtimeCreator(fake.runtime),
      sessionManager: sessionGateway([]),
      heartbeatIntervalMs: 60_000,
    });

    await service.start("/workspace");
    await expect(service.runCommand(sessionRef("extension-command-session"), "/ctx-stats")).resolves.toEqual({ type: "done" });

    expect(extensionMode).toBe("rpc");
    expect(hub.sessionEvents.filter(({ event }) => event.type === "command.output")).toHaveLength(0);
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
      modelRuntime: testModelRuntime,
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
    expect(hub.sessionEvents.filter(({ event }) => event.type === "command.output")).toHaveLength(0);
    expect(hub.sessionEvents.filter(({ event }) => event.type === "notifications.inbox")).toHaveLength(2);

    await service.dispose();
  });

  it("commits Pi /reload only after replacement session_start notifications use the plain-text theme", async () => {
    const hub = new CapturingSessionEventHub();
    const store = notificationStore();
    const fake = fakeRuntime("runtime-reload-notifications");
    const service = new PiSessionService(hub, {
      agentDir: TEST_AGENT_DIR,
      modelRuntime: testModelRuntime,
      notificationStore: store,
      createAgentRuntime: runtimeCreator(fake.runtime),
      sessionManager: sessionGateway([sessionRecord("runtime-reload-notifications")]),
      heartbeatIntervalMs: 60_000,
    });

    await service.status(sessionRef("runtime-reload-notifications"));
    const oldNotify = boundNotify(fake);
    oldNotify("old notification", "warning");
    fake.session.reload = async (options) => {
      oldNotify("shutdown notification", "info");
      await options?.beforeSessionStart?.();
      const replacementStartup = fake.session.extensionRunner.getUIContext().theme.fg("error", "replacement startup");
      currentNotify(fake)(replacementStartup, "error");
    };

    await expect(service.runCommand(sessionRef("runtime-reload-notifications"), "/reload")).resolves.toMatchObject({ type: "done" });

    expect(service.notificationInbox(sessionRef("runtime-reload-notifications"))).toMatchObject({
      summary: { retainedCount: 1, discardedCount: 0, highestSeverity: "error" },
      notifications: [{ message: "replacement startup", severity: "error" }],
    });
    expect(fake.calls.bindExtensions).toHaveLength(1);
    const revision = service.notificationInbox(sessionRef("runtime-reload-notifications")).summary.inboxRevision;
    oldNotify("stale old runner", "error");
    expect(service.notificationInbox(sessionRef("runtime-reload-notifications")).summary.inboxRevision).toBe(revision);

    await service.dispose();
  });

  it("preserves prior and candidate notifications when Pi /reload fails after rotation", async () => {
    const hub = new CapturingSessionEventHub();
    const store = notificationStore();
    const fake = fakeRuntime("failed-runtime-reload");
    const service = new PiSessionService(hub, {
      agentDir: TEST_AGENT_DIR,
      modelRuntime: testModelRuntime,
      notificationStore: store,
      createAgentRuntime: runtimeCreator(fake.runtime),
      sessionManager: sessionGateway([sessionRecord("failed-runtime-reload")]),
      heartbeatIntervalMs: 60_000,
    });

    await service.status(sessionRef("failed-runtime-reload"));
    boundNotify(fake)("prior", "info");
    fake.session.reload = async (options) => {
      await options?.beforeSessionStart?.();
      currentNotify(fake)("candidate before failure", "warning");
      throw new Error("reload failed after rotation");
    };

    await expect(service.runCommand(sessionRef("failed-runtime-reload"), "/reload")).resolves.toEqual({
      type: "unsupported",
      message: "Reload failed: reload failed after rotation",
    });
    expect(service.notificationInbox(sessionRef("failed-runtime-reload")).notifications.map((notification) => notification.message)).toEqual([
      "candidate before failure",
      "prior",
    ]);
    currentNotify(fake)("after failed reload", "error");
    expect(service.notificationInbox(sessionRef("failed-runtime-reload")).notifications[0]).toMatchObject({
      message: "after failed reload",
      severity: "error",
    });

    await service.dispose();
  });

  it("leaves the prior inbox unchanged when Pi /reload fails before rotation", async () => {
    const store = notificationStore();
    const fake = fakeRuntime("failed-before-rotation");
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: TEST_AGENT_DIR,
      modelRuntime: testModelRuntime,
      notificationStore: store,
      createAgentRuntime: runtimeCreator(fake.runtime),
      sessionManager: sessionGateway([sessionRecord("failed-before-rotation")]),
      heartbeatIntervalMs: 60_000,
    });

    await service.status(sessionRef("failed-before-rotation"));
    boundNotify(fake)("prior", "warning");
    const before = service.notificationInbox(sessionRef("failed-before-rotation"));
    fake.session.reload = () => Promise.reject(new Error("reload failed before rotation"));

    await expect(service.runCommand(sessionRef("failed-before-rotation"), "/reload")).resolves.toEqual({
      type: "unsupported",
      message: "Reload failed: reload failed before rotation",
    });
    expect(service.notificationInbox(sessionRef("failed-before-rotation"))).toEqual(before);

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
      modelRuntime: testModelRuntime,
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

  it("preserves changed-id SDK rebind notifications on the applied replacement when binding fails", async () => {
    const store = notificationStore();
    const first = fakeRuntime("session-1");
    const replacement = fakeRuntime("session-2");
    replacement.session.bindExtensions = (bindings) => {
      replacement.session.extensionRunner.setUIContext(bindings.uiContext, "rpc");
      bindings.uiContext?.notify("candidate before bind failure", "warning");
      return Promise.reject(new Error("replacement bind failed"));
    };
    let rebindSession: ((session: PiAgentSession) => Promise<void>) | undefined;
    first.runtime.setRebindSession = (callback) => { rebindSession = callback; };
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: TEST_AGENT_DIR,
      modelRuntime: testModelRuntime,
      notificationStore: store,
      createAgentRuntime: runtimeCreator(first.runtime),
      sessionManager: sessionGateway([]),
      heartbeatIntervalMs: 60_000,
    });

    await service.start("/workspace");
    boundNotify(first)("prior", "info");
    Object.defineProperty(first.runtime, "session", { configurable: true, value: replacement.session });
    await expect(rebindSession?.(replacement.session)).rejects.toThrow("replacement bind failed");

    expect(() => service.notificationInbox(sessionRef("session-1"))).toThrow("Session not found");
    expect(service.notificationInbox(sessionRef("session-2")).notifications.map((notification) => notification.message)).toEqual([
      "candidate before bind failure",
      "prior",
    ]);
    await expect(service.status(sessionRef("session-2"))).resolves.toMatchObject({ sessionId: "session-2" });
    currentNotify(replacement)("after failed rebind", "error");
    expect(service.notificationInbox(sessionRef("session-2")).notifications[0]).toMatchObject({ message: "after failed rebind", severity: "error" });

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
      modelRuntime: testModelRuntime,
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
      modelRuntime: testModelRuntime,
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
      modelRuntime: testModelRuntime,
      archiveStore: {
        list: () => Promise.resolve([{ sessionId: "archived", cwd: "/workspace", archivedAt: "2026-01-01T00:00:00.000Z" }]),
        get: () => Promise.resolve(undefined),
        archive: () => { throw new Error("archive should not be called when listing"); },
        restore: () => Promise.resolve(),
        isArchived: () => Promise.resolve(false),
      },
      sessionManager: {
        create: () => fakeSessionManager(),
        list: () => Promise.resolve([
          { ...sessionRecord("active"), messageCount: 1, firstMessage: "hello", allMessagesText: "hello" },
          { ...sessionRecord("archived"), messageCount: 2, firstMessage: "bye", allMessagesText: "bye" },
        ]),
        listAll: () => Promise.resolve([]),
        invalidateSessionFile: () => undefined,
        resolveSessionFile: () => Promise.resolve(undefined),
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
      modelRuntime: testModelRuntime,
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
        listAll: () => Promise.resolve([]),
        invalidateSessionFile: () => undefined,
        resolveSessionFile: () => Promise.resolve(undefined),
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
      modelRuntime: testModelRuntime,
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

  it("runs /reload by refreshing the active runtime resources in place", async () => {
    const hub = new CapturingSessionEventHub();
    const fake = fakeRuntime("runtime-reload-session");
    const service = new PiSessionService(hub, {
      agentDir: TEST_AGENT_DIR,
      modelRuntime: testModelRuntime,
      createAgentRuntime: runtimeCreator(fake.runtime),
      sessionManager: sessionGateway([sessionRecord("runtime-reload-session")]),
      heartbeatIntervalMs: 60_000,
    });

    await expect(service.runCommand(sessionRef("runtime-reload-session"), "/reload")).resolves.toEqual({
      type: "done",
      message: "Session runtime resources reloaded. Extensions, skills, prompt templates, themes, and context/system prompt files are refreshed for this session. Reload the browser page separately for PI WEB browser plugin changes.",
    });

    expect(fake.calls.reload).toBe(1);
    expect(fake.calls.abort).toBe(0);
    expect(fake.calls.dispose).toBe(0);
    expect(hub.globalEvents.some((event) => event.type === "activity.update" && event.activity.sessionId === "runtime-reload-session" && event.activity.label === "resources reloaded")).toBe(true);
    expect(hub.globalEvents.some((event) => event.type === "status.update" && event.status.sessionId === "runtime-reload-session")).toBe(true);

    await service.dispose();
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
      modelRuntime: testModelRuntime,
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
      modelRuntime: testModelRuntime,
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
      modelRuntime: testModelRuntime,
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
    await service.stop(sessionRef("failed-disk-reload"));
    expect(() => service.notificationInbox(sessionRef("failed-disk-reload"))).toThrow("Session not found");
    await service.dispose();
  });

  it("reload-from-disk preserves the prior inbox when deferred close fails", async () => {
    const store = notificationStore();
    const first = fakeRuntime("failed-close-reload");
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: TEST_AGENT_DIR,
      modelRuntime: testModelRuntime,
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
    await service.stop(sessionRef("failed-close-reload"));
    await service.dispose();
  });

  it("refuses to reload a session that has active work in progress", async () => {
    const fake = fakeRuntime("busy-session", { isStreaming: true });
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: TEST_AGENT_DIR,
      modelRuntime: testModelRuntime,
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
      modelRuntime: testModelRuntime,
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
      modelRuntime: testModelRuntime,
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
        listAll: () => Promise.resolve([]),
        invalidateSessionFile: () => undefined,
        resolveSessionFile: () => Promise.resolve(undefined),
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
      modelRuntime: testModelRuntime,
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
      modelRuntime: testModelRuntime,
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
