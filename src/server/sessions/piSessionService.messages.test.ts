import { describe, expect, it } from "vitest";
import { PiSessionService } from "./piSessionService.js";
import { CapturingSessionEventHub, fakeRuntime, fakeSessionManager, runtimeCreator, sessionGateway, sessionRecord, sessionRef, testModelRuntime } from "./piSessionService.testSupport.js";

const TEST_AGENT_DIR = "/tmp/pi-web-test-agent";
const streamIdMatcher: unknown = expect.any(String);

describe("PiSessionService", () => {
  describe("assistant thinking-level attribution", () => {
    function messagesService(branch: unknown[], patch: Parameters<typeof fakeRuntime>[1] = {}) {
      const fake = fakeRuntime("session-1", {
        sessionFile: "/tmp/session-1.jsonl",
        sessionManager: fakeSessionManager("/workspace", { getBranch: () => branch }),
        ...patch,
      });
      const events = new CapturingSessionEventHub();
      const service = new PiSessionService(events, {
        agentDir: TEST_AGENT_DIR,
        modelRuntime: testModelRuntime,
        createAgentRuntime: runtimeCreator(fake.runtime),
        sessionManager: sessionGateway([sessionRecord("session-1")]),
        heartbeatIntervalMs: 60_000,
      });
      return { fake, service, events };
    }

    it("projects history and completed events, but leaves streaming deltas and reconnect partials original", async () => {
      const message = { role: "assistant", content: [{ type: "text", text: "<think></think>answer" }] };
      const branch = [{ type: "message", message }];
      const { fake, service, events } = messagesService(branch, { state: { streamingMessage: message } });
      fake.session.extensionRunner.getMarkdownTransformers = () => [(text) => text.replace("<think></think>", "")];
      const projected = { role: "assistant", content: [{ type: "text", text: "<think></think>answer", displayText: "answer" }] };
      try {
        expect((await service.messages(sessionRef("session-1"))).messages).toEqual([projected]);
        fake.emit({ type: "message_end", message });
        fake.emit({ type: "entry_appended", entry: { type: "message", message } });
        fake.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "<think>" } });
        expect(events.sessionEvents.map(({ event }) => event)).toEqual(expect.arrayContaining([
          { type: "message.end", message: projected },
          { type: "message.append", message: projected },
          { type: "assistant.delta", text: "<think>" },
        ]));
        expect((await service.streamSnapshot(sessionRef("session-1"))).partial).toEqual(message);
        expect(message.content[0]).toEqual({ type: "text", text: "<think></think>answer" });
        // Resolve the current runner chain each time, including after extension reload.
        fake.session.extensionRunner.getMarkdownTransformers = () => [];
        expect((await service.messages(sessionRef("session-1"))).messages).toEqual([message]);
      } finally {
        await service.dispose();
      }
    });

    it("keeps one browser identity across start, deltas, both snapshots and end without mutating runtime messages", async () => {
      const message = {
        role: "assistant", provider: "openai", model: "model-1", timestamp: 123,
        content: [{ type: "thinking", thinking: "working", thinkingSignature: "secret" }],
      };
      const original = structuredClone(message);
      const { fake, service, events } = messagesService([], { thinkingLevel: "high", state: { streamingMessage: message } });
      const ref = sessionRef("session-1");
      try {
        await service.status(ref);
        fake.emit({ type: "message_start", message });
        const start = events.sessionEvents.map(({ event }) => event).find((event) => event.type === "assistant.start");
        const partial = (await service.streamSnapshot(ref)).partial;
        expect(partial).toMatchObject({ streamId: streamIdMatcher });
        expect(start).toEqual({ type: "assistant.start", message: partial });
        expect(partial).toEqual({
          ...message, content: [{ type: "thinking", thinking: "working" }], thinkingLevel: "high", streamId: streamIdMatcher,
        });
        expect((await service.transcriptSnapshot(ref)).partial).toEqual(partial);
        if (typeof partial !== "object" || partial === null || !("streamId" in partial)) throw new Error("Missing stream identity");
        const streamId: unknown = partial.streamId;
        // Other message lifecycles cannot finalize the assistant stream.
        const toolResult = { role: "toolResult", toolName: "bash", toolCallId: "call-1", content: [] };
        fake.emit({ type: "tool_execution_start", toolName: "bash", toolCallId: "call-1", args: {} });
        fake.emit({ type: "message_start", message: toolResult });
        fake.emit({ type: "message_end", message: toolResult });
        expect((await service.transcriptSnapshot(ref)).partial).toEqual(partial);
        for (const type of ["thinking_delta", "text_delta"]) {
          fake.emit({ type: "message_update", message, assistantMessageEvent: { type, delta: "more" } });
        }
        expect(events.sessionEvents.map(({ event }) => event)).toEqual(expect.arrayContaining([
          { type: "assistant.thinking.delta", text: "more", streamId },
          { type: "assistant.delta", text: "more", streamId },
        ]));
        expect((await service.streamSnapshot(ref)).partial).toEqual(partial);
        expect((await service.transcriptSnapshot(ref)).partial).toEqual(partial);
        fake.emit({ type: "message_end", message });
        // The capturing hub observes events before the real hub's browser projection.
        expect(events.sessionEvents.map(({ event }) => event)).toContainEqual({
          type: "message.end", message: { ...message, thinkingLevel: "high", streamId },
        });
        expect((await service.transcriptSnapshot(ref)).partial).toBeNull();
        // A fake may retain SDK state after end: it must not retain the ended identity.
        expect((await service.streamSnapshot(ref)).partial).not.toHaveProperty("streamId");
        fake.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "no start" } });
        expect(events.sessionEvents.map(({ event }) => event)).toContainEqual({ type: "assistant.delta", text: "no start" });
        fake.emit({ type: "message_start", message });
        expect((await service.streamSnapshot(ref)).partial).not.toEqual(partial);
        fake.emit({ type: "agent_end", messages: [] });
        expect((await service.streamSnapshot(ref)).partial).not.toHaveProperty("streamId");
        fake.emit({ type: "message_start", message });
        await service.stop(ref);
        expect((await service.streamSnapshot(ref)).partial).not.toHaveProperty("streamId");
        expect((await service.transcriptSnapshot(ref)).partial).toBeNull();
        expect(message).toEqual(original);
      } finally { await service.dispose(); }
    });

    it("annotates paged assistant messages with the thinking level in effect from branch entries", async () => {
      const branch = [
        { type: "message", message: { role: "user", content: [{ type: "text", text: "hi" }] } },
        { type: "message", message: { role: "assistant", provider: "openai", model: "gpt-4.1", content: [{ type: "text", text: "before any entry" }] } },
        { type: "thinking_level_change", thinkingLevel: "medium" },
        { type: "message", message: { role: "assistant", provider: "openai", model: "gpt-4.1", content: [{ type: "text", text: "first answer" }] } },
        { type: "thinking_level_change", thinkingLevel: "max" },
        { type: "message", message: { role: "assistant", provider: "openai", model: "gpt-4.1", content: [{ type: "text", text: "second answer" }] } },
        { type: "thinking_level_change", thinkingLevel: "off" },
        { type: "message", message: { role: "assistant", provider: "openai", model: "gpt-4.1", content: [{ type: "text", text: "unthinking answer" }] } },
        { type: "message", message: { role: "toolResult", toolName: "bash", content: [{ type: "text", text: "done" }] } },
      ];
      const { service } = messagesService(branch);

      const page = await service.messages(sessionRef("session-1"));

      expect(page).toEqual({
        start: 0,
        total: 6,
        messages: [
        { role: "user", content: [{ type: "text", text: "hi" }] },
        { role: "assistant", provider: "openai", model: "gpt-4.1", content: [{ type: "text", text: "before any entry" }] },
        { role: "assistant", provider: "openai", model: "gpt-4.1", content: [{ type: "text", text: "first answer" }], thinkingLevel: "medium" },
        { role: "assistant", provider: "openai", model: "gpt-4.1", content: [{ type: "text", text: "second answer" }], thinkingLevel: "max" },
        { role: "assistant", provider: "openai", model: "gpt-4.1", content: [{ type: "text", text: "unthinking answer" }] },
        { role: "toolResult", toolName: "bash", content: [{ type: "text", text: "done" }] },
        ],
      });
      await service.dispose();
    });

    it("annotates live assistant message.end events with the session's current thinking level", async () => {
      const { fake, service, events } = messagesService([], { thinkingLevel: "high" });
      await service.status(sessionRef("session-1")); // bring the session online so it publishes events

      fake.emit({ type: "message_end", message: { role: "assistant", provider: "openai", model: "gpt-4.1", content: [{ type: "text", text: "answer" }] } });
      fake.emit({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "next" }] } });

      const messageEnds = events.sessionEvents.map(({ event }) => event).filter((event) => event.type === "message.end");
      expect(messageEnds).toEqual([
        { type: "message.end", message: { role: "assistant", provider: "openai", model: "gpt-4.1", content: [{ type: "text", text: "answer" }], thinkingLevel: "high" } },
        { type: "message.end", message: { role: "user", content: [{ type: "text", text: "next" }] } },
      ]);
      await service.dispose();
    });

    it("annotates the join-time stream snapshot partial with the current thinking level", async () => {
      const streamingMessage = {
        role: "assistant",
        provider: "openai",
        model: "gpt-4.1",
        content: [{ type: "thinking", thinking: "hmm", thinkingSignature: "provider-signature" }],
      };
      const { service } = messagesService([], { thinkingLevel: "xhigh", state: { streamingMessage } });

      const snapshot = await service.streamSnapshot(sessionRef("session-1"));

      expect(snapshot.partial).toEqual({
        role: "assistant",
        provider: "openai",
        model: "gpt-4.1",
        content: [{ type: "thinking", thinking: "hmm" }],
        thinkingLevel: "xhigh",
      });
      await service.dispose();
    });
  });
});
