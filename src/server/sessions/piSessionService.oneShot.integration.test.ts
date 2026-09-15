import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { PiSessionService, type PiSessionRuntime } from "./piSessionService.js";
import { CapturingSessionEventHub, createTestModelRuntime, emptyArchiveStore, runtimeCreator, sessionGateway, testModel } from "./piSessionService.testSupport.js";

// Real Pi prompt/event semantics; only the model transport and host runtime
// construction are substituted. No live daemon, provider network, or user config.
describe("managed launcher native Pi integration", () => {
  it.each(["initial", "handled", "retry-cancelled"])("observes startup hooks and native %s outcomes without losing the conversation", async (initialPrompt) => {
    const directory = await mkdtemp(join(tmpdir(), "pi-web-launcher-"));
    const modelRuntime = await createTestModelRuntime();
    await modelRuntime.setRuntimeApiKey("anthropic", "isolated-test-key");
    const settingsManager = SettingsManager.inMemory({
      retry: { enabled: initialPrompt === "retry-cancelled", maxRetries: 3, baseDelayMs: 60_000 },
      compaction: { enabled: false },
    });
    const loader = new DefaultResourceLoader({
      cwd: directory,
      agentDir: directory,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      agentsFilesOverride: () => ({ agentsFiles: [] }),
      extensionFactories: [(pi) => {
        pi.on("session_start", () => {
          pi.sendMessage({ customType: "startup", content: "Startup observed", display: true });
        });
        pi.on("input", (event) => event.text === "handled" ? { action: "handled" } : undefined);
      }],
    });
    await loader.reload();
    const { session } = await createAgentSession({
      cwd: directory,
      agentDir: directory,
      sessionManager: SessionManager.inMemory(directory),
      settingsManager,
      resourceLoader: loader,
      modelRuntime,
      model: testModel(),
      noTools: "all",
    });
    const hub = new CapturingSessionEventHub();
    let providerFails = true;
    session.agent.streamFunction = () => {
      expect(hub.globalEvents.some((event) => event.type === "session.created")).toBe(true);
      const message: AssistantMessage = {
        role: "assistant", content: [], api: "anthropic-messages", provider: "anthropic", model: testModel().id,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: providerFails ? "error" : "stop", timestamp: Date.now(),
        ...(providerFails ? { errorMessage: initialPrompt === "retry-cancelled" ? "429 rate limit exceeded" : "synthetic provider failure" } : {}),
      };
      const stream = createAssistantMessageEventStream();
      if (providerFails) stream.push({ type: "error", reason: "error", error: message });
      else stream.push({ type: "done", reason: "stop", message });
      stream.end(message);
      return stream;
    };
    let notifyRetryStarted!: () => void;
    const retryStarted = new Promise<void>((resolve) => { notifyRetryStarted = resolve; });
    const retryEnds: unknown[] = [];
    const unsubscribeRetry = session.subscribe((event) => {
      if (event.type === "auto_retry_start") notifyRetryStarted();
      if (event.type === "auto_retry_end") retryEnds.push(event);
    });
    const nativePrompt = vi.spyOn(session, "prompt");
    const runtime: PiSessionRuntime = {
      cwd: directory, session,
      setRebindSession: () => undefined,
      fork: () => Promise.resolve({ cancelled: true }),
      dispose: () => { session.dispose(); return Promise.resolve(); },
    };
    const service = new PiSessionService(hub, {
      agentDir: directory, modelRuntime,
      createAgentRuntime: runtimeCreator(runtime),
      sessionManager: sessionGateway([]),
      archiveStore: emptyArchiveStore(), heartbeatIntervalMs: 60_000,
    });
    try {
      const run = await service.startOneShotRun(directory, initialPrompt, new AbortController().signal);
      if (initialPrompt === "retry-cancelled") {
        await retryStarted;
        expect(session.isRetrying).toBe(true);
        const completion = expect(run.completion).rejects.toMatchObject({ name: "AbortError" });
        await service.abort({ id: run.id, cwd: directory });
        await completion;
        expect(retryEnds).toContainEqual({ type: "auto_retry_end", success: false, attempt: 1, finalError: "Retry cancelled" });
        expect(session.messages.some((message) => message.role === "assistant" && message.stopReason === "aborted")).toBe(false);
      } else if (initialPrompt === "initial") await expect(run.completion).rejects.toThrow("synthetic provider failure");
      else await expect(run.completion).resolves.toBeUndefined();
      // The actual SDK promise fulfills: checking only rejection is insufficient.
      await expect(nativePrompt.mock.results[0]?.value).resolves.toBeUndefined();
      const finishedMessages = hub.sessionEvents.flatMap(({ event }) => event.type === "message.end" ? [event.message] : []);
      expect(finishedMessages[0]).toMatchObject({ customType: "startup", content: "Startup observed" });
      if (initialPrompt === "initial") {
        expect(hub.sessionEvents.some(({ event }) => event.type === "agent.start")).toBe(true);
        expect(hub.globalEvents.some((event) => event.type === "status.update" && event.status.isStreaming)).toBe(true);
        expect(finishedMessages.at(-1)).toMatchObject({ stopReason: "error", errorMessage: "synthetic provider failure" });
      }
      expect(service.activeCount()).toBe(1);
      providerFails = false;
      await service.prompt({ id: run.id, cwd: directory }, "continue");
      await expect(nativePrompt.mock.results[1]?.value).resolves.toBeUndefined();
      expect(session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
    } finally {
      unsubscribeRetry();
      await service.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
