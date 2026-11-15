import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, type AssistantMessage, type Message } from "@earendil-works/pi-ai";
import { createAgentSession, createEventBus, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import {
  createSessionStateData, readSessionState, SESSION_STATE_CUSTOM_TYPE, SESSION_STATE_RESET_CUSTOM_TYPE,
  type PiWebHostPiSessionEventsV1, type PluginSessionStateV1, type ServerPluginPeerScope,
} from "@jmfederico/pi-web/server-plugin-api";
import { describe, expect, it, vi } from "vitest";
import { createTestModelRuntime, testModel } from "../../src/server/sessions/piSessionService.testSupport.js";
import privateInputExtension from "./extensions/index.js";
import { PrivateInputService } from "./service.js";
import { OUTCOME_TYPE, parseRecord, PRIVATE_INPUT_TOOL, stateNamespace } from "./protocol.js";

// Native Pi tool, persistence and continuation; only the public host capabilities
// and provider transport are replaced. No application daemon or live model runs.
describe("private input companion lifecycle", () => {
  it.each([false, true])("confirms persistence before the response finishes and retries failed delivery (inject failure: %s)", async (failPersistence) => {
    const cwd = await realpath(await mkdtemp(join(tmpdir(), "private-input-extension-")));
    let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
    let restorePersistence: (() => void) | undefined;
    let finishOutcome: (() => void) | undefined;
    try {
      const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: "off" });
      const bus = createEventBus();
      const manager = SessionManager.create(cwd, join(cwd, "sessions"));
      let turns = 0;
      let outcomeSettled!: () => void;
      let outcomeStarted!: () => void;
      let didSettle = false;
      const settled = new Promise<void>((resolve) => { outcomeSettled = resolve; });
      const started = new Promise<void>((resolve) => { outcomeStarted = resolve; });
      const loader = new DefaultResourceLoader({
        cwd, agentDir: cwd, settingsManager, eventBus: bus, noExtensions: true,
        noSkills: true, noPromptTemplates: true, noThemes: true,
        agentsFilesOverride: () => ({ agentsFiles: [] }),
        extensionFactories: [privateInputExtension, (pi) => {
          pi.on("agent_settled", () => { if (turns === 2) { didSettle = true; outcomeSettled(); } });
        }],
      });
      const state: PluginSessionStateV1 = {
        version: 1,
        read: (_target, namespace) => Promise.resolve(readSessionState(manager.getEntries(), namespace)),
        write: (_target, namespace, input) => {
          if (readSessionState(manager.getEntries(), namespace).revision !== input.revision) throw new Error("conflict");
          manager.appendCustomEntry(SESSION_STATE_CUSTOM_TYPE, createSessionStateData(namespace, input.value, input.inherit));
          return Promise.resolve(readSessionState(manager.getEntries(), namespace));
        },
      };
      const eventLog: unknown[] = [];
      const events: PiWebHostPiSessionEventsV1 = {
        version: 1,
        connect: () => Promise.resolve({
          signal: new AbortController().signal,
          on: (channel, handler) => bus.on(channel, (data) => { void handler(data); }),
          emit: (channel, data) => { eventLog.push({ channel, data }); bus.emit(channel, data); },
          close: () => { /* The service releases its bus subscription before closing. */ },
        }),
      };
      const service = new PrivateInputService(state, events, new AbortController().signal);
      bus.on("pi-web:companion-backend:discover", (value) => {
        if (typeof value !== "object" || value === null || !("accept" in value) || typeof value.accept !== "function") return;
        Reflect.apply(value.accept, value, [() => ({ machineId: "local", forScope: () => ({ request: () => Promise.resolve({ available: true }) }) })]);
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
        const first = ++turns === 1;
        const message: AssistantMessage = {
          role: "assistant", api: "anthropic-messages", provider: "anthropic", model: testModel().id,
          content: first ? [{ type: "toolCall", id: "private-1", name: PRIVATE_INPUT_TOOL, arguments: { destination: "new-key", purpose: "Service API key" } }] : [{ type: "text", text: "Outcome received" }],
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: first ? "toolUse" : "stop", timestamp: Date.now(),
        };
        const stream = createAssistantMessageEventStream();
        const finish = () => {
          stream.push({ type: "done", reason: first ? "toolUse" : "stop", message }); stream.end(message);
        };
        if (first) finish();
        else { finishOutcome = finish; outcomeStarted(); }
        return stream;
      };
      await session.prompt("Request a private service key");
      expect(turns).toBe(1);
      const result = session.messages.find((message) => message.role === "toolResult");
      expect(result).toMatchObject({ toolName: PRIVATE_INPUT_TOOL, isError: false, details: { interventionRequired: true } });
      if (result?.role !== "toolResult" || typeof result.details !== "object" || result.details === null || !("privateInput" in result.details)) throw new Error("Missing request");
      const record = parseRecord(result.details["privateInput"]);
      const scope: ServerPluginPeerScope = {
        kind: "workspace", project: { id: "project", path: cwd, name: "Project" },
        workspace: { id: "workspace", projectId: "project", path: cwd, label: "Workspace", isMain: true },
      };
      const request = (operation: string) => service.request({ scope, operation, input: { sessionId: manager.getSessionId(), requestId: record.requestId }, signal: new AbortController().signal });
      const secret = "FAKE-PRIVATE-SENTINEL\nspaces  ";
      if (failPersistence) {
        // Inject only at the persistence boundary; the extension and native SDK
        // still own send scheduling, failure handling and the retry lifecycle.
        const persistence = vi.spyOn(manager, "appendCustomMessageEntry").mockImplementationOnce(() => {
          throw new Error("injected outcome persistence failure");
        });
        restorePersistence = () => { persistence.mockRestore(); };
      }
      const response = await service.request({ scope, operation: "submit", input: {
        sessionId: manager.getSessionId(), requestId: record.requestId, confirmedDestination: record.destination, secret,
      }, signal: new AbortController().signal });
      expect(response).toMatchObject({ record: { status: "saved" }, delivered: !failPersistence });
      if (failPersistence) {
        await session.waitForIdle();
        expect(manager.getBranch().filter((entry) => entry.type === "custom_message" && entry.customType === OUTCOME_TYPE)).toHaveLength(0);
        expect(session.messages).toContainEqual(expect.objectContaining({
          role: "assistant", stopReason: "error", errorMessage: "injected outcome persistence failure",
        }));
        restorePersistence?.();
        restorePersistence = undefined;
        expect(await request("notify")).toMatchObject({ delivered: true });
      }
      // Confirmation must not wait for model completion (the peer has a short
      // timeout). Hold the provider stream open until delivery was acknowledged.
      await started;
      expect(didSettle).toBe(false);
      expect(manager.getBranch().filter((entry) => entry.type === "custom_message" && entry.customType === OUTCOME_TYPE)).toHaveLength(1);
      const sessionFile = manager.getSessionFile();
      if (sessionFile === undefined) throw new Error("Session not persisted");
      const persisted = await readFile(sessionFile, "utf8");
      expect(persisted).toContain(OUTCOME_TYPE);
      finishOutcome?.();
      finishOutcome = undefined;
      await settled;
      expect(turns).toBe(2);
      expect(await readFile(join(cwd, "new-key"), "utf8")).toBe(secret);
      expect(modelInputs.at(-1)?.filter((message) => message.role === "user"
        && Array.isArray(message.content) && message.content.some((block) => block.type === "text" && block.text.includes(record.requestId)))).toHaveLength(1);
      expect(await request("notify")).toMatchObject({ delivered: true });
      expect(turns).toBe(2);
      expect(JSON.stringify([modelInputs, session.messages, manager.getEntries(), eventLog, response, errors, persisted])).not.toContain("FAKE-PRIVATE-SENTINEL");
      expect(errors).toEqual([]);
      // Fork/reset semantics: copied history must not revive a writable request.
      manager.appendCustomEntry(SESSION_STATE_RESET_CUSTOM_TYPE, { version: 1 });
      expect(readSessionState(manager.getEntries(), stateNamespace(record.requestId)).value).toBeUndefined();
      await expect(request("cancel")).rejects.toThrow("could not be confirmed");
    } finally {
      restorePersistence?.();
      finishOutcome?.();
      await session?.abort(); session?.dispose();
      await rm(cwd, { recursive: true, force: true });
    }
  }, 30_000);
});
