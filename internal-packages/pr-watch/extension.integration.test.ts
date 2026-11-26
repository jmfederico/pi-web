import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, type AssistantMessage, type Message } from "@earendil-works/pi-ai";
import { createAgentSession, createEventBus, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { createCompanionBackend, JsonValue, PiWebHostPiSessionEventsV1, PluginSessionStateV1 } from "@jmfederico/pi-web/server-plugin-api";
import { describe, expect, it, vi } from "vitest";
import { createTestModelRuntime, testModel } from "../../src/server/sessions/piSessionService.testSupport.js";
import { createSessionDelivery } from "./delivery.js";
import prWatchExtension from "./extensions/index.js";
import { UPDATE_MESSAGE_TYPE } from "./protocol.js";

// Native Pi session, extension loading and turn scheduling; only the host
// capabilities, companion backend and provider stream are replaced.
describe("PR watch companion", () => {
  it("forwards the session identity on subscribe and wakes an idle session once per notification", async () => {
    const cwd = await realpath(await mkdtemp(join(tmpdir(), "pr-watch-extension-")));
    let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
    try {
      const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: "off" });
      const bus = createEventBus();
      const manager = SessionManager.create(cwd, join(cwd, "sessions"));
      const requests = vi.fn<(operation: string, input: JsonValue) => Promise<JsonValue>>(() => Promise.resolve({ alreadySubscribed: false }));
      bus.on("pi-web:companion-backend:discover", (data) => {
        // This fixture is the host side of the documented in-process discovery envelope.
        // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
        const envelope = data as { pluginId: string; accept: (discover: () => ReturnType<typeof createCompanionBackend>) => void };
        if (envelope.pluginId === "pr-watch") envelope.accept(() => ({ machineId: "local", forScope: () => ({ request: requests }) }));
      });
      const loader = new DefaultResourceLoader({
        cwd, agentDir: cwd, settingsManager, eventBus: bus, noExtensions: true,
        noSkills: true, noPromptTemplates: true, noThemes: true,
        agentsFilesOverride: () => ({ agentsFiles: [] }),
        extensionFactories: [prWatchExtension],
      });
      await loader.reload();
      const modelRuntime = await createTestModelRuntime();
      await modelRuntime.setRuntimeApiKey("anthropic", "isolated-test-key");
      ({ session } = await createAgentSession({
        cwd, agentDir: cwd, settingsManager, resourceLoader: loader,
        sessionManager: manager, modelRuntime, model: testModel(), noTools: "builtin",
      }));
      const errors: unknown[] = [];
      await session.bindExtensions({ onError: (error) => errors.push(error) });
      const modelInputs: Message[][] = [];
      session.agent.streamFunction = (_model, context) => {
        modelInputs.push(structuredClone(context.messages));
        const first = modelInputs.length === 1;
        const message: AssistantMessage = {
          role: "assistant", api: "anthropic-messages", provider: "anthropic", model: testModel().id,
          content: first ? [{ type: "toolCall", id: "watch-1", name: "pr_watch_subscribe", arguments: { pr: "7" } }] : [{ type: "text", text: "Handled" }],
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: first ? "toolUse" : "stop", timestamp: Date.now(),
        };
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() => { stream.push({ type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message }); stream.end(message); });
        return stream;
      };

      await session.prompt("Open the pull request and watch it");
      expect(requests).toHaveBeenCalledWith("subscribe", { pr: "7", sessionId: manager.getSessionId(), cwd }, expect.anything());
      const turnsAfterSubscribe = modelInputs.length;

      const state: PluginSessionStateV1 = {
        version: 1,
        read: () => Promise.resolve({ revision: "" }),
        write: () => Promise.reject(new Error("unused")),
      };
      const events: PiWebHostPiSessionEventsV1 = {
        version: 1,
        connect: () => Promise.resolve({
          signal: new AbortController().signal,
          on: (channel, handler) => bus.on(channel, (data) => { void handler(data); }),
          emit: (channel, data) => { bus.emit(channel, data); },
          close: () => { /* The delivery releases its bus subscription before closing. */ },
        }),
      };
      const deliver = createSessionDelivery(state, events, new AbortController().signal);
      const target = { projectId: "project", workspaceId: "workspace", sessionId: manager.getSessionId() };
      const message = {
        sessionId: manager.getSessionId(), notificationId: "note-1", content: "[PR watch] CodeRabbit activity on owner/repo#7",
        details: { notificationId: "note-1", subscriptionId: "sub-1", pullRequest: "https://github.com/owner/repo/pull/7" },
      };
      const signal = new AbortController().signal;

      await expect(deliver(target, message, signal)).resolves.toBe(true);
      await session.waitForIdle();
      expect(modelInputs).toHaveLength(turnsAfterSubscribe + 1);
      expect(JSON.stringify(modelInputs.at(-1))).toContain("CodeRabbit activity on owner/repo#7");
      expect(manager.getBranch().filter((entry) => entry.type === "custom_message" && entry.customType === UPDATE_MESSAGE_TYPE)).toHaveLength(1);

      // A retry of an acknowledged notification is accepted without another turn.
      await expect(deliver(target, message, signal)).resolves.toBe(true);
      await session.waitForIdle();
      expect(modelInputs).toHaveLength(turnsAfterSubscribe + 1);

      await expect(deliver(target, { ...message, sessionId: "another-session", notificationId: "note-2", details: { ...message.details, notificationId: "note-2" } }, signal)).rejects.toThrow("addressed to another session");
      await expect(deliver(target, { ...message, content: "x".repeat(49 * 1024) }, signal)).rejects.toThrow("content must be");
      expect(modelInputs).toHaveLength(turnsAfterSubscribe + 1);
      expect(errors).toEqual([]);
    } finally {
      await session?.abort();
      session?.dispose();
      await rm(cwd, { recursive: true, force: true });
    }
  }, 30_000);
});
