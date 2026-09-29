import { describe, expect, it } from "vitest";
import { SessionEventHub } from "../realtime/sessionEventHub.js";
import { PiSessionService } from "./piSessionService.js";
import { fakeRuntime, fakeSessionManager, runtimeCreator, sessionGateway, sessionRecord, sessionRef, testModelRuntime } from "./piSessionService.testSupport.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function fixture(readBranch?: () => Promise<unknown[]>) {
  const branch: unknown[] = [];
  const state: { streamingMessage?: unknown } = {};
  const fake = fakeRuntime("session-1", { state, sessionManager: fakeSessionManager("/workspace", { getBranch: () => branch }) });
  const events = new SessionEventHub();
  const service = new PiSessionService(events, {
    agentDir: "/tmp/pi-web-test-agent",
    modelRuntime: testModelRuntime,
    createAgentRuntime: runtimeCreator(fake.runtime),
    sessionManager: { ...sessionGateway([sessionRecord("session-1")]), ...(readBranch === undefined ? {} : { readBranch }) },
    heartbeatIntervalMs: 60_000,
  });
  return { branch, fake, events, service, state };
}
const ref = sessionRef("session-1");
const user = { role: "user", content: "hello" };

describe("PiSessionService.transcriptSnapshot", () => {
  it("uses an unchanged idle disk branch for both history and status", async () => {
    const { service, events } = fixture(() => Promise.resolve([{ type: "message", message: user }]));
    try {
      const snapshot = await service.transcriptSnapshot(ref);
      expect(snapshot.page).toEqual({ start: 0, total: 1, messages: [user] });
      expect(snapshot.status).toMatchObject({ messageCount: 1, isStreaming: false });
      expect(snapshot.seq).toBe(events.currentSeq(ref.id));
      expect(snapshot.partial).toBeNull();
    } finally { await service.dispose(); }
  });

  it.each([false, true])("discards an idle disk read overlapping events (still active: %s)", async (stillActive) => {
    const disk = deferred<unknown[]>();
    const reading = deferred<undefined>();
    const { service, fake, branch, events } = fixture(() => { reading.resolve(undefined); return disk.promise; });
    try {
      const result = service.transcriptSnapshot(ref);
      await reading.promise;
      branch.push({ type: "message", message: user });
      fake.session.isStreaming = stillActive;
      fake.emit({ type: "message_end", message: user });
      disk.resolve([]);
      const snapshot = await result;
      expect(snapshot.page).toEqual({ start: 0, total: 1, messages: [user] });
      expect(snapshot.status).toMatchObject({ messageCount: 1, isStreaming: stillActive });
      expect(snapshot.seq).toBe(events.currentSeq(ref.id));
      expect(snapshot.partial).toBeNull();
    } finally { await service.dispose(); }
  });

  it("uses the active runtime branch and projects the current partial with a paged shape", async () => {
    const { service, fake, branch, events, state } = fixture(() => { throw new Error("must not read active disk"); });
    fake.session.isStreaming = true;
    fake.session.thinkingLevel = "high";
    state.streamingMessage = { role: "assistant", content: [{ type: "thinking", thinking: "working", thinkingSignature: "secret" }] };
    branch.push({ type: "message", message: user });
    try {
      await service.transcriptSnapshot(ref);
      fake.emit({ type: "message_start", message: state.streamingMessage });
      const snapshot = await service.transcriptSnapshot(ref, { limit: 1 });
      expect(snapshot.page).toEqual({ start: 0, total: 1, messages: [user] });
      expect(snapshot.partial).toEqual({ role: "assistant", content: [{ type: "thinking", thinking: "working" }], thinkingLevel: "high" });
      expect(snapshot.status).toMatchObject({ messageCount: 1, isStreaming: true });
      expect(snapshot.seq).toBe(events.currentSeq(ref.id));
    } finally { await service.dispose(); }
  });

  it("keeps the published partial and seq stable during async update and end extension hooks", async () => {
    const { service, fake, branch, events, state } = fixture();
    const text = { type: "text", text: "first" };
    const tool = { type: "toolCall", id: "call-1", name: "read", arguments: { path: "first" } };
    const assistant = { role: "assistant", content: [text, tool] };
    const updateHook = deferred<undefined>();
    const endHook = deferred<undefined>();
    fake.session.isStreaming = true;
    try {
      const initial = await service.transcriptSnapshot(ref);
      state.streamingMessage = assistant;
      expect(await service.transcriptSnapshot(ref)).toMatchObject({ seq: initial.seq, partial: null });
      fake.emit({ type: "message_start", message: assistant });
      const started = await service.transcriptSnapshot(ref);
      expect(started.seq).toBe(events.currentSeq(ref.id));
      expect(started.seq).toBeGreaterThan(initial.seq);
      expect(started.partial).toEqual(assistant);

      // Agent-core mutates the same message before the SDK awaits extensions.
      text.text += " next";
      tool.arguments.path = "next";
      const updating = updateHook.promise.then(() => {
        fake.emit({
          type: "message_update", message: assistant,
          assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: " next", partial: assistant },
        });
      });
      expect(await service.transcriptSnapshot(ref)).toMatchObject({ seq: started.seq, partial: started.partial });
      expect(started.partial).toMatchObject({ content: [{ text: "first" }, { arguments: { path: "first" } }] });
      updateHook.resolve(undefined);
      await updating;
      const updated = await service.transcriptSnapshot(ref);
      expect(updated.seq).toBe(events.currentSeq(ref.id));
      expect(updated.seq).toBeGreaterThan(started.seq);
      expect(updated.partial).toEqual(assistant);

      // The SDK clears its live partial before message_end is public/persisted.
      state.streamingMessage = undefined;
      text.text = "final";
      const ending = endHook.promise.then(() => {
        fake.emit({ type: "message_end", message: assistant });
        branch.push({ type: "message", message: assistant });
      });
      expect(await service.transcriptSnapshot(ref)).toMatchObject({ seq: updated.seq, partial: updated.partial });
      expect(updated.partial).toMatchObject({ content: [{ text: "first next" }, { arguments: { path: "next" } }] });
      endHook.resolve(undefined);
      await ending;
      const ended = await service.transcriptSnapshot(ref);
      expect(ended.seq).toBe(events.currentSeq(ref.id));
      expect(ended.seq).toBeGreaterThan(updated.seq);
      expect(ended.partial).toBeNull();
      expect(ended.page.messages).toEqual([assistant]);
    } finally {
      updateHook.resolve(undefined);
      endHook.resolve(undefined);
      await service.dispose();
    }
  });

  it("clears the partial at agent end and does not expose queued user messages", async () => {
    const { service, fake, state } = fixture();
    fake.session.isStreaming = true;
    try {
      await service.transcriptSnapshot(ref);
      const assistant = { role: "assistant", content: [{ type: "text", text: "working" }] };
      fake.emit({ type: "message_start", message: assistant });
      expect((await service.transcriptSnapshot(ref)).partial).toEqual(assistant);
      fake.emit({ type: "agent_end", messages: [] });
      expect((await service.transcriptSnapshot(ref)).partial).toBeNull();
      state.streamingMessage = user;
      fake.emit({ type: "message_start", message: user });
      expect((await service.transcriptSnapshot(ref)).partial).toBeNull();
      fake.emit({ type: "message_end", message: user });
      fake.emit({ type: "message_start", message: assistant });
      expect((await service.transcriptSnapshot(ref)).partial).toEqual(assistant);
    } finally { await service.dispose(); }
  });

  it("includes a published prompt echo during SDK awaits, without duplicating its later append", async () => {
    const { service, fake, branch, state } = fixture();
    const prompt = deferred<undefined>();
    fake.session.prompt = () => prompt.promise;
    try {
      await service.prompt(ref, "hello");
      fake.session.isStreaming = true;
      state.streamingMessage = user;
      fake.emit({ type: "message_start", message: user });
      const pending = await service.transcriptSnapshot(ref);
      expect(pending.partial).toBeNull();
      expect(pending.page).toEqual({ start: 0, total: 1, messages: [user] });
      expect(pending.status.messageCount).toBe(1);
      branch.push({ type: "message", message: user });
      fake.emit({ type: "message_end", message: user });
      expect((await service.transcriptSnapshot(ref)).page.messages).toEqual([user]);
      prompt.resolve(undefined);
      expect((await service.transcriptSnapshot(ref)).page.messages).toEqual([user]);
    } finally { prompt.resolve(undefined); await service.dispose(); }
  });
});
