import { describe, expect, it } from "vitest";
import type { ProviderConfig, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { adaptMiniMaxPayload, registerMiniMaxProviders } from "../extensions/lib/minimax.js";

interface Registration {
  id: string;
  config: ProviderConfig;
}

function registeredProviders(): Registration[] {
  const registrations: Registration[] = [];
  registerMiniMaxProviders({
    registerProvider(id, config) {
      registrations.push({ id, config });
    },
  });
  return registrations;
}

function models(config: ProviderConfig): ProviderModelConfig[] {
  expect(config.models).toBeDefined();
  return config.models ?? [];
}

describe("registerMiniMaxProviders", () => {
  it("registers global and China endpoints for both supported API protocols", () => {
    const registrations = registeredProviders();

    expect(registrations.map(({ id, config }) => ({
      id,
      name: config.name,
      api: config.api,
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
    }))).toEqual([
      {
        id: "minimax",
        name: "MiniMax",
        api: "anthropic-messages",
        baseUrl: "https://api.minimax.io/anthropic",
        apiKey: undefined,
      },
      {
        id: "minimax-cn",
        name: "MiniMax CN",
        api: "anthropic-messages",
        baseUrl: "https://api.minimaxi.com/anthropic",
        apiKey: undefined,
      },
      {
        id: "minimax-openai",
        name: "MiniMax OpenAI",
        api: "openai-completions",
        baseUrl: "https://api.minimax.io/v1",
        apiKey: "$MINIMAX_API_KEY",
      },
      {
        id: "minimax-openai-cn",
        name: "MiniMax OpenAI CN",
        api: "openai-completions",
        baseUrl: "https://api.minimaxi.com/v1",
        apiKey: "$MINIMAX_CN_API_KEY",
      },
    ]);
  });

  it("registers the current MiniMax-M3 and MiniMax-M2.7 model facts", () => {
    for (const { config } of registeredProviders()) {
      expect(models(config)).toEqual([
        expect.objectContaining({
          id: "MiniMax-M3",
          name: "MiniMax-M3",
          api: config.api,
          baseUrl: config.baseUrl,
          reasoning: true,
          input: ["text", "image"],
          cost: { input: 0.6, output: 2.4, cacheRead: 0.12, cacheWrite: 0 },
          contextWindow: 1_000_000,
          maxTokens: 128_000,
        }),
        expect.objectContaining({
          id: "MiniMax-M2.7",
          name: "MiniMax-M2.7",
          api: config.api,
          baseUrl: config.baseUrl,
          reasoning: true,
          thinkingLevelMap: { off: null },
          input: ["text"],
          cost: { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0.375 },
          contextWindow: 204_800,
          maxTokens: 131_072,
        }),
      ]);
    }
  });
});

describe("adaptMiniMaxPayload", () => {
  it("maps MiniMax-M3 thinking controls for both protocols", () => {
    expect(adaptMiniMaxPayload(
      "openai-completions",
      "MiniMax-M3",
      "high",
      { reasoning_effort: "high", output_config: { effort: "high" } },
    )).toEqual({ reasoning_split: true, thinking: { type: "adaptive" } });

    expect(adaptMiniMaxPayload(
      "anthropic-messages",
      "MiniMax-M3",
      undefined,
      { thinking: { type: "enabled", budget_tokens: 1024 } },
    )).toEqual({ thinking: { type: "disabled" } });
  });

  it("leaves MiniMax-M2.7 thinking always on at the endpoint", () => {
    expect(adaptMiniMaxPayload(
      "openai-completions",
      "MiniMax-M2.7",
      undefined,
      { reasoning_effort: "high", thinking: { type: "disabled" } },
    )).toEqual({ reasoning_split: true });
  });
});
