import { createAssistantMessageEventStream, type Api, type Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { generateShortSessionName } from "./generator.js";
import { resolveSessionNamingConfig } from "./config.js";

const model: Model<Api> = {
  id: "fake", name: "Fake", api: "anthropic-messages", provider: "anthropic", baseUrl: "https://example.test",
  reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100,
};

describe("session title generation", () => {
  it.each(["off", "minimal", "low", "medium", "high", "xhigh", "max"])("passes independent tuning for thinking level %s and caps input", async (level) => {
    const streamSimple = vi.fn<ExtensionContext["modelRegistry"]["streamSimple"]>(() => {
      const stream = createAssistantMessageEventStream();
      stream.end();
      return stream;
    });
    const result = await generateShortSessionName({ streamSimple }, model, "x".repeat(5_000),
      resolveSessionNamingConfig({ maxTokens: 2048, thinkingLevel: level }), new AbortController().signal);
    expect(result).toBeUndefined();
    const call = streamSimple.mock.calls[0];
    expect(call?.[1].messages).toMatchObject([{ role: "user", content: `Create a 2-6 word title for this request:\n\n${"x".repeat(4_000)}…` }]);
    expect(call?.[2]?.maxTokens).toBe(2048);
    expect(call?.[2]?.reasoning).toBe(level === "off" ? undefined : level);
  });
});
