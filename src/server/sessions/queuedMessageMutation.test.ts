import { Agent, type AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it, vi } from "vitest";
import { PiSessionService, type PiSessionLogger } from "./piSessionService.js";
import { CapturingSessionEventHub, fakeRuntime, runtimeCreator, sessionGateway, sessionRecord, sessionRef, testModelRuntime } from "./piSessionService.testSupport.js";
import { mirroredQueueEntries, parseQueueMessageMutation, queuedMessageAttachmentCounts, snapshotAgentQueues } from "./queuedMessageMutation.js";

function fixture(logger?: PiSessionLogger) {
  const fake = fakeRuntime("queue-session");
  const agent = new Agent({ streamFn: () => { throw new Error("Must not run model"); } });
  const steering: string[] = [];
  const followUp: string[] = [];
  fake.session.agent = agent;
  fake.session.getSteeringMessages = () => steering;
  fake.session.getFollowUpMessages = () => followUp;
  Object.defineProperty(fake.session, "pendingMessageCount", { get: () => steering.length + followUp.length });
  const service = new PiSessionService(new CapturingSessionEventHub(), {
    agentDir: "/tmp/pi-web-test-agent", modelRuntime: testModelRuntime,
    createAgentRuntime: runtimeCreator(fake.runtime), sessionManager: sessionGateway([sessionRecord("queue-session")]), heartbeatIntervalMs: 60_000,
    ...(logger === undefined ? {} : { logger }),
  });
  function enqueue(kind: "steer" | "followUp", text: string, image: boolean | number = false) {
    const count = typeof image === "number" ? image : image ? 1 : 0;
    const message: AgentMessage = { role: "user", timestamp: 42, content: [{ type: "text", text }, ...Array.from({ length: count }, () => ({ type: "image" as const, data: "original-bytes", mimeType: "image/png" }))] };
    (kind === "steer" ? steering : followUp).push(text);
    agent[kind](message);
    return message;
  }
  return { fake, agent, service, enqueue, ref: sessionRef("queue-session") };
}

describe("queued message mutation", () => {
  it("snapshots full queues with modes restored, including follow-up-only queues", () => {
    const agent = new Agent({ streamFn: () => { throw new Error("unused"); } });
    const first: AgentMessage = { role: "user", content: "one", timestamp: 1 };
    const second: AgentMessage = { role: "user", content: "two", timestamp: 2 };
    agent.followUp(first); agent.followUp(second);
    expect(snapshotAgentQueues(agent)).toEqual({ steer: [], followUp: [first, second] });
    expect(agent.followUpMode).toBe("one-at-a-time");
    expect(agent.peekQueuedMessages()).toEqual([first]);
  });

  it("removes only one duplicate and preserves images, custom messages, and modes", async () => {
    const f = fixture();
    try {
      f.enqueue("steer", "duplicate");
      const retained = f.enqueue("steer", "duplicate", true);
      const custom: AgentMessage = { role: "custom", customType: "test", content: "opaque", display: false, timestamp: 12 };
      f.agent.followUp(custom);
      const follow = f.enqueue("followUp", "later", true);
      const before = await f.service.status(f.ref);
      const result = await f.service.mutateQueueMessage(f.ref, { action: "remove", index: 0, expectedQueue: before.queuedMessages });
      expect(result.queuedMessages).toEqual([{ kind: "steer", text: "duplicate", hasAttachments: true, attachmentCount: 1 }, { kind: "followUp", text: "later", hasAttachments: true, attachmentCount: 1 }]);
      const queues = snapshotAgentQueues(f.agent);
      expect(queues.steer[0]).toBe(retained);
      expect(queues.followUp).toEqual([custom, follow]);
      expect(queues.followUp[0]).toBe(custom);
      expect(f.fake.calls.prompt).toEqual([]);
      expect(f.agent.steeringMode).toBe("one-at-a-time");
    } finally { await f.service.dispose(); }
  });

  it("publishes attachment counts without exposing payloads and retains counts after switching modes", async () => {
    const f = fixture();
    try {
      f.enqueue("steer", "", 3);
      f.enqueue("followUp", "plain");
      const before = await f.service.status(f.ref);
      expect(before.queuedMessages).toEqual([{ kind: "steer", text: "", hasAttachments: true, attachmentCount: 3 }, { kind: "followUp", text: "plain" }]);
      const after = await f.service.mutateQueueMessage(f.ref, { action: "toggle", index: 0, expectedQueue: before.queuedMessages });
      expect(after.queuedMessages).toEqual([{ kind: "followUp", text: "plain" }, { kind: "followUp", text: "", hasAttachments: true, attachmentCount: 3 }]);
    } finally { await f.service.dispose(); }
  });

  it("rejects attached recall when the browser snapshot did not acknowledge attachments", async () => {
    const f = fixture();
    try {
      const attached = f.enqueue("followUp", "recall", true);
      const before = await f.service.status(f.ref);
      expect(before.queuedMessages).toEqual([{ kind: "followUp", text: "recall", hasAttachments: true, attachmentCount: 1 }]);
      await expect(f.service.mutateQueueMessage(f.ref, { action: "edit", index: 0, expectedQueue: [{ kind: "followUp", text: "recall" }] })).rejects.toThrow("Queued messages changed");
      expect(snapshotAgentQueues(f.agent).followUp).toEqual([attached]);
      await expect(f.service.mutateQueueMessage(f.ref, { action: "edit", index: 0, expectedQueue: before.queuedMessages })).resolves.toMatchObject({ queuedMessages: [] });
    } finally { await f.service.dispose(); }
  });

  it("marks held image attachments in status and retains the flag after switching modes", async () => {
    const f = fixture();
    try {
      f.fake.session.isCompacting = true;
      const attachment = { kind: "image", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAAFUlEQVR42mOUT3nIwMDAwMDAxAADABiCAWj7JLiIAAAAAElFTkSuQmCC" };
      await f.service.prompt(f.ref, "held image", "followUp", [attachment, attachment]);
      const before = await f.service.status(f.ref);
      expect(before.queuedMessages).toEqual([{ kind: "followUp", text: "held image", hasAttachments: true, attachmentCount: 2 }]);
      const after = await f.service.mutateQueueMessage(f.ref, { action: "toggle", index: 0, expectedQueue: before.queuedMessages });
      expect(after.queuedMessages).toEqual([{ kind: "steer", text: "held image", hasAttachments: true, attachmentCount: 2 }]);
    } finally { await f.service.dispose(); }
  });

  it("tolerates transient missing full messages when projecting attachment metadata", () => {
    expect(queuedMessageAttachmentCounts([], ["just enqueued"])).toEqual([0]);
  });

  it("edits by removing selected and later messages in steer-first execution order, including held prompts", async () => {
    const f = fixture();
    try {
      f.enqueue("steer", "keep");
      f.enqueue("followUp", "remove runtime followup");
      f.fake.session.isCompacting = true;
      await f.service.prompt(f.ref, "held followup", "followUp");
      await f.service.prompt(f.ref, "held steer", "steer");
      const before = await f.service.status(f.ref);
      expect(before.queuedMessages.map((entry) => entry.text)).toEqual(["keep", "held steer", "remove runtime followup", "held followup"]);
      const result = await f.service.mutateQueueMessage(f.ref, { action: "edit", index: 1, expectedQueue: before.queuedMessages });
      expect(result.queuedMessages).toEqual([{ kind: "steer", text: "keep" }]);
      expect(snapshotAgentQueues(f.agent).followUp).toEqual([]);
    } finally { await f.service.dispose(); }
  });

  it("toggles an attached SDK message to the destination tail without expanding prompts", async () => {
    const f = fixture();
    try {
      const moved = f.enqueue("steer", "/template already expanded", true);
      const existing = f.enqueue("followUp", "first");
      const before = await f.service.status(f.ref);
      const result = await f.service.mutateQueueMessage(f.ref, { action: "toggle", index: 0, expectedQueue: before.queuedMessages });
      expect(result.queuedMessages.map((entry) => entry.text)).toEqual(["first", "/template already expanded"]);
      expect(snapshotAgentQueues(f.agent).followUp).toEqual([existing, moved]);
      expect(f.fake.calls.prompt).toEqual([]);
    } finally { await f.service.dispose(); }
  });

  it("appends toggle after held destination prompts and preserves SDK attachments across another toggle", async () => {
    const f = fixture();
    try {
      const moved = f.enqueue("steer", "attached", true);
      f.fake.session.isCompacting = true;
      await f.service.prompt(f.ref, "held first", "followUp");
      const before = await f.service.status(f.ref);
      const result = await f.service.mutateQueueMessage(f.ref, { action: "toggle", index: 0, expectedQueue: before.queuedMessages });
      expect(result.queuedMessages).toEqual([{ kind: "followUp", text: "held first" }, { kind: "followUp", text: "attached", hasAttachments: true, attachmentCount: 1 }]);
      expect(snapshotAgentQueues(f.agent).steer).toEqual([]);
      const again = await f.service.mutateQueueMessage(f.ref, { action: "toggle", index: 1, expectedQueue: result.queuedMessages });
      expect(again.queuedMessages).toEqual([{ kind: "steer", text: "attached", hasAttachments: true, attachmentCount: 1 }, { kind: "followUp", text: "held first" }]);
      expect(moved.content).toContainEqual({ type: "image", data: "original-bytes", mimeType: "image/png" });
    } finally { await f.service.dispose(); }
  });

  it("drains a moved full SDK message without re-expansion after compaction", async () => {
    const f = fixture();
    try {
      const moved = f.enqueue("steer", "attached", true);
      f.fake.session.isCompacting = true;
      await f.service.prompt(f.ref, "held first", "followUp");
      const before = await f.service.status(f.ref);
      await f.service.mutateQueueMessage(f.ref, { action: "toggle", index: 0, expectedQueue: before.queuedMessages });
      const prompt = vi.spyOn(f.fake.session, "prompt");
      f.fake.session.isCompacting = false;
      f.fake.emit({ type: "compaction_end" });
      await expect.poll(() => f.fake.calls.prompt.length).toBe(2);
      expect(prompt).toHaveBeenLastCalledWith("attached", { expandPromptTemplates: false, images: Array.isArray(moved.content) ? moved.content.filter((part) => part.type === "image") : [] });
      expect(f.fake.calls.prompt.map((call) => call.text)).toEqual(["held first", "attached"]);
      expect((await f.service.status(f.ref)).queuedMessages).toEqual([]);
    } finally { await f.service.dispose(); }
  });

  it("rejects a changed unselected message and concurrent stale actions without mutation", async () => {
    const f = fixture();
    try {
      const first = f.enqueue("steer", "first");
      const later = f.enqueue("followUp", "later");
      const before = await f.service.status(f.ref);
      const stale = before.queuedMessages.map((entry) => ({ ...entry }));
      const staleLater = stale[1];
      if (staleLater === undefined) throw new Error("Expected follow-up fixture");
      staleLater.text = "different";
      await expect(f.service.mutateQueueMessage(f.ref, { action: "remove", index: 0, expectedQueue: stale })).rejects.toThrow("changed");
      expect(snapshotAgentQueues(f.agent)).toEqual({ steer: [first], followUp: [later] });
      const results = await Promise.allSettled([0, 1].map((index) => f.service.mutateQueueMessage(f.ref, { action: "remove", index, expectedQueue: before.queuedMessages })));
      expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    } finally { await f.service.dispose(); }
  });

  it.each([undefined, 42, async () => await Promise.resolve([])])("disables dependent controls for missing, non-callable or asynchronous SDK methods (%s)", async (method) => {
    const info = vi.fn<PiSessionLogger["info"]>();
    const f = fixture({ info });
    try {
      f.enqueue("followUp", "keep me", true);
      f.fake.session.isStreaming = true;
      Reflect.set(f.agent, "peekQueuedMessages", method);
      const before = await f.service.status(f.ref);
      expect(before).toMatchObject({ isStreaming: true, queuedMessages: [{ kind: "followUp", text: "keep me" }] });
      expect(before.queueMessageActionsUnavailable).toContain("incompatible");
      await expect(f.service.mutateQueueMessage(f.ref, { action: "remove", index: 0, expectedQueue: before.queuedMessages })).rejects.toThrow("unavailable");
      await f.service.status(f.ref);
      expect(info.mock.calls.filter(([, message]) => message === "Disabled SDK-dependent queue controls after an incompatible queue interface")).toHaveLength(1);
      expect(f.fake.calls.abort).toBe(0);
      Reflect.deleteProperty(f.agent, "peekQueuedMessages");
      expect(snapshotAgentQueues(f.agent).followUp).toHaveLength(1);
      // The guard remains disabled for this runtime, without retrying private operations.
      expect((await f.service.status(f.ref)).queueMessageActionsUnavailable).toBeDefined();
      await f.service.clearQueue(f.ref);
      expect(f.fake.calls.clearQueue).toBe(1);
    } finally { await f.service.dispose(); }
  });

  it.each([{ result: { messages: [] } }, { result: ["invalid message"] }, { result: [{ role: "user", content: null }] }])("rejects malformed inspection results before altering any queued messages (%s)", async ({ result }) => {
    const f = fixture();
    try {
      const original = f.enqueue("steer", "preserve");
      const clear = vi.spyOn(f.agent, "clearSteeringQueue");
      Reflect.set(f.agent, "peekQueuedMessages", () => result);
      const status = await f.service.status(f.ref);
      expect(status.queueMessageActionsUnavailable).toBeDefined();
      expect(status.queuedMessages).toEqual([{ kind: "steer", text: "preserve" }]);
      expect(clear).not.toHaveBeenCalled();
      Reflect.deleteProperty(f.agent, "peekQueuedMessages");
      expect(snapshotAgentQueues(f.agent).steer).toEqual([original]);
      expect(f.agent.steeringMode).toBe("one-at-a-time");
    } finally { await f.service.dispose(); }
  });

  it("removes the inspection probe when an SDK change returns copies instead of original messages", async () => {
    const f = fixture();
    try {
      const original = f.enqueue("steer", "preserve", true);
      const peek = f.agent.peekQueuedMessages.bind(f.agent);
      Reflect.set(f.agent, "peekQueuedMessages", () => peek().map((message) => structuredClone(message)));
      expect((await f.service.status(f.ref)).queueMessageActionsUnavailable).toBeDefined();
      Reflect.deleteProperty(f.agent, "peekQueuedMessages");
      expect(snapshotAgentQueues(f.agent).steer).toEqual([original]);
    } finally { await f.service.dispose(); }
  });

  it("keeps status readable when text mirrors become read-only or stop returning arrays", async () => {
    for (const invalid of [Object.freeze(["preserve"]), { messages: ["preserve"] }]) {
      const f = fixture();
      try {
        const original = f.enqueue("followUp", "preserve");
        Reflect.set(f.fake.session, "getFollowUpMessages", () => invalid);
        const status = await f.service.status(f.ref);
        expect(status.queueMessageActionsUnavailable).toBeDefined();
        expect(status.queuedMessages).toEqual(Array.isArray(invalid) ? [{ kind: "followUp", text: "preserve" }] : []);
        expect(snapshotAgentQueues(f.agent).followUp).toEqual([original]);
      } finally { await f.service.dispose(); }
    }
  });

  it("rejects copied text mirrors before changing queue contents", async () => {
    const f = fixture();
    try {
      const original = f.enqueue("followUp", "preserve");
      const getter = f.fake.session.getFollowUpMessages;
      f.fake.session.getFollowUpMessages = () => [...getter()];
      const before = await f.service.status(f.ref);
      await expect(f.service.mutateQueueMessage(f.ref, { action: "remove", index: 0, expectedQueue: before.queuedMessages })).rejects.toThrow("unavailable");
      expect(snapshotAgentQueues(f.agent).followUp).toEqual([original]);
      expect((await f.service.status(f.ref)).queueMessageActionsUnavailable).toBeDefined();
    } finally { await f.service.dispose(); }
  });

  it("attempts to restore original queues when replacement unexpectedly fails", async () => {
    const f = fixture();
    try {
      const steer = f.enqueue("steer", "preserve steer", true);
      const followUp = f.enqueue("followUp", "preserve follow-up", true);
      const before = await f.service.status(f.ref);
      vi.spyOn(f.agent, "followUp").mockImplementationOnce(() => { throw new Error("Changed enqueue signature"); });
      await expect(f.service.mutateQueueMessage(f.ref, { action: "remove", index: 0, expectedQueue: before.queuedMessages })).rejects.toThrow("unavailable");
      expect(snapshotAgentQueues(f.agent)).toEqual({ steer: [steer], followUp: [followUp] });
      expect((await f.service.status(f.ref)).queuedMessages).toEqual([{ kind: "steer", text: "preserve steer" }, { kind: "followUp", text: "preserve follow-up" }]);
      expect(f.fake.calls.abort).toBe(0);
    } finally { await f.service.dispose(); }
  });

  it("validates mutation input and fails closed on inconsistent text mirrors", () => {
    for (const value of [null, { action: "other", index: 0, expectedQueue: [] }, { action: "remove", index: -1, expectedQueue: [] }, { action: "edit", index: 0, expectedQueue: [{ kind: "bad", text: "x" }] }]) {
      expect(() => parseQueueMessageMutation(value)).toThrow();
    }
    expect(() => mirroredQueueEntries([], ["missing"])).toThrow("out of sync");
  });
});
