import type { Api, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { streamSimple as streamAnthropicMessages } from "@earendil-works/pi-ai/api/anthropic-messages";
import { streamSimple as streamOpenAICompletions } from "@earendil-works/pi-ai/api/openai-completions";
import type { ProviderConfig, ProviderModelConfig } from "@earendil-works/pi-coding-agent";

type MiniMaxApi = "anthropic-messages" | "openai-completions";
type MiniMaxModelId = "MiniMax-M3" | "MiniMax-M2.7";

interface MiniMaxModelFacts extends Omit<ProviderModelConfig, "api" | "baseUrl" | "compat"> {
  id: MiniMaxModelId;
}

interface MiniMaxProviderRegistration {
  id: string;
  name: string;
  api: MiniMaxApi;
  baseUrl: string;
  apiKey?: string;
}

interface MiniMaxProviderRegistrar {
  registerProvider(name: string, config: ProviderConfig): void;
}

const MINI_MAX_MODELS: readonly MiniMaxModelFacts[] = [
  {
    id: "MiniMax-M3",
    name: "MiniMax-M3",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 0.6,
      output: 2.4,
      cacheRead: 0.12,
      // Pi represents an unpublished cache-write price as zero.
      cacheWrite: 0,
    },
    contextWindow: 1_000_000,
    maxTokens: 128_000,
  },
  {
    id: "MiniMax-M2.7",
    name: "MiniMax-M2.7",
    reasoning: true,
    thinkingLevelMap: { off: null },
    input: ["text"],
    cost: {
      input: 0.3,
      output: 1.2,
      cacheRead: 0.06,
      cacheWrite: 0.375,
    },
    contextWindow: 204_800,
    maxTokens: 131_072,
  },
];

const MINI_MAX_PROVIDERS: readonly MiniMaxProviderRegistration[] = [
  {
    id: "minimax",
    name: "MiniMax",
    api: "anthropic-messages",
    baseUrl: "https://api.minimax.io/anthropic",
  },
  {
    id: "minimax-cn",
    name: "MiniMax CN",
    api: "anthropic-messages",
    baseUrl: "https://api.minimaxi.com/anthropic",
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
];

const OPENAI_COMPAT: NonNullable<ProviderModelConfig["compat"]> = {
  supportsStore: false,
  supportsDeveloperRole: false,
  supportsReasoningEffort: false,
  supportsStrictMode: false,
  maxTokensField: "max_completion_tokens",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isModelForApi<T extends MiniMaxApi>(model: Model<Api>, api: T): model is Model<T> {
  return model.api === api;
}

export function adaptMiniMaxPayload(
  api: MiniMaxApi,
  modelId: string,
  reasoning: SimpleStreamOptions["reasoning"],
  payload: unknown,
): unknown {
  if (!isRecord(payload)) return payload;

  const adapted = { ...payload };
  delete adapted["reasoning_effort"];
  delete adapted["output_config"];

  if (api === "openai-completions") adapted["reasoning_split"] = true;

  if (modelId === "MiniMax-M3") {
    adapted["thinking"] = { type: reasoning === undefined ? "disabled" : "adaptive" };
  } else if (modelId === "MiniMax-M2.7") {
    // M2.7 always thinks, so leave control to the endpoint default.
    delete adapted["thinking"];
  }

  return adapted;
}

function withMiniMaxPayloadAdapter(
  api: MiniMaxApi,
  model: Model<Api>,
  options: SimpleStreamOptions | undefined,
): SimpleStreamOptions {
  const callerOnPayload = options?.onPayload;
  return {
    ...options,
    async onPayload(payload, payloadModel) {
      const adapted = adaptMiniMaxPayload(api, model.id, options?.reasoning, payload);
      if (callerOnPayload === undefined) return adapted;
      return await callerOnPayload(adapted, payloadModel) ?? adapted;
    },
  };
}

function streamMiniMaxAnthropic(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
) {
  if (!isModelForApi(model, "anthropic-messages")) {
    throw new Error(`MiniMax Anthropic stream received ${model.api} model`);
  }
  return streamAnthropicMessages(
    model,
    context,
    withMiniMaxPayloadAdapter("anthropic-messages", model, options),
  );
}

function streamMiniMaxOpenAI(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
) {
  if (!isModelForApi(model, "openai-completions")) {
    throw new Error(`MiniMax OpenAI stream received ${model.api} model`);
  }
  return streamOpenAICompletions(
    model,
    context,
    withMiniMaxPayloadAdapter("openai-completions", model, options),
  );
}

function modelsFor(api: MiniMaxApi, baseUrl: string): ProviderModelConfig[] {
  return MINI_MAX_MODELS.map((model) => ({
    ...model,
    input: [...model.input],
    cost: { ...model.cost },
    ...(model.thinkingLevelMap === undefined
      ? {}
      : { thinkingLevelMap: { ...model.thinkingLevelMap } }),
    api,
    baseUrl,
    ...(api === "openai-completions" ? { compat: { ...OPENAI_COMPAT } } : {}),
  }));
}

export function registerMiniMaxProviders(pi: MiniMaxProviderRegistrar): void {
  for (const provider of MINI_MAX_PROVIDERS) {
    pi.registerProvider(provider.id, {
      name: provider.name,
      baseUrl: provider.baseUrl,
      api: provider.api,
      ...(provider.apiKey === undefined ? {} : { apiKey: provider.apiKey }),
      models: modelsFor(provider.api, provider.baseUrl),
      streamSimple: provider.api === "anthropic-messages"
        ? streamMiniMaxAnthropic
        : streamMiniMaxOpenAI,
    });
  }
}
