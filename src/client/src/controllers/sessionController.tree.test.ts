import { beforeEach, describe, expect, it, vi } from "vitest";
import { initialAppState } from "../appState";
import { ChatTranscriptStore } from "../chatTranscriptStore";
import { machineSessionKey } from "../machineKeys";
import { loadDraft, saveDraft } from "../promptDraftStorage";
import { SessionTreeForkUnavailableError, type CommandResult, type SessionTreeSnapshot } from "../api";
import { SessionController, type SessionControllerDependencies } from "./sessionController";
import { InMemorySessionSelectionMemory } from "./sessionSelection";
import {
  defaultApi,
  transcriptSnapshotFixture,
  deferred,
  EmitSocket,
  FakeSocket,
  MemoryStorage,
  oldSession,
  replacementSession,
  runPendingAnimationFrames,
  sessionLookupId,
  status,
  workspace,
  type AppState,
  type MessagePage,
  type SessionStatus,
} from "./sessionController.testSupport";

const tree: SessionTreeSnapshot = {
  nodes: [
    { id: "root", parentId: null, kind: "user", summary: "original prompt" },
    { id: "leaf-1", parentId: "root", kind: "assistant", summary: "answer" },
  ],
  activeLeafId: "leaf-1",
  activePathIds: ["root", "leaf-1"],
};

beforeEach(() => {
  Object.defineProperty(globalThis, "localStorage", { value: new MemoryStorage(), configurable: true });
});

describe("SessionController message shortcuts", () => {
  it.each(["fork", "back"] as const)("loads fresh history for %s without opening the navigator", async (action) => {
    let state: AppState = { ...initialAppState(), selectedSession: oldSession };
    const runCommand = vi.fn<typeof defaultApi.runCommand>(() => Promise.resolve({ type: "tree", tree }));
    const forkTree = vi.fn<typeof defaultApi.forkTree>(() => Promise.resolve({ cancelled: true }));
    const navigateTree = vi.fn<typeof defaultApi.navigateTree>(() => Promise.resolve({ cancelled: true }));
    const controller = new SessionController(() => state, (patch) => { state = { ...state, ...patch }; }, () => undefined,
      new InMemorySessionSelectionMemory(), { api: { ...defaultApi, runCommand, forkTree, navigateTree }, socket: new FakeSocket() });
    await controller.actOnMessage("root", action);
    expect(runCommand).toHaveBeenCalledWith(oldSession, "/tree", "local");
    expect(state.treeDialog).toBeUndefined();
    if (action === "fork") {
      expect(forkTree).toHaveBeenCalledWith(oldSession, { entryId: "root", expectedLeafId: "leaf-1" }, "local");
      expect(navigateTree).not.toHaveBeenCalled();
    } else {
      expect(navigateTree).toHaveBeenCalledWith(oldSession, { targetId: "root", expectedLeafId: "leaf-1", summary: { mode: "none" } }, "local");
      expect(forkTree).not.toHaveBeenCalled();
    }
    await expect(controller.actOnMessage("missing", action)).rejects.toThrow("no longer available");
  });

  it("does not mutate a different session after history loading", async () => {
    let state: AppState = { ...initialAppState(), selectedSession: oldSession };
    const result = deferred<CommandResult>();
    const forkTree = vi.fn<typeof defaultApi.forkTree>();
    const controller = new SessionController(() => state, (patch) => { state = { ...state, ...patch }; }, () => undefined,
      new InMemorySessionSelectionMemory(), { api: { ...defaultApi, runCommand: () => result.promise, forkTree }, socket: new FakeSocket() });
    const action = controller.actOnMessage("root", "fork");
    state = { ...state, selectedSession: replacementSession };
    result.resolve({ type: "tree", tree });
    await action;
    expect(forkTree).not.toHaveBeenCalled();
  });
});

describe("SessionController session tree navigation", () => {
  it("opens tree command results and keeps older-server unsupported results inert", async () => {
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, selectedSession: oldSession, sessions: [oldSession] };
    const navigateTree = vi.fn<typeof defaultApi.navigateTree>();
    const results: CommandResult[] = [
      { type: "tree", tree },
      { type: "unsupported", message: "Session tree navigation is unavailable on this server" },
    ];
    const api: typeof defaultApi = {
      ...defaultApi,
      runCommand: () => Promise.resolve(results.shift() ?? { type: "unsupported", message: "missing result" }),
      navigateTree,
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      new InMemorySessionSelectionMemory(),
      { api, socket: new FakeSocket() },
    );

    await controller.send("/tree");
    expect(state.treeDialog).toEqual(tree);

    controller.closeTreeDialog();
    await controller.send("/tree");

    expect(state.treeDialog).toBeUndefined();
    expect(state.messages).toEqual([{
      role: "system",
      parts: [{ type: "text", text: "Session tree navigation is unavailable on this server" }],
    }]);
    expect(navigateTree).not.toHaveBeenCalled();
  });

  it("discards stale history and pending live updates, runs a trailing authoritative refresh, and replaces the user draft", async () => {
    const initialPage = page("initial", 1);
    const stalePage = deferred<MessagePage>();
    const staleStatus = deferred<SessionStatus>();
    const freshPage = page("fresh branch", 2);
    const cacheKey = machineSessionKey("local", oldSession.id);
    const cachedPages = new Map<string, MessagePage>();
    const removedKeys: string[] = [];
    let snapshotCalls = 0;
    const navigationCalls: unknown[] = [];
    const replacePromptEditorText = vi.fn();
    const socket = new EmitSocket();
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, selectedSession: oldSession, sessions: [oldSession] };
    const api: typeof defaultApi = {
      ...defaultApi,
      navigateTree: (session, request, machineId) => {
        navigationCalls.push({ sessionId: sessionLookupId(session), request, machineId });
        return Promise.resolve({ cancelled: false, editorText: "edit original prompt" });
      },
      transcriptSnapshot: () => {
        snapshotCalls += 1;
        return transcriptSnapshotFixture(
          snapshotCalls === 1 ? initialPage : snapshotCalls === 2 ? stalePage.promise : freshPage,
          snapshotCalls === 2 ? staleStatus.promise : { ...status(oldSession.id), messageCount: snapshotCalls === 1 ? 1 : 2 },
        );
      },
      thinkingLevels: () => Promise.resolve({ levels: [] }),
    };
    const transcripts = new ChatTranscriptStore({
      read: (key) => cachedPages.get(key),
      write: (key, value) => { cachedPages.set(key, value); },
      remove: (key) => { removedKeys.push(key); cachedPages.delete(key); },
    });
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      new InMemorySessionSelectionMemory(),
      { api, socket, transcripts, replacePromptEditorText },
    );

    await controller.selectSession(oldSession, { updateUrl: false });
    state = { ...state, treeDialog: tree };
    socket.emit({ type: "message.append", message: { role: "assistant", content: "stale live event" }, seq: 1 });

    const oldRefresh = controller.refreshSelectedSession();
    await Promise.resolve();
    expect(snapshotCalls).toBe(2);

    const navigation = controller.navigateTree("root", { mode: "custom", instructions: "focus on the prompt" });
    await Promise.resolve();
    stalePage.resolve(page("stale refresh", 1));
    staleStatus.resolve({ ...status(oldSession.id), messageCount: 1 });
    await Promise.all([oldRefresh, navigation]);
    runPendingAnimationFrames();

    expect(navigationCalls).toEqual([{
      sessionId: oldSession.id,
      request: { targetId: "root", expectedLeafId: "leaf-1", summary: { mode: "custom", instructions: "focus on the prompt" } },
      machineId: "local",
    }]);
    expect(snapshotCalls).toBe(3);
    expect(removedKeys).toEqual([cacheKey]);
    expect(cachedPages.get(cacheKey)).toEqual(freshPage);
    expect(state.messages).toEqual([{ role: "assistant", parts: [{ type: "text", text: "fresh branch" }] }]);
    expect(state.treeDialog).toBeUndefined();
    expect(loadDraft(cacheKey)).toBe("edit original prompt");
    expect(replacePromptEditorText).toHaveBeenCalledWith({ machineId: "local", sessionId: oldSession.id, text: "edit original prompt" });
    expect(socket.connectedSessionIds).toEqual([oldSession.id]);
  });

  it("keeps the busy tree mounted until authoritative history and editor replacement finish", async () => {
    const authoritativePage = deferred<MessagePage>();
    let state: AppState = {
      ...initialAppState(),
      selectedWorkspace: workspace,
      selectedSession: oldSession,
      sessions: [oldSession],
      treeDialog: tree,
    };
    const replacePromptEditorText = vi.fn();
    const transcriptSnapshot = vi.fn<typeof defaultApi.transcriptSnapshot>(() => transcriptSnapshotFixture(authoritativePage.promise, status(oldSession.id)));
    const api: typeof defaultApi = {
      ...defaultApi,
      navigateTree: () => Promise.resolve({ cancelled: false, editorText: "edit after refresh" }),
      transcriptSnapshot,
      thinkingLevels: () => Promise.resolve({ levels: [] }),
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      { api, socket: new FakeSocket(), replacePromptEditorText },
    );

    const navigation = controller.navigateTree("root", { mode: "none" });
    await vi.waitFor(() => { expect(transcriptSnapshot).toHaveBeenCalledOnce(); });
    expect(state.treeDialog).toBe(tree);
    expect(replacePromptEditorText).not.toHaveBeenCalled();

    authoritativePage.resolve(page("authoritative branch", 1));
    await navigation;

    expect(replacePromptEditorText).toHaveBeenCalledWith({ machineId: "local", sessionId: oldSession.id, text: "edit after refresh" });
    expect(state.treeDialog).toBeUndefined();
  });

  it("retains the navigator when the authoritative post-navigation refresh fails", async () => {
    const cacheKey = machineSessionKey("local", oldSession.id);
    let state: AppState = {
      ...initialAppState(),
      selectedWorkspace: workspace,
      selectedSession: oldSession,
      sessions: [oldSession],
      treeDialog: tree,
    };
    const replacePromptEditorText = vi.fn();
    const api: typeof defaultApi = {
      ...defaultApi,
      navigateTree: () => Promise.resolve({ cancelled: false, editorText: "recovered draft" }),
      transcriptSnapshot: () => Promise.reject(new Error("authoritative history refresh failed")),
      thinkingLevels: () => Promise.resolve({ levels: [] }),
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      { api, socket: new FakeSocket(), replacePromptEditorText },
    );

    await expect(controller.navigateTree("root", { mode: "none" })).rejects.toThrow("authoritative history refresh failed");

    expect(state.treeDialog).toBe(tree);
    expect(Object.values(state.browserErrors).map((error) => error.message).join("\n")).toContain("authoritative history refresh failed");    expect(loadDraft(cacheKey)).toBe("recovered draft");
    expect(replacePromptEditorText).toHaveBeenCalledWith({ machineId: "local", sessionId: oldSession.id, text: "recovered draft" });
  });

  it("retains the navigator when live prompt-editor replacement fails", async () => {
    let state: AppState = {
      ...initialAppState(),
      selectedWorkspace: workspace,
      selectedSession: oldSession,
      sessions: [oldSession],
      treeDialog: tree,
    };
    const replacePromptEditorText = vi.fn(() => Promise.reject(new Error("prompt editor replacement failed")));
    const api: typeof defaultApi = {
      ...defaultApi,
      navigateTree: () => Promise.resolve({ cancelled: false, editorText: "recovered draft" }),
      transcriptSnapshot: () => transcriptSnapshotFixture(page("authoritative branch", 1), status(oldSession.id)),
      thinkingLevels: () => Promise.resolve({ levels: [] }),
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      { api, socket: new FakeSocket(), replacePromptEditorText },
    );

    await expect(controller.navigateTree("root", { mode: "none" })).rejects.toThrow("prompt editor replacement failed");

    expect(state.messages).toEqual([{ role: "assistant", parts: [{ type: "text", text: "authoritative branch" }] }]);
    expect(state.treeDialog).toBe(tree);
    expect(Object.values(state.browserErrors).map((error) => error.message).join("\n")).toContain("prompt editor replacement failed");  });

  it("explicitly clears the editor draft when navigating to a non-user entry", async () => {
    const cacheKey = machineSessionKey("local", oldSession.id);
    saveDraft(cacheKey, "stale editor text");
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, selectedSession: oldSession, sessions: [oldSession], treeDialog: tree };
    const replacePromptEditorText = vi.fn();
    const api: typeof defaultApi = {
      ...defaultApi,
      navigateTree: () => Promise.resolve({ cancelled: false }),
      transcriptSnapshot: () => transcriptSnapshotFixture(page("selected entry", 1), status(oldSession.id)),
      thinkingLevels: () => Promise.resolve({ levels: [] }),
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      { api, socket: new FakeSocket(), replacePromptEditorText },
    );

    await controller.navigateTree("leaf-1", { mode: "none" });

    expect(loadDraft(cacheKey)).toBe("");
    expect(replacePromptEditorText).toHaveBeenCalledWith({ machineId: "local", sessionId: oldSession.id, text: "" });
  });

  it("retains the tree on cancellation and errors and exposes abort and close lifecycle methods", async () => {
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, selectedSession: oldSession, sessions: [oldSession], treeDialog: tree };
    const navigateTree = vi.fn<typeof defaultApi.navigateTree>();
    navigateTree.mockResolvedValueOnce({ cancelled: true, aborted: true }).mockRejectedValueOnce(new Error("The session changed; reopen /tree"));
    const abort = vi.fn<typeof defaultApi.abort>(() => Promise.resolve({ aborted: true }));
    const api: typeof defaultApi = { ...defaultApi, navigateTree, abort };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      { api, socket: new FakeSocket() },
    );

    await expect(controller.navigateTree("root", { mode: "default" })).resolves.toEqual({ cancelled: true, aborted: true });
    expect(state.treeDialog).toBe(tree);

    await expect(controller.navigateTree("root", { mode: "none" })).rejects.toThrow("reopen /tree");
    expect(state.treeDialog).toBe(tree);
    expect(Object.values(state.browserErrors).map((error) => error.message).join("\n")).toContain("reopen /tree");
    await controller.abortTreeNavigation();
    expect(abort).toHaveBeenCalledWith(oldSession, "local");
    controller.closeTreeDialog();
    expect(state.treeDialog).toBeUndefined();
  });

  it("keeps live socket events flowing when a selected-session join refresh fails", async () => {
    const socket = new EmitSocket();
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, selectedSession: oldSession, sessions: [oldSession] };
    const api: typeof defaultApi = {
      ...defaultApi,
      transcriptSnapshot: () => Promise.reject(new Error("history refresh failed")),
      thinkingLevels: () => Promise.resolve({ levels: [] }),
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      { api, socket },
    );

    await controller.selectSession(oldSession, { updateUrl: false });
    socket.emit({ type: "message.append", message: { role: "assistant", content: "live after failed refresh" }, seq: 1 });

    expect(Object.values(state.browserErrors).map((error) => error.message).join("\n")).toContain("history refresh failed");    expect(state.messages).toEqual([{ role: "assistant", parts: [{ type: "text", text: "live after failed refresh" }] }]);
  });

  it("does not reopen a disposed controller when navigation settles late", async () => {
    const navigationResult = deferred<{ cancelled: false; editorText: string }>();
    const transcriptSnapshot = vi.fn<typeof defaultApi.transcriptSnapshot>(() => transcriptSnapshotFixture(page("must not load", 1), status(oldSession.id)));
    const replacePromptEditorText = vi.fn();
    let state: AppState = {
      ...initialAppState(),
      selectedWorkspace: workspace,
      selectedSession: oldSession,
      sessions: [oldSession],
      treeDialog: tree,
    };
    const api: typeof defaultApi = { ...defaultApi, navigateTree: () => navigationResult.promise, transcriptSnapshot };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      { api, socket: new FakeSocket(), replacePromptEditorText },
    );

    const navigation = controller.navigateTree("root", { mode: "none" });
    controller.dispose();
    navigationResult.resolve({ cancelled: false, editorText: "late result" });
    await navigation;

    expect(transcriptSnapshot).not.toHaveBeenCalled();
    expect(replacePromptEditorText).not.toHaveBeenCalled();
  });

  it("refreshes authoritatively when the same session is reselected before navigation completes", async () => {
    const navigationResult = deferred<{ cancelled: false; editorText: string }>();
    const replacePromptEditorText = vi.fn();
    let messageCalls = 0;
    let state: AppState = {
      ...initialAppState(),
      selectedWorkspace: workspace,
      selectedSession: oldSession,
      sessions: [oldSession],
      treeDialog: tree,
    };
    const api: typeof defaultApi = {
      ...defaultApi,
      navigateTree: () => navigationResult.promise,
      transcriptSnapshot: () => {
        messageCalls += 1;
        return transcriptSnapshotFixture(page(messageCalls === 1 ? "pre-navigation reselection" : "authoritative branch", 1), status(oldSession.id));
      },
      thinkingLevels: () => Promise.resolve({ levels: [] }),
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      { api, socket: new FakeSocket(), replacePromptEditorText },
    );

    const navigation = controller.navigateTree("root", { mode: "none" });
    await controller.selectSession(oldSession, { updateUrl: false });
    navigationResult.resolve({ cancelled: false, editorText: "recovered draft" });
    await navigation;

    expect(messageCalls).toBe(2);
    expect(state.messages).toEqual([{ role: "assistant", parts: [{ type: "text", text: "authoritative branch" }] }]);
    expect(replacePromptEditorText).toHaveBeenCalledWith({ machineId: "local", sessionId: oldSession.id, text: "recovered draft" });
  });

  it("replaces live editor text when the same session is reselected during the authoritative refresh", async () => {
    const firstRefresh = deferred<MessagePage>();
    const replacePromptEditorText = vi.fn();
    let messageCalls = 0;
    let state: AppState = {
      ...initialAppState(),
      selectedWorkspace: workspace,
      selectedSession: oldSession,
      sessions: [oldSession],
      treeDialog: tree,
    };
    const api: typeof defaultApi = {
      ...defaultApi,
      navigateTree: () => Promise.resolve({ cancelled: false, editorText: "recovered draft" }),
      transcriptSnapshot: () => {
        messageCalls += 1;
        return transcriptSnapshotFixture(messageCalls === 1 ? firstRefresh.promise : page("reselected authoritative branch", 1), status(oldSession.id));
      },
      thinkingLevels: () => Promise.resolve({ levels: [] }),
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      { api, socket: new FakeSocket(), replacePromptEditorText },
    );

    const navigation = controller.navigateTree("root", { mode: "none" });
    await vi.waitFor(() => { expect(messageCalls).toBe(1); });
    const reselection = controller.selectSession(oldSession, { updateUrl: false });
    firstRefresh.resolve(page("superseded branch", 1));
    await Promise.all([navigation, reselection]);

    expect(messageCalls).toBe(2);
    expect(state.messages).toEqual([{ role: "assistant", parts: [{ type: "text", text: "reselected authoritative branch" }] }]);
    expect(replacePromptEditorText).toHaveBeenCalledWith({ machineId: "local", sessionId: oldSession.id, text: "recovered draft" });
  });

  it("discards only the originating cache and does not refresh or replace another session after a selection race", async () => {
    const navigationResult = deferred<{ cancelled: false; editorText: string }>();
    const oldCacheKey = machineSessionKey("local", oldSession.id);
    const replacementCacheKey = machineSessionKey("local", replacementSession.id);
    const cachedPages = new Map<string, MessagePage>([
      [oldCacheKey, page("old cached branch", 1)],
      [replacementCacheKey, page("replacement cached", 1)],
    ]);
    const removedKeys: string[] = [];
    const replacePromptEditorText = vi.fn();
    const requestedMessages: string[] = [];
    let state: AppState = {
      ...initialAppState(),
      selectedWorkspace: workspace,
      selectedSession: oldSession,
      sessions: [oldSession, replacementSession],
      treeDialog: tree,
    };
    const api: typeof defaultApi = {
      ...defaultApi,
      navigateTree: () => navigationResult.promise,
      transcriptSnapshot: (session) => {
        requestedMessages.push(sessionLookupId(session));
        return transcriptSnapshotFixture(page("replacement authoritative", 1), status(sessionLookupId(session)));
      },
      thinkingLevels: () => Promise.resolve({ levels: [] }),
    };
    const transcripts = new ChatTranscriptStore({
      read: (key) => cachedPages.get(key),
      write: (key, value) => { cachedPages.set(key, value); },
      remove: (key) => { removedKeys.push(key); cachedPages.delete(key); },
    });
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      { api, socket: new FakeSocket(), transcripts, replacePromptEditorText },
    );

    const navigation = controller.navigateTree("root", { mode: "none" });
    await controller.selectSession(replacementSession, { updateUrl: false });
    navigationResult.resolve({ cancelled: false, editorText: "originating draft" });
    await navigation;

    expect(state.selectedSession?.id).toBe(replacementSession.id);
    expect(state.messages).toEqual([{ role: "assistant", parts: [{ type: "text", text: "replacement authoritative" }] }]);
    expect(requestedMessages).toEqual([replacementSession.id]);
    expect(removedKeys).toEqual([oldCacheKey]);
    expect(cachedPages.get(replacementCacheKey)).toEqual(page("replacement authoritative", 1));
    expect(loadDraft(oldCacheKey)).toBe("originating draft");
    expect(replacePromptEditorText).not.toHaveBeenCalled();
  });

  it("does not open a delayed tree snapshot for the same session id on a different machine", async () => {
    const command = deferred<CommandResult>();
    const remoteA = { id: "remote-a", name: "Remote A", kind: "remote" as const, createdAt: "now", updatedAt: "now" };
    const remoteB = { id: "remote-b", name: "Remote B", kind: "remote" as const, createdAt: "now", updatedAt: "now" };
    let state: AppState = {
      ...initialAppState(),
      machines: [remoteA, remoteB],
      selectedMachine: remoteA,
      selectedWorkspace: workspace,
      selectedSession: oldSession,
      sessions: [oldSession],
    };
    const api: typeof defaultApi = { ...defaultApi, runCommand: () => command.promise };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      { api, socket: new FakeSocket() },
    );

    const run = controller.send("/tree");
    state = { ...state, selectedMachine: remoteB };
    command.resolve({ type: "tree", tree });
    await run;

    expect(state.treeDialog).toBeUndefined();
    expect(Object.values(state.browserErrors).map((error) => error.message).join("\n")).toContain("needs input; open the session and run it again");
  });

  it("requires a delayed interactive tree command to be rerun after its session is no longer selected", async () => {
    const command = deferred<CommandResult>();
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, selectedSession: oldSession, sessions: [oldSession, replacementSession] };
    const api: typeof defaultApi = {
      ...defaultApi,
      runCommand: () => command.promise,
      transcriptSnapshot: () => transcriptSnapshotFixture(page("replacement", 1), status(replacementSession.id)),
      thinkingLevels: () => Promise.resolve({ levels: [] }),
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      { api, socket: new FakeSocket() },
    );

    const run = controller.send("/tree");
    await controller.selectSession(replacementSession, { updateUrl: false });
    command.resolve({ type: "tree", tree });
    await run;

    expect(state.treeDialog).toBeUndefined();
    expect(Object.values(state.browserErrors).map((error) => error.message).join("\n")).toContain("needs input; open the session and run it again");
  });
});

describe("SessionController session tree fork", () => {
  it("forks into a new session, stores the draft under the forked key, and switches to it", async () => {
    const oldCacheKey = machineSessionKey("local", oldSession.id);
    const forkedCacheKey = machineSessionKey("local", replacementSession.id);
    const cachedPages = new Map<string, MessagePage>([[oldCacheKey, page("original branch", 1)]]);
    const removedKeys: string[] = [];
    const forkCalls: unknown[] = [];
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, selectedSession: oldSession, sessions: [oldSession], treeDialog: tree };
    const api: typeof defaultApi = {
      ...defaultApi,
      forkTree: (session, request, machineId) => {
        forkCalls.push({ sessionId: sessionLookupId(session), request, machineId });
        return Promise.resolve({ cancelled: false, session: replacementSession, promptDraft: "resend me" });
      },
      transcriptSnapshot: () => transcriptSnapshotFixture(page("forked branch", 1), status(replacementSession.id)),
      thinkingLevels: () => Promise.resolve({ levels: [] }),
    };
    const transcripts = new ChatTranscriptStore({
      read: (key) => cachedPages.get(key),
      write: (key, value) => { cachedPages.set(key, value); },
      remove: (key) => { removedKeys.push(key); cachedPages.delete(key); },
    });
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      { api, socket: new FakeSocket(), transcripts },
    );

    await controller.forkFromTree("root");
    await vi.waitFor(() => {
      runPendingAnimationFrames();
      expect(state.messages).toEqual([{ role: "assistant", parts: [{ type: "text", text: "forked branch" }] }]);
    });

    expect(forkCalls).toEqual([{ sessionId: oldSession.id, request: { entryId: "root", expectedLeafId: "leaf-1" }, machineId: "local" }]);
    expect(state.sessions[0]).toEqual(replacementSession);
    expect(state.sessions).toHaveLength(2);
    expect(state.selectedSession?.id).toBe(replacementSession.id);
    expect(state.treeDialog).toBeUndefined();
    expect(loadDraft(forkedCacheKey)).toBe("resend me");
    expect(loadDraft(oldCacheKey)).toBe("");
    expect(removedKeys).toEqual([oldCacheKey]);
  });

  it("publishes a forked session through the injected navigation boundary", async () => {
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, selectedSession: oldSession, sessions: [oldSession], treeDialog: tree };
    const selectedAtNavigation: string[] = [];
    const api: typeof defaultApi = {
      ...defaultApi,
      forkTree: () => Promise.resolve({ cancelled: false, session: replacementSession, promptDraft: "fork draft" }),
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      {
        api,
        socket: new FakeSocket(),
        navigateToSession: (session, options) => {
          selectedAtNavigation.push(state.selectedSession?.id ?? "missing");
          expect(options?.expected?.sessionId).toBe(oldSession.id);
          state = { ...state, selectedSession: session };
          return Promise.resolve(true);
        },
      },
    );

    await controller.forkFromTree("root");

    expect(selectedAtNavigation).toEqual([oldSession.id]);
    expect(state.selectedSession?.id).toBe(replacementSession.id);
    expect(state.treeDialog).toBeUndefined();
  });

  it("keeps the navigator open on cancellation without changing the selection", async () => {
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, selectedSession: oldSession, sessions: [oldSession], treeDialog: tree };
    const forkTree = vi.fn<typeof defaultApi.forkTree>(() => Promise.resolve({ cancelled: true }));
    const api: typeof defaultApi = { ...defaultApi, forkTree };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      { api, socket: new FakeSocket() },
    );

    await expect(controller.forkFromTree("root")).resolves.toEqual({ cancelled: true });

    expect(forkTree).toHaveBeenCalledWith(oldSession, { entryId: "root", expectedLeafId: "leaf-1" }, "local");
    expect(state.treeDialog).toBe(tree);
    expect(state.selectedSession?.id).toBe(oldSession.id);
    expect(state.sessions).toEqual([oldSession]);
  });

  it("surfaces daemon fork errors and keeps the navigator open", async () => {
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, selectedSession: oldSession, sessions: [oldSession], treeDialog: tree };
    const forkTree = vi.fn<typeof defaultApi.forkTree>(() => Promise.reject(new Error("Cannot fork while the session is active. Stop current activity before forking.")));
    const api: typeof defaultApi = { ...defaultApi, forkTree };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      { api, socket: new FakeSocket() },
    );

    await expect(controller.forkFromTree("root")).rejects.toThrow("Stop current activity before forking.");

    expect(state.treeDialog).toBe(tree);
    expect(Object.values(state.browserErrors).map((error) => error.message).join("\n")).toContain("Stop current activity before forking.");  });

  it("reports unavailable forks from older daemons without closing the navigator", async () => {
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, selectedSession: oldSession, sessions: [oldSession], treeDialog: tree };
    const forkTree = vi.fn<typeof defaultApi.forkTree>(() => Promise.reject(new SessionTreeForkUnavailableError()));
    const api: typeof defaultApi = { ...defaultApi, forkTree };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      { api, socket: new FakeSocket() },
    );

    await expect(controller.forkFromTree("root")).rejects.toThrow(SessionTreeForkUnavailableError);

    expect(state.treeDialog).toBe(tree);
    expect(Object.values(state.browserErrors).map((error) => error.message).join("\n")).toContain("Fork from the session tree is unavailable");  });

  it("rejects forks when the navigator is unavailable", async () => {
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, selectedSession: oldSession, sessions: [oldSession] };
    const forkTree = vi.fn<typeof defaultApi.forkTree>();
    const api: typeof defaultApi = { ...defaultApi, forkTree };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      { api, socket: new FakeSocket() },
    );

    await expect(controller.forkFromTree("root")).rejects.toThrow("The session tree navigator is no longer available");
    expect(forkTree).not.toHaveBeenCalled();

    state = { ...state, treeDialog: tree, selectedSession: { ...oldSession, archived: true } };
    await expect(controller.forkFromTree("root")).rejects.toThrow("The session tree navigator is no longer available");
    expect(forkTree).not.toHaveBeenCalled();

    state = { ...state, selectedSession: undefined };
    await expect(controller.forkFromTree("root")).rejects.toThrow("The session tree navigator is no longer available");
    expect(forkTree).not.toHaveBeenCalled();
  });
});

describe("SessionController extension-driven tree operations", () => {
  it.each(["rewound prompt", undefined])("applies a buffered rewind below the join watermark and restores editor text %s", async (editorText) => {
    const socket = new EmitSocket();
    const initialPage = deferred<MessagePage>();
    const authoritativePage = deferred<MessagePage>();
    const cacheKey = machineSessionKey("local", oldSession.id);
    const cachedPages = new Map<string, MessagePage>([[cacheKey, page("cached old branch", 1)]]);
    const removedKeys: string[] = [];
    const transcripts = new ChatTranscriptStore({
      read: (key) => cachedPages.get(key),
      write: (key, value) => { cachedPages.set(key, value); },
      remove: (key) => { removedKeys.push(key); cachedPages.delete(key); },
    });
    saveDraft(cacheKey, "stale editor draft");
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, sessions: [oldSession] };
    const replacePromptEditorText = vi.fn();
    const navigateTree = vi.fn<typeof defaultApi.navigateTree>();
    const transcriptSnapshot = vi.fn<typeof defaultApi.transcriptSnapshot>()
      .mockImplementationOnce(() => transcriptSnapshotFixture(initialPage.promise, status(oldSession.id), { seq: 10, partial: null }))
      .mockImplementationOnce(() => transcriptSnapshotFixture(authoritativePage.promise, status(oldSession.id), { seq: 10, partial: null }));
    const controller = new SessionController(
      () => state, (patch) => { state = { ...state, ...patch }; }, () => undefined, undefined,
      { api: { ...defaultApi, transcriptSnapshot, navigateTree, thinkingLevels: () => Promise.resolve({ levels: [] }) }, socket, transcripts, replacePromptEditorText },
    );

    const join = controller.selectSession(oldSession, { updateUrl: false });
    await vi.waitFor(() => { expect(transcriptSnapshot).toHaveBeenCalledOnce(); });
    // The snapshot includes branch history, but not this editor restoration.
    socket.emit({ type: "session.tree.navigated", result: { cancelled: false, ...(editorText === undefined ? {} : { editorText }) }, seq: 7 });
    initialPage.resolve(page("stale join branch", 1));
    await vi.waitFor(() => { expect(transcriptSnapshot).toHaveBeenCalledTimes(2); });
    expect(replacePromptEditorText).not.toHaveBeenCalled();
    expect(removedKeys).toEqual([cacheKey]);

    authoritativePage.resolve(page("authoritative rewind", 1));
    await join;
    await vi.waitFor(() => {
      expect(replacePromptEditorText).toHaveBeenCalledWith({ machineId: "local", sessionId: oldSession.id, text: editorText ?? "" });
    });
    expect(state.messages).toEqual([{ role: "assistant", parts: [{ type: "text", text: "authoritative rewind" }] }]);
    expect(cachedPages.get(cacheKey)).toEqual(page("authoritative rewind", 1));
    expect(loadDraft(cacheKey)).toBe(editorText ?? "");
    expect(navigateTree).not.toHaveBeenCalled();
    expect(socket.connectedSessionIds).toEqual([oldSession.id]);
    controller.dispose();
  });

  it.each(["navigate", "fork"] as const)("preserves a buffered navigation followed by %s", async (next) => {
    const socket = new EmitSocket();
    const initialPage = deferred<MessagePage>();
    const replacePromptEditorText = vi.fn();
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, sessions: [oldSession] };
    const transcriptSnapshot = vi.fn<typeof defaultApi.transcriptSnapshot>()
      .mockImplementationOnce(() => transcriptSnapshotFixture(initialPage.promise, status(oldSession.id), { seq: 10, partial: null }))
      .mockImplementation((session) => transcriptSnapshotFixture(page("final branch", 1), status(sessionLookupId(session))));
    const controller = new SessionController(
      () => state, (patch) => { state = { ...state, ...patch }; }, () => undefined, undefined,
      { api: { ...defaultApi, transcriptSnapshot, thinkingLevels: () => Promise.resolve({ levels: [] }) }, socket, replacePromptEditorText },
    );
    const joining = controller.selectSession(oldSession, { updateUrl: false });
    await vi.waitFor(() => { expect(transcriptSnapshot).toHaveBeenCalledOnce(); });
    socket.emit({ type: "session.tree.navigated", result: { cancelled: false, editorText: "earlier draft" }, seq: 4 });
    socket.emit(next === "navigate"
      ? { type: "session.tree.navigated", result: { cancelled: false, editorText: "final draft" }, seq: 5 }
      : { type: "session.tree.forked", result: { cancelled: false, session: replacementSession, promptDraft: "final draft" }, seq: 5 });
    initialPage.resolve(page("initial", 1));
    await joining;
    await vi.waitFor(() => {
      const destination = next === "fork" ? replacementSession : oldSession;
      expect(state.selectedSession?.id).toBe(destination.id);
      expect(loadDraft(machineSessionKey("local", destination.id))).toBe("final draft");
      if (next === "navigate") expect(replacePromptEditorText).toHaveBeenLastCalledWith({ machineId: "local", sessionId: oldSession.id, text: "final draft" });
    });
    expect(socket.connectedSessionIds).toEqual(next === "fork" ? [oldSession.id, replacementSession.id] : [oldSession.id]);
    controller.dispose();
  });

  it("refreshes a same-identity fork follow-up without reconnecting or losing its live editor draft", async () => {
    const socket = new EmitSocket();
    const replacePromptEditorText = vi.fn();
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, sessions: [oldSession] };
    const controller = new SessionController(
      () => state, (patch) => { state = { ...state, ...patch }; }, () => undefined, undefined,
      { api: { ...defaultApi, transcriptSnapshot: () => transcriptSnapshotFixture(page("callback branch", 1), status(oldSession.id)), thinkingLevels: () => Promise.resolve({ levels: [] }) }, socket, replacePromptEditorText },
    );
    await controller.selectSession(oldSession, { updateUrl: false });
    socket.emit({ type: "session.tree.forked", result: { cancelled: false, session: oldSession, promptDraft: "callback draft" } });
    await vi.waitFor(() => {
      expect(replacePromptEditorText).toHaveBeenCalledWith({ machineId: "local", sessionId: oldSession.id, text: "callback draft" });
    });
    expect(socket.connectedSessionIds).toEqual([oldSession.id]);
    controller.dispose();
  });

  it.each([undefined, "Post-fork workflow failed"])("applies a buffered fork without touching the original draft and reports callback error %s", async (callbackError) => {
    const socket = new EmitSocket();
    const initialPage = deferred<MessagePage>();
    const sourceKey = machineSessionKey("local", oldSession.id);
    const forkKey = machineSessionKey("local", replacementSession.id);
    saveDraft(sourceKey, "original unsent draft");
    const removedKeys: string[] = [];
    const transcripts = new ChatTranscriptStore({ read: () => undefined, write: () => undefined, remove: (key) => { removedKeys.push(key); } });
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, sessions: [oldSession] };
    const forkTree = vi.fn<typeof defaultApi.forkTree>();
    const transcriptSnapshot = vi.fn<typeof defaultApi.transcriptSnapshot>()
      .mockImplementationOnce(() => transcriptSnapshotFixture(initialPage.promise, status(oldSession.id), { seq: 10, partial: null }))
      .mockImplementationOnce(() => transcriptSnapshotFixture(page("fork history", 1), status(replacementSession.id)));
    const navigateToSession = vi.fn<NonNullable<SessionControllerDependencies["navigateToSession"]>>(async (session) => {
      if (session === undefined) throw new Error("Expected fork destination");
      await controller.selectSession(session);
      return true;
    });
    const controller = new SessionController(
      () => state, (patch) => { state = { ...state, ...patch }; }, () => undefined, undefined,
      { api: { ...defaultApi, transcriptSnapshot, forkTree, thinkingLevels: () => Promise.resolve({ levels: [] }) }, socket, transcripts, navigateToSession },
    );

    const join = controller.selectSession(oldSession, { updateUrl: false });
    await vi.waitFor(() => { expect(transcriptSnapshot).toHaveBeenCalledOnce(); });
    socket.emit({ type: "session.tree.forked", result: { cancelled: false, session: replacementSession, promptDraft: "fork-only draft" },
      ...(callbackError === undefined ? {} : { error: callbackError }), seq: 7 });
    // Replay must stop when the fork changes selection: these source-session
    // frames must not be applied to the fork's new baseline.
    socket.emit({ type: "message.append", message: { role: "assistant", content: "original late frame" }, seq: 11 });
    initialPage.resolve(page("original history", 1));
    await join;
    await vi.waitFor(() => {
      expect(state.messages).toEqual([{ role: "assistant", parts: [{ type: "text", text: "fork history" }] }]);
    });

    expect(navigateToSession).toHaveBeenCalledWith(replacementSession, { expected: { machineId: "local", projectId: undefined, workspaceId: workspace.id, sessionId: oldSession.id } });
    expect(state.selectedSession).toEqual(replacementSession);
    expect(state.sessions).toEqual([replacementSession, oldSession]);
    expect(loadDraft(sourceKey)).toBe("original unsent draft");
    expect(loadDraft(forkKey)).toBe("fork-only draft");
    expect(removedKeys).toEqual([sourceKey]);
    expect(forkTree).not.toHaveBeenCalled();
    if (callbackError !== undefined) await vi.waitFor(() => {
      expect(Object.values(state.browserErrors).map((entry) => entry.message).join("\n")).toContain(callbackError);
    });
    controller.dispose();
  });

  it.each(["history", "editor"] as const)("reports asynchronous rewind %s errors visibly while keeping the recovered draft", async (failure) => {
    const socket = new EmitSocket();
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, sessions: [oldSession] };
    const error = new Error(`${failure} restoration failed`);
    const replacePromptEditorText = vi.fn(() => failure === "editor" ? Promise.reject(error) : Promise.resolve());
    const transcriptSnapshot = vi.fn<typeof defaultApi.transcriptSnapshot>()
      .mockImplementationOnce(() => transcriptSnapshotFixture(page("original", 1), status(oldSession.id)))
      .mockImplementationOnce(() => failure === "history" ? Promise.reject(error) : transcriptSnapshotFixture(page("rewound", 1), status(oldSession.id)));
    const controller = new SessionController(
      () => state, (patch) => { state = { ...state, ...patch }; }, () => undefined, undefined,
      { api: { ...defaultApi, transcriptSnapshot, thinkingLevels: () => Promise.resolve({ levels: [] }) }, socket, replacePromptEditorText },
    );
    await controller.selectSession(oldSession, { updateUrl: false });
    state = { ...state, treeDialog: tree };

    socket.emit({ type: "session.tree.navigated", result: { cancelled: false, editorText: "recovered extension draft" }, seq: 1 });
    await vi.waitFor(() => {
      expect(Object.values(state.browserErrors).map((entry) => entry.message).join("\n")).toContain(error.message);
    });
    expect(loadDraft(machineSessionKey("local", oldSession.id))).toBe("recovered extension draft");
    expect(replacePromptEditorText).toHaveBeenCalledWith({ machineId: "local", sessionId: oldSession.id, text: "recovered extension draft" });
    expect(state.treeDialog).toBe(tree);
    controller.dispose();
  });

  it("reports asynchronous fork navigation failure on the source session", async () => {
    const socket = new EmitSocket();
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, sessions: [oldSession] };
    saveDraft(machineSessionKey("local", oldSession.id), "original draft");
    const controller = new SessionController(
      () => state, (patch) => { state = { ...state, ...patch }; }, () => undefined, undefined,
      {
        api: { ...defaultApi, transcriptSnapshot: () => transcriptSnapshotFixture(page("original", 1), status(oldSession.id)), thinkingLevels: () => Promise.resolve({ levels: [] }) },
        socket,
        navigateToSession: () => Promise.reject(new Error("fork navigation failed")),
      },
    );
    await controller.selectSession(oldSession, { updateUrl: false });
    state = { ...state, treeDialog: tree };

    socket.emit({ type: "session.tree.forked", result: { cancelled: false, session: replacementSession, promptDraft: "fork draft" }, seq: 1 });
    await vi.waitFor(() => {
      expect(Object.values(state.browserErrors).map((entry) => entry.message).join("\n")).toContain("fork navigation failed");
    });
    expect(state.selectedSession).toEqual(oldSession);
    expect(state.treeDialog).toBe(tree);
    expect(loadDraft(machineSessionKey("local", oldSession.id))).toBe("original draft");
    expect(loadDraft(machineSessionKey("local", replacementSession.id))).toBe("fork draft");
    controller.dispose();
  });

  it.each(["session", "machine"] as const)("does not replace another %s's history or editor when a rewind refresh settles late", async (destination) => {
    const socket = new EmitSocket();
    const rewindPage = deferred<MessagePage>();
    const remote = { id: "remote", name: "Remote", kind: "remote" as const, createdAt: "now", updatedAt: "now" };
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, sessions: [oldSession, replacementSession] };
    const replacePromptEditorText = vi.fn();
    const transcriptSnapshot = vi.fn<typeof defaultApi.transcriptSnapshot>()
      .mockImplementationOnce(() => transcriptSnapshotFixture(page("original", 1), status(oldSession.id)))
      .mockImplementationOnce(() => transcriptSnapshotFixture(rewindPage.promise, status(oldSession.id)))
      .mockImplementation((session) => transcriptSnapshotFixture(page("destination history", 1), status(sessionLookupId(session))));
    const controller = new SessionController(
      () => state, (patch) => { state = { ...state, ...patch }; }, () => undefined, undefined,
      { api: { ...defaultApi, transcriptSnapshot, thinkingLevels: () => Promise.resolve({ levels: [] }) }, socket, replacePromptEditorText },
    );
    await controller.selectSession(oldSession, { updateUrl: false });
    socket.emit({ type: "session.tree.navigated", result: { cancelled: false, editorText: "source draft" }, seq: 1 });
    await vi.waitFor(() => { expect(transcriptSnapshot).toHaveBeenCalledTimes(2); });
    if (destination === "machine") state = { ...state, machines: [remote], selectedMachine: remote };
    const selected = destination === "machine" ? oldSession : replacementSession;
    await controller.selectSession(selected, { updateUrl: false });
    rewindPage.resolve(page("must not overwrite destination", 1));
    // Drain both the retired refresh and its result application's continuation.
    await controller.refreshSelectedSession();

    expect(state.selectedSession?.id).toBe(selected.id);
    expect(state.messages).toEqual([{ role: "assistant", parts: [{ type: "text", text: "destination history" }] }]);
    expect(replacePromptEditorText).not.toHaveBeenCalled();
    expect(loadDraft(machineSessionKey("local", oldSession.id))).toBe("source draft");
    expect(loadDraft(machineSessionKey(destination === "machine" ? remote.id : "local", selected.id))).toBe("");
    expect(state.browserErrors).toEqual({});
    controller.dispose();
  });

  it.each(["session.tree.navigated", "session.tree.forked"] as const)("ignores stale %s socket frames after a machine switch", async (type) => {
    const socket = new EmitSocket();
    const remote = { id: "remote", name: "Remote", kind: "remote" as const, createdAt: "now", updatedAt: "now" };
    const sourceKey = machineSessionKey("local", oldSession.id);
    saveDraft(sourceKey, "original draft");
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, sessions: [oldSession] };
    const removedKeys: string[] = [];
    const transcripts = new ChatTranscriptStore({ read: () => undefined, write: () => undefined, remove: (key) => { removedKeys.push(key); } });
    const replacePromptEditorText = vi.fn();
    const navigateToSession = vi.fn<NonNullable<SessionControllerDependencies["navigateToSession"]>>();
    const transcriptSnapshot = vi.fn<typeof defaultApi.transcriptSnapshot>(() => transcriptSnapshotFixture(page("original", 1), status(oldSession.id)));
    const controller = new SessionController(
      () => state, (patch) => { state = { ...state, ...patch }; }, () => undefined, undefined,
      { api: { ...defaultApi, transcriptSnapshot, thinkingLevels: () => Promise.resolve({ levels: [] }) }, socket, transcripts, replacePromptEditorText, navigateToSession },
    );
    await controller.selectSession(oldSession, { updateUrl: false });
    // URL navigation can change machine state before its replacement session
    // join reaches this controller; the old socket is still connected then.
    state = { ...state, machines: [remote], selectedMachine: remote };
    if (type === "session.tree.navigated") socket.emit({ type, result: { cancelled: false, editorText: "wrong-machine text" }, seq: 1 });
    else socket.emit({ type, result: { cancelled: false, session: replacementSession, promptDraft: "wrong-machine text" }, seq: 1 });
    await Promise.resolve();

    expect(transcriptSnapshot).toHaveBeenCalledOnce();
    expect(removedKeys).toEqual([]);
    expect(replacePromptEditorText).not.toHaveBeenCalled();
    expect(navigateToSession).not.toHaveBeenCalled();
    expect(loadDraft(sourceKey)).toBe("original draft");
    expect(loadDraft(machineSessionKey(remote.id, oldSession.id))).toBe("");
    expect(loadDraft(machineSessionKey(remote.id, replacementSession.id))).toBe("");
    expect(state.sessions).toEqual([oldSession]);
    controller.dispose();
  });
});

function page(text: string, total: number): MessagePage {
  return { messages: [{ role: "assistant", content: text }], start: 0, total };
}
