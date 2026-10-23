import { beforeEach, describe, expect, it, vi } from "vitest";
import { initialAppState } from "../appState";
import { ChatTranscriptStore } from "../chatTranscriptStore";
import { machineSessionKey } from "../machineKeys";
import { loadDraft, saveDraft } from "../promptDraftStorage";
import type { SessionTreeSnapshot } from "../api";
import { SessionController, type SessionControllerDependencies } from "./sessionController";
import {
  defaultApi, deferred, EmitSocket, MemoryStorage, oldSession, replacementSession,
  runPendingAnimationFrames, sessionLookupId, status, transcriptSnapshotFixture, workspace,
  type AppState, type MessagePage, type SessionTranscriptSnapshot,
} from "./sessionController.testSupport";

const tree: SessionTreeSnapshot = {
  nodes: [{ id: "root", parentId: null, kind: "user", summary: "prompt" }],
  activeLeafId: "root",
  activePathIds: ["root"],
};
const sourceKey = machineSessionKey("local", oldSession.id);
const forkKey = machineSessionKey("local", replacementSession.id);

beforeEach(() => {
  Object.defineProperty(globalThis, "localStorage", { value: new MemoryStorage(), configurable: true });
});

describe("SessionController factual tree invalidation", () => {
  it("refreshes multiple observers without navigating or changing saved/live drafts; creation only adds the row", async () => {
    saveDraft(sourceKey, "saved observer draft");
    saveDraft(forkKey, "unrelated fork draft");
    let changed = false;
    const observers = [0, 1].map((index) => {
      let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, sessions: [oldSession] };
      let liveDraft = `unsent browser ${String(index)}`;
      const replacePromptEditorText = vi.fn<NonNullable<SessionControllerDependencies["replacePromptEditorText"]>>(({ text }) => { liveDraft = text; });
      const navigateToSession = vi.fn<NonNullable<SessionControllerDependencies["navigateToSession"]>>();
      const updateUrl = vi.fn();
      const socket = new EmitSocket();
      const removed: string[] = [];
      const cache = new Map<string, MessagePage>();
      const transcripts = new ChatTranscriptStore({
        read: (key) => cache.get(key), write: (key, value) => { cache.set(key, value); },
        remove: (key) => { removed.push(key); cache.delete(key); },
      });
      // A live extension command still owns its receipt after announcing the
      // change; a /tree command would be busy rather than a read snapshot.
      const runCommand = vi.fn<typeof defaultApi.runCommand>(() => Promise.resolve({ type: "unsupported", message: "Session is active" }));
      const controller = new SessionController(() => state, (patch) => { state = { ...state, ...patch }; }, updateUrl, undefined, {
        api: {
          ...defaultApi, runCommand, thinkingLevels: () => Promise.resolve({ levels: [] }),
          transcriptSnapshot: () => transcriptSnapshotFixture(page(changed ? "changed branch" : "old branch"), {
            ...status(oldSession.id), ...(changed ? { suggestedInput: "optional text" } : {}),
          }),
        },
        socket, transcripts, replacePromptEditorText, navigateToSession,
      });
      return { controller, socket, runCommand, removed, cache, replacePromptEditorText, navigateToSession, updateUrl,
        state: () => state, liveDraft: () => liveDraft, openTree: () => { state = { ...state, treeDialog: tree }; } };
    });
    await Promise.all(observers.map(({ controller }) => controller.selectSession(oldSession, { updateUrl: false })));
    observers[0]?.openTree();
    changed = true;
    for (const { controller, socket } of observers) {
      controller.applyGlobalEvent({ type: "session.created", session: replacementSession });
      socket.emit({ type: "session.tree.changed", seq: 1 });
    }
    await Promise.all(observers.map(({ controller }) => controller.refreshSelectedSession()));
    expect(observers[0]?.state().treeDialog).toBeUndefined();
    observers.forEach((observer, index) => {
      expect(observer.state().selectedSession?.id).toBe(oldSession.id);
      expect(observer.state().sessions.map((session) => session.id)).toEqual([replacementSession.id, oldSession.id]);
      expect(observer.state().messages[0]?.parts).toEqual([{ type: "text", text: "changed branch" }]);
      expect(observer.state().status?.suggestedInput).toBe("optional text");
      expect(observer.state().pendingTreeActions).toEqual([]);
      expect(observer.removed).toEqual([sourceKey]);
      expect(observer.cache.get(sourceKey)).toEqual(page("changed branch"));
      expect(observer.liveDraft()).toBe(`unsent browser ${String(index)}`);
      expect(observer.replacePromptEditorText).not.toHaveBeenCalled();
      expect(observer.navigateToSession).not.toHaveBeenCalled();
      expect(observer.updateUrl).not.toHaveBeenCalled();
      expect(observer.socket.connectedSessionIds).toEqual([oldSession.id]);
      observer.controller.dispose();
    });
    expect(observers[0]?.runCommand).not.toHaveBeenCalled();
    expect(observers[1]?.runCommand).not.toHaveBeenCalled();
    expect(loadDraft(sourceKey)).toBe("saved observer draft");
    expect(loadDraft(forkKey)).toBe("unrelated fork draft");
  });

  it("replays a change newer than a delayed join snapshot and reads the suggestion without applying it", async () => {
    saveDraft(sourceKey, "keep draft");
    const initial = deferred<SessionTranscriptSnapshot>();
    const socket = new EmitSocket();
    const replacePromptEditorText = vi.fn();
    const removed: string[] = [];
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, sessions: [oldSession] };
    const transcriptSnapshot = vi.fn<typeof defaultApi.transcriptSnapshot>()
      .mockReturnValueOnce(initial.promise)
      .mockImplementation(() => transcriptSnapshotFixture(page("authoritative branch"), { ...status(oldSession.id), suggestedInput: "latest suggestion" }, { seq: 10, partial: null }));
    const controller = new SessionController(() => state, (patch) => { state = { ...state, ...patch }; }, () => undefined, undefined, {
      api: { ...defaultApi, transcriptSnapshot, thinkingLevels: () => Promise.resolve({ levels: [] }) }, socket, replacePromptEditorText,
      transcripts: new ChatTranscriptStore({ read: () => undefined, write: () => undefined, remove: (key) => { removed.push(key); } }),
    });
    const joining = controller.selectSession(oldSession, { updateUrl: false });
    await vi.waitFor(() => { expect(transcriptSnapshot).toHaveBeenCalledOnce(); });
    socket.emit({ type: "session.tree.changed", seq: 7 });
    initial.resolve({ page: page("stale join"), status: status(oldSession.id), seq: 6, partial: null });
    await joining;
    expect(transcriptSnapshot).toHaveBeenCalledTimes(2);
    expect(removed).toEqual([sourceKey]);
    expect(state.status?.suggestedInput).toBe("latest suggestion");
    expect(state.messages[0]?.parts).toEqual([{ type: "text", text: "authoritative branch" }]);
    expect(loadDraft(sourceKey)).toBe("keep draft");
    expect(replacePromptEditorText).not.toHaveBeenCalled();
    controller.dispose();
  });

  it.each(["refresh", "reconnect"] as const)("a delayed %s and status events expose only the latest suggestion without applying it", async (trigger) => {
    const snapshot = deferred<SessionTranscriptSnapshot>();
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, sessions: [oldSession] };
    const socket = new EmitSocket();
    const replacePromptEditorText = vi.fn();
    const transcriptSnapshot = vi.fn<typeof defaultApi.transcriptSnapshot>()
      .mockImplementationOnce(() => transcriptSnapshotFixture(page("history"), status(oldSession.id)))
      .mockReturnValueOnce(snapshot.promise);
    const controller = new SessionController(() => state, (patch) => { state = { ...state, ...patch }; }, () => undefined, undefined, {
      api: { ...defaultApi, transcriptSnapshot, thinkingLevels: () => Promise.resolve({ levels: [] }) }, socket, replacePromptEditorText,
    });
    await controller.selectSession(oldSession, { updateUrl: false });
    saveDraft(sourceKey, "draft before read");
    if (trigger === "reconnect") socket.reconnect();
    const reading = controller.refreshSelectedSession();
    await vi.waitFor(() => { expect(transcriptSnapshot).toHaveBeenCalledTimes(2); });
    saveDraft(sourceKey, "typed during delayed read");
    snapshot.resolve({ page: page("history"), status: { ...status(oldSession.id), suggestedInput: "from read" }, seq: 5, partial: null });
    await reading;
    expect(state.status?.suggestedInput).toBe("from read");
    socket.emit({ type: "status.update", status: { ...status(oldSession.id), suggestedInput: "newer suggestion" }, seq: 6 });
    runPendingAnimationFrames();
    expect(state.status?.suggestedInput).toBe("newer suggestion");
    expect(loadDraft(sourceKey)).toBe("typed during delayed read");
    expect(replacePromptEditorText).not.toHaveBeenCalled();
    controller.dispose();
  });

  it.each(["session", "machine"] as const)("does not apply delayed invalidation reads after switching %s", async (destination) => {
    const snapshot = deferred<SessionTranscriptSnapshot>();
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, sessions: [oldSession, replacementSession] };
    const socket = new EmitSocket();
    const replacePromptEditorText = vi.fn();
    const transcriptSnapshot = vi.fn<typeof defaultApi.transcriptSnapshot>()
      .mockImplementationOnce(() => transcriptSnapshotFixture(page("old"), status(oldSession.id)))
      .mockReturnValueOnce(snapshot.promise)
      .mockImplementation((session) => transcriptSnapshotFixture(page("destination"), status(sessionLookupId(session))));
    const controller = new SessionController(() => state, (patch) => { state = { ...state, ...patch }; }, () => undefined, undefined, {
      api: { ...defaultApi, transcriptSnapshot, thinkingLevels: () => Promise.resolve({ levels: [] }) }, socket, replacePromptEditorText,
    });
    await controller.selectSession(oldSession, { updateUrl: false });
    state = { ...state, treeDialog: tree };
    saveDraft(sourceKey, "original draft");
    socket.emit({ type: "session.tree.changed", seq: 1 });
    const reading = controller.refreshSelectedSession();
    await vi.waitFor(() => { expect(transcriptSnapshot).toHaveBeenCalledTimes(2); });
    const remote = { id: "remote", name: "Remote", kind: "remote" as const, createdAt: "now", updatedAt: "now" };
    if (destination === "machine") {
      state = { ...state, selectedMachine: remote };
      // The retiring socket must not invalidate the new machine's same id.
      socket.emit({ type: "session.tree.changed", seq: 2 });
      expect(transcriptSnapshot).toHaveBeenCalledTimes(2);
    }
    const selected = destination === "machine" ? oldSession : replacementSession;
    const selection = controller.selectSession(selected, { updateUrl: false });
    snapshot.resolve({ page: page("stale"), status: { ...status(oldSession.id), suggestedInput: "stale suggestion" }, seq: 2, partial: null });
    await Promise.all([reading, selection]);
    expect(state.selectedSession?.id).toBe(selected.id);
    expect(state.messages[0]?.parts).toEqual([{ type: "text", text: "destination" }]);
    expect(state.treeDialog).toBeUndefined();
    expect(state.status?.suggestedInput).toBeUndefined();
    expect(loadDraft(sourceKey)).toBe("original draft");
    expect(replacePromptEditorText).not.toHaveBeenCalled();
    controller.dispose();
  });

  it("does not let a pending action in another session block the selected tree invalidation", async () => {
    const result = deferred<Awaited<ReturnType<typeof defaultApi.navigateTree>>>();
    const socket = new EmitSocket();
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, sessions: [oldSession, replacementSession] };
    const runCommand = vi.fn<typeof defaultApi.runCommand>();
    const controller = new SessionController(() => state, (patch) => { state = { ...state, ...patch }; }, () => undefined, undefined, {
      api: {
        ...defaultApi, runCommand, navigateTree: () => result.promise,
        transcriptSnapshot: (session) => transcriptSnapshotFixture(page("history"), status(sessionLookupId(session))),
        thinkingLevels: () => Promise.resolve({ levels: [] }),
      }, socket,
    });
    await controller.selectSession(oldSession, { updateUrl: false });
    state = { ...state, treeDialog: tree };
    const navigating = controller.navigateTree("root", { mode: "none" });
    await controller.selectSession(replacementSession, { updateUrl: false });
    state = { ...state, treeDialog: tree };
    socket.emit({ type: "session.tree.changed", seq: 1 });
    await controller.refreshSelectedSession();
    expect(state.treeDialog).toBeUndefined();
    expect(runCommand).not.toHaveBeenCalled();
    result.resolve({ cancelled: true });
    await navigating;
    expect(state.selectedSession?.id).toBe(replacementSession.id);
    controller.dispose();
  });

  it("keeps a session pending until its last overlapping history request settles", async () => {
    const firstResult = deferred<Awaited<ReturnType<typeof defaultApi.navigateTree>>>();
    const secondResult = deferred<Awaited<ReturnType<typeof defaultApi.navigateTree>>>();
    let state: AppState = { ...initialAppState(), selectedSession: oldSession, treeDialog: tree };
    const navigateTree = vi.fn<typeof defaultApi.navigateTree>()
      .mockReturnValueOnce(firstResult.promise).mockReturnValueOnce(secondResult.promise);
    const controller = new SessionController(() => state, (patch) => { state = { ...state, ...patch }; }, () => undefined, undefined, {
      api: { ...defaultApi, navigateTree }, socket: new EmitSocket(),
    });
    const first = controller.navigateTree("root", { mode: "none" });
    const second = controller.navigateTree("root", { mode: "none" });
    expect(state.pendingTreeActions).toHaveLength(2);
    firstResult.resolve({ cancelled: true });
    await first;
    expect(state.pendingTreeActions).toEqual([{ machineId: "local", sessionId: oldSession.id }]);
    secondResult.resolve({ cancelled: true });
    await second;
    expect(state.pendingTreeActions).toEqual([]);
    controller.dispose();
  });

  it.each(["navigate", "fork"] as const)("preserves explicit HTTP %s behavior when invalidation arrives during the action", async (action) => {
    const socket = new EmitSocket();
    const navigateResult = deferred<Awaited<ReturnType<typeof defaultApi.navigateTree>>>();
    const forkResult = deferred<Awaited<ReturnType<typeof defaultApi.forkTree>>>();
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, sessions: [oldSession] };
    const replacePromptEditorText = vi.fn();
    const runCommand = vi.fn<typeof defaultApi.runCommand>();
    const controller = new SessionController(() => state, (patch) => { state = { ...state, ...patch }; }, () => undefined, undefined, {
      api: {
        ...defaultApi, runCommand, navigateTree: () => navigateResult.promise, forkTree: () => forkResult.promise,
        transcriptSnapshot: (session) => transcriptSnapshotFixture(page("current history"), { ...status(sessionLookupId(session)),
          suggestedInput: sessionLookupId(session) === replacementSession.id ? "explicit fork" : "do not auto-use",
        }),
        thinkingLevels: () => Promise.resolve({ levels: [] }),
      }, socket, replacePromptEditorText,
    });
    await controller.selectSession(oldSession, { updateUrl: false });
    state = { ...state, treeDialog: tree };
    saveDraft(sourceKey, "original unsent draft");
    const acting = action === "navigate" ? controller.navigateTree("root", { mode: "none" }) : controller.forkFromTree("root");
    socket.emit({ type: "session.tree.changed", seq: 1 });
    await controller.refreshSelectedSession();
    expect(state.treeDialog).toBe(tree);
    expect(loadDraft(sourceKey)).toBe("original unsent draft");
    expect(replacePromptEditorText).not.toHaveBeenCalled();
    navigateResult.resolve({ cancelled: false, editorText: "explicit rewind" });
    forkResult.resolve({ cancelled: false, session: replacementSession, promptDraft: "explicit fork" });
    await acting;
    expect(runCommand).not.toHaveBeenCalled();
    expect(state.treeDialog).toBeUndefined();
    if (action === "navigate") {
      expect(state.selectedSession?.id).toBe(oldSession.id);
      expect(loadDraft(sourceKey)).toBe("explicit rewind");
      expect(replacePromptEditorText).toHaveBeenCalledWith({ machineId: "local", sessionId: oldSession.id, text: "explicit rewind" });
    } else {
      expect(state.selectedSession?.id).toBe(replacementSession.id);
      expect(loadDraft(sourceKey)).toBe("original unsent draft");
      expect(loadDraft(forkKey)).toBe("explicit fork");
    }
    controller.dispose();
  });
});

describe("SessionController go-back editor restoration", () => {
  it.each(["before response", "after refresh"] as const)("restores an empty composer without waiting for history or overwriting later edits when status arrives %s", async (arrival) => {
    const navigation = deferred<Awaited<ReturnType<typeof defaultApi.navigateTree>>>();
    const refresh = deferred<SessionTranscriptSnapshot>();
    const socket = new EmitSocket();
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, sessions: [oldSession] };
    let liveDraft = "";
    const replacePromptEditorText = vi.fn<NonNullable<SessionControllerDependencies["replacePromptEditorText"]>>(({ text }) => { liveDraft = text; });
    const navigateTree = vi.fn<typeof defaultApi.navigateTree>(() => navigation.promise);
    const transcriptSnapshot = vi.fn<typeof defaultApi.transcriptSnapshot>()
      .mockImplementationOnce(() => transcriptSnapshotFixture(page("old branch"), status(oldSession.id)))
      .mockReturnValue(refresh.promise);
    const controller = new SessionController(() => state, (patch) => { state = { ...state, ...patch }; }, () => undefined, undefined, {
      api: { ...defaultApi, navigateTree, transcriptSnapshot,
        runCommand: () => Promise.resolve({ type: "tree", tree }), thinkingLevels: () => Promise.resolve({ levels: [] }),
      }, socket, replacePromptEditorText,
    });
    await controller.selectSession(oldSession, { updateUrl: false });
    expect(loadDraft(sourceKey)).toBe("");
    const acting = controller.actOnMessage("root", "back");
    await vi.waitFor(() => { expect(navigateTree).toHaveBeenCalledOnce(); });
    expect(state.pendingTreeActions).toEqual([{ machineId: "local", sessionId: oldSession.id }]);
    const suggestion = { ...status(oldSession.id), suggestedInput: "original prompt" };
    if (arrival === "before response") {
      socket.emit({ type: "status.update", status: suggestion, seq: 1 });
      runPendingAnimationFrames();
      expect(state.status?.suggestedInput).toBe("original prompt");
      expect(replacePromptEditorText).not.toHaveBeenCalled();
    }
    navigation.resolve({ cancelled: false, editorText: "original prompt" });
    await vi.waitFor(() => {
      expect(transcriptSnapshot).toHaveBeenCalledTimes(2);
    });
    // The transcript read is still unresolved, but the empty composer is restored.
    expect(loadDraft(sourceKey)).toBe("original prompt");
    expect(replacePromptEditorText).toHaveBeenCalledExactlyOnceWith({ machineId: "local", sessionId: oldSession.id, text: "original prompt" });
    expect(state.pendingTreeActions).toEqual([{ machineId: "local", sessionId: oldSession.id }]);
    expect(liveDraft).toBe("original prompt");
    liveDraft = "typed while history was loading";
    saveDraft(sourceKey, liveDraft);
    refresh.resolve({ page: page("new branch"), status: arrival === "before response" ? suggestion : status(oldSession.id), seq: 2, partial: null });
    await acting;
    expect(state.pendingTreeActions).toEqual([]);
    expect(liveDraft).toBe("typed while history was loading");
    expect(loadDraft(sourceKey)).toBe(liveDraft);
    socket.emit({ type: "status.update", status: suggestion, seq: 3 });
    runPendingAnimationFrames();
    // Status remains authoritative without replacing subsequent composer edits.
    expect(state.status?.suggestedInput).toBe("original prompt");
    expect(liveDraft).toBe("typed while history was loading");
    expect(loadDraft(sourceKey)).toBe(liveDraft);
    expect(replacePromptEditorText).toHaveBeenCalledOnce();
    controller.dispose();
  });

});

function page(text: string): MessagePage {
  return { messages: [{ role: "assistant", content: text }], start: 0, total: 1 };
}
