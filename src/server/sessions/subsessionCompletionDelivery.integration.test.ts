import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, defineTool, SessionManager, SettingsManager } from "../../piSdk.js";
import { describe, expect, it, vi } from "vitest";
import { Type } from "pi-web-typebox";
import { PiSessionService, type PiSessionRuntime } from "./piSessionService.js";
import { CapturingSessionEventHub, createTestModelRuntime, emptyArchiveStore, fakeRuntime, fakeSessionManager, sessionGateway, testModel } from "./piSessionService.testSupport.js";
import { createSubsessionToolDefinitions } from "./spawnSubsessionTool.js";
import { createSubsessionCompletionDelivery } from "./subsessionCompletionDelivery.js";

// Real Pi tool-result, boundary-draft, and settlement semantics. Only the
// provider transport and the independently running child's runtime are fake.
describe("subsession completion delivery through native Pi", () => {
  it.each(["yield-ready", "check-ready", "yield-race", "natural-stop", "nested-check", "check-rejected", "parent-error", "parent-aborted"] as const)("delivers a child result once through %s", async (scenario) => {
    const failed = scenario === "parent-error" || scenario === "parent-aborted";
    const directory = await mkdtemp(join(tmpdir(), "pi-web-subsession-delivery-"));
    const modelRuntime = await createTestModelRuntime();
    await modelRuntime.setRuntimeApiKey("anthropic", "isolated-test-key");
    const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: "off" });
    const childMessages: unknown[] = [];
    const child = fakeRuntime("child-1", {
      sessionManager: fakeSessionManager(directory, { getBranch: () => childMessages }),
    });
    let completed = false;
    function finishChild() {
      if (completed) return;
      completed = true;
      childMessages.push({ type: "message", message: { role: "assistant", content: "CHILD_FINAL_ANSWER" } });
      child.session.isStreaming = false;
      child.emit({ type: "agent_end" });
    }
    let boundaryProof = false;
    const loader = new DefaultResourceLoader({
      cwd: directory, agentDir: directory, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
      agentsFilesOverride: () => ({ agentsFiles: [] }),
      extensionFactories: [
        (pi) => {
          pi.on("agent_before_settle", (event) => {
            if (scenario === "yield-race") finishChild();
            if (scenario === "natural-stop" && !boundaryProof) {
              boundaryProof = true;
              return { entries: [...event.entries, { type: "custom", customType: "earlier-boundary-proof", data: true }] };
            }
            return undefined;
          });
          pi.on("tool_result", (event) => scenario === "check-rejected" && event.toolName === "check_subsession"
            ? { isError: true, content: [{ type: "text", text: "Inspection could not be delivered" }] } : undefined);
        },
        createSubsessionCompletionDelivery({ prepare: (...args) => hosted.prepareSubsessionDelivery(...args) }),
      ],
    });
    await loader.reload();
    const { session } = await createAgentSession({
      cwd: directory, agentDir: directory, sessionManager: SessionManager.inMemory(directory),
      settingsManager, resourceLoader: loader, modelRuntime, model: testModel(), tools: ["yield_to_subsessions", "check_subsession", "nested_check"],
      customTools: [...createSubsessionToolDefinitions(directory, {
        spawn: (input) => hosted.spawnSubsession(input),
        list: (...args) => hosted.listSubsessions(...args),
        join: (...args) => hosted.joinSubsessions(...args),
        check: (...args) => hosted.checkSubsession(...args),
        read: (...args) => hosted.readSubsession(...args),
      }), defineTool({
        name: "nested_check", label: "Nested check", description: "Read the child through a nested tool.", parameters: Type.Object({}),
        async execute(_id, _args, _signal, _onUpdate, ctx) {
          const outcome = await ctx.executeTool("check_subsession", { sessionId: "child-1" });
          return { content: outcome.result.content, details: {} };
        },
      })],
    });
    const parentRuntime: PiSessionRuntime = {
      cwd: directory, session,
      setRebindSession: () => undefined, fork: () => Promise.resolve({ cancelled: true }),
      dispose: () => { session.dispose(); return Promise.resolve(); },
    };
    const runtimes = [parentRuntime, child.runtime];
    let runtimeIndex = 0;
    const hosted = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: directory, modelRuntime, sessionManager: sessionGateway([]), archiveStore: emptyArchiveStore(),
      createAgentRuntime: () => Promise.resolve(runtimes[runtimeIndex++] ?? child.runtime),
      spawnTargets: { resolveSpawnTarget: () => Promise.resolve({ allowed: true, cwd: directory }) },
      heartbeatIntervalMs: 60_000,
    });
    const errors: unknown[] = [];
    const sendMessage = vi.spyOn(session, "sendCustomMessage");
    let requests = 0;
    const modelInputs: string[] = [];
    session.agent.streamFunction = (_model, context) => {
      requests += 1;
      if (requests > (scenario === "check-rejected" ? 3 : 2)) throw new Error("duplicate child input caused an extra provider request");
      if (requests === 1 && scenario !== "yield-race") finishChild();
      const inputs = context.messages.filter((message) => message.role === "user" || message.role === "toolResult");
      modelInputs.push(inputs.map((message) => typeof message.content === "string" ? message.content
        : message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n")).join("\n"));
      const toolName = scenario === "nested-check" ? "nested_check"
        : scenario === "check-ready" || scenario === "check-rejected" ? "check_subsession" : "yield_to_subsessions";
      const hasToolCall = requests === 1 && scenario !== "natural-stop" && !failed;
      const stopReason = failed ? (scenario === "parent-error" ? "error" : "aborted") : hasToolCall ? "toolUse" : "stop";
      const message: AssistantMessage = {
        role: "assistant", api: "anthropic-messages", provider: "anthropic", model: testModel().id,
        content: hasToolCall
          ? [{ type: "toolCall", id: "join-child", name: toolName, arguments: toolName === "check_subsession" ? { sessionId: "child-1" } : {} }]
          : [{ type: "text", text: requests === 1 ? "Independent work done" : "Integrated the child result" }],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason, timestamp: Date.now(),
        ...(failed ? { errorMessage: "Parent could not continue" } : {}),
      };
      const stream = createAssistantMessageEventStream();
      if (stopReason === "error" || stopReason === "aborted") stream.push({ type: "error", reason: stopReason, error: message });
      else stream.push({ type: "done", reason: stopReason, message });
      stream.end(message);
      return stream;
    };
    try {
      await hosted.start(directory);
      await session.bindExtensions({ onError: (error) => errors.push(error) });
      await hosted.spawnSubsession({ spawningCwd: directory, parentSessionId: session.sessionId, parentSessionFile: undefined, prompt: "Work" });
      child.session.isStreaming = true;
      child.emit({ type: "agent_start" });
      await session.prompt("Continue independent work, then join");
      await new Promise<void>((resolve) => setImmediate(resolve));
      const joined = await hosted.joinSubsessions(session.sessionId);
      expect(joined.completions).toHaveLength(failed ? 1 : 0);
      expect(requests).toBe(failed ? 1 : scenario === "check-rejected" ? 3 : 2);
      if (!failed) {
        expect(modelInputs.at(-1)?.split("CHILD_FINAL_ANSWER")).toHaveLength(2);
        expect(session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Integrated the child result" }] });
      } else {
        expect(session.messages.at(-1)).toMatchObject({ stopReason: scenario === "parent-error" ? "error" : "aborted" });
      }
      expect(session.messages.filter((message) => message.role === "toolResult").every((message) => !message.isError)).toBe(scenario !== "check-rejected");
      if (scenario === "natural-stop") expect(session.sessionManager.getBranch().some((entry) => entry.type === "custom" && entry.customType === "earlier-boundary-proof")).toBe(true);
      expect(sendMessage).not.toHaveBeenCalled(); // No rendered answer was enqueued separately.
      const notices = session.messages.filter((message) => message.role === "custom" && message.customType === "subsession.completion");
      expect(notices).toHaveLength(scenario === "yield-race" || scenario === "natural-stop" || scenario === "check-rejected" ? 1 : 0);
      expect(await hosted.prepareSubsessionDelivery(session.sessionId)).toBeUndefined();
      expect(errors).toEqual([]);
    } finally {
      await hosted.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
