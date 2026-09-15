import { createEventBus } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { PiSessionService, type PiAgentSession } from "./piSessionService.js";
import { PiSessionEventConnections } from "./piSessionEventConnections.js";
import { CapturingSessionEventHub, emptyArchiveStore, fakeRuntime, runtimeCreator, sessionGateway, testModelRuntime } from "./piSessionService.testSupport.js";

describe("hosted event connection replacement", () => {
  it("does not connect while the observed session is still initializing extensions", async () => {
    const fake = fakeRuntime("session-1");
    const registry = new PiSessionEventConnections();
    registry.register(fake.session, createEventBus());
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const initializing = new Promise<void>((resolve) => { entered = resolve; });
    fake.session.bindExtensions = async () => { entered(); await pending; };
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: "/tmp/pi-web-events-test", modelRuntime: testModelRuntime,
      createAgentRuntime: runtimeCreator(fake.runtime), sessionEvents: registry,
      sessionManager: sessionGateway([]), archiveStore: emptyArchiveStore(), heartbeatIntervalMs: 60_000,
    });
    try {
      const starting = service.start("/workspace");
      await initializing;
      const ref = { id: "session-1", cwd: "/workspace" };
      const lifetime = new AbortController();
      expect(() => service.connectSessionEvents(ref, lifetime.signal)).toThrow("still initializing");
      release();
      await starting;
      expect(service.connectSessionEvents(ref, lifetime.signal).signal.aborted).toBe(false);
    } finally {
      release();
      await service.dispose();
    }
  });
  it.each(["session-1", "session-2"])("invalidates old handles on rebind to %s", async (nextId) => {
    const first = fakeRuntime("session-1");
    const replacement = fakeRuntime(nextId);
    const registry = new PiSessionEventConnections();
    const oldBus = createEventBus(), newBus = createEventBus();
    registry.register(first.session, oldBus);
    registry.register(replacement.session, newBus);
    let rebind: ((session: PiAgentSession) => Promise<void>) | undefined;
    first.runtime.setRebindSession = (callback) => { rebind = callback; };
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: "/tmp/pi-web-events-test", modelRuntime: testModelRuntime,
      createAgentRuntime: runtimeCreator(first.runtime), sessionEvents: registry,
      sessionManager: sessionGateway([]), archiveStore: emptyArchiveStore(), heartbeatIntervalMs: 60_000,
    });
    try {
      await service.start("/workspace");
      const lifetime = new AbortController();
      const old = service.connectSessionEvents({ id: "session-1", cwd: "/workspace" }, lifetime.signal);
      const receive = vi.fn();
      old.on("reply", receive);
      if (rebind === undefined) throw new Error("Runtime replacement was not bound");
      Object.defineProperty(first.runtime, "session", { configurable: true, value: replacement.session });
      await rebind(replacement.session);
      expect(old.signal.aborted).toBe(true);
      oldBus.emit("reply", "stale");
      newBus.emit("reply", "not implicitly retargeted");
      expect(receive).not.toHaveBeenCalled();
      const next = service.connectSessionEvents({ id: nextId, cwd: "/workspace" }, lifetime.signal);
      next.on("reply", receive);
      newBus.emit("reply", "new connection");
      expect(receive).toHaveBeenCalledWith("new connection");
      lifetime.abort();
      expect(next.signal.aborted).toBe(true);
      expect(service.activeCount()).toBe(1);
    } finally {
      await service.dispose();
    }
  });
});
