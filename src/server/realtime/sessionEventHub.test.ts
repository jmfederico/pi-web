import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { SessionEventHub, type RealtimeSocket } from "./sessionEventHub.js";

class FakeSocket extends EventEmitter implements RealtimeSocket {
  readonly OPEN = 1;
  readyState = this.OPEN;
  send = vi.fn();
}

describe("SessionEventHub", () => {
  it("publishes session events only to sockets for that session", () => {
    const hub = new SessionEventHub();
    const sessionSocket = new FakeSocket();
    const otherSocket = new FakeSocket();
    hub.add("s1", sessionSocket);
    hub.add("s2", otherSocket);

    hub.publish("s1", { type: "assistant.delta", text: "hello" });

    expect(sessionSocket.send).toHaveBeenCalledWith(JSON.stringify({ type: "assistant.delta", text: "hello", seq: 1 }));
    expect(otherSocket.send).not.toHaveBeenCalled();
  });

  it("omits thinking signatures from final-message payloads without mutating source events", () => {
    const hub = new SessionEventHub();
    const socket = new FakeSocket();
    hub.add("s1", socket);
    const thinkingBlock = { type: "thinking", thinking: "private chain", thinkingSignature: "opaque-provider-payload", redacted: true };
    const message = { role: "assistant", content: [thinkingBlock, { type: "text", text: "visible answer" }] };

    hub.publish("s1", { type: "message.end", message });

    expect(socket.send).toHaveBeenCalledWith(JSON.stringify({
      type: "message.end",
      message: { role: "assistant", content: [{ type: "thinking", thinking: "private chain", redacted: true }, { type: "text", text: "visible answer" }] },
      seq: 1,
    }));
    expect(thinkingBlock.thinkingSignature).toBe("opaque-provider-payload");
  });

  it("removes session sockets on close and skips non-open sockets", () => {
    const hub = new SessionEventHub();
    const closed = new FakeSocket();
    const removed = new FakeSocket();
    closed.readyState = 3;
    hub.add("s1", closed);
    hub.add("s1", removed);
    removed.emit("close");

    hub.publish("s1", { type: "session.error", message: "boom" });

    expect(closed.send).not.toHaveBeenCalled();
    expect(removed.send).not.toHaveBeenCalled();
  });

  it("publishes global events only to global sockets", () => {
    const hub = new SessionEventHub();
    const globalSocket = new FakeSocket();
    const sessionSocket = new FakeSocket();
    hub.addGlobal(globalSocket);
    hub.add("s1", sessionSocket);

    const status = {
      sessionId: "s1",
      isStreaming: false,
      isCompacting: false,
      isBashRunning: false,
      pendingMessageCount: 0,
      queuedMessages: [],
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      cost: 0,
    };

    hub.publishGlobal({ type: "status.update", status });

    expect(globalSocket.send).toHaveBeenCalledWith(JSON.stringify({ type: "status.update", status }));
    expect(sessionSocket.send).not.toHaveBeenCalled();
  });

  it("stamps a monotonically increasing per-session seq on published events", () => {
    const hub = new SessionEventHub();
    const socket = new FakeSocket();
    hub.add("s1", socket);

    hub.publish("s1", { type: "assistant.delta", text: "a" });
    hub.publish("s1", { type: "assistant.delta", text: "b" });
    hub.publish("s1", { type: "assistant.delta", text: "c" });

    expect(socket.send).toHaveBeenNthCalledWith(1, JSON.stringify({ type: "assistant.delta", text: "a", seq: 1 }));
    expect(socket.send).toHaveBeenNthCalledWith(2, JSON.stringify({ type: "assistant.delta", text: "b", seq: 2 }));
    expect(socket.send).toHaveBeenNthCalledWith(3, JSON.stringify({ type: "assistant.delta", text: "c", seq: 3 }));
  });

  it("advances seq even when no sockets are attached so the watermark stays accurate", () => {
    const hub = new SessionEventHub();

    hub.publish("s1", { type: "assistant.delta", text: "a" });
    hub.publish("s1", { type: "assistant.delta", text: "b" });

    expect(hub.currentSeq("s1")).toBe(2);

    const socket = new FakeSocket();
    hub.add("s1", socket);
    hub.publish("s1", { type: "assistant.delta", text: "c" });

    expect(socket.send).toHaveBeenCalledWith(JSON.stringify({ type: "assistant.delta", text: "c", seq: 3 }));
  });

  it("tracks seq independently per session", () => {
    const hub = new SessionEventHub();
    const s1 = new FakeSocket();
    const s2 = new FakeSocket();
    hub.add("s1", s1);
    hub.add("s2", s2);

    hub.publish("s1", { type: "assistant.delta", text: "a" });
    hub.publish("s1", { type: "assistant.delta", text: "b" });
    hub.publish("s2", { type: "assistant.delta", text: "x" });

    expect(hub.currentSeq("s1")).toBe(2);
    expect(hub.currentSeq("s2")).toBe(1);
    expect(s1.send).toHaveBeenLastCalledWith(JSON.stringify({ type: "assistant.delta", text: "b", seq: 2 }));
    expect(s2.send).toHaveBeenCalledWith(JSON.stringify({ type: "assistant.delta", text: "x", seq: 1 }));
  });

  it("reports zero seq for a session that has never published", () => {
    const hub = new SessionEventHub();
    expect(hub.currentSeq("never")).toBe(0);
  });

  it("does not stamp seq on global events", () => {
    const hub = new SessionEventHub();
    const globalSocket = new FakeSocket();
    hub.addGlobal(globalSocket);

    hub.publishGlobal({ type: "session.name", sessionId: "s1", name: "Renamed" });

    expect(globalSocket.send).toHaveBeenCalledWith(JSON.stringify({ type: "session.name", sessionId: "s1", name: "Renamed" }));
  });
});
