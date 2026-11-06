import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { Type } from "pi-web-typebox";
import { describe, expect, it, vi } from "vitest";
import { createAgentSession, DefaultResourceLoader, defineTool, SessionManager, SettingsManager, type AgentSession } from "../../piSdk.js";
import { createArchiveSelfToolDefinition } from "./archiveSelfTool.js";
import { createPiSessionManagerGateway } from "./piSessionManagerGateway.js";
import { PiSessionService, type PiSessionServiceDependencies } from "./piSessionService.js";
import { CapturingSessionEventHub, createTestModelRuntime, testModel } from "./piSessionService.testSupport.js";
import { SessionArchiveStore } from "./sessionArchiveStore.js";

// Exercise real SDK result persistence, settlement, and host prompt receipts.
// Only runtime construction and model transport are substituted; all files and
// configuration belong to this test, not the running daemon or user profile.
describe("archive_self hosted SDK lifecycle", () => {
  it.each([
    { mixed: false, behavior: "archives the persisted result without a follow-up model request" },
    { mixed: true, behavior: "cancels pending archival when a mixed batch continues" },
  ])("$behavior", async ({ mixed }) => {
    const directory = await mkdtemp(join(tmpdir(), "pi-web-archive-self-"));
    const agentDir = join(directory, "agent");
    const sessionDir = join(directory, "sessions");
    let service: PiSessionService | undefined;
    let nativeSession: AgentSession | undefined;
    try {
      const modelRuntime = await createTestModelRuntime();
      await modelRuntime.setRuntimeApiKey("anthropic", "isolated-test-key");
      const archiveStore = new SessionArchiveStore(join(directory, "archives.json"), join(directory, "archive"));
      const archive = vi.spyOn(archiveStore, "archive");
      const executeSibling = vi.fn(() => Promise.resolve({ content: [{ type: "text" as const, text: "Done" }], details: {} }));
      const sibling = defineTool({
        name: "sentinel",
        label: "Sentinel",
        description: "Return without terminating the run.",
        parameters: Type.Object({}),
        execute: executeSibling,
      });
      let requestCount = 0;
      const createAgentRuntime: NonNullable<PiSessionServiceDependencies["createAgentRuntime"]> = async (_factory, options) => {
        if (!(options.sessionManager instanceof SessionManager)) throw new Error("Expected a file-backed SessionManager");
        const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
        const resourceLoader = new DefaultResourceLoader({
          cwd: directory, agentDir, settingsManager,
          noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
          agentsFilesOverride: () => ({ agentsFiles: [] }),
        });
        await resourceLoader.reload();
        const { session } = await createAgentSession({
          cwd: directory, agentDir, sessionManager: options.sessionManager, settingsManager, resourceLoader,
          modelRuntime, model: testModel(), noTools: "builtin",
          customTools: [createArchiveSelfToolDefinition(), sibling],
        });
        nativeSession = session;
        session.setSessionName("Archive lifecycle test");
        session.agent.streamFunction = () => {
          requestCount += 1;
          const first = requestCount === 1;
          const message: AssistantMessage = {
            role: "assistant",
            content: first
              ? [
                { type: "toolCall", id: "archive-call", name: "archive_self", arguments: {} },
                ...(mixed ? [{ type: "toolCall" as const, id: "sibling-call", name: "sentinel", arguments: {} }] : []),
              ]
              : [{ type: "text", text: "Continued after the mixed batch" }],
            api: "anthropic-messages", provider: "anthropic", model: testModel().id,
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            stopReason: first ? "toolUse" : "stop", timestamp: Date.now(),
          };
          const stream = createAssistantMessageEventStream();
          stream.push({ type: "done", reason: first ? "toolUse" : "stop", message });
          stream.end(message);
          return stream;
        };
        return {
          cwd: directory, session, setRebindSession: () => undefined,
          fork: () => Promise.resolve({ cancelled: true }),
          dispose: () => { session.dispose(); return Promise.resolve(); },
        };
      };
      service = new PiSessionService(new CapturingSessionEventHub(), {
        agentDir, modelRuntime, createAgentRuntime, archiveStore, heartbeatIntervalMs: 60_000,
        sessionManager: createPiSessionManagerGateway({ agentDir, env: { PI_CODING_AGENT_SESSION_DIR: sessionDir } }),
      });
      const started = await service.start(directory);
      if (nativeSession === undefined) throw new Error("Expected the hosted SDK session");
      const session = nativeSession;
      const sessionFile = session.sessionFile;
      if (sessionFile === undefined) throw new Error("Expected a persistent session path");
      const prompt = vi.spyOn(session, "prompt");
      // Flush the deferred idle check deterministically in the negative case;
      // an immediate assertion could pass before an erroneous archive begins.
      if (mixed) vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      await service.prompt({ id: started.id, cwd: directory }, "Archive this session");
      expect(prompt).toHaveBeenCalledOnce();
      await prompt.mock.results[0]?.value;

      const persistedResult = {
        type: "message",
        message: { role: "toolResult", toolCallId: "archive-call", toolName: "archive_self", isError: false, details: { archiveSelf: true } },
      };
      if (mixed) {
        await vi.runOnlyPendingTimersAsync();
        expect(requestCount).toBe(2);
        expect(executeSibling).toHaveBeenCalledOnce();
        expect(archive).not.toHaveBeenCalled();
        expect(await archiveStore.list()).toEqual([]);
        expect(service.activeCount()).toBe(1);
        const branch = SessionManager.open(sessionFile).getBranch();
        expect(branch.find((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "archive_self"))
          .toMatchObject(persistedResult);
        expect(branch.at(-1)).toMatchObject({ type: "message", message: { role: "assistant", stopReason: "stop" } });
      } else {
        await vi.waitFor(async () => {
          expect(archive).toHaveBeenCalledOnce();
          expect(await archiveStore.get(started.id)).toHaveProperty("archivePath");
          await expect(access(sessionFile)).rejects.toMatchObject({ code: "ENOENT" });
        });
        await archive.mock.results[0]?.value;
        const archived = await archiveStore.get(started.id);
        if (archived?.archivePath === undefined) throw new Error("Expected an archived transcript");
        const branch = SessionManager.open(archived.archivePath).getBranch();
        expect(branch.at(-1)).toMatchObject(persistedResult);
        expect(requestCount).toBe(1);
        expect(service.activeCount()).toBe(0);
      }
    } finally {
      await service?.dispose();
      nativeSession?.dispose();
      vi.useRealTimers();
      vi.restoreAllMocks();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
