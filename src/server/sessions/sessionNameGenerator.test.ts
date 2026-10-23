import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream, getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { describe, expect, it, vi } from "vitest";
import { cleanSessionName, fallbackSessionName, generateShortSessionName, requireInitialSessionName } from "./sessionNameGenerator.js";
import { KNOWN_THINKING_LEVELS } from "../../shared/thinkingLevels.js";

function fakeModel(): Model<Api> {
  return { id: "fake-model", name: "Fake Model", api: "anthropic-messages", provider: "anthropic", baseUrl: "https://example.test", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100 };
}

function fakeAssistantMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "fake-model",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: Date.now(),
    ...overrides,
  };
}

function streamThatCompletes(text: string): StreamFn {
  return () => {
    const stream = createAssistantMessageEventStream();
    const message = fakeAssistantMessage({ content: [{ type: "text", text }] });
    stream.push({ type: "done", reason: "stop", message });
    stream.end(message);
    return stream;
  };
}

function streamThatErrors(): StreamFn {
  return () => {
    const stream = createAssistantMessageEventStream();
    const message = fakeAssistantMessage({ stopReason: "error", errorMessage: "boom" });
    stream.push({ type: "error", reason: "error", error: message });
    stream.end(message);
    return stream;
  };
}

describe("sessionNameGenerator", () => {
  it("generates a session name by calling the injected streamFn", async () => {
    const calls: unknown[] = [];
    const stream = streamThatCompletes('Title: "Fix the bug"');
    const streamFn: StreamFn = (model, context, options) => {
      expect(getCurrentSystemPrompt(context.messages)).toBe("Generate a concise title for a coding-agent chat session. Return only the title, with no quotes or punctuation wrapper.");
      expect(context.messages.at(-1)).toMatchObject({
        role: "user",
        content: "Create a 2-6 word title for this request:\n\nPlease fix the login bug",
      });
      calls.push({ model, context, options });
      return stream(model, context, options);
    };

    const name = await generateShortSessionName(streamFn, fakeModel(), "Please fix the login bug");

    expect(name).toBe("Fix the bug");
    expect(calls).toHaveLength(1);
  });

  it.each([false, true])("keeps the default budget at 24 tokens (reasoning: %s)", async (reasoning) => {
    const streamFn: StreamFn = (model, context, options) => {
      expect(options?.maxTokens).toBe(24);
      expect(options?.reasoning).toBe("minimal");
      return streamThatCompletes("A short title")(model, context, options);
    };
    await generateShortSessionName(streamFn, { ...fakeModel(), reasoning }, "A request");
  });

  it("passes an explicit token budget to the model", async () => {
    const streamFn: StreamFn = (model, context, options) => {
      expect(options?.maxTokens).toBe(2048);
      return streamThatCompletes("A short title")(model, context, options);
    };
    await generateShortSessionName(streamFn, fakeModel(), "A request", { maxTokens: 2048 });
  });

  it.each(KNOWN_THINKING_LEVELS)("passes naming thinking level %s independently of the token budget", async (level) => {
    const streamFn: StreamFn = (model, context, options) => {
      expect(options?.reasoning).toBe(level === "off" ? undefined : level);
      expect(options?.maxTokens).toBe(24);
      return streamThatCompletes("A short title")(model, context, options);
    };
    expect(await generateShortSessionName(streamFn, fakeModel(), "A request", { thinkingLevel: level })).toBe("A short title");
  });

  it.each([undefined, 90_000])("uses the total request timeout %s, defaulting to 10 seconds", async (timeoutMs) => {
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    const streamFn: StreamFn = (model, context, options) => {
      expect(options?.signal).toBe(controller.signal);
      return streamThatCompletes("A short title")(model, context, options);
    };
    try {
      await generateShortSessionName(streamFn, fakeModel(), "A request", timeoutMs === undefined ? {} : { timeoutMs });
      expect(timeout).toHaveBeenCalledWith(timeoutMs ?? 10_000);
    } finally {
      timeout.mockRestore();
    }
  });

  it("returns undefined when the stream reports an error", async () => {
    const streamFn = streamThatErrors();

    const name = await generateShortSessionName(streamFn, fakeModel(), "Please fix the login bug");

    expect(name).toBeUndefined();
  });

  it("cleans model-generated titles", () => {
    expect(cleanSessionName('Title: "Fix Session Naming."\nextra')).toBe("Fix Session Naming");
  });

  it("preserves explicit extension names", () => {
    expect(requireInitialSessionName("A workflow leg 2")).toBe("A workflow leg 2");
  });

  it.each([undefined, null, "", " ", " padded", "padded ", "two\nlines", "control\0character", "a".repeat(61)])("rejects invalid initial names (%j)", (value) => {
    expect(() => requireInitialSessionName(value)).toThrow("Initial session name");
  });

  it("builds a concise fallback from the first request", () => {
    expect(fallbackSessionName("Seems like auto name for sessions is not working, I still get the first message as a name."))
      .toBe("Seems like auto name for sessions");
  });

  it("ignores skill blocks in fallback names", () => {
    expect(fallbackSessionName('<skill name="x" location="/x">\nDo x\n</skill>\n\nCheck the UI now'))
      .toBe("Check the UI now");
  });

  it("skips fallback names when the first request is missing", () => {
    expect(fallbackSessionName(undefined)).toBeUndefined();
  });
});
