import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RealtimeSocket, SessionSocket, parseRealtimeSocketEvent, parseSessionSocketEvent } from "./sessionSocket";

function notification(order = 1) {
  return {
    id: `daemon-a:${String(order)}`,
    message: "notice",
    truncated: false,
    severity: "info",
    receivedAt: "2026-07-18T00:00:00.000Z",
    order,
  };
}

function summary() {
  return {
    sessionId: "session-1",
    cwd: "/repo",
    inboxRevision: 1,
    retainedCount: 1,
    discardedCount: 0,
    highestSeverity: "info",
  };
}

function inboxEvent() {
  return {
    type: "notifications.inbox",
    daemonInstanceId: "daemon-a",
    catalogRevision: 1,
    summary: summary(),
    dismissThrough: { order: 1, overflowWatermark: 0 },
    delta: { kind: "added", notification: notification() },
  };
}

describe("notification socket guards", () => {
  it("accepts validated selected-session events and drops global notification summaries", () => {
    expect(parseSessionSocketEvent(inboxEvent())).toMatchObject({ type: "notifications.inbox", delta: { kind: "added" } });

    expect(parseRealtimeSocketEvent({
      type: "notifications.summary",
      daemonInstanceId: "daemon-a",
      catalogRevision: 1,
      summary: summary(),
    })).toBeUndefined();
  });

  it("ignores malformed notification events instead of widening type-only acceptance", () => {
    expect(parseSessionSocketEvent({
      type: "notifications.inbox",
      daemonInstanceId: "daemon-a",
      catalogRevision: 1,
      summary: { ...summary(), highestSeverity: "fatal" },
      dismissThrough: { order: 1, overflowWatermark: 0 },
      delta: { kind: "added", notification: notification() },
    })).toBeUndefined();
  });

  it("accepts only strictly validated global unread deltas", () => {
    const unread = {
      sessionId: "session-1",
      cwd: "/repo",
      completionOrder: 1,
      completedAt: "2026-07-20T00:00:01.000Z",
    };
    expect(parseRealtimeSocketEvent({
      type: "sessions.unread",
      catalogId: "catalog-a",
      catalogRevision: 1,
      sessionId: unread.sessionId,
      cwd: unread.cwd,
      unread,
    })).toMatchObject({ type: "sessions.unread", unread });
    expect(parseRealtimeSocketEvent({
      type: "sessions.unread",
      catalogId: "catalog-a",
      catalogRevision: 1,
      sessionId: "other-session",
      cwd: unread.cwd,
      unread,
    })).toBeUndefined();
    expect(parseRealtimeSocketEvent({
      type: "sessions.unread",
      catalogId: "catalog-a",
      catalogRevision: 3.5,
      sessionId: unread.sessionId,
      cwd: unread.cwd,
      unread: null,
    })).toBeUndefined();
  });

  it("preserves existing event acceptance without treating unknown types as realtime events", () => {
    expect(parseSessionSocketEvent({ type: "command.output", level: "info", message: "legacy" })).toMatchObject({ type: "command.output" });
    expect(parseRealtimeSocketEvent({ type: "future.notification", payload: {} })).toBeUndefined();
  });
});

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly instances: FakeWebSocket[] = [];

  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: MessageEvent["data"] }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  close(): void {
    this.readyState = 3;
  }
}

describe("socket instance isolation", () => {
  const setTimeoutSpy = vi.fn(() => 1);

  beforeEach(() => {
    FakeWebSocket.instances.length = 0;
    setTimeoutSpy.mockClear();
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("document", { baseURI: "https://pi.example.test/" });
    vi.stubGlobal("window", { clearTimeout: vi.fn(), setTimeout: setTimeoutSpy });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("drops queued session frames and close callbacks from a replaced machine socket", async () => {
    const socket = new SessionSocket();
    const oldHandler = vi.fn();
    const newHandler = vi.fn();
    const onInitialOpen = vi.fn();
    const target = { id: "session-1", cwd: "/repo" };
    socket.connect(target, oldHandler, undefined, "machine-a");
    const oldSocket = FakeWebSocket.instances[0];
    if (oldSocket === undefined) throw new Error("expected old session socket");
    const staleClose = oldSocket.onclose;
    oldSocket.onmessage?.({ data: JSON.stringify(inboxEvent()) });

    socket.connect(target, newHandler, undefined, "machine-b", onInitialOpen);
    staleClose?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(oldHandler).not.toHaveBeenCalled();
    expect(newHandler).not.toHaveBeenCalled();
    expect(setTimeoutSpy).not.toHaveBeenCalled();

    const newSocket = FakeWebSocket.instances[1];
    if (newSocket === undefined) throw new Error("expected replacement session socket");
    newSocket.onopen?.();
    expect(onInitialOpen).toHaveBeenCalledOnce();
    newSocket.onmessage?.({ data: JSON.stringify(inboxEvent()) });
    await Promise.resolve();
    await Promise.resolve();
    expect(newHandler).toHaveBeenCalledOnce();
  });

  it("does not attribute a queued global frame to a replacement machine", async () => {
    const socket = new RealtimeSocket();
    const oldHandler = vi.fn();
    const newHandler = vi.fn();
    const event = {
      type: "workspace.activity",
      activity: {
        cwd: "/repo",
        hasSessionActivity: true,
        hasTerminalActivity: false,
        updatedAt: "2026-07-18T00:00:00.000Z",
      },
    };
    socket.connect(oldHandler, undefined, "machine-a");
    const oldSocket = FakeWebSocket.instances[0];
    if (oldSocket === undefined) throw new Error("expected old realtime socket");
    oldSocket.onmessage?.({ data: JSON.stringify(event) });

    socket.connect(newHandler, undefined, "machine-b");
    await Promise.resolve();
    await Promise.resolve();

    expect(oldHandler).not.toHaveBeenCalled();
    expect(newHandler).not.toHaveBeenCalled();

    const newSocket = FakeWebSocket.instances[1];
    if (newSocket === undefined) throw new Error("expected replacement realtime socket");
    newSocket.onmessage?.({ data: JSON.stringify(event) });
    await Promise.resolve();
    await Promise.resolve();
    expect(newHandler).toHaveBeenCalledOnce();
  });
});
