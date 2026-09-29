import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, type AgentBeforeSettleEvent, type TurnEndEvent, type TurnEndEventResult } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { PiSessionService, type PiSessionRuntime } from "./piSessionService.js";
import { CapturingSessionEventHub, createTestModelRuntime, emptyArchiveStore, runtimeCreator, sessionGateway, testModel } from "./piSessionService.testSupport.js";
import { historyMessagesFromEntries } from "./transcriptMessages.js";

// Real Pi boundary dispatch/persistence with isolated configuration and model transport.
describe("Pi canonical context and boundary transcript compatibility", () => {
  it.each((["turn_end", "agent_before_settle"] as const).flatMap((boundary) => [
    { boundary, compact: false }, { boundary, compact: true },
  ]))("publishes $boundary drafts (compact=$compact) without rewriting raw history", async ({ boundary, compact }) => {
    const directory = await mkdtemp(join(tmpdir(), "pi-web-boundaries-"));
    const modelRuntime = await createTestModelRuntime();
    await modelRuntime.setRuntimeApiKey("anthropic", "isolated-test-key");
    const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
    const manager = SessionManager.inMemory(directory);
    let dispatched = false;
    const loader = new DefaultResourceLoader({
      cwd: directory, agentDir: directory, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
      agentsFilesOverride: () => ({ agentsFiles: [] }),
      extensionFactories: [(pi) => {
        const handleBoundary = (event: TurnEndEvent | AgentBeforeSettleEvent): TurnEndEventResult | undefined => {
          if (dispatched) return;
          dispatched = true;
          const assistant = manager.getBranch().find((entry) => entry.type === "message" && entry.message.role === "assistant");
          if (assistant === undefined) throw new Error("Boundary must observe a persisted assistant");
          return {
            entries: [...event.entries,
              compact
                ? { type: "compaction", summary: "Boundary summary", firstKeptEntryId: null }
                : { type: "context_edit", targetId: assistant.id, replacement: null },
              { type: "custom", customType: "metadata", data: { internal: true } },
              { type: "custom_message", customType: "hidden", content: "Hidden context", display: false },
              { type: "custom_message", customType: "visible", content: "Continue from boundary", display: true },
            ],
            continue: true,
          };
        };
        if (boundary === "turn_end") pi.on("turn_end", handleBoundary);
        else pi.on("agent_before_settle", handleBoundary);
      }],
    });
    await loader.reload();
    const { session } = await createAgentSession({
      cwd: directory, agentDir: directory, sessionManager: manager, settingsManager,
      resourceLoader: loader, modelRuntime, model: testModel(), noTools: "all",
    });
    session.setSessionName("Boundary compatibility test");
    const requests: unknown[] = [];
    session.agent.streamFunction = (_model, context) => {
      requests.push(structuredClone(context.messages));
      const message: AssistantMessage = {
        role: "assistant", content: [{ type: "text", text: requests.length === 1 ? "Original answer" : "Continued answer" }],
        api: "anthropic-messages", provider: "anthropic", model: testModel().id,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop", timestamp: Date.now(),
      };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "done", reason: "stop", message });
      stream.end(message);
      return stream;
    };
    const runtime: PiSessionRuntime = {
      cwd: directory, session, setRebindSession: () => undefined,
      fork: () => Promise.resolve({ cancelled: true }),
      dispose: () => { session.dispose(); return Promise.resolve(); },
    };
    const hub = new CapturingSessionEventHub();
    const service = new PiSessionService(hub, {
      agentDir: directory, modelRuntime, createAgentRuntime: runtimeCreator(runtime),
      sessionManager: sessionGateway([]), archiveStore: emptyArchiveStore(), heartbeatIntervalMs: 60_000,
    });
    try {
      const run = await service.startOneShotRun(directory, "Initial prompt", new AbortController().signal);
      await run.completion;
      expect(requests).toHaveLength(2);
      expect(requests[0]).toEqual(expect.arrayContaining([expect.objectContaining({ role: "system" })]));
      expect(JSON.stringify(requests[1])).not.toContain("Original answer");
      expect(JSON.stringify(requests[1])).toContain("Continue from boundary");
      expect(JSON.stringify(requests[1])).toContain("Hidden context");

      const history = historyMessagesFromEntries(manager.getBranch());
      expect(history).toContainEqual(expect.objectContaining({ role: "system" }));
      expect(history).toContainEqual(expect.objectContaining({ role: "assistant", content: [{ type: "text", text: "Original answer" }] }));
      const visible = history.find((message) => typeof message === "object" && message !== null && "customType" in message && message.customType === "visible");
      expect(visible).toHaveProperty("entryId", expect.any(String));
      expect(visible).toHaveProperty("content", "Continue from boundary");
      const appended = hub.sessionEvents.filter(({ event }) => event.type === "message.append").map(({ event }) => event);
      expect(appended).toHaveLength(compact ? 3 : 2);
      expect(appended[0]).toMatchObject({ type: "message.append", message: { role: "user" } });
      expect(appended.at(-1)).toEqual({ type: "message.append", message: visible });
      if (compact) {
        expect(appended[1]).toMatchObject({ type: "message.append", message: { role: "system", source: "compaction", content: "Compacted history:\n\nBoundary summary" } });
      }
    } finally {
      await service.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
