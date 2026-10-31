import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, type AgentSession, type CustomMessageEntry } from "../../piSdk.js";
import { describe, expect, it, vi } from "vitest";
import { ASK_USER_ANSWERS_CUSTOM_TYPE, type AskUserRequest } from "../../shared/apiTypes.js";
import { createPiWebCustomToolDefinitions, PiSessionService, type PiSessionRuntime, type PiSessionServiceDependencies } from "./piSessionService.js";
import { AskUserValidationError, createAskUserRequest } from "./askUserDomain.js";
import { createAskUserToolDefinition } from "./askUserTool.js";
import { createPiSessionManagerGateway } from "./piSessionManagerGateway.js";
import { isRecord } from "./sessionFileFormat.js";
import { CapturingSessionEventHub, createTestModelRuntime, emptyArchiveStore, fakeRuntime, runtimeCreator, sessionGateway, sessionRecord, sessionRef, testModel, testModelRuntime } from "./piSessionService.testSupport.js";

const SESSION_ID = "ask-session";
const questions = [{ id: "db", question: "Which database?", options: [{ value: "pg", label: "Postgres" }] }];
const ask = createAskUserRequest(questions, { createAskId: () => "ask-1", now: () => new Date("2026-02-01T10:00:00.000Z") });

function appendRequest(manager: SessionManager, request: AskUserRequest = ask) {
  return manager.appendMessage({
    role: "toolResult", toolCallId: `call-${request.askId}`, toolName: "ask_user", content: [{ type: "text", text: "Posted questions" }],
    isError: false, details: { ask: {
      ...request, questions: request.questions.map((question) => ({ ...question, options: question.options.map((option) => ({ ...option })) })),
    } }, timestamp: Date.now(),
  });
}

function askService(branch: unknown[] = [{ type: "message", message: {
  role: "toolResult", toolName: "ask_user", isError: false, details: { ask },
} }]) {
  const fake = fakeRuntime(SESSION_ID, {
    sessionManager: {
      getCwd: () => "/workspace", getSessionId: () => SESSION_ID, getSessionFile: () => undefined,
      getLeafId: () => "leaf-1", branch: () => undefined, resetLeaf: () => undefined,
      getBranch: () => branch,
    },
  });
  const events = new CapturingSessionEventHub();
  const gateway = sessionGateway([sessionRecord(SESSION_ID)]);
  const service = new PiSessionService(events, {
    agentDir: "/tmp/pi-web-test-agent", modelRuntime: testModelRuntime,
    sessionManager: gateway, archiveStore: emptyArchiveStore(),
    createAgentRuntime: runtimeCreator(fake.runtime), heartbeatIntervalMs: 60_000,
    now: () => new Date("2026-02-01T10:01:00.000Z"),
  });
  return { service, events, fake, branch, gateway };
}

function questionEvents(events: CapturingSessionEventHub) {
  return events.sessionEvents.filter(({ event }) => event.type.startsWith("ask."));
}

describe("ask_user registration", () => {
  it("offers the stateless tool when enabled, including to restricted children", () => {
    for (const delegationEnabled of [true, false]) {
      expect(createPiWebCustomToolDefinitions("/workspace", delegationEnabled, undefined, undefined, true).map((tool) => tool.name))
        .toEqual(["edit", "request_human_intervention", "ask_user"]);
    }
    expect(createPiWebCustomToolDefinitions("/workspace", true).map((tool) => tool.name)).toEqual(["edit", "request_human_intervention"]);
  });
});

describe("PiSessionService durable question replies", () => {
  it("validates the durable request and delivers a structured follow-up that wakes the agent", async () => {
    const { service, events, fake } = askService();
    try {
      const response = await service.submitAsk(sessionRef(SESSION_ID), "ask-1", { answers: [{ id: "db", values: [], otherText: "DuckDB" }] });
      expect(response.sessionId).toBe(SESSION_ID);
      expect(response).not.toHaveProperty("result");
      expect(response).not.toHaveProperty("pendingAsk");
      expect(fake.calls.sendCustomMessage).toHaveLength(1);
      expect(fake.calls.sendCustomMessage[0]).toMatchObject({
        message: {
          customType: ASK_USER_ANSWERS_CUSTOM_TYPE, display: true,
          details: {
            askId: "ask-1", reason: "submitted", askedAt: ask.askedAt, closedAt: "2026-02-01T10:01:00.000Z",
            questions: [{ question: questions[0], answered: true, values: [], otherText: "DuckDB" }],
            answeredCount: 1, unansweredIds: [],
          },
        },
        options: { triggerTurn: true, deliverAs: "followUp" },
      });
      expect(fake.calls.sendCustomMessage[0]?.message.content).toContain('custom: "DuckDB"');
      expect(questionEvents(events)).toEqual([]);
    } finally { await service.dispose(); }
  });

  it("answers an earlier request after later conversation and a newer request", async () => {
    const { service, fake, branch } = askService();
    branch.push({ type: "message", message: { role: "user", content: "Continue with the design" } }, {
      type: "message", message: { role: "toolResult", toolName: "ask_user", isError: false, details: { ask: { ...ask, askId: "ask-2" } } },
    });
    try {
      await service.submitAsk(sessionRef(SESSION_ID), "ask-1", { answers: [{ id: "db", values: ["pg"] }] });
      expect(fake.calls.sendCustomMessage[0]?.message.details).toMatchObject({ askId: "ask-1", reason: "submitted" });
    } finally { await service.dispose(); }
  });

  it("records two consecutive human answers even while the first agent wake is in flight", async () => {
    const { service, fake } = askService();
    let finish!: () => void;
    const delivery = new Promise<void>((resolve) => { finish = resolve; });
    const sendCustomMessage = vi.spyOn(fake.session, "sendCustomMessage");
    sendCustomMessage.mockImplementationOnce(async () => { fake.session.isStreaming = true; await delivery; });
    try {
      const first = service.submitAsk(sessionRef(SESSION_ID), "ask-1", { answers: [{ id: "db", values: ["pg"] }] });
      await vi.waitFor(() => { expect(sendCustomMessage).toHaveBeenCalledOnce(); });
      await service.submitAsk(sessionRef(SESSION_ID), "ask-1", { answers: [{ id: "db", values: ["pg"] }] });
      expect(sendCustomMessage).toHaveBeenCalledTimes(2);
      for (const [message, options] of sendCustomMessage.mock.calls) {
        expect(message.details).toMatchObject({ askId: "ask-1", reason: "submitted" });
        expect(options).toEqual({ triggerTurn: true, deliverAs: "followUp" });
      }
      finish();
      await first;
    } finally { finish(); await service.dispose(); }
  });

  it("preserves unanswered question names in the model-facing follow-up", async () => {
    const partialAsk = { ...ask, questions: [...questions, { id: "cache", question: "Which cache?", options: [] }] };
    const { service, fake } = askService([{ type: "message", message: { role: "toolResult", toolName: "ask_user", isError: false, details: { ask: partialAsk } } }]);
    try {
      await service.submitAsk(sessionRef(SESSION_ID), "ask-1", { answers: [{ id: "db", values: ["pg"] }] });
      expect(fake.calls.sendCustomMessage[0]?.message.details).toMatchObject({ answeredCount: 1, unansweredIds: ["cache"] });
      expect(fake.calls.sendCustomMessage[0]?.message.content).toContain("Answered 1 of 2; unanswered: cache");
    } finally { await service.dispose(); }
  });

  it("rejects unknown requests and invalid answers without recording an outcome", async () => {
    const { service, fake } = askService();
    try {
      await expect(service.submitAsk(sessionRef(SESSION_ID), "ask-unknown", { answers: [] })).rejects.toThrow("Unknown ask ID ask-unknown");
      await expect(service.cancelAsk(sessionRef(SESSION_ID), "ask-unknown")).rejects.toThrow("Unknown ask ID ask-unknown");
      await expect(service.submitAsk(sessionRef(SESSION_ID), "ask-1", { answers: [{ id: "nope", values: [] }] })).rejects.toThrow(AskUserValidationError);
      expect(fake.calls.sendCustomMessage).toEqual([]);
      await service.submitAsk(sessionRef(SESSION_ID), "ask-1", { answers: [] });
      expect(fake.calls.sendCustomMessage).toHaveLength(1);
    } finally { await service.dispose(); }
  });

  it("rejects malformed durable payloads before delivery", async () => {
    const { service, fake } = askService([{ type: "message", message: {
      role: "toolResult", toolName: "ask_user", isError: false, details: { ask: { askId: "ask-1", askedAt: ask.askedAt, questions: null } },
    } }]);
    try {
      await expect(service.cancelAsk(sessionRef(SESSION_ID), "ask-1")).rejects.toThrow("Malformed ask_user request ask-1");
      expect(fake.calls.sendCustomMessage).toEqual([]);
    } finally { await service.dispose(); }
  });

  it("records a late skip after an answer, and still accepts a later answer", async () => {
    const { service, fake, events } = askService();
    try {
      await service.submitAsk(sessionRef(SESSION_ID), "ask-1", { answers: [{ id: "db", values: ["pg"] }] });
      const response = await service.cancelAsk(sessionRef(SESSION_ID), "ask-1");
      expect(response.sessionId).toBe(SESSION_ID);
      expect(fake.calls.sendCustomMessage[1]).toMatchObject({
        message: { details: { reason: "cancelled", answeredCount: 0, unansweredIds: ["db"] } },
        options: { triggerTurn: true, deliverAs: "followUp" },
      });
      expect(fake.calls.sendCustomMessage[1]?.message.content).toContain("The user skipped these questions.");
      await service.submitAsk(sessionRef(SESSION_ID), "ask-1", { answers: [] });
      expect(fake.calls.sendCustomMessage).toHaveLength(3);
      expect(questionEvents(events)).toEqual([]);
    } finally { await service.dispose(); }
  });

  it.each([undefined, "followUp", "steer"] as const)("ordinary %s prompts never manufacture a cancellation outcome", async (behavior) => {
    const { service, fake, events } = askService();
    try {
      await service.status(sessionRef(SESSION_ID));
      fake.session.isStreaming = behavior !== undefined;
      await service.prompt(sessionRef(SESSION_ID), "Use DuckDB", behavior);
      const message = { role: "user", content: [{ type: "text", text: "Use DuckDB" }] };
      fake.emit({ type: "message_start", message });
      fake.emit({ type: "message_end", message });
      expect(fake.calls.prompt.map((call) => call.text)).toEqual(["Use DuckDB"]);
      expect(fake.calls.sendCustomMessage).toEqual([]);
      expect(questionEvents(events)).toEqual([]);
      await service.cancelAsk(sessionRef(SESSION_ID), "ask-1");
      expect(fake.calls.sendCustomMessage).toHaveLength(1);
    } finally { await service.dispose(); }
  });

  it("resolves idle requests from fresh history, but active runs from the live branch", async () => {
    const { service, fake, gateway } = askService();
    const diskAsk = { ...ask, questions: [{ id: "external", question: "An external question?", options: [] }] };
    const readBranch = vi.fn(() => Promise.resolve([{ type: "message", message: {
      role: "toolResult", toolName: "ask_user", isError: false, details: { ask: diskAsk },
    } }]));
    gateway.readBranch = readBranch;
    try {
      await expect(service.submitAsk(sessionRef(SESSION_ID), "ask-1", { answers: [{ id: "db", values: ["pg"] }] })).rejects.toThrow("Unknown question id db");
      await service.submitAsk(sessionRef(SESSION_ID), "ask-1", { answers: [{ id: "external", values: [], otherText: "Fresh disk answer" }] });
      expect(fake.calls.sendCustomMessage[0]?.message.details).toMatchObject({ questions: [{ question: diskAsk.questions[0] }] });
      readBranch.mockClear();
      fake.session.isStreaming = true;
      await service.submitAsk(sessionRef(SESSION_ID), "ask-1", { answers: [{ id: "db", values: ["pg"] }] });
      expect(fake.calls.sendCustomMessage[1]?.message.details).toMatchObject({ questions: [{ question: questions[0] }] });
      expect(readBranch).not.toHaveBeenCalled();
    } finally { await service.dispose(); }
  });

  it("uses the live active branch, not all entries from abandoned branches", async () => {
    const manager = SessionManager.inMemory("/workspace", { id: SESSION_ID });
    const rootId = manager.appendMessage({ role: "user", content: "Before the questions", timestamp: Date.now() });
    const resultId = appendRequest(manager);
    manager.branch(rootId);
    const { service, fake } = askService();
    fake.session.sessionManager = manager;
    try {
      await expect(service.submitAsk(sessionRef(SESSION_ID), "ask-1", { answers: [] })).rejects.toThrow("active session branch");
      manager.branch(resultId);
      await service.submitAsk(sessionRef(SESSION_ID), "ask-1", { answers: [] });
      expect(fake.calls.sendCustomMessage).toHaveLength(1);
    } finally { await service.dispose(); }
  });
});

// The durable-history invariant needs real JSONL and SDK tool/custom-message
// persistence. Only resource discovery and model transport are isolated here.
describe("durable questions across runtime/service restarts", () => {
  it("persists a terminating ask_user result, reopens it, and records repeated answers and late skips", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-web-durable-ask-"));
    const agentDir = join(directory, "agent");
    const sessionDir = join(directory, "sessions");
    const modelRuntime = await createTestModelRuntime();
    await modelRuntime.setRuntimeApiKey("anthropic", "isolated-test-key");
    const nativeSessions: AgentSession[] = [];
    const modelContexts: unknown[] = [];
    const createAgentRuntime: NonNullable<PiSessionServiceDependencies["createAgentRuntime"]> = async (_factory, options) => {
      if (!(options.sessionManager instanceof SessionManager)) throw new Error("Expected a real SessionManager");
      const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
      const resourceLoader = new DefaultResourceLoader({
        cwd: directory, agentDir, settingsManager,
        noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
        agentsFilesOverride: () => ({ agentsFiles: [] }),
      });
      await resourceLoader.reload();
      const { session } = await createAgentSession({
        cwd: directory, agentDir, sessionManager: options.sessionManager, settingsManager, resourceLoader, modelRuntime, model: testModel(),
        noTools: "builtin", customTools: [createAskUserToolDefinition({ createAskId: () => "persisted-ask", now: () => new Date(ask.askedAt) })],
      });
      session.setSessionName("Durable questions test");
      nativeSessions.push(session);
      session.agent.streamFunction = (_model, context) => {
        modelContexts.push(structuredClone(context.messages));
        const posting = modelContexts.length === 1;
        const message: AssistantMessage = {
          role: "assistant", content: posting
            ? [{ type: "toolCall", id: "ask-call", name: "ask_user", arguments: { questions } }]
            : [{ type: "text", text: "Reply received" }],
          api: "anthropic-messages", provider: "anthropic", model: testModel().id,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: posting ? "toolUse" : "stop", timestamp: Date.now(),
        };
        const stream = createAssistantMessageEventStream();
        stream.push({ type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message });
        stream.end(message);
        return stream;
      };
      const runtime: PiSessionRuntime = {
        cwd: directory, session, setRebindSession: () => undefined, fork: () => Promise.resolve({ cancelled: true }),
        dispose: () => { session.dispose(); return Promise.resolve(); },
      };
      return runtime;
    };
    const newService = () => {
      const events = new CapturingSessionEventHub();
      const service = new PiSessionService(events, {
        agentDir, modelRuntime, createAgentRuntime, archiveStore: emptyArchiveStore(), heartbeatIntervalMs: 60_000,
        sessionManager: createPiSessionManagerGateway({ agentDir, env: { PI_CODING_AGENT_SESSION_DIR: sessionDir } }),
      });
      return { service, events };
    };
    const first = newService();
    let reopened: ReturnType<typeof newService> | undefined;
    try {
      const started = await first.service.start(directory);
      const originalSession = nativeSessions[0];
      if (originalSession === undefined) throw new Error("Expected original SDK session");
      await originalSession.prompt("Ask me which database to use");
      expect(modelContexts).toHaveLength(1); // terminate skips the automatic follow-up.
      expect(await first.service.status(sessionRef(started.id, directory))).toMatchObject({ interventionRequired: true });
      expect((await first.service.list(directory)).find((entry) => entry.id === started.id)?.interventionRequired).toBe(true);
      const sessionFile = originalSession.sessionFile;
      if (sessionFile === undefined) throw new Error("Expected a durable session file");
      expect(SessionManager.open(sessionFile).getBranch().find((entry) => entry.type === "message" && entry.message.role === "toolResult"))
        .toMatchObject({ type: "message", message: {
          role: "toolResult", toolName: "ask_user", isError: false, details: { ask: { ...ask, askId: "persisted-ask" } },
        } });
      await first.service.dispose();

      reopened = newService();
      const ref = sessionRef(started.id, directory);
      expect((await reopened.service.list(directory)).find((entry) => entry.id === started.id)?.interventionRequired).toBe(true);
      await expect(reopened.service.submitAsk(ref, "persisted-ask", { answers: [{ id: "db", values: ["pg"] }] })).resolves.toMatchObject({ sessionId: started.id });
      await reopened.service.submitAsk(ref, "persisted-ask", { answers: [{ id: "db", values: [], otherText: "DuckDB" }] });
      await reopened.service.cancelAsk(ref, "persisted-ask");
      expect(await reopened.service.status(ref)).toMatchObject({ interventionRequired: false });
      expect((await reopened.service.list(directory)).find((entry) => entry.id === started.id)?.interventionRequired).toBe(false);
      expect(nativeSessions).toHaveLength(2);
      expect(modelContexts).toHaveLength(4);
      expect(JSON.stringify(modelContexts[1])).toContain("The user submitted answers to your questions.");
      expect(JSON.stringify(modelContexts[3])).toContain("The user skipped these questions.");
      const outcomes = SessionManager.open(sessionFile).getBranch().filter((entry): entry is CustomMessageEntry =>
        entry.type === "custom_message" && entry.customType === ASK_USER_ANSWERS_CUSTOM_TYPE);
      expect(outcomes.map((entry) => entry.details)).toMatchObject([
        { askId: "persisted-ask", reason: "submitted", questions: [{ question: questions[0], values: ["pg"] }] },
        { askId: "persisted-ask", reason: "submitted", questions: [{ otherText: "DuckDB" }] },
        { askId: "persisted-ask", reason: "cancelled", unansweredIds: ["db"] },
      ]);
      expect(outcomes.every((entry) => entry.display)).toBe(true);
      expect(questionEvents(reopened.events)).toEqual([]);
      const transcript = await reopened.service.messages(ref);
      const projectedOutcomes = transcript.messages.filter((message) => isRecord(message) && message["customType"] === ASK_USER_ANSWERS_CUSTOM_TYPE);
      expect(projectedOutcomes.at(-1)).toMatchObject({ customType: ASK_USER_ANSWERS_CUSTOM_TYPE, details: { reason: "cancelled" } });
    } finally {
      await first.service.dispose();
      await reopened?.service.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
