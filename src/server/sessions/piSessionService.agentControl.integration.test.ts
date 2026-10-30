import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "../../piSdk.js";
import { PiSessionService, type PiSessionRuntime } from "./piSessionService.js";
import {
  CapturingSessionEventHub, createTestModelRuntime, emptyArchiveStore, fakeRuntime,
  fakeSessionManager, sessionGateway, stubExtensionToolContext, testModel,
} from "./piSessionService.testSupport.js";
import { createSendSessionMessageToolDefinition } from "./sendSessionMessageTool.js";

function gate() {
  let resolve: () => void = () => { throw new Error("Gate not initialized"); };
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { reject(new Error(`Timed out waiting for ${label}`)); }, 3_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function assistant(text: string, stopReason: "stop" | "aborted" = "stop"): AssistantMessage {
  return {
    role: "assistant", api: "anthropic-messages", provider: "anthropic", model: testModel().id,
    content: [{ type: "text", text }], stopReason, timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    ...(stopReason === "aborted" ? { errorMessage: "Test transport aborted" } : {}),
  };
}

// Pi owns prompting, queues, abort, and settlement. Only the provider transport
// and the independently running parent are fake; service mutation receipts stay real.
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "pi-web-agent-control-"));
  const modelRuntime = await createTestModelRuntime();
  await modelRuntime.setRuntimeApiKey("anthropic", "isolated-test-key");
  const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: "off" });
  const loader = new DefaultResourceLoader({
    cwd: directory, agentDir: directory, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
    agentsFilesOverride: () => ({ agentsFiles: [] }),
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd: directory, agentDir: directory, sessionManager: SessionManager.inMemory(directory),
    settingsManager, resourceLoader: loader, modelRuntime, model: testModel(), thinkingLevel: "off", tools: [],
  });
  // The service identifies tracked runtimes by file even when the SDK journal
  // is in-memory. Supply only that host identity; no session file is written.
  const sessionFile = vi.spyOn(session, "sessionFile", "get").mockReturnValue(join(directory, "child.jsonl"));
  session.setSessionName("Integration child"); // Avoid unrelated title-generation provider requests.
  const parent = fakeRuntime("parent-1", {
    sessionManager: fakeSessionManager(directory),
    // Keep automatic delivery from consuming completions before we inspect them.
    isStreaming: true,
  });
  const childRuntime: PiSessionRuntime = {
    cwd: directory, session,
    setRebindSession: () => undefined, fork: () => Promise.resolve({ cancelled: true }),
    dispose: () => { session.dispose(); return Promise.resolve(); },
  };
  const runtimes = [parent.runtime, childRuntime];
  let runtimeIndex = 0;
  const createAgentRuntime = vi.fn(() => {
    const runtime = runtimes[runtimeIndex++];
    if (runtime === undefined) throw new Error("Unexpected replacement runtime");
    return Promise.resolve(runtime);
  });
  const service = new PiSessionService(new CapturingSessionEventHub(), {
    agentDir: directory, modelRuntime, sessionManager: sessionGateway([]), archiveStore: emptyArchiveStore(),
    createAgentRuntime,
    spawnTargets: { resolveSpawnTarget: () => Promise.resolve({ allowed: true, cwd: directory }) },
    messageTargets: { resolveSpawnTarget: () => Promise.resolve({ allowed: true, cwd: directory }) },
    heartbeatIntervalMs: 60_000,
  });
  const errors: unknown[] = [];
  await service.start(directory);
  await session.bindExtensions({ onError: (error) => errors.push(error) });

  const spawn = () => service.spawnSubsession({
    spawningCwd: directory, parentSessionId: parent.session.sessionId,
    parentSessionFile: parent.session.sessionFile, prompt: "Initial child task",
  });
  const stop = () => service.stopSubsession(parent.session.sessionId, session.sessionId, parent.session.sessionFile);
  const resume = (prompt: string) => service.resumeSubsession(parent.session.sessionId, session.sessionId, prompt, parent.session.sessionFile);
  const joinResults = () => service.joinSubsessions(parent.session.sessionId, parent.session.sessionFile);
  const sendTool = createSendSessionMessageToolDefinition(directory, { send: (input) => service.sendSessionMessage(input) });
  const send = (message: string) => {
    const params = { sessionId: session.sessionId, message, sendingSessionId: "forged-sender" };
    return sendTool.execute("send-message", params, undefined, undefined,
      stubExtensionToolContext({ sessionManager: { getSessionId: () => parent.session.sessionId } }));
  };

  async function settled() {
    await bounded(session.waitForIdle(), "native child idle");
    // Cross an event-loop boundary after native settlement so the service's
    // asynchronous prompt receipt and completion reconciliation can unwind.
    await bounded(new Promise<void>((resolve) => setImmediate(resolve)), "host receipt settlement");
  }

  return {
    directory, session, service, errors, createAgentRuntime, spawn, stop, resume, joinResults, send, settled,
    async dispose() {
      try {
        await bounded(service.dispose(), "service disposal");
      } finally {
        session.dispose();
        sessionFile.mockRestore();
        await rm(directory, { recursive: true, force: true });
      }
    },
  };
}

describe("agent control composed with native Pi sessions", () => {
  it("settles the host prompt receipt on stop so an immediate resume starts another native run", async () => {
    const f = await fixture();
    const entered = gate();
    const resumed = gate();
    let requests = 0;
    f.session.agent.streamFunction = (_model, _context, options) => {
      requests += 1;
      const stream = createAssistantMessageEventStream();
      if (requests === 1) {
        const signal = options?.signal;
        if (signal === undefined) throw new Error("Native run did not supply an abort signal");
        const finishAbort = () => {
          const message = assistant("", "aborted");
          stream.push({ type: "error", reason: "aborted", error: message });
          stream.end(message);
        };
        if (signal.aborted) finishAbort();
        else signal.addEventListener("abort", finishAbort, { once: true });
        entered.resolve();
      } else if (requests === 2) {
        const message = assistant("RESUMED_FINAL");
        stream.push({ type: "done", reason: "stop", message });
        stream.end(message);
        resumed.resolve();
      } else throw new Error("Unexpected provider request after resume");
      return stream;
    };
    try {
      await bounded(f.spawn(), "spawn acceptance");
      await bounded(entered.promise, "initial provider request");
      const stopped = await f.stop();
      expect(stopped).toMatchObject({ sessionId: f.session.sessionId, status: "idle" });
      // Deliberately no idle wait or event-loop drain between stop and resume:
      // native abort alone can finish before the host mutation receipt does.
      await expect(f.resume("Continue interrupted work")).resolves.toMatchObject({ status: "working" });
      await bounded(resumed.promise, "resumed provider request");
      await f.settled();
      expect(requests).toBe(2);
      expect(f.session.messages.at(-1)).toMatchObject({ content: [{ type: "text", text: "RESUMED_FINAL" }], stopReason: "stop" });
      expect(f.createAgentRuntime).toHaveBeenCalledTimes(2);
      expect(f.errors).toEqual([]);
    } finally {
      await f.dispose();
    }
  });

  it("records a fresh child completion for a subsequent resumed run in the same conversation", async () => {
    const f = await fixture();
    const entered = [gate(), gate()] as const;
    let requests = 0;
    f.session.agent.streamFunction = () => {
      const request = requests++;
      const entry = entered[request];
      if (entry === undefined) throw new Error("Unexpected extra provider request");
      const message = assistant(request === 0 ? "FIRST_FINAL" : "SECOND_FINAL");
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "done", reason: "stop", message });
      stream.end(message);
      entry.resolve();
      return stream;
    };
    try {
      await bounded(f.spawn(), "spawn acceptance");
      await bounded(entered[0].promise, "first run");
      await f.settled();
      const first = await f.joinResults();
      expect(first.completions).toHaveLength(1);
      expect(first.completions[0]).toMatchObject({ sessionId: f.session.sessionId, finalText: "FIRST_FINAL", status: "idle" });
      expect((await f.joinResults()).completions).toEqual([]);

      await expect(f.resume("Continue this conversation")).resolves.toMatchObject({ status: "working" });
      await bounded(entered[1].promise, "second run");
      await f.settled();
      const second = await f.joinResults();
      expect(second.completions).toHaveLength(1);
      expect(second.completions[0]).toMatchObject({ sessionId: f.session.sessionId, finalText: "SECOND_FINAL", status: "idle" });
      expect(second.completions[0]?.completionId).not.toBe(first.completions[0]?.completionId);
      expect((await f.joinResults()).completions).toEqual([]);
      expect(f.session.messages.filter((message) => message.role === "user")).toHaveLength(2);
      expect(f.createAgentRuntime).toHaveBeenCalledTimes(2);
      expect(f.errors).toEqual([]);
    } finally {
      await f.dispose();
    }
  });

  it.each(["idle", "working"] as const)("returns the message tool before a %s recipient finishes and delivers a content-only custom follow-up", async (state) => {
    const f = await fixture();
    const initialEntered = gate();
    const messageEntered = gate();
    const finishInitial = gate();
    const finishMessage = gate();
    const messageText = "  Investigate this follow-up independently.\n\nPreserve this body.  \n";
    const deliveredContent = `Message from session parent-1:\n\n${messageText}`;
    const details = { sendingSessionId: "parent-1" };
    const sendCustomMessage = vi.spyOn(f.session, "sendCustomMessage");
    let requests = 0;
    let messageInput: unknown;
    f.session.agent.streamFunction = (_model, context, options) => {
      const request = ++requests;
      if (request > 2) throw new Error("Duplicate message caused an extra provider request");
      const stream = createAssistantMessageEventStream();
      const release = request === 1 ? finishInitial : finishMessage;
      if (request === 1) initialEntered.resolve();
      else {
        messageInput = context.messages.at(-1);
        messageEntered.resolve();
      }
      const finish = (aborted: boolean) => {
        const message = assistant(aborted ? "" : request === 1 ? "INITIAL_FINAL" : "MESSAGE_FINAL", aborted ? "aborted" : "stop");
        if (aborted) stream.push({ type: "error", reason: "aborted", error: message });
        else stream.push({ type: "done", reason: "stop", message });
        stream.end(message);
      };
      let finished = false;
      const complete = (aborted: boolean) => {
        if (finished) return;
        finished = true;
        options?.signal?.removeEventListener("abort", abort);
        finish(aborted);
      };
      const abort = () => { complete(true); };
      if (options?.signal?.aborted === true) abort();
      else options?.signal?.addEventListener("abort", abort, { once: true });
      void release.promise.then(() => { complete(false); });
      return stream;
    };
    try {
      await bounded(f.spawn(), "spawn acceptance");
      await bounded(initialEntered.promise, "initial request");
      let firstCompletionId: string | undefined;
      if (state === "idle") {
        finishInitial.resolve();
        await f.settled();
        const first = await f.joinResults();
        expect(first.completions).toHaveLength(1);
        firstCompletionId = first.completions[0]?.completionId;
      }

      // The recipient cannot finish until we release finishMessage below. A
      // tool that awaits sendCustomMessage's full native run times out here.
      const result = await bounded(f.send(messageText), "sender tool acceptance before recipient completion");
      expect(result.details).toEqual({ sessionId: f.session.sessionId, delivery: state === "idle" ? "started" : "queued" });
      expect(JSON.stringify(result)).not.toContain("parent-1");
      if (state === "working") {
        expect(requests).toBe(1);
        finishInitial.resolve();
      }
      await bounded(messageEntered.promise, "custom message provider request");
      expect(f.session.isStreaming).toBe(true);
      expect(sendCustomMessage).toHaveBeenCalledExactlyOnceWith(
        { customType: "session.message", content: deliveredContent, display: true, details },
        { triggerTurn: true, deliverAs: "followUp" },
      );
      // The visible transcript and model context both retain sender provenance;
      // metadata alone would not reach the model. This grants no control authority.
      const custom = f.session.messages.filter((message) => message.role === "custom" && message.customType === "session.message");
      expect(custom).toHaveLength(1);
      expect(custom[0]).toEqual({ role: "custom", customType: "session.message", content: deliveredContent, display: true, details, timestamp: custom[0]?.timestamp });
      expect(messageInput).toMatchObject({ role: "user", content: [{ type: "text", text: deliveredContent }] });

      finishMessage.resolve();
      await f.settled();
      const completed = await f.joinResults();
      expect(completed.completions).toHaveLength(1);
      expect(completed.completions[0]).toMatchObject({ sessionId: f.session.sessionId, finalText: "MESSAGE_FINAL", status: "idle" });
      if (firstCompletionId !== undefined) expect(completed.completions[0]?.completionId).not.toBe(firstCompletionId);
      expect((await f.joinResults()).completions).toEqual([]);
      expect(requests).toBe(2);
      expect(f.errors).toEqual([]);
    } finally {
      finishInitial.resolve();
      finishMessage.resolve();
      sendCustomMessage.mockRestore();
      await f.dispose();
    }
  });
});
