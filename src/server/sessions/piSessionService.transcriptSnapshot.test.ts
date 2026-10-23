import { describe, expect, it, vi } from "vitest";
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
const streamIdMatcher: unknown = expect.any(String);
const ref = sessionRef("session-1");
const user = { role: "user", content: "hello" };

describe("PiSessionService.transcriptSnapshot", () => {
  it("transforms snapshot history and pending echoes without transforming the published partial", async () => {
    const { service, fake, branch, events } = fixture();
    const assistant = { role: "assistant", content: [{ type: "text", text: "answer" }] };
    const partial = { role: "assistant", content: [{ type: "thinking", thinking: "working" }] };
    const prompt = deferred<undefined>();
    fake.session.prompt = () => prompt.promise;
    fake.session.extensionRunner.getMarkdownTransformers = () => [(text) => `[${text}]`];
    branch.push({ type: "message", message: assistant });
    try {
      await service.prompt(ref, "hello");
      fake.session.isStreaming = true;
      fake.emit({ type: "message_start", message: partial });
      const snapshot = await service.transcriptSnapshot(ref);
      expect(snapshot.page).toEqual({ start: 0, total: 2, messages: [
        { role: "assistant", content: [{ type: "text", text: "answer", displayText: "[answer]" }] },
        { role: "user", content: "hello", displayText: "[hello]" },
      ] });
      expect(snapshot.partial).toEqual({ ...partial, streamId: streamIdMatcher });
      expect(snapshot.seq).toBe(events.currentSeq(ref.id));
      expect(assistant.content[0]).toEqual({ type: "text", text: "answer" });
      // Pending echoes remain original internally, so repeated reads do not re-transform display text.
      expect((await service.transcriptSnapshot(ref)).page).toEqual(snapshot.page);
    } finally { prompt.resolve(undefined); await service.dispose(); }
  });

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
      expect(snapshot.partial).toEqual({ role: "assistant", content: [{ type: "thinking", thinking: "working" }], thinkingLevel: "high", streamId: streamIdMatcher });
      expect(snapshot.status).toMatchObject({ messageCount: 1, isStreaming: true });
      expect(snapshot.seq).toBe(events.currentSeq(ref.id));
    } finally { await service.dispose(); }
  });

  it("keeps active status and status events aligned with transcript history after compaction", async () => {
    const { service, fake, branch, events } = fixture();
    const oldAssistant = { role: "assistant", content: "earlier answer" };
    branch.push(
      { type: "message", message: user },
      { type: "message", message: oldAssistant },
      { type: "compaction", summary: "Earlier conversation" },
      { type: "message", message: user },
    );
    // The model context is shorter than the persisted transcript after compaction.
    fake.session.messages = [user];
    fake.session.isStreaming = true;
    const publish = vi.spyOn(events, "publishGlobal");
    try {
      expect((await service.transcriptSnapshot(ref)).status.messageCount).toBe(3);
      expect((await service.status(ref)).messageCount).toBe(3);
      fake.emit({ type: "message_update", message: oldAssistant });
      const statusEvents = publish.mock.calls.map(([event]) => event).filter((event) => event.type === "status.update");
      expect(statusEvents.at(-1)?.status.messageCount).toBe(3);
    } finally { publish.mockRestore(); await service.dispose(); }
  });

  it("increments completed messages without scanning and reconciles drift only at settlement", async () => {
    const { service, fake, branch } = fixture();
    branch.push({ type: "message", message: user });
    fake.session.isStreaming = true;
    const assistant = { role: "assistant", content: "answer" };
    try {
      expect((await service.status(ref)).messageCount).toBe(1);
      const getBranch = vi.spyOn(fake.session.sessionManager, "getBranch");
      try {
        for (let i = 0; i < 5; i += 1) {
          fake.emit({ type: "message_update", message: assistant });
          expect((await service.status(ref)).messageCount).toBe(1);
        }
        // Pi emits message_end before appending the completed message.
        fake.emit({ type: "message_end", message: assistant });
        expect((await service.status(ref)).messageCount).toBe(2);
        branch.push({ type: "message", message: assistant });
        fake.emit({ type: "entry_appended", entry: { type: "message", message: user } });
        expect((await service.status(ref)).messageCount).toBe(3);
        branch.push({ type: "message", message: user });
        fake.emit({ type: "message_end", message: { role: "custom", content: "notice" } });
        fake.emit({ type: "entry_appended", entry: { type: "compaction", summary: "earlier history" } });
        fake.emit({ type: "compaction_end" });
        expect((await service.status(ref)).messageCount).toBe(3);
        expect(getBranch).not.toHaveBeenCalled();
        // An unobserved append is corrected at the run's persistence boundary.
        branch.push({ type: "message", message: user });
        fake.emit({ type: "agent_settled" });
        expect((await service.status(ref)).messageCount).toBe(4);
        expect(getBranch).toHaveBeenCalled();
      } finally { getBranch.mockRestore(); }
    } finally { await service.dispose(); }
  });

  it("reuses the idle disk snapshot count until external history changes, without overwriting runtime state", async () => {
    let entryReads = 0;
    const entry = { get type() { entryReads += 1; return "message"; }, message: user };
    let diskBranch: unknown[] = [entry];
    const { service, fake } = fixture(() => Promise.resolve(diskBranch));
    try {
      expect((await service.status(ref)).messageCount).toBe(1);
      const readsAfterFirstStatus = entryReads;
      expect((await service.status(ref)).messageCount).toBe(1);
      expect(entryReads).toBe(readsAfterFirstStatus);
      // The gateway supplies a new immutable snapshot when the file changes.
      diskBranch = [entry, { type: "message", message: user }];
      expect((await service.status(ref)).messageCount).toBe(2);
      expect(entryReads).toBeGreaterThan(readsAfterFirstStatus);
      fake.session.isStreaming = true;
      // External disk history must not replace the runtime's own branch count.
      expect((await service.status(ref)).messageCount).toBe(0);
    } finally { await service.dispose(); }
  });

  it("recounts when the runtime selects a different branch", async () => {
    const { service, fake, branch } = fixture();
    branch.push({ type: "message", message: user }, { type: "message", message: user });
    fake.session.isStreaming = true;
    try {
      expect((await service.status(ref)).messageCount).toBe(2);
      branch.pop();
      fake.emit({ type: "session_tree" });
      expect((await service.status(ref)).messageCount).toBe(1);
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
      expect(started.partial).toEqual({ ...assistant, streamId: streamIdMatcher });

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
      expect(updated.partial).toEqual({ ...assistant, streamId: streamIdMatcher });

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
      expect((await service.transcriptSnapshot(ref)).partial).toEqual({ ...assistant, streamId: streamIdMatcher });
      fake.emit({ type: "agent_end", messages: [] });
      expect((await service.transcriptSnapshot(ref)).partial).toBeNull();
      state.streamingMessage = user;
      fake.emit({ type: "message_start", message: user });
      expect((await service.transcriptSnapshot(ref)).partial).toBeNull();
      fake.emit({ type: "message_end", message: user });
      fake.emit({ type: "message_start", message: assistant });
      expect((await service.transcriptSnapshot(ref)).partial).toEqual({ ...assistant, streamId: streamIdMatcher });
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
