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
async function fixture(options: { rootUser?: boolean; notificationsDisabled?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "pi-web-extension-commands-"));
  const agentDir = join(directory, "agent");
  const sessionDir = join(directory, "sessions");
  const controls: { input?: ReturnType<typeof gate>; tree?: ReturnType<typeof gate>; fork?: ReturnType<typeof gate>; cancelTree: boolean; cancelFork: boolean; forkStartupDialog: boolean; reloadStartupDialog: boolean } = {
    cancelTree: false, cancelFork: false, forkStartupDialog: false, reloadStartupDialog: false,
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
  if (options.rootUser !== true) {
    manager.appendModelChange(testModel().provider, testModel().id);
    manager.appendThinkingLevelChange("off");
    manager.appendSessionInfo("Extension command regression");
    manager.appendMessage({ role: "user", content: "Initial question", timestamp: 1 });
  }
  const draftText = "Edit this question\nwith its original text";
  const earlier = options.rootUser === true ? undefined : manager.appendMessage(assistant("Earlier answer"));
  const draft = manager.appendMessage({ role: "user", content: [{ type: "text", text: draftText }], timestamp: 2 });
  const latest = options.rootUser === true ? draft : manager.appendMessage(assistant("Later answer"));
  const originalFile = manager.getSessionFile();
  if (originalFile === undefined) throw new Error("Fixture must have a persistent session file");

  const modelRuntime = await createTestModelRuntime();
  const modelCall = vi.fn(() => { throw new Error("Extension commands must not call a model"); });
  onTestFinished(() => { expect(modelCall).not.toHaveBeenCalled(); });
  const sessionEvents = new PiSessionEventConnections();
  // No realtime subscriber: discovery, dialogs and drafts must work by reads alone.
  const hub = new CapturingSessionEventHub();
  const addSocket = vi.spyOn(hub, "add");
  const addGlobalSocket = vi.spyOn(hub, "addGlobal");
  onTestFinished(() => {
    expect(addSocket).not.toHaveBeenCalled();
    expect(addGlobalSocket).not.toHaveBeenCalled();
  });
  const starts: { id: string; generation: number; reason: string }[] = [];
  const startupDialogs: { id: string; announcedBeforeStart: boolean; accepted?: boolean }[] = [];
  const reloadDialogs: Promise<boolean>[] = [];
  let archived = options.notificationsDisabled === true;
  let generation = 0;
  let current: AgentSession | undefined;
  let pending: { action: CommandAction; complete: (outcome: CommandOutcome) => void } | undefined;
  const list = () => SessionManager.list(directory, sessionDir);
  const hosted = new PiSessionService(hub, {
    agentDir, modelRuntime, sessionEvents, heartbeatIntervalMs: 60_000,
    archiveStore: {
      ...emptyArchiveStore(),
      get: () => Promise.resolve(archived ? { sessionId: manager.getSessionId(), cwd: directory, archivedAt: "2026-02-01T10:00:00.000Z", archivePath: originalFile } : undefined),
    },
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
            pi.on("session_start", async (event, ctx) => {
              const id = ctx.sessionManager.getSessionId();
              starts.push({ id, generation: loaded, reason: event.reason });
              if (event.reason === "fork" && controls.forkStartupDialog) {
                const dialog: (typeof startupDialogs)[number] = { id, announcedBeforeStart: hub.globalEvents.some((item) => item.type === "session.created" && item.session.id === id) };
                startupDialogs.push(dialog);
                dialog.accepted = await ctx.ui.confirm("Start this fork?", "Answer when a client joins later");
              }
              if (event.reason === "reload" && controls.reloadStartupDialog) {
                reloadDialogs.push(ctx.ui.confirm("Start after reload?", "Keep this replacement dialog answerable"));
              }
            });
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
  if (archived) {
    // Exercise the notification-disabled archive read path, then an external restore.
    await hosted.status({ id: manager.getSessionId(), cwd: directory });
    archived = false;
  } else {
    await hosted.start(directory);
  }
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
  return { service: hosted, hub, manager, controls, session, ref, run, starts, startupDialogs, reloadDialogs, diskList: list, earlier: earlier ?? draft, draft, latest, draftText, originalFile };
}

describe("hosted ExtensionCommandContext actions with native Pi", () => {
  it("navigates real agent context through runCommand and pi.events -> sendUserMessage, retaining drafts for later status reads", async () => {
    const f = await fixture();
    const originalId = f.session().sessionId;
    const entries = structuredClone(f.manager.getEntries());
    expect(f.session().messages).toContainEqual(assistant("Later answer"));

    await expect(f.run((ctx) => ctx.navigateTree(f.earlier))).resolves.toEqual({ result: { cancelled: false } });
    expect(f.manager.getLeafId()).toBe(f.earlier);
    expect(f.session().agent.state.messages).toEqual(f.manager.buildSessionContext().messages);
    expect(f.session().messages).not.toContainEqual(assistant("Later answer"));
    expect(f.hub.sessionEvents.filter(({ event }) => event.type === "session.tree.changed")).toEqual([
      { sessionId: originalId, event: { type: "session.tree.changed" } },
    ]);
    expect(await f.service.status(f.ref())).not.toHaveProperty("suggestedInput");

    await expect(f.run((ctx) => ctx.navigateTree(f.draft), true)).resolves.toEqual({ result: { cancelled: false } });
    expect(f.manager.getLeafId()).toBe(f.earlier);
    expect(f.session().agent.state.messages).toEqual(f.manager.buildSessionContext().messages);
    expect(f.session().messages).not.toContainEqual(expect.objectContaining({ role: "user", content: [{ type: "text", text: f.draftText }] }));
    expect(f.hub.sessionEvents.filter(({ event }) => event.type === "session.tree.changed")).toEqual([
      { sessionId: originalId, event: { type: "session.tree.changed" } },
      { sessionId: originalId, event: { type: "session.tree.changed" } },
    ]);
    expect(await f.service.status(f.ref())).toHaveProperty("suggestedInput", f.draftText);
    expect((await f.service.transcriptSnapshot(f.ref())).status).toHaveProperty("suggestedInput", f.draftText);
    expect(await f.service.runCommand(f.ref(), "/tree")).toMatchObject({ type: "tree", tree: { activeLeafId: f.earlier } });
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
        expect(fresh.sessionManager.getSessionName()).toBe("Extension command regression — Fork 1");
        expect(await f.service.list(f.ref().cwd)).toContainEqual(expect.objectContaining({ id: freshId }));
        const status = await f.service.status(f.ref());
        if (position === "before") expect(status).toHaveProperty("suggestedInput", f.draftText);
        else expect(status).not.toHaveProperty("suggestedInput");
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
    expect(f.hub.sessionEvents.filter(({ event }) => event.type === "session.tree.changed")).toEqual([
      { sessionId: original.sessionId, event: { type: "session.tree.changed" } },
    ]);
    expect(await f.service.list(f.ref().cwd)).toContainEqual(expect.objectContaining({
      id: freshId, path: forked.sessionFile, parentSessionPath: f.originalFile,
      name: "Extension command regression — Fork 1",
    }));
    const status = await f.service.status(f.ref());
    if (position === "before") expect(status).toHaveProperty("suggestedInput", f.draftText);
    else expect(status).not.toHaveProperty("suggestedInput");
    expect(f.service.activeCount()).toBe(1);
    // Real setRebindSession installs working command actions on the replacement.
    await expect(f.run((ctx) => ctx.navigateTree(f.earlier))).resolves.toEqual({ result: { cancelled: false } });
    expect(forked.sessionManager.getLeafId()).toBe(f.earlier);
  });

  it("makes every nested fork discoverable and retains the current tree and latest suggestion without clients", async () => {
    const f = await fixture();
    const originalId = f.session().sessionId;
    let firstId: string | undefined;
    let finalId: string | undefined;
    await expect(f.run((ctx) => ctx.fork(f.draft, {
      position: "at",
      withSession: async (fresh) => {
        firstId = fresh.sessionManager.getSessionId();
        expect(fresh.sessionManager.getSessionName()).toBe("Extension command regression — Fork 1");
        await fresh.fork(f.draft, {
          position: "at",
          withSession: async (next) => {
            finalId = next.sessionManager.getSessionId();
            expect(next.sessionManager.getSessionName()).toBe("Extension command regression — Fork 2");
            expect(() => fresh.sessionManager.getLeafId()).toThrow("stale");
            await next.navigateTree(f.draft);
          },
        });
      },
    }))).resolves.toEqual({ result: { cancelled: false } });
    expect(finalId).not.toBe(firstId);
    expect(f.session().sessionId).toBe(finalId);
    const discovered = await f.service.list(f.ref().cwd);
    expect(discovered.map(({ id }) => id)).toEqual(expect.arrayContaining([originalId, firstId, finalId]));
    expect(new Set(discovered.map(({ id }) => id)).size).toBe(discovered.length);
    expect(await f.service.runCommand(f.ref(), "/tree")).toMatchObject({ type: "tree", tree: { activeLeafId: f.earlier } });
    expect(await f.service.status(f.ref())).toHaveProperty("suggestedInput", f.draftText);
    expect(f.session().agent.state.messages).toEqual(f.session().sessionManager.buildSessionContext().messages);
    expect((await f.service.messages(f.ref())).messages).not.toContainEqual(expect.objectContaining({ role: "user", content: [{ type: "text", text: f.draftText }] }));
    expect(f.hub.sessionEvents.filter(({ event }) => event.type === "session.tree.changed")).toEqual([
      { sessionId: originalId, event: { type: "session.tree.changed" } },
      { sessionId: firstId, event: { type: "session.tree.changed" } },
      { sessionId: finalId, event: { type: "session.tree.changed" } },
    ]);
    expect(f.service.activeCount()).toBe(1);
  });

  it("discovers an unpersisted fork before the root user entry while session_start waits for a delayed client, without a handoff", async () => {
    const f = await fixture({ rootUser: true });
    const originalId = f.session().sessionId;
    const cwd = f.ref().cwd;
    // A metadata entry before this user would take the persisted-branch SDK path instead.
    expect(f.manager.getEntries()[0]).toMatchObject({ id: f.draft, parentId: null, type: "message", message: { role: "user" } });
    f.controls.forkStartupDialog = true;
    let accepted: boolean | undefined;
    let settled = false;
    const operation = f.run((ctx) => ctx.fork(f.draft, {
      withSession: async (fresh) => {
        expect(fresh.sessionManager.getSessionName()).toContain("— Fork 1");
        expect(() => ctx.sessionManager.getLeafId()).toThrow("stale");
        accepted = await fresh.ui.confirm("Continue fork?", "Confirm the replacement workflow");
      },
    })).then((outcome) => { settled = true; return outcome; });

    // A client arrives after the operation has parked. It uses only list/status/answer APIs.
    const discovered = await vi.waitFor(async () => {
      const forked = (await f.service.list(cwd)).find(({ id }) => id !== originalId);
      if (forked === undefined) throw new Error("Fork is not yet discoverable");
      return forked;
    });
    const forkRef = { id: discovered.id, cwd: discovered.cwd };
    const startup = await vi.waitFor(async () => {
      const dialog = (await f.service.status(forkRef)).pendingDialogs?.[0];
      if (dialog?.title !== "Start this fork?") throw new Error("Missing recoverable session_start dialog");
      return dialog;
    });
    expect(f.startupDialogs).toEqual([{ id: discovered.id, announcedBeforeStart: true }]);
    expect((await f.diskList()).map(({ id }) => id)).not.toContain(discovered.id);
    await expect(readFile(discovered.path, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(settled).toBe(false);
    expect(f.hub.sessionEvents.filter(({ event }) => event.type === "session.tree.changed")).toEqual([]);
    expect(await f.service.status(forkRef)).toMatchObject({ sessionId: discovered.id, persisted: false });
    expect(f.starts).toHaveLength(2);
    await f.service.answerDialog(forkRef, startup.dialogId, true);

    const callback = await vi.waitFor(async () => {
      const dialog = (await f.service.status(forkRef)).pendingDialogs?.[0];
      if (dialog?.title !== "Continue fork?") throw new Error("Callback dialog is not yet open");
      return dialog;
    });
    expect(f.startupDialogs[0]?.accepted).toBe(true);
    expect(settled).toBe(false);
    expect(await f.service.status(forkRef)).toHaveProperty("suggestedInput", f.draftText);
    await f.service.answerDialog(forkRef, callback.dialogId, true);
    await expect(operation).resolves.toEqual({ result: { cancelled: false } });
    expect(accepted).toBe(true);
    expect(await f.service.status(forkRef)).toMatchObject({ sessionId: discovered.id, persisted: false, suggestedInput: f.draftText });
    expect((await f.service.status(forkRef)).pendingDialogs ?? []).toEqual([]);
    expect(await f.service.list(forkRef.cwd)).toContainEqual(expect.objectContaining({ id: discovered.id }));
    expect((await f.diskList()).map(({ id }) => id)).not.toContain(discovered.id);
    expect(f.starts).toHaveLength(2); // Reads did not create a second runtime.
    expect(f.session().sessionManager.getEntries()).not.toContainEqual(expect.objectContaining({ id: f.draft }));
    expect((await f.service.messages(forkRef)).messages).toEqual([]);
    expect(f.service.activeCount()).toBe(1);
  });

  it("keeps detached forks discoverable when they commit after their initiating callback returns", async () => {
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
    expect(await f.service.list(f.ref().cwd)).toContainEqual(expect.objectContaining({ id: firstId }));
    held.release.resolve();
    await late;
    expect(f.session().sessionId).not.toBe(firstId);
    expect((await f.service.list(f.ref().cwd)).map(({ id }) => id)).toEqual(expect.arrayContaining([firstId, f.session().sessionId]));
    expect(f.hub.sessionEvents.filter(({ event }) => event.type === "session.tree.changed")).toEqual([
      { sessionId: f.manager.getSessionId(), event: { type: "session.tree.changed" } },
      { sessionId: firstId, event: { type: "session.tree.changed" } },
    ]);
  });

  it("retains tree and suggestion changes from a fresh callback after the originating fork resolves", async () => {
    const f = await fixture();
    const released = deferred();
    let late: Promise<unknown> | undefined;
    await expect(f.run((ctx) => ctx.fork(f.draft, {
      position: "at",
      withSession: (fresh) => {
        late = released.promise.then(() => fresh.navigateTree(f.draft));
        return Promise.resolve();
      },
    }))).resolves.toEqual({ result: { cancelled: false } });
    const forkedId = f.session().sessionId;
    released.resolve();
    await late;
    expect(f.session().sessionManager.getLeafId()).toBe(f.earlier);
    expect(await f.service.status(f.ref())).toHaveProperty("suggestedInput", f.draftText);
    expect(await f.service.runCommand(f.ref(), "/tree")).toMatchObject({ type: "tree", tree: { activeLeafId: f.earlier } });
    expect(f.hub.sessionEvents.filter(({ event }) => event.type === "session.tree.changed")).toEqual([
      { sessionId: f.manager.getSessionId(), event: { type: "session.tree.changed" } },
      { sessionId: forkedId, event: { type: "session.tree.changed" } },
    ]);
  });

  it.each([false, true])("retains committed forks and reports callback failure in the current recoverable inbox (nested=%s)", async (nested) => {
    const f = await fixture();
    const originalId = f.session().sessionId;
    const bytes = await readFile(f.originalFile, "utf8");
    let firstId: string | undefined;
    await expect(f.run((ctx) => ctx.fork(f.draft, {
      position: nested ? "at" : "before",
      withSession: async (fresh) => {
        firstId = fresh.sessionManager.getSessionId();
        if (nested) await fresh.fork(f.draft);
        throw new Error("Post-fork workflow failed");
      },
    }))).resolves.toEqual({ error: "Post-fork workflow failed" });
    const currentId = f.session().sessionId;
    expect(currentId).not.toBe(originalId);
    if (nested) expect(currentId).not.toBe(firstId);
    expect(await readFile(f.originalFile, "utf8")).toBe(bytes);
    expect((await f.service.list(f.ref().cwd)).map(({ id }) => id)).toEqual(expect.arrayContaining([originalId, firstId, currentId]));
    expect(await f.service.status(f.ref())).toHaveProperty("suggestedInput", f.draftText);
    const tree = await f.service.runCommand(f.ref(), "/tree");
    expect(tree).toMatchObject({ type: "tree", tree: { activeLeafId: f.session().sessionManager.getLeafId() } });
    if (tree.type !== "tree") throw new Error("Committed fork tree is unavailable");
    expect(tree.tree.activePathIds).toContain(f.earlier);
    expect(tree.tree.nodes.map(({ id }) => id)).not.toContain(f.draft);
    const inbox = f.service.notificationInbox(f.ref());
    expect(inbox.summary).toMatchObject({ sessionId: currentId, retainedCount: 1, highestSeverity: "error" });
    expect(inbox.notifications).toEqual([expect.objectContaining({ message: "Post-fork workflow failed", severity: "error" })]);
    expect(f.service.notificationCatalog().sessions).toEqual([
      expect.objectContaining({ sessionId: currentId, retainedCount: 1, highestSeverity: "error" }),
    ]);
    expect(f.hub.sessionEvents.filter(({ event }) => event.type === "session.error")).toEqual([
      { sessionId: currentId, event: { type: "session.error", message: "Post-fork workflow failed" } },
    ]);
    expect(f.hub.sessionEvents.map(({ event }) => event.type)).not.toContain("session.tree.forked");
    expect(f.service.activeCount()).toBe(1);
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
    const withSession = vi.fn(() => Promise.resolve());
    await expect(f.run((ctx) => ctx.navigateTree(f.earlier))).resolves.toEqual({ result: { cancelled: true } });
    await expect(f.run((ctx) => ctx.fork(f.draft, { withSession }))).resolves.toEqual({ result: { cancelled: true } });
    expect(withSession).not.toHaveBeenCalled();
    expect(f.manager.getLeafId()).toBe(f.latest);
    expect(f.starts).toHaveLength(1);
    expect(f.hub.sessionEvents.filter(({ event }) => event.type === "session.tree.changed")).toEqual([]);
    expect(f.hub.globalEvents.filter((event) => event.type === "session.created")).toHaveLength(1);
    expect(await f.service.status(f.ref())).not.toHaveProperty("suggestedInput");
    f.controls.cancelTree = false;
    await expect(f.run((ctx) => ctx.navigateTree(f.earlier))).resolves.toEqual({ result: { cancelled: false } });
    expect(f.manager.getLeafId()).toBe(f.earlier);
  });

  it.each([false, true])("settles obsolete reload dialogs but retains replacement session_start dialogs (notificationsDisabled=%s)", async (notificationsDisabled) => {
    const f = await fixture({ notificationsDisabled });
    const ctx = f.session().extensionRunner.createContext();
    const confirm = ctx.ui.confirm("Old confirm?", "From the obsolete runner");
    const input = ctx.ui.input("Old input?");
    const oldDialogs = (await f.service.status(f.ref())).pendingDialogs ?? [];
    expect(oldDialogs).toHaveLength(2);
    expect(oldDialogs.every((dialog) => !dialog.runScoped)).toBe(true);
    f.controls.reloadStartupDialog = true;

    await expect(f.run((command) => command.reload())).resolves.toEqual({ result: undefined });

    expect(() => ctx.sessionManager.getSessionId()).toThrow("stale");
    const replacement = (await f.service.status(f.ref())).pendingDialogs ?? [];
    expect(replacement).toEqual([expect.objectContaining({ title: "Start after reload?" })]);
    await expect(confirm).resolves.toBe(false);
    await expect(input).resolves.toBeUndefined();
    expect(f.hub.sessionEvents.flatMap(({ event }) => event.type === "dialog.closed" ? [event] : [])).toEqual(
      oldDialogs.map(({ dialogId }) => ({ type: "dialog.closed", dialogId, reason: "session-ended" })),
    );
    for (const old of oldDialogs) {
      await expect(f.service.answerDialog(f.ref(), old.dialogId, true)).resolves.toHaveProperty("result", "stale");
    }
    if (notificationsDisabled) expect(f.service.notificationCatalog().sessions).toEqual([]);
    const dialog = replacement[0];
    if (dialog === undefined) throw new Error("Missing replacement dialog");
    await f.service.answerDialog(f.ref(), dialog.dialogId, true);
    await expect(f.reloadDialogs[0]).resolves.toBe(true);
    expect((await f.service.status(f.ref())).pendingDialogs ?? []).toEqual([]);
  });

  it.each([false, true])("settles obsolete dialogs when SDK reload fails before session_start (notificationsDisabled=%s)", async (notificationsDisabled) => {
    const f = await fixture({ notificationsDisabled });
    const ctx = f.session().extensionRunner.createContext();
    const confirm = ctx.ui.confirm("Old confirm?", "From the obsolete runner");
    const old = (await f.service.status(f.ref())).pendingDialogs?.[0];
    if (old === undefined) throw new Error("Missing old dialog");
    const failedSettings = vi.spyOn(f.session().settingsManager, "reload").mockRejectedValueOnce(new Error("settings reload failed"));
    onTestFinished(() => { failedSettings.mockRestore(); });

    await expect(f.run((command) => command.reload())).resolves.toEqual({ error: "settings reload failed" });

    expect(() => ctx.sessionManager.getSessionId()).toThrow("stale");
    expect((await f.service.status(f.ref())).pendingDialogs ?? []).toEqual([]);
    await expect(confirm).resolves.toBe(false);
    expect(f.starts).toHaveLength(1);
    expect(f.hub.sessionEvents.flatMap(({ event }) => event.type === "dialog.closed" ? [event] : [])).toEqual([
      { type: "dialog.closed", dialogId: old.dialogId, reason: "session-ended" },
    ]);
    expect(f.hub.sessionEvents).toContainEqual({ sessionId: f.ref().id, event: { type: "session.error", message: "settings reload failed" } });
  });

  it("does not sweep replacement session_start dialogs when reload fails after the hook", async () => {
    const f = await fixture();
    const confirm = f.session().extensionRunner.createContext().ui.confirm("Old confirm?", "From the obsolete runner");
    f.controls.reloadStartupDialog = true;
    const nativeReload = f.session().reload.bind(f.session());
    const failedReload = vi.spyOn(f.session(), "reload").mockImplementation(async (options) => {
      await nativeReload(options);
      throw new Error("reload failed after startup");
    });
    onTestFinished(() => { failedReload.mockRestore(); });

    await expect(f.run((command) => command.reload())).resolves.toEqual({ error: "reload failed after startup" });

    const replacement = (await f.service.status(f.ref())).pendingDialogs ?? [];
    expect(replacement).toEqual([expect.objectContaining({ title: "Start after reload?" })]);
    await expect(confirm).resolves.toBe(false);
    expect(f.hub.sessionEvents.filter(({ event }) => event.type === "dialog.closed")).toHaveLength(1);
    const dialog = replacement[0];
    if (dialog === undefined) throw new Error("Missing replacement dialog");
    await f.service.answerDialog(f.ref(), dialog.dialogId, true);
    await expect(f.reloadDialogs[0]).resolves.toBe(true);
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
