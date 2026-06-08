import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { GlobalSessionEvent, SessionUiEvent } from "../../shared/apiTypes.js";
import { SessionEventHub } from "../realtime/sessionEventHub.js";
import { PiSessionService, type PiAgentSession, type PiSessionManager, type PiSessionRuntime, type PiSessionServiceDependencies } from "./piSessionService.js";

class CapturingSessionEventHub extends SessionEventHub {
  readonly sessionEvents: { sessionId: string; event: SessionUiEvent }[] = [];
  readonly globalEvents: GlobalSessionEvent[] = [];

  override publish(sessionId: string, event: SessionUiEvent): void {
    this.sessionEvents.push({ sessionId, event });
  }

  override publishGlobal(event: GlobalSessionEvent): void {
    this.globalEvents.push(event);
  }
}

type SessionGateway = NonNullable<PiSessionServiceDependencies["sessionManager"]>;
type RuntimeCreator = NonNullable<PiSessionServiceDependencies["createAgentRuntime"]>;

interface TestSession extends PiAgentSession {
  sessionName: string | undefined;
  model: PiAgentSession["model"];
  isStreaming: boolean;
  isCompacting: boolean;
  isBashRunning: boolean;
  pendingMessageCount: number;
  getSteeringMessages: () => readonly string[];
  getFollowUpMessages: () => readonly string[];
}

function fakeSessionManager(cwd = "/workspace"): PiSessionManager {
  return {
    getCwd: () => cwd,
    getBranch: () => [],
    getLeafId: () => "leaf-1",
  };
}

function sessionRecord(id: string, cwd = "/workspace") {
  return { id, path: `/sessions/${id}.jsonl`, cwd, created: new Date("2026-01-01T00:00:00.000Z"), modified: new Date("2026-01-01T00:01:00.000Z"), messageCount: 0, firstMessage: "", allMessagesText: "" };
}

function fakeRuntime(sessionId = "session-1", patch: Partial<TestSession> = {}) {
  const promptCalls: { text: string; options: unknown }[] = [];
  const listeners: ((event: unknown) => void)[] = [];
  const calls = { abort: 0, clearQueue: 0, dispose: 0, prompt: promptCalls };
  const session: TestSession = {
    sessionId,
    sessionFile: `/tmp/${sessionId}.jsonl`,
    messages: [],
    sessionName: undefined,
    model: undefined,
    thinkingLevel: "off",
    isStreaming: false,
    isCompacting: false,
    isBashRunning: false,
    pendingMessageCount: 0,
    sessionManager: fakeSessionManager(),
    modelRegistry: ModelRegistry.create(AuthStorage.inMemory()),
    scopedModels: [],
    extensionRunner: { getRegisteredCommands: () => [] },
    promptTemplates: [],
    resourceLoader: { getSkills: () => ({ skills: [] }) },
    subscribe: (listener: (event: unknown) => void) => {
      listeners.push(listener);
      return () => {
        const index = listeners.indexOf(listener);
        if (index !== -1) listeners.splice(index, 1);
      };
    },
    getSessionStats: () => ({ sessionId, totalMessages: 0, userMessages: 0, assistantMessages: 0, toolCalls: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 }),
    getContextUsage: () => undefined,
    prompt: (text: string, options: unknown) => {
      calls.prompt.push({ text, options });
      return Promise.resolve();
    },
    executeBash: () => Promise.resolve({ output: "", exitCode: 0, cancelled: false, truncated: false }),
    abort: () => {
      calls.abort += 1;
      return Promise.resolve();
    },
    clearQueue: () => {
      calls.clearQueue += 1;
      return { steering: [], followUp: [] };
    },
    getSteeringMessages: () => [],
    getFollowUpMessages: () => [],
    setModel: () => Promise.resolve(),
    cycleModel: () => Promise.resolve(undefined),
    getAvailableThinkingLevels: () => [],
    setThinkingLevel: () => undefined,
    cycleThinkingLevel: () => undefined,
    setSessionName: (name: string) => { session.sessionName = name; },
    compact: () => Promise.resolve({ summary: "", tokensBefore: 0 }),
    getUserMessagesForForking: () => [],
    ...patch,
  };
  const runtime: PiSessionRuntime = {
    cwd: session.sessionManager.getCwd(),
    session,
    setRebindSession: () => undefined,
    fork: () => Promise.resolve({ cancelled: false }),
    dispose: () => {
      calls.dispose += 1;
      return Promise.resolve();
    },
  };
  return { runtime, session, calls, emit: (event: unknown) => { for (const listener of [...listeners]) listener(event); } };
}

function runtimeCreator(runtime: PiSessionRuntime): RuntimeCreator {
  return async () => {
    await Promise.resolve();
    return runtime;
  };
}

function sessionGateway(records: ReturnType<typeof sessionRecord>[]): SessionGateway {
  return {
    create: () => fakeSessionManager(),
    list: () => Promise.resolve(records),
    listAll: () => Promise.resolve(records),
    open: () => fakeSessionManager(),
  };
}

describe("PiSessionService", () => {
  it("starts sessions through an injected runtime creator", async () => {
    const hub = new CapturingSessionEventHub();
    const fake = fakeRuntime();
    let createCalls = 0;
    const createAgentRuntime: RuntimeCreator = async () => {
      createCalls += 1;
      await Promise.resolve();
      return fake.runtime;
    };
    const service = new PiSessionService(hub, {
      createAgentRuntime,
      sessionManager: sessionGateway([]),
      heartbeatIntervalMs: 60_000,
    });

    const session = await service.start("/workspace");

    expect(createCalls).toBe(1);
    expect(session).toMatchObject({ id: "session-1", cwd: "/workspace", messageCount: 0 });
    expect(service.activeCount()).toBe(1);
    expect(hub.globalEvents.some((event) => event.type === "status.update" && event.status.sessionId === "session-1")).toBe(true);

    await service.dispose();
    expect(fake.calls.abort).toBe(1);
    expect(fake.calls.dispose).toBe(1);
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
        createAgentRuntime: runtimeCreator(fake.runtime),
        sessionManager: sessionGateway([sessionRecord("idle-session")]),
        heartbeatIntervalMs: 1_000,
      });

      await service.status("idle-session");
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
      createAgentRuntime: runtimeCreator(fake.runtime),
      sessionManager: sessionGateway([sessionRecord("completion-session")]),
      heartbeatIntervalMs: 60_000,
    });

    await service.status("completion-session");
    hub.globalEvents.length = 0;
    listener?.({ type: "tool_execution_end", toolName: "read", isError: false });

    expect(hub.globalEvents.filter((event) => event.type === "activity.update")).toMatchObject([
      { activity: { sessionId: "completion-session", phase: "idle", label: "tool complete", detail: "read" } },
    ]);

    await service.dispose();
  });

  it("uses injected archive and session-manager gateways for listing", async () => {
    const service = new PiSessionService(new CapturingSessionEventHub(), {
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
        listAll: () => Promise.resolve([]),
        open: () => fakeSessionManager(),
      },
      heartbeatIntervalMs: 60_000,
    });

    const sessions = await service.list("/workspace");
    expect(sessions).toHaveLength(2);
    expect(sessions[0]).toMatchObject({ id: "active" });
    expect(sessions[0]?.archived).toBeUndefined();
    expect(sessions[1]).toMatchObject({ id: "archived", archived: true, archivedAt: "2026-01-01T00:00:00.000Z" });

    await service.dispose();
  });

  it("lists archived records that have been moved out of the active session directory", async () => {
    const service = new PiSessionService(new CapturingSessionEventHub(), {
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

  it("archives a session subtree within the root workspace", async () => {
    const archivedInputs: string[] = [];
    const root = sessionRecord("root");
    const directChild = { ...sessionRecord("direct-child"), path: "/sessions/direct-child.jsonl", parentSessionPath: root.path };
    const archivedChild = { ...sessionRecord("archived-child"), path: "/sessions/archived-child.jsonl", parentSessionPath: root.path };
    const grandchild = { ...sessionRecord("grandchild"), path: "/sessions/grandchild.jsonl", parentSessionPath: archivedChild.path };
    const otherWorkspaceChild = { ...sessionRecord("other-child", "/other"), path: "/sessions/other-child.jsonl", parentSessionPath: root.path };
    const fake = fakeRuntime("root", { sessionFile: root.path });
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      createAgentRuntime: runtimeCreator(fake.runtime),
      archiveStore: {
        list: () => Promise.resolve([{ sessionId: "archived-child", cwd: "/workspace", archivedAt: "2026-01-02T00:00:00.000Z", originalPath: archivedChild.path, archivePath: "/archive/archived-child.jsonl", created: "2026-01-01T00:00:00.000Z", modified: "2026-01-01T00:01:00.000Z", messageCount: 1, firstMessage: "archived", parentSessionPath: root.path }]),
        get: () => Promise.resolve(undefined),
        archive: (input) => {
          archivedInputs.push(input.sessionId);
          return Promise.resolve({ sessionId: input.sessionId, cwd: input.cwd, archivedAt: "2026-01-03T00:00:00.000Z" });
        },
        restore: () => Promise.resolve(),
        isArchived: () => Promise.resolve(false),
      },
      sessionManager: {
        create: () => fakeSessionManager(),
        list: (cwd) => Promise.resolve(cwd === "/workspace" ? [root, directChild, archivedChild, grandchild] : [otherWorkspaceChild]),
        listAll: () => Promise.resolve([root, directChild, archivedChild, grandchild, otherWorkspaceChild]),
        open: () => fakeSessionManager(),
      },
      heartbeatIntervalMs: 60_000,
    });

    await expect(service.archiveTree("root")).resolves.toEqual({
      archived: true,
      sessionIds: ["root", "direct-child", "grandchild"],
      archivedCount: 3,
      skippedAlreadyArchivedCount: 1,
    });
    expect(archivedInputs).toEqual(["root", "direct-child", "grandchild"]);

    await service.dispose();
  });

  it("permanently deletes archived sessions through the archive store", async () => {
    const deletedSessionIds: string[] = [];
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      archiveStore: {
        list: () => Promise.resolve([]),
        get: (sessionId) => Promise.resolve(sessionId === "archived" || "archived".startsWith(sessionId)
          ? { sessionId: "archived", cwd: "/workspace", archivedAt: "2026-01-02T00:00:00.000Z", archivePath: "/archive/archived.jsonl" }
          : undefined),
        archive: () => { throw new Error("archive should not be called for records that already have archive files"); },
        restore: () => Promise.resolve(),
        isArchived: () => Promise.resolve(false),
        deleteArchived: (sessionId) => {
          deletedSessionIds.push(sessionId);
          return Promise.resolve();
        },
      },
      sessionManager: sessionGateway([sessionRecord("active")]),
      heartbeatIntervalMs: 60_000,
    });

    await expect(service.deleteArchived("arch")).resolves.toBeUndefined();
    await expect(service.deleteArchived("active")).rejects.toThrow("Archived session not found");

    expect(deletedSessionIds).toEqual(["archived"]);
    await service.dispose();
  });

  it("reconciles workspace activity when listing only archived sessions", async () => {
    const reconciliations: { cwd: string; sessionIds: string[] }[] = [];
    const service = new PiSessionService(new CapturingSessionEventHub(), {
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

  it("sends prompts to an injected runtime without touching the SDK runtime", async () => {
    const fake = fakeRuntime("prompt-session");
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      createAgentRuntime: runtimeCreator(fake.runtime),
      sessionManager: sessionGateway([sessionRecord("prompt-session")]),
      heartbeatIntervalMs: 60_000,
    });

    await service.prompt("prompt-session", "Build the thing");

    expect(fake.calls.prompt).toEqual([{ text: "Build the thing", options: undefined }]);
    await service.dispose();
  });

  it("rejects malformed prompt text before opening the runtime", async () => {
    const fake = fakeRuntime("prompt-session");
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      createAgentRuntime: runtimeCreator(fake.runtime),
      sessionManager: sessionGateway([sessionRecord("prompt-session")]),
      heartbeatIntervalMs: 60_000,
    });

    await expect(service.prompt("prompt-session", undefined)).rejects.toThrow("Prompt text is required");

    expect(fake.calls.prompt).toEqual([]);
    await service.dispose();
  });

  it("includes queued message details in session status", async () => {
    const fake = fakeRuntime("status-session", {
      messages: [{ role: "user", content: "hello" }, { role: "assistant", content: "hi" }],
      pendingMessageCount: 2,
      getSteeringMessages: () => ["adjust this turn"],
      getFollowUpMessages: () => ["then do this"],
    });
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      createAgentRuntime: runtimeCreator(fake.runtime),
      sessionManager: sessionGateway([sessionRecord("status-session")]),
      heartbeatIntervalMs: 60_000,
    });

    await expect(service.status("status-session")).resolves.toMatchObject({
      pendingMessageCount: 2,
      queuedMessages: [{ kind: "steer", text: "adjust this turn" }, { kind: "followUp", text: "then do this" }],
      messageCount: 2,
    });
    await service.dispose();
  });

  it("does not enqueue duplicate queued message text", async () => {
    const fake = fakeRuntime("dedupe-session", {
      isStreaming: true,
      pendingMessageCount: 1,
      getFollowUpMessages: () => ["already queued"],
    });
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      createAgentRuntime: runtimeCreator(fake.runtime),
      sessionManager: sessionGateway([sessionRecord("dedupe-session")]),
      heartbeatIntervalMs: 60_000,
    });

    await service.prompt("dedupe-session", "already queued", "followUp");

    expect(fake.calls.prompt).toEqual([]);
    await service.dispose();
  });

  it("does not append queued prompts to the transcript before delivery", async () => {
    const hub = new CapturingSessionEventHub();
    const fake = fakeRuntime("queued-session", { isStreaming: true });
    const service = new PiSessionService(hub, {
      createAgentRuntime: runtimeCreator(fake.runtime),
      sessionManager: sessionGateway([sessionRecord("queued-session")]),
      heartbeatIntervalMs: 60_000,
    });

    await service.prompt("queued-session", "Wait for the current turn", "followUp");

    expect(fake.calls.prompt).toEqual([{ text: "Wait for the current turn", options: { streamingBehavior: "followUp" } }]);
    expect(hub.sessionEvents.some(({ event }) => event.type === "message.append")).toBe(false);
    await service.dispose();
  });

  it("holds prompts sent during compaction until compaction finishes", async () => {
    const hub = new CapturingSessionEventHub();
    const fake = fakeRuntime("compacting-session", { isCompacting: true });
    let resolveFirstPrompt: (() => void) | undefined;
    fake.session.prompt = (text: string, options?: { streamingBehavior?: "steer" | "followUp" }) => {
      fake.calls.prompt.push({ text, options });
      if (options === undefined) {
        fake.session.isStreaming = true;
        return new Promise<void>((resolve) => { resolveFirstPrompt = resolve; });
      }
      return Promise.resolve();
    };
    const service = new PiSessionService(hub, {
      createAgentRuntime: runtimeCreator(fake.runtime),
      sessionManager: sessionGateway([sessionRecord("compacting-session")]),
      heartbeatIntervalMs: 60_000,
    });

    await service.prompt("compacting-session", "Start task 1", "followUp");
    await service.prompt("compacting-session", "Then task 2", "followUp");

    expect(fake.calls.prompt).toEqual([]);
    expect(hub.sessionEvents.some(({ event }) => event.type === "message.append")).toBe(false);
    await expect(service.status("compacting-session")).resolves.toMatchObject({
      pendingMessageCount: 2,
      queuedMessages: [{ kind: "followUp", text: "Start task 1" }, { kind: "followUp", text: "Then task 2" }],
    });

    fake.session.isCompacting = false;
    fake.emit({ type: "compaction_end" });
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(fake.calls.prompt).toEqual([{ text: "Start task 1", options: undefined }]);
    expect(hub.sessionEvents.some(({ event }) => event.type === "message.append" && JSON.stringify(event.message).includes("Start task 1"))).toBe(true);
    await expect(service.status("compacting-session")).resolves.toMatchObject({
      pendingMessageCount: 1,
      queuedMessages: [{ kind: "followUp", text: "Then task 2" }],
    });

    fake.emit({ type: "agent_start" });
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(fake.calls.prompt).toEqual([
      { text: "Start task 1", options: undefined },
      { text: "Then task 2", options: { streamingBehavior: "followUp" } },
    ]);
    await expect(service.status("compacting-session")).resolves.toMatchObject({
      pendingMessageCount: 0,
      queuedMessages: [],
    });
    resolveFirstPrompt?.();
    await service.dispose();
  });

  it("clears queued messages when aborting active work", async () => {
    const fake = fakeRuntime("abort-session");
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      createAgentRuntime: runtimeCreator(fake.runtime),
      sessionManager: sessionGateway([sessionRecord("abort-session")]),
      heartbeatIntervalMs: 60_000,
    });

    await service.status("abort-session");
    await service.abort("abort-session");

    expect(fake.calls.clearQueue).toBe(1);
    expect(fake.calls.abort).toBe(1);
    await service.dispose();
  });

  it("clears prompts queued during compaction when aborting active work", async () => {
    const fake = fakeRuntime("abort-compaction-session", { isCompacting: true });
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      createAgentRuntime: runtimeCreator(fake.runtime),
      sessionManager: sessionGateway([sessionRecord("abort-compaction-session")]),
      heartbeatIntervalMs: 60_000,
    });

    await service.prompt("abort-compaction-session", "Do not deliver after abort", "followUp");
    await expect(service.status("abort-compaction-session")).resolves.toMatchObject({ pendingMessageCount: 1 });
    await service.abort("abort-compaction-session");

    expect(fake.calls.clearQueue).toBe(1);
    expect(fake.calls.prompt).toEqual([]);
    await expect(service.status("abort-compaction-session")).resolves.toMatchObject({ pendingMessageCount: 0, queuedMessages: [] });
    await service.dispose();
  });

  it("refreshes auth state and dedupes warnings when logout removes the current model's credentials", async () => {
    const hub = new CapturingSessionEventHub();
    const authStorage = AuthStorage.inMemory({ anthropic: { type: "api_key", key: "sk-test" } });
    const modelRegistry = ModelRegistry.create(authStorage);
    const model = modelRegistry.find("anthropic", "claude-3-5-sonnet-20241022");
    if (model === undefined) throw new Error("Expected Anthropic model fixture");
    const fake = fakeRuntime("auth-session", { model, modelRegistry });

    const service = new PiSessionService(hub, {
      modelRegistry,
      createAgentRuntime: runtimeCreator(fake.runtime),
      sessionManager: sessionGateway([sessionRecord("auth-session")]),
      heartbeatIntervalMs: 60_000,
    });

    await service.status("auth-session");
    hub.sessionEvents.length = 0;
    hub.globalEvents.length = 0;

    authStorage.logout("anthropic");
    service.applyAuthChange({ removedProviderId: "anthropic" });
    service.applyAuthChange({ removedProviderId: "anthropic" });

    const warningCount = () => hub.sessionEvents.filter(({ event }) => event.type === "command.output" && event.level === "error" && event.message.includes("anthropic/claude-3-5-sonnet-20241022")).length;
    expect(warningCount()).toBe(1);
    expect(hub.globalEvents.some((event) => event.type === "status.update" && event.status.sessionId === "auth-session")).toBe(true);

    authStorage.set("anthropic", { type: "api_key", key: "sk-new" });
    service.applyAuthChange();
    authStorage.logout("anthropic");
    service.applyAuthChange({ removedProviderId: "anthropic" });
    expect(warningCount()).toBe(2);

    await service.dispose();
  });

  it("clears queued messages when stopping a session runtime", async () => {
    const fake = fakeRuntime("stop-session");
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      createAgentRuntime: runtimeCreator(fake.runtime),
      sessionManager: sessionGateway([sessionRecord("stop-session")]),
      heartbeatIntervalMs: 60_000,
    });

    await service.status("stop-session");
    service.stop("stop-session");

    expect(fake.calls.clearQueue).toBe(1);
    await service.dispose();
  });
});
