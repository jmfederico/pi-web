import { describe, expect, it, vi } from "vitest";
import { OmpSessionService } from "./ompSessionService.js";
import {
  CapturingSessionEventHub,
  fakeRpcClientFactory,
  FakeOmpSessionStore,
  getStatePayload,
  NEW_SESSION_ACCEPTED,
  ompRef,
  ompSessionId,
  sessionInfo,
  sessionStatsPayload,
  TEST_AGENT_DIR,
  TEST_NATIVE_ID_A,
  TEST_NATIVE_ID_B,
} from "./ompSessionService.testSupport.js";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}

describe("OmpSessionService: provisional startup identity bridge", () => {
  it("publishes the validated native identity and serves a startup dialog before new_session resolves", async () => {
    const newSession = deferred<{ cancelled: boolean }>();
    let switched = false;
    const factory = fakeRpcClientFactory((client) => {
      client.onSuccess("get_state", getStatePayload(TEST_NATIVE_ID_A));
      client.on("get_session_stats", () => sessionStatsPayload(switched ? TEST_NATIVE_ID_B : TEST_NATIVE_ID_A));
      client.on("new_session", async () => {
        queueMicrotask(() => {
          client.emit({ type: "extension_ui_request", id: "startup-wire", method: "confirm", title: "Trust project?", message: "Continue startup" });
        });
        const result = await newSession.promise;
        switched = true;
        return result;
      });
    });
    const hub = new CapturingSessionEventHub();
    const service = new OmpSessionService(hub, {
      agentDir: TEST_AGENT_DIR,
      createRpcClient: factory,
      store: new FakeOmpSessionStore(),
    });

    const starting = service.start("/workspace", { startupToken: "pending-browser-1", backend: "omp" });
    const provisionalId = ompSessionId(TEST_NATIVE_ID_A);
    await vi.waitFor(() => {
      expect(hub.globalEvents.some((event) => event.type === "session.startup" && event.startupToken === "pending-browser-1" && event.activity.sessionId === provisionalId && event.activity.phase === "active" && event.activity.startup === true)).toBe(true);
      expect(hub.eventsFor(provisionalId).some((event) => event.type === "dialog.opened" && event.dialog.title === "Trust project?")).toBe(true);
    });
    const opened = hub.eventsFor(provisionalId).find((event) => event.type === "dialog.opened");
    if (opened?.type !== "dialog.opened") throw new Error("expected startup dialog");

    const answering = service.answerDialog({ id: provisionalId, cwd: "/workspace" }, opened.dialog.dialogId, true);
    await vi.waitFor(() => {
      expect(factory.clients[0]?.sent).toContainEqual({ id: "startup-wire", type: "extension_ui_response", confirmed: true });
    });
    newSession.resolve(NEW_SESSION_ACCEPTED);
    await expect(answering).resolves.toMatchObject({ result: "closed" });

    const created = await starting;
    expect(created.id).toBe(ompSessionId(TEST_NATIVE_ID_B));
    expect(service.activeCount()).toBe(1);
    const createdEvents = hub.globalEvents.filter((event) => event.type === "session.created");
    expect(createdEvents).toHaveLength(1);
    expect(createdEvents[0]).toMatchObject({ type: "session.created", session: { id: ompSessionId(TEST_NATIVE_ID_B), backend: "omp" } });
    factory.clients[0]?.emit({ type: "command_output", text: "final identity output" });
    expect(hub.eventsFor(ompSessionId(TEST_NATIVE_ID_B))).toContainEqual(expect.objectContaining({ type: "command.output", message: "final identity output" }));
  });

  it("rejects a final identity already owned by another active client without replacing it", async () => {
    let freshSwitched = false;
    const factory = fakeRpcClientFactory((client) => {
      client.onSuccess("get_state", getStatePayload(TEST_NATIVE_ID_B));
      if (client.options.sessionFile !== undefined) {
        client.onSuccess("get_session_stats", sessionStatsPayload(TEST_NATIVE_ID_B));
      } else {
        client.on("get_session_stats", () => sessionStatsPayload(freshSwitched ? TEST_NATIVE_ID_B : TEST_NATIVE_ID_A));
        client.on("new_session", () => {
          freshSwitched = true;
          return NEW_SESSION_ACCEPTED;
        });
      }
    });
    const store = new FakeOmpSessionStore().seed({
      nativeId: TEST_NATIVE_ID_B,
      cwd: "/workspace",
      path: "/workspace/existing.jsonl",
      info: sessionInfo(TEST_NATIVE_ID_B),
    });
    const hub = new CapturingSessionEventHub();
    const service = new OmpSessionService(hub, { agentDir: TEST_AGENT_DIR, createRpcClient: factory, store });
    await service.status(ompRef(TEST_NATIVE_ID_B));
    const existing = factory.clients[0];

    await expect(service.start("/workspace", { startupToken: "pending-collision", backend: "omp" })).rejects.toThrow();

    expect(service.activeCount()).toBe(1);
    expect(existing?.alive).toBe(true);
    expect(factory.clients[1]?.closed).toBe(true);
    expect(hub.globalEvents.filter((event) => event.type === "session.created")).toEqual([]);
  });

  it("closes and removes a provisional runtime when new_session fails", async () => {
    const factory = fakeRpcClientFactory((client) => {
      client.onSuccess("get_session_stats", sessionStatsPayload(TEST_NATIVE_ID_A));
      client.onFailure("new_session", "startup hook failed");
    });
    const hub = new CapturingSessionEventHub();
    const service = new OmpSessionService(hub, {
      agentDir: TEST_AGENT_DIR,
      createRpcClient: factory,
      store: new FakeOmpSessionStore(),
    });

    await expect(service.start("/workspace", { startupToken: "pending-failure", backend: "omp" })).rejects.toThrow("startup hook failed");

    expect(service.activeCount()).toBe(0);
    expect(factory.clients[0]?.closed).toBe(true);
    expect(hub.globalEvents.some((event) => event.type === "session.startup" && event.startupToken === "pending-failure" && event.activity.sessionId === ompSessionId(TEST_NATIVE_ID_A) && event.activity.phase === "idle" && event.activity.startup === true)).toBe(true);
    expect(hub.globalEvents.filter((event) => event.type === "session.created")).toEqual([]);
  });
});
