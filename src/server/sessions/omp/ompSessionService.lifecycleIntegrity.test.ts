import { describe, expect, it } from "vitest";
import { PendingExtensionDialogStore } from "../pendingExtensionDialogStore.js";
import { OmpSessionService } from "./ompSessionService.js";
import {
  CapturingSessionEventHub,
  FakeOmpRpcClient,
  FakeOmpSessionStore,
  getStatePayload,
  NEW_SESSION_ACCEPTED,
  ompRef,
  sessionInfo,
  sessionStatsPayload,
  TEST_AGENT_DIR,
  TEST_NATIVE_ID_A,
  type OmpRpcClientLike,
  type OmpRpcClientOptions,
  type OmpRpcFrame,
} from "./ompSessionService.testSupport.js";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

class DeadAwareOmpRpcClient extends FakeOmpRpcClient {
  override request<T = unknown>(command: OmpRpcFrame): Promise<T> {
    if (!this.alive) return Promise.reject(new Error("OMP RPC process is not running"));
    return super.request<T>(command);
  }
}

class DeferredCloseOmpRpcClient extends DeadAwareOmpRpcClient {
  closeGate: Promise<void> | undefined;

  override async close(): Promise<void> {
    if (this.closeGate !== undefined) await this.closeGate;
    await super.close();
  }
}

function clientFactory<TClient extends FakeOmpRpcClient>(
  create: (options: OmpRpcClientOptions) => TClient,
  configure: (client: TClient) => void,
): { factory: (options: OmpRpcClientOptions) => OmpRpcClientLike; clients: TClient[] } {
  const clients: TClient[] = [];
  return {
    clients,
    factory: (options) => {
      const client = create(options);
      configure(client);
      clients.push(client);
      return client;
    },
  };
}

function configureExistingSession(client: FakeOmpRpcClient): void {
  client.onSuccess("get_session_stats", sessionStatsPayload(TEST_NATIVE_ID_A));
  client.onSuccess("get_state", getStatePayload(TEST_NATIVE_ID_A));
}

function existingStore(): FakeOmpSessionStore {
  return new FakeOmpSessionStore().seed({
    nativeId: TEST_NATIVE_ID_A,
    cwd: "/workspace",
    path: "/workspace/session.jsonl",
    info: sessionInfo(TEST_NATIVE_ID_A),
  });
}

async function settleMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("OmpSessionService: runtime identity and lifecycle integrity", () => {
  it.each([
    ["missing", {}],
    ["malformed", { sessionId: "not-a-native-uuid" }],
  ])("rejects a %s fresh native identity before registration or publication", async (_case, stats) => {
    const { factory, clients } = clientFactory(
      (options) => new DeadAwareOmpRpcClient(options),
      (client) => {
        client.onSuccess("new_session", NEW_SESSION_ACCEPTED);
        client.onSuccess("get_session_stats", stats);
      },
    );
    const hub = new CapturingSessionEventHub();
    const service = new OmpSessionService(hub, {
      agentDir: TEST_AGENT_DIR,
      createRpcClient: factory,
      store: new FakeOmpSessionStore(),
    });

    await expect(service.start("/workspace")).rejects.toThrow();

    expect(service.activeCount()).toBe(0);
    expect(clients).toHaveLength(1);
    expect(clients[0]?.closed).toBe(true);
    expect(hub.globalEvents.filter((event) => event.type === "session.created")).toEqual([]);
  });

  it("reopens a persisted session after its registered child dies", async () => {
    const { factory, clients } = clientFactory(
      (options) => new DeadAwareOmpRpcClient(options),
      configureExistingSession,
    );
    const service = new OmpSessionService(new CapturingSessionEventHub(), {
      agentDir: TEST_AGENT_DIR,
      createRpcClient: factory,
      store: existingStore(),
    });
    const ref = ompRef(TEST_NATIVE_ID_A);

    await service.status(ref);
    await clients[0]?.close();

    await expect(service.status(ref)).resolves.toMatchObject({ sessionId: ref.id, backend: "omp" });
    expect(clients).toHaveLength(2);
    expect(clients[0]?.closed).toBe(true);
    expect(clients[1]?.alive).toBe(true);
  });

  it("shares one reopened client when messages and status race after child death", async () => {
    const liveMessages = [{ role: "assistant", content: [{ type: "text", text: "reopened" }] }];
    const { factory, clients } = clientFactory(
      (options) => new DeadAwareOmpRpcClient(options),
      (client) => {
        configureExistingSession(client);
        client.onSuccess("get_messages", { messages: liveMessages });
      },
    );
    const service = new OmpSessionService(new CapturingSessionEventHub(), {
      agentDir: TEST_AGENT_DIR,
      createRpcClient: factory,
      store: existingStore(),
    });
    const ref = ompRef(TEST_NATIVE_ID_A);
    await service.status(ref);
    await clients[0]?.close();

    const [page, status] = await Promise.all([
      service.messages(ref),
      service.status(ref),
    ]);

    expect(page.messages).toEqual(liveMessages);
    expect(status).toMatchObject({ sessionId: ref.id, backend: "omp" });
    expect(clients).toHaveLength(2);
  });

  it("serializes close and reopen for one id and ignores events from the closing generation", async () => {
    const { factory, clients } = clientFactory(
      (options) => new DeferredCloseOmpRpcClient(options),
      configureExistingSession,
    );
    const hub = new CapturingSessionEventHub();
    const service = new OmpSessionService(hub, {
      agentDir: TEST_AGENT_DIR,
      createRpcClient: factory,
      store: existingStore(),
    });
    const ref = ompRef(TEST_NATIVE_ID_A);
    await service.status(ref);
    const first = clients[0];
    if (first === undefined) throw new Error("expected first OMP client");
    const closeGate: Deferred<void> = deferred();
    first.closeGate = closeGate.promise;
    hub.sessionEvents.length = 0;

    const stopping = service.stop(ref);
    first.emit({ type: "agent_start" });
    const reopening = service.status(ref);
    await settleMicrotasks();

    expect(clients).toHaveLength(1);
    expect(hub.eventsFor(ref.id).filter((event) => event.type === "agent.start")).toEqual([]);

    closeGate.resolve();
    await stopping;
    await expect(reopening).resolves.toMatchObject({ sessionId: ref.id });
    expect(clients).toHaveLength(2);

    first.emit({ type: "agent_start" });
    first.emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "stale text" },
      message: { role: "assistant", content: [] },
    });
    first.emit({ type: "tool_execution_start", toolCallId: "stale-tool", toolName: "read", args: { path: "stale.ts" } });
    expect(hub.eventsFor(ref.id).filter((event) =>
      event.type === "agent.start" || event.type === "assistant.delta" || event.type === "tool.start"
    )).toEqual([]);

    clients[1]?.emit({ type: "agent_start" });
    expect(hub.eventsFor(ref.id).filter((event) => event.type === "agent.start")).toHaveLength(1);
  });

  it("ends pending dialogs with their runtime and treats a late browser answer as stale", async () => {
    const dialogs = new PendingExtensionDialogStore({ createDialogId: () => "dialog-1" });
    const { factory, clients } = clientFactory(
      (options) => new DeadAwareOmpRpcClient(options),
      (client) => {
        client.onSuccess("new_session", NEW_SESSION_ACCEPTED);
        configureExistingSession(client);
      },
    );
    const hub = new CapturingSessionEventHub();
    const service = new OmpSessionService(hub, {
      agentDir: TEST_AGENT_DIR,
      createRpcClient: factory,
      store: existingStore(),
      pendingExtensionDialogStore: dialogs,
    });
    const session = await service.start("/workspace");
    const ref = { id: session.id, cwd: session.cwd };
    const first = clients[0];
    if (first === undefined) throw new Error("expected fresh OMP client");
    first.emit({ type: "extension_ui_request", id: "wire-dialog-1", method: "confirm", title: "Continue?", message: "Proceed" });
    expect(dialogs.pendingDialogs(ref.id)).toHaveLength(1);

    await service.stop(ref);

    expect(dialogs.pendingDialogs(ref.id)).toEqual([]);
    expect(hub.eventsFor(ref.id)).toContainEqual(expect.objectContaining({
      type: "dialog.closed",
      dialogId: "dialog-1",
      reason: "session-ended",
    }));
    await expect(service.answerDialog(ref, "dialog-1", true)).resolves.toMatchObject({ result: "stale" });
    expect(clients.flatMap((client) => client.sent).filter((frame) => frame.type === "extension_ui_response")).toEqual([]);
  });
});
