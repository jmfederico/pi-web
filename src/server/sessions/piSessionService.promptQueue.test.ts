import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, InMemoryCredentialStore, type AssistantMessage } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { ModelRuntime } from "../../piSdk.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PiWebConfigResponse, PiWebConfigValues } from "../../shared/apiTypes.js";
import { PiSessionService } from "./piSessionService.js";
import { createFilePiWebConfigService } from "../configRoutes.js";
import { CapturingSessionEventHub, createTestModelRuntime, fakeRuntime, fakeSessionManager, runtimeCreator, seedCredential, sessionGateway, sessionRecord, sessionRef, TEST_MODEL_ID, TEST_MODEL_PROVIDER, testModel, testModelRuntime, type RuntimeCreator } from "./piSessionService.testSupport.js";

const TEST_AGENT_DIR = "/tmp/pi-web-test-agent";

function namingConfigResponse(sessionNaming?: PiWebConfigValues["sessionNaming"]): PiWebConfigResponse {
  const config = sessionNaming === undefined ? {} : { sessionNaming };
  return {
    path: "/tmp/pi-web/config.json", exists: true, config, effectiveConfig: config,
    envOverrides: { host: false, port: false, allowedHosts: false, spawnSessions: false, subsessions: false, askUser: false },
  };
}

beforeEach(() => {
  // Pi 0.82 uses PI_OFFLINE for refreshes after runtime creation. These tests
  // exercise local model/auth behavior and must never fetch provider catalogs.
  vi.stubEnv("PI_OFFLINE", "1");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("PiSessionService prompt, queue, and auth warnings", () => {
  it("sends prompts to an injected runtime without touching the SDK runtime", async () => {
    const fake = fakeRuntime("prompt-session");
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: TEST_AGENT_DIR,
      modelRuntime: testModelRuntime,
      createAgentRuntime: runtimeCreator(fake.runtime),
      sessionManager: sessionGateway([sessionRecord("prompt-session")]),
      heartbeatIntervalMs: 60_000,
    });

    await service.prompt(sessionRef("prompt-session"), "Build the thing");

    expect(fake.calls.prompt).toEqual([{ text: "Build the thing", options: undefined }]);
    await service.dispose();
  });

  it("echoes the user message for direct prompts but not command-forwarded ones", async () => {
    const fake = fakeRuntime("echo-session", {
      resourceLoader: { getSkills: () => ({ skills: [{ name: "skill-creator" }] }) },
    });
    const hub = new CapturingSessionEventHub();
    const service = new PiSessionService(hub, {
      agentDir: TEST_AGENT_DIR,
      modelRuntime: testModelRuntime,
      createAgentRuntime: runtimeCreator(fake.runtime),
      sessionManager: sessionGateway([sessionRecord("echo-session")]),
      heartbeatIntervalMs: 60_000,
    });

    await service.prompt(sessionRef("echo-session"), "Build the thing");
    expect(hub.sessionEvents.filter(({ event }) => event.type === "message.append")).toHaveLength(1);

    // The client optimistically renders command-forwarded prompts (e.g. /skill:*),
    // so the server must not publish a second copy via message.append.
    await service.runCommand(sessionRef("echo-session"), "/skill:skill-creator");
    expect(hub.sessionEvents.filter(({ event }) => event.type === "message.append")).toHaveLength(1);
    expect(fake.calls.prompt).toEqual([
      { text: "Build the thing", options: undefined },
      { text: "/skill:skill-creator", options: undefined },
    ]);

    await service.dispose();
  });

  it("rejects malformed prompt text before opening the runtime", async () => {
    const fake = fakeRuntime("prompt-session");
    let createCalls = 0;
    const createAgentRuntime: RuntimeCreator = async () => {
      createCalls += 1;
      await Promise.resolve();
      return fake.runtime;
    };
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: TEST_AGENT_DIR,
      modelRuntime: testModelRuntime,
      createAgentRuntime,
      sessionManager: sessionGateway([sessionRecord("prompt-session")]),
      heartbeatIntervalMs: 60_000,
    });

    await expect(service.prompt(sessionRef("prompt-session"), undefined)).rejects.toThrow("Prompt text is required");

    expect(createCalls).toBe(0);
    expect(fake.calls.prompt).toEqual([]);
    await service.dispose();
  });

  it.each([false, true])("generates a name without changing the session model (configured: %s)", async (configured) => {
    const model = testModel();
    const namingModel = testModelRuntime.getModels().find((candidate) => candidate.id !== model.id);
    if (namingModel === undefined) throw new Error("A second catalog model is required");
    const streamCalls: unknown[] = [];
    const streamFn: StreamFn = (streamModel, context, options) => {
      streamCalls.push({ streamModel, context, options });
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: "Fix login bug" }],
        api: "anthropic-messages",
        provider: "anthropic",
        model: model.id,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop",
        timestamp: Date.now(),
      };
      stream.push({ type: "done", reason: "stop", message });
      stream.end(message);
      return stream;
    };
    const hub = new CapturingSessionEventHub();
    const fake = fakeRuntime("name-session", { model, agent: { streamFunction: streamFn } });
    const service = new PiSessionService(hub, {
      agentDir: TEST_AGENT_DIR,
      modelRuntime: testModelRuntime,
      createAgentRuntime: runtimeCreator(fake.runtime),
      sessionManager: sessionGateway([sessionRecord("name-session")]),
      ...(configured ? { config: { read: () => namingConfigResponse({ model: `${namingModel.provider}/${namingModel.id}`, maxTokens: 2048 }) } } : {}),
      heartbeatIntervalMs: 60_000,
    });

    await service.prompt(sessionRef("name-session"), "Please fix the login bug");
    await vi.waitFor(() => { expect(fake.session.sessionName).toBe("Fix login bug"); });

    expect(streamCalls).toHaveLength(1);
    expect(streamCalls[0]).toMatchObject({ streamModel: configured ? namingModel : model, options: { maxTokens: configured ? 2048 : 24 } });
    expect(fake.session.model).toBe(model);
    expect(hub.sessionEvents.some(({ event }) => event.type === "session.name" && event.name === "Fix login bug")).toBe(true);
    await service.dispose();
  });

  it("reads the config file fresh for each new title without changing in-progress calls or existing titles", async () => {
    const sessionModel = testModel();
    const alternate = testModelRuntime.getModels().find((model) => model.id !== sessionModel.id);
    if (alternate === undefined) throw new Error("A second model is required");
    const configDir = await mkdtemp(join(tmpdir(), "pi-web-naming-config-"));
    const configPath = join(configDir, "config.json");
    const config = createFilePiWebConfigService({ env: { PI_WEB_CONFIG: configPath }, cwd: configDir });
    const read = vi.fn(config.read);
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const calls: { model: string; maxTokens: number | undefined; reasoning: string | undefined; timeoutMs: number | undefined; finish: () => void }[] = [];
    const streamFn: StreamFn = (model, _context, options) => {
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = {
        role: "assistant", content: [{ type: "text", text: "Generated title" }],
        api: model.api, provider: model.provider, model: model.id,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop", timestamp: Date.now(),
      };
      calls.push({
        model: `${model.provider}/${model.id}`, maxTokens: options?.maxTokens, reasoning: options?.reasoning, timeoutMs: timeout.mock.lastCall?.[0],
        finish: () => { stream.push({ type: "done", reason: "stop", message }); stream.end(message); },
      });
      return stream;
    };
    const fakes = ["live-first", "live-second", "live-third"].map((id) => fakeRuntime(id, { model: sessionModel, thinkingLevel: "high", agent: { streamFunction: streamFn } }));
    const remaining = [...fakes];
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: TEST_AGENT_DIR, modelRuntime: testModelRuntime,
      sessionManager: sessionGateway(fakes.map((fake) => sessionRecord(fake.session.sessionId))),
      createAgentRuntime: () => {
        const next = remaining.shift();
        if (next === undefined) throw new Error("Unexpected runtime open");
        return Promise.resolve(next.runtime);
      },
      config: { read }, heartbeatIntervalMs: 60_000,
    });
    try {
      await service.prompt(sessionRef("live-first"), "First request");
      await vi.waitFor(() => { expect(calls).toHaveLength(1); });
      await config.write({ sessionNaming: { model: `${alternate.provider}/${alternate.id}`, maxTokens: 2048, thinkingLevel: "off", timeoutMs: 90_000 } });
      expect(calls[0]).toMatchObject({ model: `${sessionModel.provider}/${sessionModel.id}`, maxTokens: 24, reasoning: "minimal", timeoutMs: 10_000 });
      calls[0]?.finish();
      await vi.waitFor(() => { expect(fakes[0]?.session.sessionName).toBe("Generated title"); });

      await service.prompt(sessionRef("live-second"), "Second request");
      await vi.waitFor(() => { expect(calls).toHaveLength(2); });
      expect(calls[1]).toMatchObject({ model: `${alternate.provider}/${alternate.id}`, maxTokens: 2048, reasoning: undefined, timeoutMs: 90_000 });
      // Direct file edits must work too, without a save notification or reload.
      await writeFile(configPath, "{}\n", "utf8");
      calls[1]?.finish();
      await vi.waitFor(() => { expect(fakes[1]?.session.sessionName).toBe("Generated title"); });

      await service.prompt(sessionRef("live-third"), "Third request");
      await vi.waitFor(() => { expect(calls).toHaveLength(3); });
      expect(calls[2]).toMatchObject({ model: `${sessionModel.provider}/${sessionModel.id}`, maxTokens: 24, reasoning: "minimal", timeoutMs: 10_000 });
      calls[2]?.finish();
      await vi.waitFor(() => { expect(fakes[2]?.session.sessionName).toBe("Generated title"); });
      await service.prompt(sessionRef("live-first"), "Another request");
      expect(calls).toHaveLength(3);
      expect(read).toHaveBeenCalledTimes(3);
      expect(fakes.every((fake) => fake.session.model === sessionModel && fake.session.thinkingLevel === "high")).toBe(true);
    } finally {
      timeout.mockRestore();
      for (const call of calls) call.finish();
      await service.dispose();
      await rm(configDir, { recursive: true, force: true });
    }
  });

  it.each([false, true])("falls back without blocking the prompt on naming config/model failure (config read fails: %s)", async (readFails) => {
    const expectedError = new Error(readFails ? "Config unavailable" : "Session naming model is unavailable: missing-provider/missing-model");
    const fake = fakeRuntime("missing-naming-model", { model: testModel() });
    const info = vi.fn();
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: TEST_AGENT_DIR,
      modelRuntime: testModelRuntime,
      createAgentRuntime: runtimeCreator(fake.runtime),
      sessionManager: sessionGateway([sessionRecord("missing-naming-model")]),
      config: { read: () => {
        if (readFails) throw expectedError;
        return namingConfigResponse({ model: "missing-provider/missing-model" });
      } },
      logger: { info },
      heartbeatIntervalMs: 60_000,
    });
    try {
      await service.prompt(sessionRef("missing-naming-model"), "Please fix the login bug");
      await vi.waitFor(() => { expect(fake.session.sessionName).toBe("Please fix the login bug"); });
      expect(fake.calls.prompt).toHaveLength(1);
      expect(info).toHaveBeenCalledWith({ sessionId: "missing-naming-model", err: expectedError }, "Session naming failed; using the first-message fallback");
    } finally {
      await service.dispose();
    }
  });

  it("includes queued message details in session status", async () => {
    const messages = [{ role: "user", content: "hello" }, { role: "assistant", content: "hi" }];
    const fake = fakeRuntime("status-session", {
      messages,
      sessionManager: fakeSessionManager("/workspace", {
        getBranch: () => messages.map((message) => ({ type: "message", message })),
      }),
      pendingMessageCount: 2,
      getSteeringMessages: () => ["adjust this turn"],
      getFollowUpMessages: () => ["then do this"],
    });
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: TEST_AGENT_DIR,
      modelRuntime: testModelRuntime,
      createAgentRuntime: runtimeCreator(fake.runtime),
      sessionManager: sessionGateway([sessionRecord("status-session")]),
      heartbeatIntervalMs: 60_000,
    });

    await expect(service.status(sessionRef("status-session"))).resolves.toMatchObject({
      pendingMessageCount: 2,
      queuedMessages: [{ kind: "steer", text: "adjust this turn" }, { kind: "followUp", text: "then do this" }],
      messageCount: 2,
    });
    await service.dispose();
  });

  it("does not enqueue duplicate queued message text", async () => {
    const fake = fakeRuntime("dedupe-session", {
      isStreaming: true,
      pendingMessageCount: 1,
      getFollowUpMessages: () => ["already queued"],
    });
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: TEST_AGENT_DIR,
      modelRuntime: testModelRuntime,
      createAgentRuntime: runtimeCreator(fake.runtime),
      sessionManager: sessionGateway([sessionRecord("dedupe-session")]),
      heartbeatIntervalMs: 60_000,
    });

    await service.prompt(sessionRef("dedupe-session"), "already queued", "followUp");

    expect(fake.calls.prompt).toEqual([]);
    await service.dispose();
  });

  it("does not append queued prompts to the transcript before delivery", async () => {
    const hub = new CapturingSessionEventHub();
    const fake = fakeRuntime("queued-session", { isStreaming: true });
    const service = new PiSessionService(hub, {
      agentDir: TEST_AGENT_DIR,
      modelRuntime: testModelRuntime,
      createAgentRuntime: runtimeCreator(fake.runtime),
      sessionManager: sessionGateway([sessionRecord("queued-session")]),
      heartbeatIntervalMs: 60_000,
    });

    await service.prompt(sessionRef("queued-session"), "Wait for the current turn", "followUp");

    expect(fake.calls.prompt).toEqual([{ text: "Wait for the current turn", options: { streamingBehavior: "followUp" } }]);
    expect(hub.sessionEvents.some(({ event }) => event.type === "message.append")).toBe(false);
    await service.dispose();
  });

  it("holds prompts sent during compaction until compaction finishes", async () => {
    const hub = new CapturingSessionEventHub();
    const fake = fakeRuntime("compacting-session", { isCompacting: true });
    let resolveFirstPrompt: (() => void) | undefined;
    fake.session.prompt = (text: string, options?: { streamingBehavior?: "steer" | "followUp" }) => {
      fake.calls.prompt.push({ text, options });
      if (options === undefined) {
        fake.session.isStreaming = true;
        return new Promise<void>((resolve) => { resolveFirstPrompt = resolve; });
      }
      return Promise.resolve();
    };
    const service = new PiSessionService(hub, {
      agentDir: TEST_AGENT_DIR,
      modelRuntime: testModelRuntime,
      createAgentRuntime: runtimeCreator(fake.runtime),
      sessionManager: sessionGateway([sessionRecord("compacting-session")]),
      heartbeatIntervalMs: 60_000,
    });

    await service.prompt(sessionRef("compacting-session"), "Start task 1", "followUp");
    await service.prompt(sessionRef("compacting-session"), "Then task 2", "followUp");

    expect(fake.calls.prompt).toEqual([]);
    expect(hub.sessionEvents.some(({ event }) => event.type === "message.append")).toBe(false);
    await expect(service.status(sessionRef("compacting-session"))).resolves.toMatchObject({
      pendingMessageCount: 2,
      queuedMessages: [{ kind: "followUp", text: "Start task 1" }, { kind: "followUp", text: "Then task 2" }],
    });

    fake.session.isCompacting = false;
    fake.emit({ type: "compaction_end" });
    // compaction_end drains the held queue on a scheduled timer; wait for the
    // first prompt to be delivered rather than sleeping a fixed interval.
    await vi.waitFor(() => {
      expect(fake.calls.prompt).toEqual([{ text: "Start task 1", options: undefined }]);
    });

    expect(hub.sessionEvents.some(({ event }) => event.type === "message.append" && JSON.stringify(event.message).includes("Start task 1"))).toBe(true);
    await expect(service.status(sessionRef("compacting-session"))).resolves.toMatchObject({
      pendingMessageCount: 1,
      queuedMessages: [{ kind: "followUp", text: "Then task 2" }],
    });

    fake.emit({ type: "agent_start" });
    // agent_start drains the next queued prompt asynchronously; wait for both
    // prompts to have been delivered rather than sleeping.
    await vi.waitFor(() => {
      expect(fake.calls.prompt).toEqual([
        { text: "Start task 1", options: undefined },
        { text: "Then task 2", options: { streamingBehavior: "followUp" } },
      ]);
    });
    await expect(service.status(sessionRef("compacting-session"))).resolves.toMatchObject({
      pendingMessageCount: 0,
      queuedMessages: [],
    });
    resolveFirstPrompt?.();
    await service.dispose();
  });

  it("clears runtime and compaction queues without interrupting active work", async () => {
    const steeringMessages = ["adjust this turn"];
    const followUpMessages = ["then do this"];
    const transcript = [{ role: "user", content: "keep this history" }];
    const hub = new CapturingSessionEventHub();
    const fake = fakeRuntime("clear-queue-session", {
      messages: transcript,
      sessionManager: fakeSessionManager("/workspace", {
        getBranch: () => transcript.map((message) => ({ type: "message", message })),
      }),
      isStreaming: true,
      isCompacting: true,
      pendingMessageCount: 2,
      getSteeringMessages: () => steeringMessages,
      getFollowUpMessages: () => followUpMessages,
    });
    const clearRuntimeQueue = vi.fn(() => {
      const cleared = { steering: [...steeringMessages], followUp: [...followUpMessages] };
      steeringMessages.length = 0;
      followUpMessages.length = 0;
      fake.session.pendingMessageCount = 0;
      return cleared;
    });
    fake.session.clearQueue = clearRuntimeQueue;
    const service = new PiSessionService(hub, {
      agentDir: TEST_AGENT_DIR,
      modelRuntime: testModelRuntime,
      createAgentRuntime: runtimeCreator(fake.runtime),
      sessionManager: sessionGateway([sessionRecord("clear-queue-session")]),
      heartbeatIntervalMs: 60_000,
    });

    await service.prompt(sessionRef("clear-queue-session"), "queued during compaction", "followUp");
    await expect(service.status(sessionRef("clear-queue-session"))).resolves.toMatchObject({
      isStreaming: true,
      isCompacting: true,
      pendingMessageCount: 3,
      queuedMessages: [
        { kind: "steer", text: "adjust this turn" },
        { kind: "followUp", text: "then do this" },
        { kind: "followUp", text: "queued during compaction" },
      ],
    });

    const status = await service.clearQueue(sessionRef("clear-queue-session"));

    expect(clearRuntimeQueue).toHaveBeenCalledOnce();
    expect(status).toMatchObject({
      isStreaming: true,
      isCompacting: true,
      pendingMessageCount: 0,
      queuedMessages: [],
      messageCount: 1,
    });
    expect(fake.session.messages).toBe(transcript);
    expect(fake.calls.prompt).toEqual([]);
    expect(fake.calls.abort).toBe(0);
    expect(fake.calls.dispose).toBe(0);
    const publishedStatuses = hub.sessionEvents.filter(({ event }) => event.type === "status.update");
    expect(publishedStatuses.at(-1)?.event).toEqual({ type: "status.update", status });
    await service.dispose();
  });

  it("clears an already-empty queue idempotently", async () => {
    const fake = fakeRuntime("clear-empty-queue-session");
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: TEST_AGENT_DIR,
      modelRuntime: testModelRuntime,
      createAgentRuntime: runtimeCreator(fake.runtime),
      sessionManager: sessionGateway([sessionRecord("clear-empty-queue-session")]),
      heartbeatIntervalMs: 60_000,
    });

    const firstStatus = await service.clearQueue(sessionRef("clear-empty-queue-session"));
    const secondStatus = await service.clearQueue(sessionRef("clear-empty-queue-session"));

    expect(fake.calls.clearQueue).toBe(2);
    expect(fake.calls.abort).toBe(0);
    expect(firstStatus).toMatchObject({ pendingMessageCount: 0, queuedMessages: [] });
    expect(secondStatus).toMatchObject({ pendingMessageCount: 0, queuedMessages: [] });
    await service.dispose();
  });

  it("clears queued messages when aborting active work", async () => {
    const fake = fakeRuntime("abort-session");
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: TEST_AGENT_DIR,
      modelRuntime: testModelRuntime,
      createAgentRuntime: runtimeCreator(fake.runtime),
      sessionManager: sessionGateway([sessionRecord("abort-session")]),
      heartbeatIntervalMs: 60_000,
    });

    await service.status(sessionRef("abort-session"));
    await service.abort(sessionRef("abort-session"));

    expect(fake.calls.clearQueue).toBe(1);
    expect(fake.calls.abort).toBe(1);
    await service.dispose();
  });

  it("clears prompts queued during compaction when aborting active work", async () => {
    const fake = fakeRuntime("abort-compaction-session", { isCompacting: true });
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: TEST_AGENT_DIR,
      modelRuntime: testModelRuntime,
      createAgentRuntime: runtimeCreator(fake.runtime),
      sessionManager: sessionGateway([sessionRecord("abort-compaction-session")]),
      heartbeatIntervalMs: 60_000,
    });

    await service.prompt(sessionRef("abort-compaction-session"), "Do not deliver after abort", "followUp");
    await expect(service.status(sessionRef("abort-compaction-session"))).resolves.toMatchObject({ pendingMessageCount: 1 });
    await service.abort(sessionRef("abort-compaction-session"));

    expect(fake.calls.clearQueue).toBe(1);
    expect(fake.calls.prompt).toEqual([]);
    await expect(service.status(sessionRef("abort-compaction-session"))).resolves.toMatchObject({ pendingMessageCount: 0, queuedMessages: [] });
    await service.dispose();
  });

  it("reloads models.json before listing and selecting models", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "pi-web-model-runtime-"));
    try {
      const modelsPath = join(agentDir, "models.json");
      await writeLocalModelsConfig(modelsPath, "initial-model");
      const modelRuntime = await ModelRuntime.create({
        credentials: new InMemoryCredentialStore(),
        modelsPath,
        allowModelNetwork: false,
      });
      const setSessionModel = vi.fn(() => Promise.resolve());
      const fake = fakeRuntime("models-session", { modelRuntime, setModel: setSessionModel });
      const service = new PiSessionService(new CapturingSessionEventHub(), {
        agentDir,
        modelRuntime,
        createAgentRuntime: runtimeCreator(fake.runtime),
        sessionManager: sessionGateway([sessionRecord("models-session")]),
        heartbeatIntervalMs: 60_000,
      });

      try {
        await writeLocalModelsConfig(modelsPath, "listed-model");
        const listed = await service.availableModels(sessionRef("models-session"));
        expect(listed).toEqual(expect.arrayContaining([
          expect.objectContaining({ provider: "test-local", id: "listed-model" }),
        ]));
        expect(listed).not.toEqual(expect.arrayContaining([
          expect.objectContaining({ provider: "test-local", id: "initial-model" }),
        ]));

        await writeLocalModelsConfig(modelsPath, "selected-model");
        await expect(service.setModel(sessionRef("models-session"), "test-local", "selected-model")).resolves.toBeDefined();
        expect(setSessionModel).toHaveBeenCalledWith(expect.objectContaining({
          provider: "test-local",
          id: "selected-model",
        }));
      } finally {
        await service.dispose();
      }
    } finally {
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it("refreshes auth state and dedupes warnings when logout removes the current model's credentials", async () => {
    const hub = new CapturingSessionEventHub();
    // The shared model runtime reads a live credential store. Mutating the store
    // and refreshing here simulates the committed snapshot that
    // ModelRuntime.login()/logout() establishes before AuthService emits.
    // applyAuthChange then only needs to notify active sessions.
    const credentials = new InMemoryCredentialStore();
    await seedCredential(credentials, "anthropic", { type: "api_key", key: "sk-test" });
    const modelRuntime = await createTestModelRuntime(credentials);
    const model = modelRuntime.getModel(TEST_MODEL_PROVIDER, TEST_MODEL_ID);
    if (model === undefined) throw new Error("Expected Anthropic model fixture");
    const fake = fakeRuntime("auth-session", { model, modelRuntime });

    const service = new PiSessionService(hub, {
      agentDir: TEST_AGENT_DIR,
      modelRuntime,
      createAgentRuntime: runtimeCreator(fake.runtime),
      sessionManager: sessionGateway([sessionRecord("auth-session")]),
      heartbeatIntervalMs: 60_000,
    });

    await service.status(sessionRef("auth-session"));
    hub.sessionEvents.length = 0;
    hub.globalEvents.length = 0;

    await credentials.delete("anthropic");
    await modelRuntime.refresh();
    service.applyAuthChange({ removedProviderId: "anthropic" });
    service.applyAuthChange({ removedProviderId: "anthropic" });

    const warningCount = () => hub.sessionEvents.filter(({ event }) => event.type === "command.output" && event.level === "error" && event.message.includes(`${TEST_MODEL_PROVIDER}/${TEST_MODEL_ID}`)).length;
    expect(warningCount()).toBe(1);
    expect(hub.globalEvents.some((event) => event.type === "status.update" && event.status.sessionId === "auth-session")).toBe(true);

    await seedCredential(credentials, "anthropic", { type: "api_key", key: "sk-new" });
    await modelRuntime.refresh();
    service.applyAuthChange();
    await credentials.delete("anthropic");
    await modelRuntime.refresh();
    service.applyAuthChange({ removedProviderId: "anthropic" });
    expect(warningCount()).toBe(2);

    await service.dispose();
  });

  it("clears queued messages when stopping a session runtime", async () => {
    const fake = fakeRuntime("stop-session");
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: TEST_AGENT_DIR,
      modelRuntime: testModelRuntime,
      createAgentRuntime: runtimeCreator(fake.runtime),
      sessionManager: sessionGateway([sessionRecord("stop-session")]),
      heartbeatIntervalMs: 60_000,
    });

    await service.status(sessionRef("stop-session"));
    await service.stop(sessionRef("stop-session"));

    expect(fake.calls.clearQueue).toBe(1);
    await service.dispose();
  });
});

async function writeLocalModelsConfig(path: string, modelId: string): Promise<void> {
  await writeFile(path, JSON.stringify({
    providers: {
      "test-local": {
        name: "Test Local",
        baseUrl: "http://127.0.0.1:1234/v1",
        apiKey: "offline-test-key",
        api: "openai-completions",
        models: [{
          id: modelId,
          name: modelId,
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 1_000,
          maxTokens: 100,
        }],
      },
    },
  }));
}
