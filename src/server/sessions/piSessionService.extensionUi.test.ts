import { describe, expect, it } from "vitest";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { SessionStatus } from "../../shared/apiTypes.js";
import { PiSessionService, type PiAgentSession } from "./piSessionService.js";
import { CapturingSessionEventHub, emptyArchiveStore, fakeRuntime, runtimeCreator, sessionGateway, sessionRef, testModelRuntime } from "./piSessionService.testSupport.js";

const TEST_AGENT_DIR = "/tmp/pi-web-test-agent";

function serviceFor(fake: ReturnType<typeof fakeRuntime>, events: CapturingSessionEventHub): PiSessionService {
  return new PiSessionService(events, {
    agentDir: TEST_AGENT_DIR,
    modelRuntime: testModelRuntime,
    sessionManager: sessionGateway([]),
    archiveStore: emptyArchiveStore(),
    createAgentRuntime: runtimeCreator(fake.runtime),
    heartbeatIntervalMs: 60_000,
  });
}

function boundUi(fake: ReturnType<typeof fakeRuntime>): ExtensionUIContext {
  const bindings = fake.calls.bindExtensions.at(-1);
  if (bindings?.uiContext === undefined) throw new Error("session extensions were not bound");
  return bindings.uiContext;
}

function statusFrames(events: CapturingSessionEventHub): SessionStatus[] {
  return events.sessionEvents.flatMap(({ event }) => event.type === "status.update" ? [event.status] : []);
}

describe("PiSessionService extension UI status", () => {
  it("bridges bounded working messages and clears them without changing other extension state", async () => {
    const fake = fakeRuntime("session-1");
    const events = new CapturingSessionEventHub();
    const service = serviceFor(fake, events);
    try {
      await service.start("/workspace");
      const ui = boundUi(fake);
      ui.setWorkingMessage("Consulting the rubber duck");
      expect(statusFrames(events).at(-1)?.extensionUi).toEqual({ statuses: {}, widgets: {}, workingMessage: "Consulting the rubber duck" });
      const count = statusFrames(events).length;
      ui.setWorkingMessage("Consulting the rubber duck");
      expect(statusFrames(events)).toHaveLength(count);
      ui.setWorkingMessage("x".repeat(600));
      expect((await service.status(sessionRef("session-1"))).extensionUi?.workingMessage).toHaveLength(512);
      ui.setWorkingMessage();
      expect((await service.status(sessionRef("session-1"))).extensionUi).toBeUndefined();
      ui.setStatus("worker", "ready");
      ui.setWorkingMessage("   ");
      expect((await service.status(sessionRef("session-1"))).extensionUi).toEqual({ statuses: { worker: "ready" }, widgets: {} });
    } finally {
      await service.dispose();
    }
  });

  it("publishes status text and bounded string-array widgets, then removes cleared keys", async () => {
    const fake = fakeRuntime("session-1");
    const events = new CapturingSessionEventHub();
    const service = serviceFor(fake, events);
    try {
      await service.start("/workspace");
      const ui = boundUi(fake);
      expect((await service.status(sessionRef("session-1"))).extensionUi).toBeUndefined();

      ui.setStatus("worker", "running");
      ui.setWidget("subagent-async", ["PI_SUBAGENT_ASYNC_JSON:{\"version\":1}"]);
      expect(await service.status(sessionRef("session-1"))).toMatchObject({
        extensionUi: {
          statuses: { worker: "running" },
          widgets: { "subagent-async": ["PI_SUBAGENT_ASYNC_JSON:{\"version\":1}"] },
        },
      });
      expect(statusFrames(events).at(-1)?.extensionUi?.widgets["subagent-async"]).toEqual([
        "PI_SUBAGENT_ASYNC_JSON:{\"version\":1}",
      ]);

      const frameCount = statusFrames(events).length;
      ui.setStatus("worker", "running");
      ui.setWidget("subagent-async", ["PI_SUBAGENT_ASYNC_JSON:{\"version\":1}"]);
      expect(statusFrames(events)).toHaveLength(frameCount);

      ui.setStatus("worker", undefined);
      ui.setWidget("subagent-async", undefined);
      expect((await service.status(sessionRef("session-1"))).extensionUi).toBeUndefined();

      ui.setWidget("subagent-inspect", ["PI_SUBAGENT_INSPECT_JSON: private request/reply"]);
      let factoryCalls = 0;
      Reflect.apply(ui.setWidget.bind(ui), undefined, ["factory", () => { factoryCalls += 1; }]);
      expect(factoryCalls).toBe(0);
      expect((await service.status(sessionRef("session-1"))).extensionUi).toBeUndefined();
    } finally {
      await service.dispose();
    }
  });

  it("isolates state on runtime replacement and ignores old and disposed callbacks", async () => {
    const first = fakeRuntime("session-1");
    const replacement = fakeRuntime("session-2");
    const events = new CapturingSessionEventHub();
    let rebindSession: ((session: PiAgentSession) => Promise<void>) | undefined;
    first.runtime.setRebindSession = (callback) => { rebindSession = callback; };
    const service = serviceFor(first, events);
    let disposed = false;

    try {
      await service.start("/workspace");
      const oldUi = boundUi(first);
      oldUi.setStatus("worker", "old runtime");
      oldUi.setWorkingMessage("old phrase");
      expect((await service.status(sessionRef("session-1"))).extensionUi?.statuses).toEqual({ worker: "old runtime" });

      Object.defineProperty(first.runtime, "session", { configurable: true, value: replacement.session });
      if (rebindSession === undefined) throw new Error("runtime rebind callback was not installed");
      await rebindSession(replacement.session);
      const newUi = boundUi(replacement);
      expect((await service.status(sessionRef("session-2"))).extensionUi).toBeUndefined();

      const framesBeforeStaleCall = statusFrames(events).length;
      oldUi.setStatus("late", "stale");
      oldUi.setWorkingMessage("stale phrase");
      expect(statusFrames(events)).toHaveLength(framesBeforeStaleCall);

      newUi.setStatus("worker", "new runtime");
      const snapshot = await service.status(sessionRef("session-2"));
      expect(snapshot.extensionUi?.statuses).toEqual({ worker: "new runtime" });
      expect((await service.status(sessionRef("session-2"))).extensionUi).toEqual(snapshot.extensionUi);

      await service.dispose();
      disposed = true;
      const framesAfterDispose = statusFrames(events).length;
      newUi.setStatus("late", "disposed");
      newUi.setWorkingMessage("disposed phrase");
      expect(statusFrames(events)).toHaveLength(framesAfterDispose);
    } finally {
      if (!disposed) await service.dispose();
    }
  });

  it("installs fresh extension UI state before in-place reload startup writes", async () => {
    const fake = fakeRuntime("session-1");
    const events = new CapturingSessionEventHub();
    const service = serviceFor(fake, events);
    let startupUi: ExtensionUIContext | undefined;

    try {
      await service.start("/workspace");
      const oldUi = boundUi(fake);
      oldUi.setStatus("removed-extension", "old status");
      oldUi.setWidget("subagent-async", ["old widget"]);
      fake.session.reload = async (options) => {
        oldUi.setStatus("shutdown-callback", "must be ignored");
        await options?.beforeSessionStart?.();
        startupUi = fake.session.extensionRunner.getUIContext();
        startupUi.setStatus("new-extension", "startup status");
        startupUi.setWidget("subagent-async", ["new widget"]);
      };

      await expect(service.runCommand(sessionRef("session-1"), "/reload")).resolves.toMatchObject({ type: "done" });
      expect((await service.status(sessionRef("session-1"))).extensionUi).toEqual({
        statuses: { "new-extension": "startup status" },
        widgets: { "subagent-async": ["new widget"] },
      });

      const frameCount = statusFrames(events).length;
      oldUi.setStatus("removed-extension", "late stale callback");
      oldUi.setWidget("subagent-async", ["late stale widget"]);
      expect(statusFrames(events)).toHaveLength(frameCount);
      if (startupUi === undefined) throw new Error("replacement session_start did not receive a UI context");
      startupUi.setStatus("new-extension", "updated");
      expect((await service.status(sessionRef("session-1"))).extensionUi?.statuses).toEqual({
        "new-extension": "updated",
      });
    } finally {
      await service.dispose();
    }
  });

  it("invalidates the old bridge when in-place reload fails before replacement startup", async () => {
    const fake = fakeRuntime("session-1");
    const events = new CapturingSessionEventHub();
    const service = serviceFor(fake, events);

    try {
      await service.start("/workspace");
      const oldUi = boundUi(fake);
      oldUi.setStatus("old-extension", "old status");
      oldUi.setWidget("subagent-async", ["old widget"]);
      fake.session.reload = () => Promise.reject(new Error("reload failed before replacement"));

      await expect(service.runCommand(sessionRef("session-1"), "/reload")).resolves.toEqual({
        type: "unsupported",
        message: "Reload failed: reload failed before replacement",
      });
      expect((await service.status(sessionRef("session-1"))).extensionUi).toBeUndefined();

      const frameCount = statusFrames(events).length;
      oldUi.setStatus("late", "stale after failed reload");
      expect(statusFrames(events)).toHaveLength(frameCount);
    } finally {
      await service.dispose();
    }
  });

  it("keeps replacement startup UI state on reload failure and rejects the old bridge", async () => {
    const fake = fakeRuntime("session-1");
    const events = new CapturingSessionEventHub();
    const service = serviceFor(fake, events);
    let replacementUi: ExtensionUIContext | undefined;

    try {
      await service.start("/workspace");
      const oldUi = boundUi(fake);
      oldUi.setStatus("old-extension", "old status");
      fake.session.reload = async (options) => {
        await options?.beforeSessionStart?.();
        replacementUi = fake.session.extensionRunner.getUIContext();
        replacementUi.setStatus("new-extension", "candidate startup");
        throw new Error("reload failed after replacement");
      };

      await expect(service.runCommand(sessionRef("session-1"), "/reload")).resolves.toEqual({
        type: "unsupported",
        message: "Reload failed: reload failed after replacement",
      });
      expect((await service.status(sessionRef("session-1"))).extensionUi).toEqual({
        statuses: { "new-extension": "candidate startup" },
        widgets: {},
      });

      const frameCount = statusFrames(events).length;
      oldUi.setStatus("late", "stale after replacement");
      expect(statusFrames(events)).toHaveLength(frameCount);
      if (replacementUi === undefined) throw new Error("replacement runner did not receive a UI context");
      replacementUi.setStatus("new-extension", "still current");
      expect((await service.status(sessionRef("session-1"))).extensionUi?.statuses).toEqual({
        "new-extension": "still current",
      });
    } finally {
      await service.dispose();
    }
  });
});
