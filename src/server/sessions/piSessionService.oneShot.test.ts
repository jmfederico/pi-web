import { setImmediate } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { PiSessionService, type PiSessionRuntime } from "./piSessionService.js";
import {
  CapturingSessionEventHub,
  fakeRuntime,
  emptyArchiveStore,
  runtimeCreator,
  sessionGateway,
  sessionRef,
  sessionRecord,
  testModelRuntime,
  type RuntimeCreator,
} from "./piSessionService.testSupport.js";

const TEST_AGENT_DIR = "/tmp/pi-web-test-agent";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("PiSessionService host-owned one-shot runs", () => {
  it.each(["managed", "existing"])("observes %s startup without admitting ordinary prompts before binding finishes", async (kind) => {
    const entered = deferred();
    const binding = deferred();
    const hub = new CapturingSessionEventHub();
    const fake = fakeRuntime("session-1", { bindExtensions: () => {
      fake.emit({ type: "agent_start" });
      entered.resolve();
      return binding.promise;
    } });
    const service = new PiSessionService(hub, {
      agentDir: TEST_AGENT_DIR, modelRuntime: testModelRuntime,
      createAgentRuntime: runtimeCreator(fake.runtime),
      sessionManager: sessionGateway([sessionRecord("session-1")]), archiveStore: emptyArchiveStore(), heartbeatIntervalMs: 60_000,
    });
    const starting = kind === "managed"
      ? service.createHostedSession("/workspace", new AbortController().signal)
      : service.messages(sessionRef("session-1"));
    try {
      await entered.promise;
      expect(hub.sessionEvents).toContainEqual({ sessionId: "session-1", event: { type: "agent.start" } });
      const prompt = service.prompt(sessionRef("session-1"), "ordinary submission");
      // Let the request traverse its async admission path while binding is parked.
      await setImmediate();
      expect(fake.calls.prompt).toHaveLength(0);
      binding.resolve();
      await Promise.all([starting, prompt]);
      expect(fake.calls.prompt).toHaveLength(1);
    } finally {
      binding.resolve();
      await starting;
      await service.dispose();
    }
  });

  it.each(["stop", "dispose"])("coordinates managed startup with %s without republishing a disposed runtime", async (operation) => {
    const entered = deferred();
    const binding = deferred();
    const fake = fakeRuntime("session-1", { bindExtensions: () => {
      entered.resolve();
      return binding.promise;
    } });
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: TEST_AGENT_DIR, modelRuntime: testModelRuntime,
      createAgentRuntime: runtimeCreator(fake.runtime), sessionManager: sessionGateway([]), heartbeatIntervalMs: 60_000,
    });
    const starting = service.createHostedSession("/workspace", new AbortController().signal);
    try {
      await entered.promise;
      const closing = operation === "stop" ? service.stop(sessionRef("session-1")) : service.dispose();
      await setImmediate();
      expect(fake.calls.dispose).toBe(0);
      binding.resolve();
      await Promise.all([starting, closing]);
      expect(fake.calls.dispose).toBe(1);
      expect(service.activeCount()).toBe(0);
    } finally {
      binding.resolve();
      await starting;
      await service.dispose();
    }
  });

  it("observes prompt-free creation before extension startup and transfers published lifetime to hosting", async () => {
    const hub = new CapturingSessionEventHub();
    const fake = fakeRuntime("session-created");
    fake.session.bindExtensions = () => {
      fake.emit({ type: "agent_start" });
      expect(hub.sessionEvents).toContainEqual({ sessionId: "session-created", event: { type: "agent.start" } });
      fake.emit({ type: "agent_end", messages: [] });
      return Promise.resolve();
    };
    const lifetime = new AbortController();
    const service = new PiSessionService(hub, {
      agentDir: TEST_AGENT_DIR, modelRuntime: testModelRuntime,
      createAgentRuntime: runtimeCreator(fake.runtime), sessionManager: sessionGateway([]), heartbeatIntervalMs: 60_000,
    });
    try {
      const created = await service.createHostedSession("/workspace", lifetime.signal);
      expect(created).toEqual({ id: "session-created" });
      expect(fake.calls.prompt).toEqual([]);
      expect(hub.globalEvents.filter((event) => event.type === "session.created")).toHaveLength(1);
      lifetime.abort();
      expect(service.activeCount()).toBe(1);
      expect(fake.calls.abort).toBe(0);
      expect(fake.calls.dispose).toBe(0);
      await service.prompt(sessionRef(created.id), "ordinary work");
      expect(fake.calls.prompt).toHaveLength(1);
    } finally {
      await service.dispose();
    }
  });

  it("atomically starts a visible non-delegating session and returns its prompt completion", async () => {
    const prompt = deferred();
    const hub = new CapturingSessionEventHub();
    const promptCall = vi.fn(() => {
      expect(hub.globalEvents.some((event) => event.type === "session.created")).toBe(true);
      return prompt.promise;
    });
    const fake = fakeRuntime("session-1", { prompt: promptCall });
    let delegationToolsEnabled: boolean | undefined;
    const createAgentRuntime: RuntimeCreator = async (_createRuntime, options) => {
      delegationToolsEnabled = options.delegationToolsEnabled;
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

    const run = await service.startOneShotRun(
      "/workspace",
      "Do the bounded work",
      new AbortController().signal,
    );
    let settled = false;
    void run.completion.then(() => { settled = true; });
    await Promise.resolve();

    expect(run.id).toBe("session-1");
    expect(promptCall).toHaveBeenCalledWith("Do the bounded work", undefined);
    expect(settled).toBe(false);
    expect(delegationToolsEnabled).toBe(false);
    expect(hub.globalEvents.some((event) => (
      event.type === "session.created"
      && event.session.id === "session-1"
      && event.session.cwd === "/workspace"
    ))).toBe(true);

    prompt.resolve();
    await run.completion;
    expect(service.activeCount()).toBe(1);
    expect(fake.calls.abort).toBe(0);
    expect(fake.calls.dispose).toBe(0);
    await service.stop(sessionRef(run.id));
    expect(fake.calls.abort).toBe(1);
    expect(fake.calls.dispose).toBe(1);
    await service.dispose();
  });

  it("projects prompt failures through the normal session error channel and rejects completion", async () => {
    const failure = new Error("model unavailable");
    const fake = fakeRuntime("session-1", { prompt: () => Promise.reject(failure) });
    const hub = new CapturingSessionEventHub();
    const service = new PiSessionService(hub, {
      agentDir: TEST_AGENT_DIR,
      modelRuntime: testModelRuntime,
      createAgentRuntime: runtimeCreator(fake.runtime),
      sessionManager: sessionGateway([]),
      heartbeatIntervalMs: 60_000,
    });

    const run = await service.startOneShotRun(
      "/workspace",
      "Do the work",
      new AbortController().signal,
    );
    await expect(run.completion).rejects.toBe(failure);

    expect(hub.sessionEvents).toContainEqual({
      sessionId: run.id,
      event: { type: "session.error", message: "model unavailable" },
    });
    await service.stop(sessionRef(run.id));
    await service.dispose();
  });

  it.each([
    ["stop", "settled"], ["error", "settled"], ["aborted", "settled"],
    ["stop", "queued"], ["error", "queued"],
  ])("freezes initial %s outcome before later %s user activity", async (reason, boundary) => {
    const prompt = deferred();
    const fake = fakeRuntime("session-1", { prompt: () => prompt.promise });
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: TEST_AGENT_DIR,
      modelRuntime: testModelRuntime,
      createAgentRuntime: runtimeCreator(fake.runtime),
      sessionManager: sessionGateway([]),
      heartbeatIntervalMs: 60_000,
    });
    try {
      const run = await service.startOneShotRun("/workspace", "Initial work", new AbortController().signal);
      fake.emit({ type: "message_start", message: { role: "user", content: "Initial work" } });
      fake.emit({ type: "message_end", message: { role: "assistant", stopReason: reason, errorMessage: "initial failure" } });
      if (boundary === "settled") fake.emit({ type: "agent_settled" });
      else fake.emit({ type: "message_start", message: { role: "user", content: "Later queued work" } });
      // A later turn finishes before the initial prompt promise's continuation.
      fake.emit({ type: "message_end", message: { role: "assistant", stopReason: reason === "stop" ? "error" : "stop", errorMessage: "later failure" } });
      // Retry cancellation from later work must not change the initial result.
      fake.emit({ type: "auto_retry_end", success: false, attempt: 1, finalError: "Retry cancelled" });
      prompt.resolve();
      if (reason === "stop") await expect(run.completion).resolves.toBeUndefined();
      else await expect(run.completion).rejects.toThrow(reason === "error" ? "initial failure" : "was aborted");
      expect(fake.calls.abort).toBe(0);
    } finally {
      await service.dispose();
    }
  });

  it("reports a successful retry rather than its transient provider error", async () => {
    const prompt = deferred();
    const fake = fakeRuntime("session-1", { prompt: () => prompt.promise });
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: TEST_AGENT_DIR,
      modelRuntime: testModelRuntime,
      createAgentRuntime: runtimeCreator(fake.runtime),
      sessionManager: sessionGateway([]),
      heartbeatIntervalMs: 60_000,
    });
    try {
      const run = await service.startOneShotRun("/workspace", "Initial work", new AbortController().signal);
      fake.emit({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "transient" } });
      fake.emit({ type: "agent_end", messages: [], willRetry: true });
      fake.emit({ type: "message_end", message: { role: "assistant", stopReason: "stop" } });
      fake.emit({ type: "agent_settled" });
      prompt.resolve();
      await expect(run.completion).resolves.toBeUndefined();
    } finally {
      await service.dispose();
    }
  });

  it("rejects a pre-cancelled lifetime before constructing a session", async () => {
    const fake = fakeRuntime("session-1");
    const createAgentRuntime = vi.fn(runtimeCreator(fake.runtime));
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: TEST_AGENT_DIR,
      modelRuntime: testModelRuntime,
      createAgentRuntime,
      sessionManager: sessionGateway([]),
      heartbeatIntervalMs: 60_000,
    });
    const lifetime = new AbortController();
    lifetime.abort(new DOMException("Plugin stopped", "AbortError"));

    await expect(service.startOneShotRun("/workspace", "Must not start", lifetime.signal))
      .rejects.toThrow("Plugin stopped");
    expect(createAgentRuntime).not.toHaveBeenCalled();
    expect(service.activeCount()).toBe(0);
    await service.dispose();
  });

  it("cleans up without admitting a prompt when cancellation wins session startup", async () => {
    const runtimeReady = deferred<PiSessionRuntime>();
    const promptCall = vi.fn(() => Promise.resolve());
    const fake = fakeRuntime("session-1", { prompt: promptCall });
    const createAgentRuntime: RuntimeCreator = async () => await runtimeReady.promise;
    const hub = new CapturingSessionEventHub();
    const service = new PiSessionService(hub, {
      agentDir: TEST_AGENT_DIR,
      modelRuntime: testModelRuntime,
      createAgentRuntime,
      sessionManager: sessionGateway([]),
      heartbeatIntervalMs: 60_000,
    });
    const lifetime = new AbortController();

    const starting = service.startOneShotRun("/workspace", "Must not start", lifetime.signal);
    await Promise.resolve();
    lifetime.abort(new DOMException("Plugin stopped", "AbortError"));
    runtimeReady.resolve(fake.runtime);

    await expect(starting).rejects.toThrow("Plugin stopped");
    expect(promptCall).not.toHaveBeenCalled();
    expect(fake.calls.abort).toBe(1);
    expect(fake.calls.dispose).toBe(1);
    expect(service.activeCount()).toBe(0);
    expect(hub.globalEvents.some((event) => event.type === "session.created")).toBe(false);
    await service.dispose();
  });
});
