import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SessionRef, SessionUiEvent } from "../../../shared/apiTypes.js";
import { parseSlashCommand } from "../../../client/src/api/parsers.js";
import { SessionArchiveStore } from "../sessionArchiveStore.js";
import { SessionNotificationStore } from "../sessionNotificationStore.js";
import { SessionUnreadStore } from "../sessionUnreadStore.js";
import { OmpSessionService } from "./ompSessionService.js";
import {
  CapturingSessionEventHub,
  fakeRpcClientFactory,
  FakeOmpRpcClient,
  FakeOmpSessionStore,
  getStatePayload,
  NEW_SESSION_ACCEPTED,
  NEW_SESSION_CANCELLED,
  OMP_CAPABILITIES,
  ompRef,
  ompSessionId,
  sessionInfo,
  sessionStatsPayload,
  TEST_AGENT_DIR,
  TEST_NATIVE_ID_A,
  TEST_NATIVE_ID_B,
  type FakeOmpRpcClientFactory,
  type OmpSessionStoreLike,
} from "./ompSessionService.testSupport.js";
type DialogOpenedEvent = Extract<SessionUiEvent, { type: "dialog.opened" }>;


interface StartedSession {
  service: OmpSessionService;
  hub: CapturingSessionEventHub;
  factory: FakeOmpRpcClientFactory;
  store: FakeOmpSessionStore;
  client: FakeOmpRpcClient;
  ref: SessionRef;
}

/**
 * Start one fresh OMP session end-to-end (the same path the "fresh session
 * creation" tests prove in isolation) and hand back every seam a later
 * assertion might need. Reused across most describe blocks below, so a
 * shared fixture stays in lockstep with the fresh-start contract instead of
 * each block re-deriving it slightly differently.
 */
async function startedSession(
  configureClient?: (client: FakeOmpRpcClient) => void,
  serviceOptions: Record<string, unknown> = {},
): Promise<StartedSession> {
  const store = new FakeOmpSessionStore();
  const factory = fakeRpcClientFactory((client) => {
    client.onSuccess("new_session", NEW_SESSION_ACCEPTED);
    client.onSuccess("get_session_stats", sessionStatsPayload(TEST_NATIVE_ID_A));
    client.onSuccess("get_state", getStatePayload(TEST_NATIVE_ID_A));
    configureClient?.(client);
  });
  const hub = new CapturingSessionEventHub();
  const service = new OmpSessionService(hub, { agentDir: TEST_AGENT_DIR, createRpcClient: factory, store, ...serviceOptions });
  const session = await service.start("/workspace");
  const client = factory.clients[0];
  if (client === undefined) throw new Error("expected startedSession to have spawned a client");
  return { service, hub, factory, store, client, ref: { id: session.id, cwd: session.cwd } };
}

describe("OmpSessionService: fresh session creation", () => {
  it("spawns a fresh OMP process and, once new_session is accepted, issues get_session_stats to learn the native id", async () => {
    const factory = fakeRpcClientFactory((client) => {
      client.onSuccess("new_session", NEW_SESSION_ACCEPTED);
      client.onSuccess("get_session_stats", sessionStatsPayload(TEST_NATIVE_ID_A));
    });
    const service = new OmpSessionService(new CapturingSessionEventHub(), { agentDir: TEST_AGENT_DIR, createRpcClient: factory, store: new FakeOmpSessionStore() });

    const session = await service.start("/workspace");

    expect(factory.clients).toHaveLength(1);
    const client = factory.clients[0];
    expect(client?.options).toMatchObject({ cwd: "/workspace", agentDir: TEST_AGENT_DIR });
    expect(client?.options.sessionFile).toBeUndefined();
    expect(session).toMatchObject({ id: ompSessionId(TEST_NATIVE_ID_A), cwd: "/workspace", backend: "omp" });
    expect(service.activeCount()).toBe(1);
  });

  it("rejects when new_session reports cancelled:true, instead of silently returning whatever session the process auto-loaded", async () => {
    // Native new_session's success data
    // is {cancelled: boolean}. Treating a cancelled new_session as fresh
    // would misattribute an unrelated, possibly pre-existing session to this
    // caller.
    const factory = fakeRpcClientFactory((client) => {
      client.onSuccess("new_session", NEW_SESSION_CANCELLED);
      client.onSuccess("get_session_stats", sessionStatsPayload(TEST_NATIVE_ID_A));
    });
    const service = new OmpSessionService(new CapturingSessionEventHub(), { agentDir: TEST_AGENT_DIR, createRpcClient: factory, store: new FakeOmpSessionStore() });

    await expect(service.start("/workspace")).rejects.toThrow(/cancel/i);
    expect(service.activeCount()).toBe(0);
  });

  it("publishes session.created and status.update on the global feed for a fresh session", async () => {
    const { hub, service } = await startedSession();

    expect(hub.globalEvents.some((event) => event.type === "session.created" && event.session.id === ompSessionId(TEST_NATIVE_ID_A))).toBe(true);
    expect(hub.globalEvents.some((event) => event.type === "status.update" && event.status.sessionId === ompSessionId(TEST_NATIVE_ID_A))).toBe(true);
    await service.dispose();
  });

  it("surfaces a spawn failure (e.g. missing model configuration) without registering a session", async () => {
    // An OMP process with no
    // configured models fails before emitting its ready frame with
    // "No models available" on stderr, which OmpRpcClient must surface
    // through start()'s rejection rather than a generic message.
    const factory = fakeRpcClientFactory((client) => { client.failStart(new Error("No models available")); });
    const service = new OmpSessionService(new CapturingSessionEventHub(), { agentDir: TEST_AGENT_DIR, createRpcClient: factory, store: new FakeOmpSessionStore() });

    await expect(service.start("/workspace")).rejects.toThrow("No models available");
    expect(service.activeCount()).toBe(0);
  });
});

describe("OmpSessionService: resuming a persisted session", () => {
  it("resolves the ref through the store and resumes with the stored session file, without issuing new_session", async () => {
    const store = new FakeOmpSessionStore().seed({ nativeId: TEST_NATIVE_ID_A, cwd: "/workspace", path: "/workspace/.omp/sessions/a.jsonl", info: sessionInfo(TEST_NATIVE_ID_A) });
    const factory = fakeRpcClientFactory((client) => {
      client.onSuccess("get_session_stats", sessionStatsPayload(TEST_NATIVE_ID_A));
      client.onSuccess("get_state", getStatePayload(TEST_NATIVE_ID_A));
    });
    const service = new OmpSessionService(new CapturingSessionEventHub(), { agentDir: TEST_AGENT_DIR, createRpcClient: factory, store });

    const status = await service.status(ompRef(TEST_NATIVE_ID_A));

    expect(factory.clients).toHaveLength(1);
    const client = factory.clients[0];
    expect(client?.options.sessionFile).toBe("/workspace/.omp/sessions/a.jsonl");
    expect(client?.requested.some((command) => command.type === "new_session")).toBe(false);
    expect(status).toMatchObject({ sessionId: ompSessionId(TEST_NATIVE_ID_A), backend: "omp" });
  });

  it("rejects when the store has no matching OMP session for the ref", async () => {
    const service = new OmpSessionService(new CapturingSessionEventHub(), { agentDir: TEST_AGENT_DIR, createRpcClient: fakeRpcClientFactory(), store: new FakeOmpSessionStore() });

    await expect(service.status(ompRef(TEST_NATIVE_ID_A))).rejects.toThrow();
  });

  it("rejects when the ref's cwd does not match the session's stored workspace, without spawning a process", async () => {
    const store = new FakeOmpSessionStore().seed({ nativeId: TEST_NATIVE_ID_A, cwd: "/workspace-a", path: "/x.jsonl", info: sessionInfo(TEST_NATIVE_ID_A, "/workspace-a") });
    const factory = fakeRpcClientFactory();
    const service = new OmpSessionService(new CapturingSessionEventHub(), { agentDir: TEST_AGENT_DIR, createRpcClient: factory, store });

    await expect(service.status(ompRef(TEST_NATIVE_ID_A, "/workspace-b"))).rejects.toThrow();
    expect(factory.clients).toHaveLength(0);
  });

  it("rejects when the resumed process reports a different native session id than the store resolved (identity mismatch)", async () => {
    const store = new FakeOmpSessionStore().seed({ nativeId: TEST_NATIVE_ID_A, cwd: "/workspace", path: "/x.jsonl", info: sessionInfo(TEST_NATIVE_ID_A) });
    const factory = fakeRpcClientFactory((client) => {
      client.onSuccess("get_session_stats", sessionStatsPayload(TEST_NATIVE_ID_B));
      client.onSuccess("get_state", getStatePayload(TEST_NATIVE_ID_B));
    });
    const service = new OmpSessionService(new CapturingSessionEventHub(), { agentDir: TEST_AGENT_DIR, createRpcClient: factory, store });

    await expect(service.status(ompRef(TEST_NATIVE_ID_A))).rejects.toThrow(/identity|mismatch/i);
    expect(service.activeCount()).toBe(0);
  });
});

describe("OmpSessionService: concurrent open dedup", () => {
  it("shares one spawned process across concurrent calls for the same session", async () => {
    const store = new FakeOmpSessionStore().seed({ nativeId: TEST_NATIVE_ID_A, cwd: "/workspace", path: "/x.jsonl", info: sessionInfo(TEST_NATIVE_ID_A) });
    const factory = fakeRpcClientFactory((client) => {
      client.onSuccess("get_session_stats", sessionStatsPayload(TEST_NATIVE_ID_A));
      client.onSuccess("get_state", getStatePayload(TEST_NATIVE_ID_A));
    });
    const service = new OmpSessionService(new CapturingSessionEventHub(), { agentDir: TEST_AGENT_DIR, createRpcClient: factory, store });

    const [first, second] = await Promise.all([
      service.status(ompRef(TEST_NATIVE_ID_A)),
      service.status(ompRef(TEST_NATIVE_ID_A)),
    ]);

    expect(factory.clients).toHaveLength(1);
    expect(first.sessionId).toBe(ompSessionId(TEST_NATIVE_ID_A));
    expect(second.sessionId).toBe(ompSessionId(TEST_NATIVE_ID_A));
  });

  it("rejects a concurrent call for the same native session id under a mismatched cwd instead of silently reusing the process", async () => {
    // The store here deliberately resolves the same native id from either
    // workspace, isolating the SERVICE's own registry cwd guard (defense in
    // depth) from the store's own cwd validation already covered above.
    const permissiveStore: OmpSessionStoreLike = {
      list: () => Promise.resolve([]),
      listAll: () => Promise.resolve([]),
      resolve: () => Promise.resolve({ path: "/x.jsonl", nativeId: TEST_NATIVE_ID_A }),
      messages: () => Promise.resolve([]),
    };
    const factory = fakeRpcClientFactory((client) => {
      client.onSuccess("get_session_stats", sessionStatsPayload(TEST_NATIVE_ID_A));
      client.onSuccess("get_state", getStatePayload(TEST_NATIVE_ID_A));
    });
    const service = new OmpSessionService(new CapturingSessionEventHub(), { agentDir: TEST_AGENT_DIR, createRpcClient: factory, store: permissiveStore });

    await service.status(ompRef(TEST_NATIVE_ID_A, "/workspace-a"));
    await expect(service.status(ompRef(TEST_NATIVE_ID_A, "/workspace-b"))).rejects.toThrow(/workspace|cwd/i);
    expect(factory.clients).toHaveLength(1);
  });
});

describe("OmpSessionService: streaming events, status, and stream snapshot", () => {
  it("forwards assistant text deltas as assistant.delta events and buffers them for streamSnapshot", async () => {
    const { hub, client, ref, service } = await startedSession();
    const sessionId = ompSessionId(TEST_NATIVE_ID_A);

    client.emit({ type: "agent_start" });
    client.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Hel" }, message: { role: "assistant", content: [] } });
    client.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "lo" }, message: { role: "assistant", content: [] } });

    const deltas = hub.eventsFor(sessionId).filter((event): event is { type: "assistant.delta"; text: string } => event.type === "assistant.delta");
    expect(deltas.map((event) => event.text)).toEqual(["Hel", "lo"]);

    const snapshot = await service.streamSnapshot(ref);
    expect(snapshot.seq).toBe(hub.currentSeq(sessionId));
    expect(snapshot.partial).not.toBeNull();
  });

  it("forwards assistant thinking deltas as assistant.thinking.delta events", async () => {
    const { hub, client } = await startedSession();
    const sessionId = ompSessionId(TEST_NATIVE_ID_A);

    client.emit({ type: "agent_start" });
    client.emit({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "considering options" }, message: { role: "assistant", content: [] } });

    const deltas = hub.eventsFor(sessionId).filter((event): event is { type: "assistant.thinking.delta"; text: string } => event.type === "assistant.thinking.delta");
    expect(deltas.map((event) => event.text)).toEqual(["considering options"]);
  });

  it("forwards tool_execution_start/update/end as tool.start/tool.update/tool.end events", async () => {
    const { hub, client } = await startedSession();
    const sessionId = ompSessionId(TEST_NATIVE_ID_A);

    client.emit({ type: "tool_execution_start", toolCallId: "call-1", toolName: "read", args: { path: "a.ts" } });
    client.emit({ type: "tool_execution_update", toolCallId: "call-1", toolName: "read", partialResult: { content: [{ type: "text", text: "partial" }] } });
    client.emit({ type: "tool_execution_end", toolCallId: "call-1", toolName: "read", result: { content: [{ type: "text", text: "done" }] }, isError: false });

    const events = hub.eventsFor(sessionId);
    const start = events.find((event): event is { type: "tool.start"; toolName: string; toolCallId: string; summary: string } => event.type === "tool.start");
    const update = events.find((event): event is { type: "tool.update"; toolName: string; toolCallId: string; text: string } => event.type === "tool.update");
    const end = events.find((event): event is { type: "tool.end"; toolName: string; toolCallId: string; text: string; isError: boolean } => event.type === "tool.end");
    expect(start?.toolCallId).toBe("call-1");
    expect(update?.toolCallId).toBe("call-1");
    expect(end).toMatchObject({ toolCallId: "call-1", isError: false });
  });

  it("clears the buffered partial once agent_end arrives", async () => {
    const { hub, client, ref, service } = await startedSession();

    client.emit({ type: "agent_start" });
    client.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Hi" }, message: { role: "assistant", content: [] } });
    client.emit({ type: "agent_end", messages: [], isTerminal: true });

    expect(hub.eventsFor(ompSessionId(TEST_NATIVE_ID_A)).some((event) => event.type === "agent.end")).toBe(true);
    const snapshot = await service.streamSnapshot(ref);
    expect(snapshot.partial).toBeNull();
  });

  it("resolves prompt() promptly on a local-only response (agentInvoked:false) without waiting for a nonexistent agent_end", async () => {
    const { client, ref, hub, service } = await startedSession((c) => { c.onSuccess("prompt", { agentInvoked: false }); });

    await service.prompt(ref, "/help");

    expect(client.requested.some((command) => command.type === "prompt")).toBe(true);
    expect(hub.eventsFor(ompSessionId(TEST_NATIVE_ID_A)).some((event) => event.type === "agent.start" || event.type === "agent.end")).toBe(false);
  });

  it("surfaces a runtime extension_error frame as an observable session.error event (a genuine terminal failure, not swallowed)", async () => {
    const { client, hub } = await startedSession();
    const sessionId = ompSessionId(TEST_NATIVE_ID_A);

    client.emit({ type: "extension_error", extensionPath: "/project/.omp/extensions/broken.ts", event: "agent_start", error: "TypeError: cannot read property 'x' of undefined" });

    const errorEvent = hub.eventsFor(sessionId).find((event): event is { type: "session.error"; message: string } => event.type === "session.error");
    expect(errorEvent?.message).toContain("TypeError");
  });

  it("rejects prompt() outright when the RPC command itself fails, distinct from an accepted-then-streamed turn", async () => {
    const { ref, service } = await startedSession((c) => { c.onFailure("prompt", "Session is compacting", "session_busy"); });

    await expect(service.prompt(ref, "hello")).rejects.toThrow("Session is compacting");
  });

  it("surfaces a late, unmatched prompt failure frame (accepted then failed mid-schedule) as an observable terminal error, distinct from an immediate rejection", async () => {
    // prompt/abort_and_prompt can emit a LATER response with the
    // same id if async scheduling fails after the immediate accept; the
    // transport forwards such now-unmatched response frames through
    // onEvent rather than a second promise resolution.
    const { client, hub } = await startedSession((c) => { c.onSuccess("prompt", { agentInvoked: true }); });
    const sessionId = ompSessionId(TEST_NATIVE_ID_A);

    client.emit({ id: "req_1", type: "response", command: "prompt", success: false, error: "Failed to schedule prompt: provider unavailable" });

    const errorEvent = hub.eventsFor(sessionId).find((event): event is { type: "session.error"; message: string } => event.type === "session.error");
    expect(errorEvent?.message).toContain("provider unavailable");
  });

  it("maps get_state into ClientSessionStatus with backend omp and the fixed OMP capability set", async () => {
    const { ref, service } = await startedSession();

    const status = await service.status(ref);

    expect(status).toMatchObject({
      sessionId: ompSessionId(TEST_NATIVE_ID_A),
      backend: "omp",
      isStreaming: false,
      isCompacting: false,
      model: { provider: "anthropic", id: "claude-sonnet-4-5" },
      thinkingLevel: "medium",
      capabilities: OMP_CAPABILITIES,
    });
  });
});

describe("OmpSessionService: abort and stop", () => {
  it("sends an abort RPC command for an active session", async () => {
    const { client, ref, service } = await startedSession((c) => { c.onSuccess("abort", {}); });

    await service.abort(ref);

    expect(client.requested.some((command) => command.type === "abort")).toBe(true);
  });

  it("is a no-op when the session has no active process", async () => {
    const service = new OmpSessionService(new CapturingSessionEventHub(), { agentDir: TEST_AGENT_DIR, createRpcClient: fakeRpcClientFactory(), store: new FakeOmpSessionStore() });

    await expect(service.abort(ompRef(TEST_NATIVE_ID_A))).resolves.toBeUndefined();
  });

  it("stop closes the transport and forgets the process", async () => {
    const { client, ref, service } = await startedSession();

    await service.stop(ref);

    expect(client.closed).toBe(true);
    expect(service.activeCount()).toBe(0);
  });

  it("stop is a no-op when nothing is active", async () => {
    const service = new OmpSessionService(new CapturingSessionEventHub(), { agentDir: TEST_AGENT_DIR, createRpcClient: fakeRpcClientFactory(), store: new FakeOmpSessionStore() });

    await expect(service.stop(ompRef(TEST_NATIVE_ID_A))).resolves.toBeUndefined();
  });
});

describe("OmpSessionService: failures", () => {
  it("propagates a failed RPC command as a rejected promise carrying the server's error message", async () => {
    const { ref, service } = await startedSession((c) => { c.onFailure("set_model", "Model not found: acme/ghost", "model_not_found"); });

    await expect(service.setModel(ref, "acme", "ghost")).rejects.toThrow("Model not found: acme/ghost");
  });

  it("propagates a transport failure raised mid-request without hanging or falling back", async () => {
    const { ref, service } = await startedSession((c) => {
      c.on("get_available_models", () => { throw new Error("child process exited unexpectedly (signal SIGKILL)"); });
    });

    await expect(service.availableModels(ref)).rejects.toThrow(/exited unexpectedly/);
  });
});

describe("OmpSessionService: model controls", () => {
  it("lists available models via get_available_models", async () => {
    const { ref, service } = await startedSession((c) => {
      c.onSuccess("get_available_models", { models: [{ provider: "anthropic", id: "claude-sonnet-4-5" }] });
    });

    const models = await service.availableModels(ref);

    expect(models).toEqual([{ provider: "anthropic", id: "claude-sonnet-4-5" }]);
  });

  it("sets the model via set_model and returns refreshed status", async () => {
    const { client, ref, service } = await startedSession((c) => {
      c.onSuccess("set_model", {});
      c.onSuccess("get_state", getStatePayload(TEST_NATIVE_ID_A, { model: { provider: "openai", id: "gpt-5.2" } }));
    });

    const status = await service.setModel(ref, "openai", "gpt-5.2");

    expect(client.requested.some((command) => command.type === "set_model" && command["provider"] === "openai" && command["modelId"] === "gpt-5.2")).toBe(true);
    expect(status.model).toEqual({ provider: "openai", id: "gpt-5.2" });
  });

  it("cycles the model forward via cycle_model", async () => {
    const { client, ref, service } = await startedSession((c) => { c.onSuccess("cycle_model", {}); });

    await service.cycleModel(ref, "forward");

    expect(client.requested.some((command) => command.type === "cycle_model")).toBe(true);
  });

  it("rejects cycling the model backward: OMP's cycle_model command has no reverse direction", async () => {
    const { client, ref, service } = await startedSession();

    await expect(service.cycleModel(ref, "backward")).rejects.toThrow(/backward|not supported/i);
    expect(client.requested.some((command) => command.type === "cycle_model")).toBe(false);
  });

  it("rejects setModelEnabled and setModelScope: OMP has no enabled-model scope concept", async () => {
    const { ref, service } = await startedSession();

    await expect(service.setModelEnabled(ref, "anthropic", "claude-sonnet-4-5", false)).rejects.toThrow(/not supported/i);
    await expect(service.setModelScope(ref, "all")).rejects.toThrow(/not supported/i);
  });

  it("reports the supported OMP thinking levels", async () => {
    const { ref, service } = await startedSession();

    const levels = await service.availableThinkingLevels(ref);

    expect(levels).toEqual(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
  });
});

describe("OmpSessionService: interactive dialog responses", () => {
  it("bridges an extension_ui_request confirm into a pending dialog and answers it back over RPC", async () => {
    const { client, ref, hub, service } = await startedSession();
    const sessionId = ompSessionId(TEST_NATIVE_ID_A);

    client.emit({ type: "extension_ui_request", id: "ui_7", method: "confirm", title: "Confirm", message: "Continue?" });

    const opened = hub.eventsFor(sessionId).find((event): event is DialogOpenedEvent => event.type === "dialog.opened");
    expect(opened?.dialog).toMatchObject({ kind: "confirm", title: "Confirm" });
    if (opened === undefined) throw new Error("expected a dialog.opened event");
    const response = await service.answerDialog(ref, opened.dialog.dialogId, true);

    expect(response.result).toBe("closed");
    expect(client.sent).toContainEqual({ id: "ui_7", type: "extension_ui_response", confirmed: true });
  });

  it("bridges a select dialog's options and cancels it back over RPC", async () => {
    const { client, ref, hub, service } = await startedSession();
    const sessionId = ompSessionId(TEST_NATIVE_ID_A);

    client.emit({ type: "extension_ui_request", id: "ui_9", method: "select", title: "Pick one", options: ["a", "b"] });
    const opened = hub.eventsFor(sessionId).find((event): event is DialogOpenedEvent => event.type === "dialog.opened");
    expect(opened?.dialog.options).toEqual(["a", "b"]);

    if (opened === undefined) throw new Error("expected a dialog.opened event");
    await service.cancelDialog(ref, opened.dialog.dialogId);

    expect(client.sent).toContainEqual({ id: "ui_9", type: "extension_ui_response", cancelled: true });
  });

  it("bridges OMP's editor request onto the input dialog kind with multiline+initialValue, and answers with the edited text", async () => {
    // OMP's wire field is `prefill` (confirmed via installed
    // @oh-my-pi/pi-coding-agent/src/modes/rpc/rpc-types.ts:395-402: { title,
    // prefill?, promptStyle? }). PendingExtensionDialog's own field name is
    // `initialValue`, per BackendSelectionUi's locked-in apiTypes.ts design
    // (2026-09-10) — the service renames prefill -> initialValue at the
    // mapping boundary; kind stays "input", no separate "editor" kind value.
    const { client, ref, hub, service } = await startedSession();
    const sessionId = ompSessionId(TEST_NATIVE_ID_A);

    client.emit({ type: "extension_ui_request", id: "ui_editor", method: "editor", title: "Edit commit message", prefill: "fix: typo" });

    const opened = hub.eventsFor(sessionId).find((event): event is DialogOpenedEvent => event.type === "dialog.opened");
    expect(opened?.dialog).toMatchObject({ kind: "input", multiline: true, initialValue: "fix: typo" });

    if (opened === undefined) throw new Error("expected a dialog.opened event");
    await service.answerDialog(ref, opened.dialog.dialogId, "fix: typo in commit body");

    expect(client.sent).toContainEqual({ id: "ui_editor", type: "extension_ui_response", value: "fix: typo in commit body" });
  });

  it("closes the corresponding pending dialog when OMP sends a cancel request for it, without a host reply", async () => {
    // `targetId` confirmed via installed rpc-types.ts:403:
    // { type: "extension_ui_request"; id; method: "cancel"; targetId: string }.
    const { client, hub } = await startedSession();
    const sessionId = ompSessionId(TEST_NATIVE_ID_A);

    client.emit({ type: "extension_ui_request", id: "ui_1", method: "confirm", title: "Continue?" });
    expect(hub.eventsFor(sessionId).some((event) => event.type === "dialog.opened")).toBe(true);

    client.emit({ type: "extension_ui_request", id: "ui_2", method: "cancel", targetId: "ui_1" });

    expect(hub.eventsFor(sessionId).some((event) => event.type === "dialog.closed")).toBe(true);
    expect(client.sent).toHaveLength(0);
  });

  it("turns an OMP notify request into a real session notification rather than a dialog", async () => {
    // Fields confirmed via installed rpc-types.ts:404-410:
    // { method: "notify"; message: string; notifyType?: "info"|"warning"|"error" }.
    const { ref, client, service } = await startedSession();

    client.emit({ type: "extension_ui_request", id: "ui_n1", method: "notify", message: "Background task finished", notifyType: "info" });

    const inbox = service.notificationInbox(ref);
    expect(inbox.notifications.some((notification) => notification.message === "Background task finished")).toBe(true);
  });

  it("rejects submitAsk and cancelAsk: OMP has no ask_user tool (native dialogs still work via answerDialog/cancelDialog)", async () => {
    const { ref, service } = await startedSession();

    await expect(service.submitAsk(ref, "ask-1", { answers: [] })).rejects.toThrow(/not supported/i);
    await expect(service.cancelAsk(ref, "ask-1")).rejects.toThrow(/not supported/i);
  });

  it("responds to an unrecognized method with an explicit error notification and a cancel, never leaving OMP hanging silently", async () => {
    const { client, ref, service } = await startedSession();

    client.emit({ type: "extension_ui_request", id: "ui_future", method: "future_blocking_kind" });

    expect(client.sent).toContainEqual({ id: "ui_future", type: "extension_ui_response", cancelled: true });
    const inbox = service.notificationInbox(ref);
    expect(inbox.notifications.some((notification) => notification.severity === "error")).toBe(true);
  });

  it("safely ignores fire-and-forget OMP UI hints it has no surface for (setStatus/setWidget/set_editor_text/open_url), without cancelling or erroring", async () => {
    const { client, ref, service } = await startedSession();

    // Field shapes confirmed via installed rpc-types.ts:411-440.
    client.emit({ type: "extension_ui_request", id: "ui_status", method: "setStatus", statusKey: "sync", statusText: "Indexing…" });
    client.emit({ type: "extension_ui_request", id: "ui_widget", method: "setWidget", widgetKey: "todo", widgetLines: ["1. Plan", "2. Build"] });
    client.emit({ type: "extension_ui_request", id: "ui_editor_text", method: "set_editor_text", text: "draft text" });
    client.emit({ type: "extension_ui_request", id: "ui_open_url", method: "open_url", url: "https://example.com/oauth" });

    expect(client.sent).toHaveLength(0);
    expect(service.notificationInbox(ref).notifications).toHaveLength(0);
  });
});

describe("OmpSessionService: operations with no safe OMP RPC equivalent", () => {
  it("rejects clearQueue, dismissWarning, respondToCommand, and detachParent explicitly rather than silently no-op'ing", async () => {
    const { ref, service } = await startedSession();

    await expect(service.clearQueue(ref)).rejects.toThrow(/not supported/i);
    await expect(service.dismissWarning(ref, "any-id")).rejects.toThrow(/not supported/i);
    await expect(service.respondToCommand(ref, "req-1", "value")).rejects.toThrow(/not supported/i);
    await expect(service.detachParent(ref)).rejects.toThrow(/not supported/i);
  });

  it("rejects navigateTree and forkFromTree: OMP's `branch` command only rewinds to a selected USER message (agent-session.ts:9335-9438), excludes it, and returns {selectedText,images} to prefill an editor — it is not a generic fork-from-any-entry primitive, so PI WEB's tree navigator is not approximated onto it", async () => {
    const { ref, service } = await startedSession();

    await expect(service.navigateTree(ref, { targetId: "entry-1", expectedLeafId: null, summary: { mode: "none" } })).rejects.toThrow(/not supported/i);
    await expect(service.forkFromTree(ref, { entryId: "entry-1", expectedLeafId: null })).rejects.toThrow(/not supported/i);
  });
});

describe("OmpSessionService: default configuration", () => {
  it("resolves the default OMP agent dir from the injected homedir(), not process.env.HOME", async () => {
    const factory = fakeRpcClientFactory((client) => {
      client.onSuccess("new_session", NEW_SESSION_ACCEPTED);
      client.onSuccess("get_session_stats", sessionStatsPayload(TEST_NATIVE_ID_A));
    });
    const service = new OmpSessionService(new CapturingSessionEventHub(), {
      createRpcClient: factory,
      store: new FakeOmpSessionStore(),
      homedir: () => "/home/fixture-user",
    });

    await service.start("/workspace");

    expect(factory.clients[0]?.options.agentDir).toBe("/home/fixture-user/.omp/agent");
  });

  it("leaves command undefined by default so the transport's own \"omp\" default applies", async () => {
    const { client } = await startedSession();

    expect(client.options.command).toBeUndefined();
  });

  it("forwards an explicitly configured command to the transport", async () => {
    const factory = fakeRpcClientFactory((client) => {
      client.onSuccess("new_session", NEW_SESSION_ACCEPTED);
      client.onSuccess("get_session_stats", sessionStatsPayload(TEST_NATIVE_ID_A));
    });
    const service = new OmpSessionService(new CapturingSessionEventHub(), { agentDir: TEST_AGENT_DIR, command: "/opt/omp/bin/omp", createRpcClient: factory, store: new FakeOmpSessionStore() });

    await service.start("/workspace");

    expect(factory.clients[0]?.options.command).toBe("/opt/omp/bin/omp");
  });
});

describe("OmpSessionService: activeCount and dispose", () => {
  it("activeCount reflects live processes and dispose closes every one", async () => {
    const nativeIds = [TEST_NATIVE_ID_A, TEST_NATIVE_ID_B];
    let nextIndex = 0;
    const factory = fakeRpcClientFactory((client) => {
      const nativeId = nativeIds[nextIndex] ?? TEST_NATIVE_ID_A;
      nextIndex += 1;
      client.onSuccess("new_session", NEW_SESSION_ACCEPTED);
      client.onSuccess("get_session_stats", sessionStatsPayload(nativeId));
    });
    const service = new OmpSessionService(new CapturingSessionEventHub(), { agentDir: TEST_AGENT_DIR, createRpcClient: factory, store: new FakeOmpSessionStore() });

    await service.start("/workspace-a");
    await service.start("/workspace-b");
    expect(service.activeCount()).toBe(2);

    await service.dispose();

    expect(service.activeCount()).toBe(0);
    expect(factory.clients.every((client) => client.closed)).toBe(true);
  });
});

describe("OmpSessionService: shared notification and unread stores", () => {
  it("reuses the injected SessionNotificationStore and SessionUnreadStore instances rather than creating its own", async () => {
    const notificationStore = new SessionNotificationStore();
    const unreadStore = new SessionUnreadStore();
    const service = new OmpSessionService(new CapturingSessionEventHub(), {
      agentDir: TEST_AGENT_DIR,
      createRpcClient: fakeRpcClientFactory(),
      store: new FakeOmpSessionStore(),
      notificationStore,
      unreadStore,
    });

    expect(service.notificationCatalog()).toEqual(notificationStore.catalogSnapshot());
    expect(await service.unreadCatalog()).toEqual(await unreadStore.durableCatalogSnapshot());
  });
});

describe("OmpSessionService: read-only projections", () => {
  it("lists sessions for a cwd via the store, tagged with backend omp", async () => {
    const store = new FakeOmpSessionStore().seed({ nativeId: TEST_NATIVE_ID_A, cwd: "/workspace", path: "/x.jsonl", info: sessionInfo(TEST_NATIVE_ID_A) });
    const service = new OmpSessionService(new CapturingSessionEventHub(), { agentDir: TEST_AGENT_DIR, createRpcClient: fakeRpcClientFactory(), store });

    const sessions = await service.list("/workspace");

    expect(sessions).toEqual([expect.objectContaining({ id: ompSessionId(TEST_NATIVE_ID_A), backend: "omp" })]);
  });

  it("reads messages from the store without spawning a process when none is active", async () => {
    const messages = [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }];
    const persistedEntries = messages.map((message, index) => ({
      type: "message",
      id: `message-${String(index)}`,
      parentId: index === 0 ? null : `message-${String(index - 1)}`,
      timestamp: "2026-01-01T00:00:00.000Z",
      message,
    }));
    const store = new FakeOmpSessionStore().seed({ nativeId: TEST_NATIVE_ID_A, cwd: "/workspace", path: "/x.jsonl", info: sessionInfo(TEST_NATIVE_ID_A), messages: persistedEntries });
    const factory = fakeRpcClientFactory();
    const service = new OmpSessionService(new CapturingSessionEventHub(), { agentDir: TEST_AGENT_DIR, createRpcClient: factory, store });

    const page = await service.messages(ompRef(TEST_NATIVE_ID_A));

    expect(page).toEqual({ messages, start: 0, total: 2 });
    expect(factory.clients).toHaveLength(0);
  });

  it("keeps every native command category readable by browser autocomplete", async () => {
    const nativeCommands = [
      { name: "compact", source: "builtin" },
      { name: "skill:review", source: "skill" },
      { name: "extension-action", source: "extension" },
      { name: "custom-action", source: "custom" },
      { name: "mcp-prompt", source: "mcp_prompt" },
      { name: "file-prompt", source: "file", description: "A workspace prompt" },
    ];
    const { ref, service } = await startedSession((client) => {
      client.onSuccess("get_available_commands", { commands: nativeCommands });
    });

    expect((await service.commands(ref)).map(parseSlashCommand)).toEqual([
      { name: "compact", source: "builtin" },
      { name: "skill:review", source: "skill" },
      { name: "extension-action", source: "extension" },
      { name: "custom-action", source: "extension" },
      { name: "mcp-prompt", source: "prompt" },
      { name: "file-prompt", source: "prompt", description: "A workspace prompt" },
    ]);
  });
});

describe("OmpSessionService: archive, restore, and cleanup", () => {
  async function tempSession(): Promise<{ dir: string; sessionFile: string; store: FakeOmpSessionStore }> {
    const dir = await mkdtemp(join(tmpdir(), "pi-web-omp-archive-"));
    const sessionFile = join(dir, "session.jsonl");
    await writeFile(sessionFile, '{"type":"session","version":3,"id":"a1a1a1a1-0000-4000-8000-000000000001","cwd":"' + dir + '"}\n', "utf8");
    const store = new FakeOmpSessionStore().seed({
      nativeId: TEST_NATIVE_ID_A,
      cwd: dir,
      path: sessionFile,
      info: sessionInfo(TEST_NATIVE_ID_A, dir, { path: sessionFile, modified: "2020-01-01T00:00:00.000Z" }),
    });
    return { dir, sessionFile, store };
  }

  it("archives into its OWN SessionArchiveStore instance (never Pi's shared one), after stopping the active process", async () => {
    const { dir, store } = await tempSession();
    const piArchiveStore = new SessionArchiveStore(join(dir, "pi-archived-sessions.json"), join(dir, "pi-archive"));
    const ompArchiveStore = new SessionArchiveStore(join(dir, "omp-archived-sessions.json"), join(dir, "omp-archive"));
    const factory = fakeRpcClientFactory((client) => {
      client.onSuccess("get_session_stats", sessionStatsPayload(TEST_NATIVE_ID_A));
      client.onSuccess("get_state", getStatePayload(TEST_NATIVE_ID_A));
    });
    const service = new OmpSessionService(new CapturingSessionEventHub(), { agentDir: TEST_AGENT_DIR, createRpcClient: factory, store, archiveStore: ompArchiveStore });

    await service.status(ompRef(TEST_NATIVE_ID_A, dir));
    const client = factory.clients[0];
    if (client === undefined) throw new Error("expected status to create an OMP client");

    await service.archive(ompRef(TEST_NATIVE_ID_A, dir));

    expect(client.closed).toBe(true);
    expect(await ompArchiveStore.isArchived(ompSessionId(TEST_NATIVE_ID_A))).toBe(true);
    expect(await piArchiveStore.isArchived(ompSessionId(TEST_NATIVE_ID_A))).toBe(false);

    await rm(dir, { recursive: true, force: true });
  });

  it("restore() returns the archived transcript to its exact original path", async () => {
    const { dir, sessionFile, store } = await tempSession();
    const ompArchiveStore = new SessionArchiveStore(join(dir, "omp-archived-sessions.json"), join(dir, "omp-archive"));
    const factory = fakeRpcClientFactory((client) => {
      client.onSuccess("get_session_stats", sessionStatsPayload(TEST_NATIVE_ID_A));
      client.onSuccess("get_state", getStatePayload(TEST_NATIVE_ID_A));
    });
    const service = new OmpSessionService(new CapturingSessionEventHub(), { agentDir: TEST_AGENT_DIR, createRpcClient: factory, store, archiveStore: ompArchiveStore });

    await service.status(ompRef(TEST_NATIVE_ID_A, dir));
    await service.archive(ompRef(TEST_NATIVE_ID_A, dir));
    await service.restore(ompRef(TEST_NATIVE_ID_A, dir));

    const restoredRecord = await ompArchiveStore.get(ompSessionId(TEST_NATIVE_ID_A));
    expect(restoredRecord).toBeUndefined();
    const content = await readFile(sessionFile, "utf8");
    expect(content).toContain(TEST_NATIVE_ID_A);

    await rm(dir, { recursive: true, force: true });
  });

  it("cleanupPreview reuses sessionCleanup's structural helpers against the OMP store's own listing for an explicit cwd", async () => {
    const store = new FakeOmpSessionStore().seed({
      nativeId: TEST_NATIVE_ID_A,
      cwd: "/workspace",
      path: "/x.jsonl",
      info: sessionInfo(TEST_NATIVE_ID_A, "/workspace", { modified: "2020-01-01T00:00:00.000Z" }),
    });
    const dir = await mkdtemp(join(tmpdir(), "pi-web-omp-cleanup-"));
    const archiveStore = new SessionArchiveStore(join(dir, "omp-archived-sessions.json"), join(dir, "omp-archive"));
    const service = new OmpSessionService(new CapturingSessionEventHub(), { agentDir: TEST_AGENT_DIR, createRpcClient: fakeRpcClientFactory(), store, archiveStore });

    const preview = await service.cleanupPreview({ thresholds: { archiveIdleDays: 30 }, projectCwds: ["/workspace"] });

    expect(preview.totals.archiveCount).toBe(1);
    expect(preview.projects).toContainEqual(expect.objectContaining({ cwd: "/workspace", archiveCount: 1 }));

    await rm(dir, { recursive: true, force: true });
  });

  it("cleanup discovers sessions across every cwd via store.listAll() when projectCwds is omitted, and actually archives them", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-web-omp-cleanup-all-"));
    const pathA = join(dir, "a.jsonl");
    const pathB = join(dir, "b.jsonl");
    await writeFile(pathA, '{"type":"session"}\n', "utf8");
    await writeFile(pathB, '{"type":"session"}\n', "utf8");
    const store = new FakeOmpSessionStore()
      .seed({ nativeId: TEST_NATIVE_ID_A, cwd: "/workspace-a", path: pathA, info: sessionInfo(TEST_NATIVE_ID_A, "/workspace-a", { path: pathA, modified: "2020-01-01T00:00:00.000Z" }) })
      .seed({ nativeId: TEST_NATIVE_ID_B, cwd: "/workspace-b", path: pathB, info: sessionInfo(TEST_NATIVE_ID_B, "/workspace-b", { path: pathB, modified: "2020-01-01T00:00:00.000Z" }) });
    const archiveStore = new SessionArchiveStore(join(dir, "omp-archived-sessions.json"), join(dir, "omp-archive"));
    const service = new OmpSessionService(new CapturingSessionEventHub(), { agentDir: TEST_AGENT_DIR, createRpcClient: fakeRpcClientFactory(), store, archiveStore });

    const result = await service.cleanup({ thresholds: { archiveIdleDays: 30 } });

    expect(result.totals.archiveCount).toBe(2);
    expect(result.archivedSessionIds.sort()).toEqual([ompSessionId(TEST_NATIVE_ID_A), ompSessionId(TEST_NATIVE_ID_B)].sort());
    expect(await archiveStore.isArchived(ompSessionId(TEST_NATIVE_ID_A))).toBe(true);
    expect(await archiveStore.isArchived(ompSessionId(TEST_NATIVE_ID_B))).toBe(true);

    await rm(dir, { recursive: true, force: true });
  });
});
