import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  createAgentSessionFromServices, createAgentSessionServices, createEventBus,
  DefaultResourceLoader, SessionManager, SettingsManager,
  type AgentSession, type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { PiSessionEventConnections } from "./piSessionEventConnections.js";
import { PiSessionService } from "./piSessionService.js";
import {
  CapturingSessionEventHub, createTestModelRuntime, emptyArchiveStore,
  resolveSessionFileFromList, sessionGateway, testModel,
} from "./piSessionService.testSupport.js";

function assistant(text: string): AssistantMessage {
  return {
    role: "assistant", content: [{ type: "text", text }],
    api: "anthropic-messages", provider: testModel().provider, model: testModel().id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop", timestamp: 1,
  };
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

function gate() {
  return { entered: deferred(), release: deferred() };
}

type CommandOutcome = { result: unknown } | { error: string };
type CommandAction = (ctx: ExtensionCommandContext) => Promise<unknown>;

// Real resource loader, ExtensionRunner, persistent tree and AgentSessionRuntime.
// Only configuration/model access and extension-owned workflow controls are isolated.
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "pi-web-extension-commands-"));
  const agentDir = join(directory, "agent");
  const sessionDir = join(directory, "sessions");
  const controls: { input?: ReturnType<typeof gate>; tree?: ReturnType<typeof gate>; fork?: ReturnType<typeof gate>; cancelTree: boolean; cancelFork: boolean } = {
    cancelTree: false, cancelFork: false,
  };
  const cleanup: { service?: PiSessionService } = {};
  onTestFinished(async () => {
    controls.input?.release.resolve();
    controls.tree?.release.resolve();
    controls.fork?.release.resolve();
    try { await cleanup.service?.dispose(); }
    finally { await rm(directory, { recursive: true, force: true }); }
  });
  const manager = SessionManager.create(directory, sessionDir);
  manager.appendModelChange(testModel().provider, testModel().id);
  manager.appendThinkingLevelChange("off");
  manager.appendSessionInfo("Extension command regression");
  manager.appendMessage({ role: "user", content: "Initial question", timestamp: 1 });
  const earlier = manager.appendMessage(assistant("Earlier answer"));
  const draftText = "Edit this question\nwith its original text";
  const draft = manager.appendMessage({ role: "user", content: [{ type: "text", text: draftText }], timestamp: 2 });
  const latest = manager.appendMessage(assistant("Later answer"));
  const originalFile = manager.getSessionFile();
  if (originalFile === undefined) throw new Error("Fixture must have a persistent session file");

  const modelRuntime = await createTestModelRuntime();
  const modelCall = vi.fn(() => { throw new Error("Extension commands must not call a model"); });
  onTestFinished(() => { expect(modelCall).not.toHaveBeenCalled(); });
  const sessionEvents = new PiSessionEventConnections();
  const hub = new CapturingSessionEventHub();
  const starts: { id: string; generation: number; reason: string }[] = [];
  let generation = 0;
  let current: AgentSession | undefined;
  let pending: { action: CommandAction; complete: (outcome: CommandOutcome) => void } | undefined;
  const list = () => SessionManager.list(directory, sessionDir);
  const hosted = new PiSessionService(hub, {
    agentDir, modelRuntime, sessionEvents, archiveStore: emptyArchiveStore(), heartbeatIntervalMs: 60_000,
    sessionManager: {
      ...sessionGateway([]), create: () => manager, open: (path) => SessionManager.open(path, sessionDir),
      list, listAll: list, resolveSessionFile: resolveSessionFileFromList(list),
    },
    createRuntime: async ({ cwd, sessionManager, sessionStartEvent }) => {
      const bus = createEventBus();
      const services = await createAgentSessionServices({
        cwd, agentDir, modelRuntime,
        settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: "off" }),
        resourceLoaderOptions: {
          eventBus: bus, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
          agentsFilesOverride: () => ({ agentsFiles: [] }),
          extensionFactories: [(pi) => {
            const loaded = ++generation;
            pi.on("session_start", (event, ctx) => { starts.push({ id: ctx.sessionManager.getSessionId(), generation: loaded, reason: event.reason }); });
            pi.on("session_before_tree", async () => {
              const held = controls.tree;
              held?.entered.resolve();
              await held?.release.promise;
              return { cancel: controls.cancelTree };
            });
            pi.on("session_before_fork", async () => {
              const held = controls.fork;
              held?.entered.resolve();
              await held?.release.promise;
              return { cancel: controls.cancelFork };
            });
            // Hold a real hosted prompt receipt without starting a model run.
            pi.on("input", async () => {
              const held = controls.input;
              held?.entered.resolve();
              await held?.release.promise;
              return { action: "handled" };
            });
            pi.events.on("fixture:run-command", () => {
              pi.sendUserMessage("/tree-regression", { expandPromptTemplates: true });
            });
            pi.registerCommand("tree-regression", {
              handler: async (_args, ctx) => {
                const command = pending;
                if (command === undefined) throw new Error("Unexpected fixture command");
                // Keep only plain callbacks across fork/reload, never reuse a stale pi/ctx.
                try { command.complete({ result: await command.action(ctx) }); }
                catch (error) { command.complete({ error: error instanceof Error ? error.message : String(error) }); }
              },
            });
          }],
        },
      });
      expect(services.resourceLoader).toBeInstanceOf(DefaultResourceLoader);
      expect(services.resourceLoader.getExtensions().errors).toEqual([]);
      const result = await createAgentSessionFromServices({
        services, sessionManager, ...(sessionStartEvent === undefined ? {} : { sessionStartEvent }),
        model: testModel(), thinkingLevel: "off", noTools: "all",
      });
      result.session.agent.streamFunction = modelCall;
      sessionEvents.register(result.session, bus);
      current = result.session;
      return { ...result, services, diagnostics: services.diagnostics };
    },
  });
  cleanup.service = hosted;
  await hosted.start(directory);
  function session(): AgentSession {
    if (current === undefined) throw new Error("Fixture session has not started");
    return current;
  }
  function ref() { return { id: session().sessionId, cwd: directory }; }
  async function run(action: CommandAction, viaEvents = false): Promise<CommandOutcome> {
    const completion = deferred<CommandOutcome>();
    pending = { action, complete: completion.resolve };
    if (!viaEvents) {
      await expect(hosted.runCommand(ref(), "/tree-regression")).resolves.toEqual({ type: "done" });
      return completion.promise;
    }
    const connection = hosted.connectSessionEvents(ref(), new AbortController().signal);
    try {
      connection.emit("fixture:run-command", null);
      return await completion.promise;
    } finally { connection.close(); }
  }
  return { service: hosted, hub, manager, controls, session, ref, run, starts, earlier, draft, latest, draftText, originalFile };
}

describe("hosted ExtensionCommandContext actions with native Pi", () => {
  it("navigates real agent context through runCommand and pi.events -> sendUserMessage, publishing the draft on the original socket", async () => {
    const f = await fixture();
    const originalId = f.session().sessionId;
    const entries = structuredClone(f.manager.getEntries());
    expect(f.session().messages).toContainEqual(assistant("Later answer"));

    await expect(f.run((ctx) => ctx.navigateTree(f.earlier))).resolves.toEqual({ result: { cancelled: false } });
    expect(f.manager.getLeafId()).toBe(f.earlier);
    expect(f.session().agent.state.messages).toEqual(f.manager.buildSessionContext().messages);
    expect(f.session().messages).not.toContainEqual(assistant("Later answer"));
    expect(f.hub.sessionEvents.filter(({ event }) => event.type === "session.tree.navigated")).toEqual([
      { sessionId: originalId, event: { type: "session.tree.navigated", result: { cancelled: false } } },
    ]);

    await expect(f.run((ctx) => ctx.navigateTree(f.draft), true)).resolves.toEqual({ result: { cancelled: false } });
    expect(f.manager.getLeafId()).toBe(f.earlier);
    expect(f.session().agent.state.messages).toEqual(f.manager.buildSessionContext().messages);
    expect(f.session().messages).not.toContainEqual(expect.objectContaining({ role: "user", content: [{ type: "text", text: f.draftText }] }));
    expect(f.hub.sessionEvents.filter(({ event }) => event.type === "session.tree.navigated").at(-1)).toEqual({
      sessionId: originalId, event: { type: "session.tree.navigated", result: { cancelled: false, editorText: f.draftText } },
    });
    expect(f.manager.getEntries()).toEqual(entries);
    expect(f.session().sessionId).toBe(originalId);
    expect(f.service.activeCount()).toBe(1);
  });

  it.each(["before", "at"] as const)("forks %s a user entry with fresh withSession bindings and leaves the original file untouched", async (position) => {
    const f = await fixture();
    const original = f.session();
    const originalBytes = await readFile(f.originalFile, "utf8");
    const originalEntries = structuredClone(original.sessionManager.getEntries());
    let freshId: string | undefined;
    await expect(f.run((ctx) => ctx.fork(f.draft, {
      position,
      withSession: async (fresh) => {
        expect(fresh === ctx).toBe(false);
        freshId = fresh.sessionManager.getSessionId();
        expect(freshId).not.toBe(original.sessionId);
        const branch = fresh.sessionManager.getBranch().map((entry) => entry.id);
        expect(branch).toContain(f.earlier);
        if (position === "before") expect(branch).not.toContain(f.draft);
        else expect(branch).toContain(f.draft);
        expect(() => ctx.sessionManager.getSessionId()).toThrow("stale");
        await fresh.sendMessage({ customType: "fork-proof", content: "Fresh fork context", display: true });
      },
    }))).resolves.toEqual({ result: { cancelled: false } });
    const forked = f.session();
    expect(forked.sessionId).toBe(freshId);
    expect(forked.sessionFile).not.toBe(f.originalFile);
    expect(forked.sessionManager.getHeader()?.parentSession).toBe(f.originalFile);
    expect(forked.messages).toContainEqual(expect.objectContaining({ role: "custom", customType: "fork-proof", content: "Fresh fork context" }));
    const draftMessage = { role: "user", content: [{ type: "text", text: f.draftText }], timestamp: 2 };
    if (position === "before") expect(forked.messages).not.toContainEqual(draftMessage);
    else expect(forked.messages).toContainEqual(draftMessage);
    expect(forked.messages).not.toContainEqual(assistant("Later answer"));
    expect(forked.agent.state.messages).toEqual(forked.sessionManager.buildSessionContext().messages);
    expect(await readFile(f.originalFile, "utf8")).toBe(originalBytes);
    expect(original.sessionManager.getEntries()).toEqual(originalEntries);
    expect(original.sessionManager.getLeafId()).toBe(f.latest);
    const forkEvents = f.hub.sessionEvents.filter(({ event }) => event.type === "session.tree.forked");
    expect(forkEvents).toHaveLength(1);
    const [forkEvent] = forkEvents;
    expect(forkEvent?.sessionId).toBe(original.sessionId);
    if (forkEvent?.event.type !== "session.tree.forked") throw new Error("Missing fork result event");
    expect(forkEvent.event.result).toMatchObject({
      cancelled: false, session: { id: freshId, path: forked.sessionFile, parentSessionPath: f.originalFile },
    });
    if (position === "before") expect(forkEvent.event.result).toHaveProperty("promptDraft", f.draftText);
    else expect(forkEvent.event.result).not.toHaveProperty("promptDraft");
    expect(f.service.activeCount()).toBe(1);
    // Real setRebindSession installs working command actions on the replacement.
    await expect(f.run((ctx) => ctx.navigateTree(f.earlier))).resolves.toEqual({ result: { cancelled: false } });
    expect(forked.sessionManager.getLeafId()).toBe(f.earlier);
  });

  it("coalesces nested replacement controls into the final identity and draft on the original channel", async () => {
    const f = await fixture();
    const originalId = f.session().sessionId;
    let firstId: string | undefined;
    let finalId: string | undefined;
    await expect(f.run((ctx) => ctx.fork(f.draft, {
      position: "at",
      withSession: async (fresh) => {
        firstId = fresh.sessionManager.getSessionId();
        await fresh.fork(f.draft, {
          position: "at",
          withSession: async (next) => {
            finalId = next.sessionManager.getSessionId();
            await next.navigateTree(f.draft);
          },
        });
      },
    }))).resolves.toEqual({ result: { cancelled: false } });
    expect(finalId).not.toBe(firstId);
    expect(f.session().sessionId).toBe(finalId);
    expect(f.session().sessionManager.getLeafId()).toBe(f.earlier);
    expect(f.hub.sessionEvents.filter(({ event }) => event.type === "session.tree.navigated")).toEqual([]);
    const events = f.hub.sessionEvents.filter(({ event }) => event.type === "session.tree.forked");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ sessionId: originalId,
      event: { result: { cancelled: false, session: { id: finalId }, promptDraft: f.draftText } },
    });
  });

  it("hands off a replacement before waiting for its browser dialog and follows later callback navigation", async () => {
    const f = await fixture();
    const originalId = f.session().sessionId;
    let accepted: boolean | undefined;
    const operation = f.run((ctx) => ctx.fork(f.draft, {
      position: "at",
      withSession: async (fresh) => {
        accepted = await fresh.ui.confirm("Continue fork?", "Confirm the replacement workflow");
        await fresh.navigateTree(f.draft);
      },
    }));
    await vi.waitFor(() => {
      expect(f.hub.sessionEvents.some(({ sessionId, event }) => sessionId === originalId && event.type === "session.tree.forked")).toBe(true);
    });
    const status = await f.service.status(f.ref());
    const dialog = status.pendingDialogs?.[0];
    if (dialog === undefined) throw new Error("Replacement dialog must be recoverable from its announced session");
    expect(dialog.title).toBe("Continue fork?");
    await f.service.answerDialog(f.ref(), dialog.dialogId, true);
    await expect(operation).resolves.toEqual({ result: { cancelled: false } });
    expect(accepted).toBe(true);
    const events = f.hub.sessionEvents.filter(({ event }) => event.type === "session.tree.forked");
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ sessionId: f.session().sessionId,
      event: { result: { session: { id: f.session().sessionId }, promptDraft: f.draftText } },
    });
  });

  it("publishes detached forks that start inside a scope but commit after it expires", async () => {
    const f = await fixture();
    const held = gate();
    let late: Promise<unknown> | undefined;
    let firstId: string | undefined;
    await expect(f.run((ctx) => ctx.fork(f.draft, {
      position: "at",
      withSession: async (fresh) => {
        firstId = fresh.sessionManager.getSessionId();
        f.controls.fork = held;
        late = fresh.fork(f.draft, { position: "at" });
        await held.entered.promise;
      },
    }))).resolves.toEqual({ result: { cancelled: false } });
    expect(f.hub.sessionEvents.filter(({ event }) => event.type === "session.tree.forked")).toHaveLength(1);
    held.release.resolve();
    await late;
    expect(f.session().sessionId).not.toBe(firstId);
    const events = f.hub.sessionEvents.filter(({ event }) => event.type === "session.tree.forked");
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ sessionId: firstId, event: { result: { session: { id: f.session().sessionId } } } });
  });

  it("expires replacement event coalescing before detached callback work runs", async () => {
    const f = await fixture();
    const released = deferred();
    let late: Promise<unknown> | undefined;
    await expect(f.run((ctx) => ctx.fork(f.draft, {
      position: "at",
      withSession: (fresh) => {
        late = released.promise.then(() => fresh.navigateTree(f.earlier));
        return Promise.resolve();
      },
    }))).resolves.toEqual({ result: { cancelled: false } });
    const forkedId = f.session().sessionId;
    released.resolve();
    await late;
    expect(f.session().sessionManager.getLeafId()).toBe(f.earlier);
    expect(f.hub.sessionEvents.filter(({ event }) => event.type === "session.tree.navigated")).toEqual([
      { sessionId: forkedId, event: { type: "session.tree.navigated", result: { cancelled: false } } },
    ]);
  });

  it("publishes the committed fork and callback failure even when post-replacement code throws", async () => {
    const f = await fixture();
    const originalId = f.session().sessionId;
    const bytes = await readFile(f.originalFile, "utf8");
    await expect(f.run((ctx) => ctx.fork(f.draft, {
      withSession: () => Promise.reject(new Error("Post-fork workflow failed")),
    }))).resolves.toEqual({ error: "Post-fork workflow failed" });
    expect(f.session().sessionId).not.toBe(originalId);
    expect(await readFile(f.originalFile, "utf8")).toBe(bytes);
    const events = f.hub.sessionEvents.filter(({ event }) => event.type === "session.tree.forked");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ sessionId: originalId,
      event: { result: { cancelled: false, session: { id: f.session().sessionId }, promptDraft: f.draftText }, error: "Post-fork workflow failed" },
    });
  });

  it("does not exempt an unrelated hosted mutation and reports native navigation/fork cancellation truthfully", async () => {
    const f = await fixture();
    const held = gate();
    f.controls.input = held;
    await f.service.prompt(f.ref(), "Held input consumed by the extension");
    await held.entered.promise;
    await expect(f.run((ctx) => ctx.navigateTree(f.earlier))).resolves.toEqual({ error: "Stop current session activity before navigating the session tree" });
    await expect(f.run((ctx) => ctx.fork(f.draft))).resolves.toEqual({ error: "Stop current session activity before forking the session tree" });
    expect(f.manager.getLeafId()).toBe(f.latest);
    expect(f.service.activeCount()).toBe(1);
    held.release.resolve();
    await vi.waitFor(async () => { expect(await f.service.runCommand(f.ref(), "/tree")).toMatchObject({ type: "tree" }); });

    f.controls.cancelTree = true;
    f.controls.cancelFork = true;
    await expect(f.run((ctx) => ctx.navigateTree(f.earlier))).resolves.toEqual({ result: { cancelled: true } });
    await expect(f.run((ctx) => ctx.fork(f.draft))).resolves.toEqual({ result: { cancelled: true } });
    expect(f.manager.getLeafId()).toBe(f.latest);
    expect(f.starts).toHaveLength(1);
    expect(f.hub.sessionEvents.filter(({ event }) => event.type === "session.tree.navigated" || event.type === "session.tree.forked")).toEqual([]);
    f.controls.cancelTree = false;
    await expect(f.run((ctx) => ctx.navigateTree(f.earlier))).resolves.toEqual({ result: { cancelled: false } });
    expect(f.manager.getLeafId()).toBe(f.earlier);
  });

  it("waits for native tree work, reloads actual extensions, and explicitly rejects unsupported identity changes", async () => {
    const f = await fixture();
    const held = gate();
    f.controls.tree = held;
    const navigation = f.service.navigateTree(f.ref(), { targetId: f.earlier, expectedLeafId: f.latest, summary: { mode: "none" } });
    await held.entered.promise;
    const waiting = deferred();
    let idle = false;
    const command = f.run(async (ctx) => {
      const done = ctx.waitForIdle();
      waiting.resolve();
      await done;
      idle = true;
    }, true);
    await waiting.promise;
    expect(idle).toBe(false);
    held.release.resolve();
    await expect(navigation).resolves.toEqual({ cancelled: false });
    await expect(command).resolves.toEqual({ result: undefined });
    expect(idle).toBe(true);
    delete f.controls.tree;

    const originalId = f.session().sessionId;
    await expect(f.run((ctx) => ctx.reload())).resolves.toEqual({ result: undefined });
    expect(f.starts).toEqual([
      { id: originalId, generation: 1, reason: "startup" },
      { id: originalId, generation: 2, reason: "reload" },
    ]);
    await expect(f.run((ctx) => ctx.navigateTree(f.latest))).resolves.toEqual({ result: { cancelled: false } });
    expect(f.manager.getLeafId()).toBe(f.latest);
    await expect(f.run((ctx) => ctx.newSession())).resolves.toHaveProperty("error", expect.stringContaining("ctx.newSession() is not supported in PI WEB"));
    await expect(f.run((ctx) => ctx.switchSession(f.originalFile))).resolves.toHaveProperty("error", expect.stringContaining("ctx.switchSession() is not supported in PI WEB"));
    expect(f.session().sessionId).toBe(originalId);
    expect(f.service.activeCount()).toBe(1);
  });
});
