import { describe, expect, it } from "vitest";
import { PiSessionService } from "./piSessionService.js";
import { CapturingSessionEventHub, fakeRuntime, fakeSessionManager, runtimeCreator, sessionGateway, sessionRecord, sessionRef, testModelRuntime } from "./piSessionService.testSupport.js";

const TEST_AGENT_DIR = "/tmp/pi-web-test-agent";

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

  it("reports generated output-token throughput after an agent response", async () => {
    let outputTokens = 0;
    let now = new Date("2026-01-01T00:00:00.000Z");
    const fake = fakeRuntime("session-1", {
      getSessionStats: () => ({ sessionId: "session-1", totalMessages: 0, userMessages: 0, assistantMessages: 0, toolCalls: 0, tokens: { input: 0, output: outputTokens, cacheRead: 0, cacheWrite: 0, total: outputTokens }, cost: 0 }),
    });
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: TEST_AGENT_DIR,
      modelRuntime: testModelRuntime,
      createAgentRuntime: runtimeCreator(fake.runtime),
      sessionManager: sessionGateway([sessionRecord("session-1")]),
      heartbeatIntervalMs: 60_000,
      now: () => now,
    });
    try {
      await service.status(sessionRef("session-1"));
      fake.emit({ type: "agent_start" });
      outputTokens = 20;
      now = new Date("2026-01-01T00:00:10.000Z");
      fake.emit({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "Plan" } });
      outputTokens = 120;
      now = new Date("2026-01-01T00:00:12.000Z");
      fake.emit({ type: "agent_end" });

      await expect(service.status(sessionRef("session-1"))).resolves.toMatchObject({ outputTokensPerSecond: 60 });
      now = new Date("2026-01-01T00:01:12.000Z");
      await expect(service.status(sessionRef("session-1"))).resolves.toMatchObject({ outputTokensPerSecond: 60 });
    } finally {
      await service.dispose();
    }
  });
});
