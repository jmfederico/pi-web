import { createEventBus } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { PiSessionEventConnections } from "./piSessionEventConnections.js";

describe("session-local package event connections", () => {
  it("delivers synchronous replies and isolates sessions and connection subscriptions", () => {
    const registry = new PiSessionEventConnections();
    const first = {}, second = {};
    const bus = createEventBus(), otherBus = createEventBus();
    registry.register(first, bus);
    registry.register(second, otherBus);
    const lifetime = new AbortController();
    const connection = registry.connect(first, lifetime.signal);
    const sibling = registry.connect(first, lifetime.signal);
    const other = registry.connect(second, lifetime.signal);
    bus.on("request", (data) => { bus.emit("reply", data); });
    const receive = vi.fn(), siblingReceive = vi.fn(), otherReceive = vi.fn();
    const unsubscribe = connection.on("reply", receive);
    sibling.on("reply", siblingReceive);
    other.on("reply", otherReceive);
    connection.emit("request", { hello: "Pi" });
    expect(receive).toHaveBeenCalledWith({ hello: "Pi" });
    expect(siblingReceive).toHaveBeenCalledTimes(1);
    expect(otherReceive).not.toHaveBeenCalled();
    unsubscribe();
    connection.close();
    connection.close();
    sibling.emit("request", 2);
    expect(receive).toHaveBeenCalledTimes(1);
    expect(siblingReceive).toHaveBeenCalledTimes(2);
    expect(() => { connection.emit("request", 3); }).toThrow("connection closed");
    expect(() => connection.on("reply", receive)).toThrow("connection closed");
    lifetime.abort();
    expect(sibling.signal.aborted).toBe(true);
    expect(other.signal.aborted).toBe(true);
    bus.emit("reply", 4);
    expect(siblingReceive).toHaveBeenCalledTimes(2);
  });

  it("keeps native async listener error reporting without making emit await work", async () => {
    const registry = new PiSessionEventConnections();
    const session = {};
    registry.register(session, createEventBus());
    const lifetime = new AbortController();
    const connection = registry.connect(session, lifetime.signal);
    let reject!: (error: Error) => void;
    const pending = new Promise<void>((_resolve, rejectPromise) => { reject = rejectPromise; });
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      connection.on("request", () => pending);
      connection.emit("request", null);
      const error = new Error("companion reply handler failed");
      reject(error);
      await pending.catch(() => undefined);
      expect(logged).toHaveBeenCalledWith("Event handler error (request):", error);
    } finally {
      connection.close();
      logged.mockRestore();
    }
  });

  it("invalidates concrete sessions without retargeting old handles", () => {
    const registry = new PiSessionEventConnections();
    const session = {};
    const bus = createEventBus();
    registry.register(session, bus);
    const lifetime = new AbortController();
    const old = registry.connect(session, lifetime.signal);
    const receive = vi.fn();
    old.on("event", receive);
    registry.close(session);
    expect(old.signal.aborted).toBe(true);
    expect(() => registry.connect(session, lifetime.signal)).toThrow("does not have");
    registry.register(session, createEventBus());
    expect(registry.connect(session, lifetime.signal).signal.aborted).toBe(false);
    bus.emit("event", "stale");
    expect(receive).not.toHaveBeenCalled();
    lifetime.abort();
  });
});
