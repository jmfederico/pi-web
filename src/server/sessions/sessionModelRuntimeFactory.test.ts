import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ProviderConfig,
  type ProviderModelConfig,
} from "@earendil-works/pi-coding-agent";
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { ProfileCredentialStore } from "./profileCredentialStore.js";
import { createSessionModelRuntimeFactory } from "./sessionModelRuntimeFactory.js";

const tempRoots: string[] = [];

interface StreamCapture {
  origin: "a" | "b";
  modelId: string;
  baseUrl: string;
  apiKey: string | undefined;
  headers: SimpleStreamOptions["headers"];
}

const modelDefinition: ProviderModelConfig = {
  id: "model",
  name: "Model",
  api: "openai-completions",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 4096,
  maxTokens: 256,
};

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("createSessionModelRuntimeFactory", () => {
  it("creates isolated provider/model/stream overlays over one shared profile credential store", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "pi-web-session-model-runtime-"));
    tempRoots.push(agentDir);
    const credentials = await ProfileCredentialStore.create({ agentDir });
    await credentials.modify("collision", () => Promise.resolve({ type: "api_key", key: "shared-secret" }));
    const createRuntime = createSessionModelRuntimeFactory({ agentDir, credentials });
    const [runtimeA, runtimeB] = await Promise.all([createRuntime(), createRuntime()]);
    expect(runtimeA).not.toBe(runtimeB);

    const captures: StreamCapture[] = [];
    const config = (origin: "a" | "b"): ProviderConfig => ({
      name: `Provider ${origin}`,
      baseUrl: `https://${origin}.example/v1`,
      apiKey: "fallback",
      headers: { "x-origin": origin },
      api: "openai-completions",
      models: [{ ...modelDefinition, id: `model-${origin}`, name: `Model ${origin}` }],
      streamSimple(model, _context, options) {
        captures.push({
          origin,
          modelId: model.id,
          baseUrl: model.baseUrl,
          apiKey: options?.apiKey,
          headers: options?.headers,
        });
        return completedStream(model);
      },
    });

    runtimeA.registerProvider("collision", config("a"));
    const endpointBeforeB = runtimeA.getProvider("collision")?.baseUrl;
    runtimeB.registerProvider("collision", config("b"));
    await Promise.all([runtimeA.reloadConfig(), runtimeB.reloadConfig()]);

    expect(runtimeA.getProvider("collision")?.baseUrl).toBe(endpointBeforeB);
    expect(runtimeA.getModels("collision").map((model) => model.id)).toEqual(["model-a"]);
    expect(runtimeB.getProvider("collision")?.baseUrl).toBe("https://b.example/v1");
    expect(runtimeB.getModels("collision").map((model) => model.id)).toEqual(["model-b"]);

    const modelA = runtimeA.getModel("collision", "model-a");
    const modelB = runtimeB.getModel("collision", "model-b");
    if (modelA === undefined || modelB === undefined) throw new Error("Expected isolated models");
    await Promise.all([
      runtimeA.streamSimple(modelA, { systemPrompt: "", messages: [], tools: [] }).result(),
      runtimeB.streamSimple(modelB, { systemPrompt: "", messages: [], tools: [] }).result(),
    ]);

    const captureA = captures.find((capture) => capture.origin === "a");
    const captureB = captures.find((capture) => capture.origin === "b");
    expect(captureA?.modelId).toBe("model-a");
    expect(captureA?.baseUrl).toBe("https://a.example/v1");
    expect(captureA?.apiKey).toBe("shared-secret");
    expect(captureA?.headers?.["x-origin"]).toBe("a");
    expect(captureB?.modelId).toBe("model-b");
    expect(captureB?.baseUrl).toBe("https://b.example/v1");
    expect(captureB?.apiKey).toBe("shared-secret");
    expect(captureB?.headers?.["x-origin"]).toBe("b");

    await credentials.modify("collision", () => Promise.resolve({ type: "api_key", key: "updated-secret" }));
    const updatedAuth = await Promise.all([runtimeA.getAuth("collision"), runtimeB.getAuth("collision")]);
    expect(updatedAuth[0]?.auth.apiKey).toBe("updated-secret");
    expect(updatedAuth[1]?.auth.apiKey).toBe("updated-secret");
  });
});

function completedStream(model: Model<Api>) {
  const stream = createAssistantMessageEventStream();
  const message: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text: "ok" }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
  queueMicrotask(() => {
    stream.push({ type: "start", partial: message });
    stream.push({ type: "done", reason: "stop", message });
    stream.end();
  });
  return stream;
}
