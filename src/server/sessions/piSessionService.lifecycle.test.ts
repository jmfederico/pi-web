import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PiSessionService, type PiAgentSession, type PiSessionRuntime } from "./piSessionService.js";
import { CapturingSessionEventHub, emptyArchiveStore, fakeRuntime, fakeSessionManager, runtimeCreator, sessionGateway, sessionRecord, sessionRef, testModelRuntime, type RuntimeCreator } from "./piSessionService.testSupport.js";

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

describe("PiSessionService lifecycle, listing, and reload", () => {
  it("starts sessions through an injected runtime creator", async () => {
    const hub = new CapturingSessionEventHub();
    const fake = fakeRuntime();
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

  it("opens legacy id-only lookups from the default session store gateway", async () => {
    const hub = new CapturingSessionEventHub();
    const fake = fakeRuntime("legacy-session");
    const open = vi.fn(() => fakeSessionManager());
    const service = new PiSessionService(hub, {
      agentDir: TEST_AGENT_DIR,
      modelRuntime: testModelRuntime,
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
    expect(hub.sessionEvents).toContainEqual({
      sessionId: "extension-command-session",
      event: { type: "command.output", level: "info", message: "context-mode stats" },
    });

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
