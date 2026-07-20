import { beforeEach, describe, expect, it, vi } from "vitest";
import { initialAppState } from "../appState";
import { ChatTranscriptStore } from "../chatTranscriptStore";
import { machineSessionKey } from "../machineKeys";
import { loadDraft, saveDraft } from "../promptDraftStorage";
import type { CommandResult, SessionTreeSnapshot } from "../api";
import { SessionController } from "./sessionController";
import { InMemorySessionSelectionMemory } from "./sessionSelection";
import {
  defaultApi,
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
    let messageCalls = 0;
    let statusCalls = 0;
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
      messages: () => {
        messageCalls += 1;
        if (messageCalls === 1) return Promise.resolve(initialPage);
        if (messageCalls === 2) return stalePage.promise;
        return Promise.resolve(freshPage);
      },
      status: () => {
        statusCalls += 1;
        if (statusCalls === 2) return staleStatus.promise;
        return Promise.resolve({ ...status(oldSession.id), messageCount: statusCalls === 1 ? 1 : 2 });
      },
      streamSnapshot: () => Promise.resolve({ seq: 0, partial: null }),
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
    expect(messageCalls).toBe(2);

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
    expect(messageCalls).toBe(3);
    expect(statusCalls).toBe(3);
    expect(removedKeys).toEqual([cacheKey]);
    expect(cachedPages.get(cacheKey)).toEqual(freshPage);
    expect(state.messages).toEqual([{ role: "assistant", parts: [{ type: "text", text: "fresh branch" }] }]);
    expect(state.treeDialog).toBeUndefined();
    expect(loadDraft(cacheKey)).toBe("edit original prompt");
    expect(replacePromptEditorText).toHaveBeenCalledWith({ machineId: "local", sessionId: oldSession.id, text: "edit original prompt" });
    expect(socket.connectedSessionIds).toEqual([oldSession.id, oldSession.id]);
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
    const messages = vi.fn<typeof defaultApi.messages>(() => authoritativePage.promise);
    const api: typeof defaultApi = {
      ...defaultApi,
      navigateTree: () => Promise.resolve({ cancelled: false, editorText: "edit after refresh" }),
      messages,
      status: () => Promise.resolve(status(oldSession.id)),
      streamSnapshot: () => Promise.resolve({ seq: 0, partial: null }),
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
    await vi.waitFor(() => { expect(messages).toHaveBeenCalledOnce(); });
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
      messages: () => Promise.reject(new Error("authoritative history refresh failed")),
      status: () => Promise.resolve(status(oldSession.id)),
      streamSnapshot: () => Promise.resolve({ seq: 0, partial: null }),
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
    expect(state.error).toContain("authoritative history refresh failed");
    expect(loadDraft(cacheKey)).toBe("recovered draft");
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
      messages: () => Promise.resolve(page("authoritative branch", 1)),
      status: () => Promise.resolve(status(oldSession.id)),
      streamSnapshot: () => Promise.resolve({ seq: 0, partial: null }),
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
    expect(state.error).toContain("prompt editor replacement failed");
  });

  it("explicitly clears the editor draft when navigating to a non-user entry", async () => {
    const cacheKey = machineSessionKey("local", oldSession.id);
    saveDraft(cacheKey, "stale editor text");
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, selectedSession: oldSession, sessions: [oldSession], treeDialog: tree };
    const replacePromptEditorText = vi.fn();
    const api: typeof defaultApi = {
      ...defaultApi,
      navigateTree: () => Promise.resolve({ cancelled: false }),
      messages: () => Promise.resolve(page("selected entry", 1)),
      status: () => Promise.resolve(status(oldSession.id)),
      streamSnapshot: () => Promise.resolve({ seq: 0, partial: null }),
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
    expect(state.error).toContain("reopen /tree");

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
      messages: () => Promise.reject(new Error("history refresh failed")),
      status: () => Promise.resolve(status(oldSession.id)),
      streamSnapshot: () => Promise.resolve({ seq: 0, partial: null }),
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

    expect(state.error).toContain("history refresh failed");
    expect(state.messages).toEqual([{ role: "assistant", parts: [{ type: "text", text: "live after failed refresh" }] }]);
  });

  it("does not reopen a disposed controller when navigation settles late", async () => {
    const navigationResult = deferred<{ cancelled: false; editorText: string }>();
    const messages = vi.fn<typeof defaultApi.messages>(() => Promise.resolve(page("must not load", 1)));
    const replacePromptEditorText = vi.fn();
    let state: AppState = {
      ...initialAppState(),
      selectedWorkspace: workspace,
      selectedSession: oldSession,
      sessions: [oldSession],
      treeDialog: tree,
    };
    const api: typeof defaultApi = { ...defaultApi, navigateTree: () => navigationResult.promise, messages };
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

    expect(messages).not.toHaveBeenCalled();
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
      messages: () => {
        messageCalls += 1;
        return Promise.resolve(page(messageCalls === 1 ? "pre-navigation reselection" : "authoritative branch", 1));
      },
      status: () => Promise.resolve(status(oldSession.id)),
      streamSnapshot: () => Promise.resolve({ seq: 0, partial: null }),
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
      messages: () => {
        messageCalls += 1;
        return messageCalls === 1 ? firstRefresh.promise : Promise.resolve(page("reselected authoritative branch", 1));
      },
      status: () => Promise.resolve(status(oldSession.id)),
      streamSnapshot: () => Promise.resolve({ seq: 0, partial: null }),
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
      messages: (session) => {
        requestedMessages.push(sessionLookupId(session));
        return Promise.resolve(page("replacement authoritative", 1));
      },
      status: (session) => Promise.resolve(status(sessionLookupId(session))),
      streamSnapshot: () => Promise.resolve({ seq: 0, partial: null }),
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
    expect(state.error).toContain("needs input; open the session and run it again");
  });

  it("requires a delayed interactive tree command to be rerun after its session is no longer selected", async () => {
    const command = deferred<CommandResult>();
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, selectedSession: oldSession, sessions: [oldSession, replacementSession] };
    const api: typeof defaultApi = {
      ...defaultApi,
      runCommand: () => command.promise,
      messages: () => Promise.resolve(page("replacement", 1)),
      status: () => Promise.resolve(status(replacementSession.id)),
      streamSnapshot: () => Promise.resolve({ seq: 0, partial: null }),
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
    expect(state.error).toContain("needs input; open the session and run it again");
  });
});

function page(text: string, total: number): MessagePage {
  return { messages: [{ role: "assistant", content: text }], start: 0, total };
}
