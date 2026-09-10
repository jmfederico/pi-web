/** Browser-visible status, history, events, and failure cleanup across the native RPC boundary. */
import { describe, expect, it } from "vitest";
import type { SessionUiEvent } from "../../../shared/apiTypes.js";
import { OmpSessionService } from "./ompSessionService.js";
import {
  CapturingSessionEventHub,
  fakeRpcClientFactory,
  FakeOmpRpcClient,
  FakeOmpSessionStore,
  getStatePayload,
  NEW_SESSION_ACCEPTED,
  ompRef,
  ompSessionId,
  sessionStatsPayload,
  TEST_AGENT_DIR,
  TEST_NATIVE_ID_A,
  type OmpSessionStoreLike,
} from "./ompSessionService.testSupport.js";
type EventOfType<T extends SessionUiEvent["type"]> = Extract<SessionUiEvent, { type: T }>;


async function startedSession(configureClient?: (client: FakeOmpRpcClient) => void) {
  const store = new FakeOmpSessionStore();
  const factory = fakeRpcClientFactory((client) => {
    client.onSuccess("new_session", NEW_SESSION_ACCEPTED);
    client.onSuccess("get_session_stats", sessionStatsPayload(TEST_NATIVE_ID_A));
    client.onSuccess("get_state", getStatePayload(TEST_NATIVE_ID_A));
    configureClient?.(client);
  });
  const hub = new CapturingSessionEventHub();
  const service = new OmpSessionService(hub, { agentDir: TEST_AGENT_DIR, createRpcClient: factory, store });
  const session = await service.start("/workspace");
  const client = factory.clients[0];
  if (client === undefined) throw new Error("expected startedSession to have spawned a client");
  return { service, hub, factory, store, client, ref: { id: session.id, cwd: session.cwd } };
}

describe("OmpSessionService (consumer contract): status stats and queue", () => {
  it("maps get_state's queuedMessageCount into pendingMessageCount instead of hardcoding zero", async () => {
    const { ref, service } = await startedSession((c) => {
      c.onSuccess("get_state", getStatePayload(TEST_NATIVE_ID_A, { queuedMessageCount: 3 }));
    });

    const status = await service.status(ref);

    expect(status.pendingMessageCount).toBe(3);
  });

  it("pulls real tokens/cost from get_session_stats instead of hardcoding zero", async () => {
    const { ref, service } = await startedSession((c) => {
      c.onSuccess("get_session_stats", sessionStatsPayload(TEST_NATIVE_ID_A, {
        tokens: { input: 100, output: 50, reasoning: 0, cacheRead: 10, cacheWrite: 5, total: 165 },
        cost: 0.05,
      }));
    });

    const status = await service.status(ref);

    expect(status.tokens).toEqual({ input: 100, output: 50, cacheRead: 10, cacheWrite: 5, total: 165 });
    expect(status.cost).toBe(0.05);
  });
});

describe("OmpSessionService (consumer contract): message and tool event mapping", () => {
  it("publishes message.end with the final message content when a message finishes", async () => {
    const { hub, client } = await startedSession();
    const sessionId = ompSessionId(TEST_NATIVE_ID_A);
    const finalMessage = { role: "assistant", content: [{ type: "text", text: "done" }] };

    client.emit({ type: "message_end", message: finalMessage });

    const event = hub.eventsFor(sessionId).find((entry): entry is { type: "message.end"; message: unknown } => entry.type === "message.end");
    expect(event?.message).toEqual(finalMessage);
  });

  it("summarizes tool call args into a real summary instead of an empty placeholder", async () => {
    const { hub, client } = await startedSession();
    const sessionId = ompSessionId(TEST_NATIVE_ID_A);

    client.emit({ type: "tool_execution_start", toolCallId: "call-1", toolName: "bash", args: { command: "ls -la" } });

    const start = hub.eventsFor(sessionId).find((entry): entry is EventOfType<"tool.start"> => entry.type === "tool.start");
    expect(start?.summary).toBe("ls -la");
  });

  it("stringifies the tool result text instead of an empty placeholder", async () => {
    const { hub, client } = await startedSession();
    const sessionId = ompSessionId(TEST_NATIVE_ID_A);

    client.emit({ type: "tool_execution_end", toolCallId: "call-1", toolName: "bash", result: { output: "file.txt" }, isError: false });

    const end = hub.eventsFor(sessionId).find((entry): entry is EventOfType<"tool.end"> => entry.type === "tool.end");
    expect(end?.text).toBe("file.txt");
  });

  it("surfaces an unmapped agent-session frame (e.g. turn_start) as a generic pi.event rather than dropping it silently", async () => {
    const { hub, client } = await startedSession();
    const sessionId = ompSessionId(TEST_NATIVE_ID_A);

    client.emit({ type: "turn_start" });

    const generic = hub.eventsFor(sessionId).find((entry): entry is { type: "pi.event"; eventType: string } => entry.type === "pi.event");
    expect(generic?.eventType).toBe("turn_start");
  });
});

describe("OmpSessionService (consumer contract): persisted display normalization", () => {
  it("returns the same RPC-visible messages before and after the session process is opened", async () => {
    const timestamp = "2026-01-02T03:04:05.000Z";
    const persistedEntries = [
      { type: "thinking_level_change", id: "thinking", parentId: null, timestamp, thinkingLevel: "high" },
      { type: "service_tier_change", id: "tier", parentId: "thinking", timestamp, serviceTier: null },
      { type: "message", id: "old", parentId: "tier", timestamp, message: { role: "user", content: "compacted away", timestamp: Date.parse(timestamp) } },
      { type: "custom_message", id: "custom", parentId: "old", timestamp, customType: "notice", content: "kept custom context", display: true, details: { source: "hook" }, attribution: "agent" },
      { type: "branch_summary", id: "branch", parentId: "custom", timestamp, summary: "kept branch summary", fromId: "fork-source" },
      { type: "compaction", id: "compact", parentId: "branch", timestamp, summary: "compacted context", shortSummary: "compact", tokensBefore: 1_000, tokensAfter: 120, method: "soft", warning: "review summary", firstKeptEntryId: "custom" },
      { type: "message", id: "bash", parentId: "compact", timestamp, message: { role: "bashExecution", command: "printf ok", output: "ok", exitCode: 0, cancelled: false, truncated: false, timestamp: Date.parse(timestamp) } },
    ];
    // Canonical OMP mapping and order are defined by installed
    // session/session-context.ts:291-316,375-408,459-549. get_messages
    // exposes session.messages, so an active compaction summary precedes its
    // retained pre-compaction tail, followed by post-compaction messages.
    const rpcVisibleMessages = [
      {
        role: "compactionSummary",
        summary: "compacted context",
        shortSummary: "compact",
        tokensBefore: 1_000,
        tokensAfter: 120,
        method: "soft",
        warning: "review summary",
        timestamp: Date.parse(timestamp),
      },
      {
        role: "custom",
        customType: "notice",
        content: "kept custom context",
        display: true,
        details: { source: "hook" },
        attribution: "agent",
        timestamp: Date.parse(timestamp),
      },
      {
        role: "branchSummary",
        summary: "kept branch summary",
        fromId: "fork-source",
        timestamp: Date.parse(timestamp),
      },
      {
        role: "bashExecution",
        command: "printf ok",
        output: "ok",
        exitCode: 0,
        cancelled: false,
        truncated: false,
        timestamp: Date.parse(timestamp),
      },
    ];
    const store: OmpSessionStoreLike = {
      list: () => Promise.resolve([]),
      listAll: () => Promise.resolve([]),
      resolve: () => Promise.resolve({ path: "/x.jsonl", nativeId: TEST_NATIVE_ID_A }),
      messages: () => Promise.resolve(persistedEntries),
    };
    const factory = fakeRpcClientFactory((client) => {
      client.onSuccess("get_session_stats", sessionStatsPayload(TEST_NATIVE_ID_A));
      client.onSuccess("get_state", getStatePayload(TEST_NATIVE_ID_A));
      client.onSuccess("get_messages", { messages: rpcVisibleMessages });
    });
    const service = new OmpSessionService(new CapturingSessionEventHub(), { agentDir: TEST_AGENT_DIR, createRpcClient: factory, store });
    const ref = ompRef(TEST_NATIVE_ID_A);

    const cold = await service.messages(ref);
    await service.status(ref);
    const live = await service.messages(ref);

    expect(cold).toEqual(live);
    expect(cold).toEqual({ messages: rpcVisibleMessages, start: 0, total: rpcVisibleMessages.length });
  });
});

describe("OmpSessionService (consumer contract): messages() cwd guard", () => {
  it("does not read from a live client registered under a different workspace for the same native id", async () => {
    const permissiveStore: OmpSessionStoreLike = {
      list: () => Promise.resolve([]),
      listAll: () => Promise.resolve([]),
      resolve: () => Promise.resolve({ path: "/x.jsonl", nativeId: TEST_NATIVE_ID_A }),
      messages: () => Promise.resolve(["store-fallback"]),
    };
    const factory = fakeRpcClientFactory((client) => {
      client.onSuccess("get_session_stats", sessionStatsPayload(TEST_NATIVE_ID_A));
      client.onSuccess("get_state", getStatePayload(TEST_NATIVE_ID_A));
      client.onSuccess("get_messages", { messages: [] });
    });
    const service = new OmpSessionService(new CapturingSessionEventHub(), { agentDir: TEST_AGENT_DIR, createRpcClient: factory, store: permissiveStore });

    await service.status(ompRef(TEST_NATIVE_ID_A, "/workspace-a"));

    await expect(service.messages(ompRef(TEST_NATIVE_ID_A, "/workspace-b"))).rejects.toThrow(/workspace|cwd/i);
  });
});

describe("OmpSessionService (consumer contract): start() cleanup on transport failure", () => {
  it("closes the spawned process and propagates the error when new_session itself rejects (not just cancelled:true)", async () => {
    const factory = fakeRpcClientFactory((client) => {
      client.onSuccess("get_session_stats", sessionStatsPayload(TEST_NATIVE_ID_A));
      client.on("new_session", () => { throw new Error("transport broke mid-handshake"); });
    });
    const service = new OmpSessionService(new CapturingSessionEventHub(), { agentDir: TEST_AGENT_DIR, createRpcClient: factory, store: new FakeOmpSessionStore() });

    await expect(service.start("/workspace")).rejects.toThrow("transport broke mid-handshake");

    expect(factory.clients[0]?.closed).toBe(true);
    expect(service.activeCount()).toBe(0);
  });

  it("closes the spawned process and propagates the error when get_session_stats rejects", async () => {
    const factory = fakeRpcClientFactory((client) => {
      client.onSuccess("new_session", NEW_SESSION_ACCEPTED);
      client.on("get_session_stats", () => { throw new Error("stats unavailable"); });
    });
    const service = new OmpSessionService(new CapturingSessionEventHub(), { agentDir: TEST_AGENT_DIR, createRpcClient: factory, store: new FakeOmpSessionStore() });

    await expect(service.start("/workspace")).rejects.toThrow("stats unavailable");

    expect(factory.clients[0]?.closed).toBe(true);
    expect(service.activeCount()).toBe(0);
  });
});

describe("OmpSessionService (consumer contract): dispose drains in-flight opens", () => {
  it("does not leave a concurrently-opening session registered after dispose resolves", async () => {
    let releaseGate: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
    const store: OmpSessionStoreLike = {
      list: () => Promise.resolve([]),
      listAll: () => Promise.resolve([]),
      resolve: async () => {
        await gate;
        return { path: "/x.jsonl", nativeId: TEST_NATIVE_ID_A };
      },
      messages: () => Promise.resolve([]),
    };
    const factory = fakeRpcClientFactory((client) => {
      client.onSuccess("get_session_stats", sessionStatsPayload(TEST_NATIVE_ID_A));
    });
    const service = new OmpSessionService(new CapturingSessionEventHub(), { agentDir: TEST_AGENT_DIR, createRpcClient: factory, store });

    const openPromise = service.status(ompRef(TEST_NATIVE_ID_A)).catch(() => undefined);
    const disposePromise = service.dispose();
    releaseGate?.();
    await Promise.all([openPromise, disposePromise]);

    expect(service.activeCount()).toBe(0);
  });
});
