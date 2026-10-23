import { describe, expect, it, vi } from "vitest";
import { initialAppState } from "../appState";
import type { SessionInfo, SessionTranscriptSnapshot } from "../api";
import { ChatTranscriptStore } from "../chatTranscriptStore";
import { SessionController } from "./sessionController";
import { InMemorySessionSelectionMemory } from "./sessionSelection";
import { WorkspaceController } from "./workspaceController";
import { defaultApi, deferred, emptyPage, FakeSocket, oldSession, replacementSession, status, workspace, type AppState } from "./sessionController.testSupport";

function harness(initiallyVisible = false) {
  let visible = initiallyVisible;
  let state: AppState = {
    ...initialAppState(),
    selectedProject: { id: workspace.projectId, name: "Project", path: workspace.path, createdAt: "now" },
    selectedWorkspace: workspace, sessions: [oldSession, replacementSession],
  };
  const setState = (patch: Partial<AppState>) => { state = { ...state, ...patch }; };
  const snapshot = deferred<SessionTranscriptSnapshot>();
  const api: typeof defaultApi = {
    ...defaultApi,
    sessions: vi.fn().mockResolvedValue([oldSession, replacementSession]),
    transcriptSnapshot: vi.fn(() => snapshot.promise),
    messages: vi.fn().mockResolvedValue(emptyPage),
    thinkingLevels: vi.fn().mockResolvedValue({ levels: [] }),
  };
  const cache = { read: vi.fn(), write: vi.fn(), remove: vi.fn() };
  const notifications = {
    prepareSelectedSession: vi.fn(), clearSelectedSession: vi.fn(),
    refreshSelectedSession: vi.fn().mockResolvedValue(undefined), applyInboxEvent: vi.fn(),
  };
  const socket = new FakeSocket();
  const memory = new InMemorySessionSelectionMemory();
  const updateUrl = vi.fn();
  const ready = vi.fn();
  const controller = new SessionController(() => state, setState, updateUrl, memory, {
    api, socket, notifications, transcripts: new ChatTranscriptStore(cache),
    isChatVisible: () => visible, onSelectedSessionReady: ready,
  });
  return {
    controller, api, cache, notifications, socket, memory, updateUrl, ready, snapshot,
    state: () => state, setState, showChat: () => { visible = true; }, hideChat: () => { visible = false; },
  };
}

function snapshot(session: SessionInfo): SessionTranscriptSnapshot {
  return { page: { messages: [{ role: "assistant", content: session.id }], start: 0, total: 1 }, status: status(session.id), seq: 0, partial: null };
}

describe("SessionController deferred chat loading", () => {
  it.each([false, true])("finishes workspace selection before joining Chat, including side-by-side layouts (Chat visible: %s)", async (visible) => {
    const test = harness(visible);
    test.memory.rememberSession({ ...oldSession, cwd: `local:${workspace.path}` });
    const workspaces = new WorkspaceController(test.state, test.setState, test.updateUrl, test.controller, undefined, { api: test.api });

    await expect(workspaces.selectWorkspace(workspace)).resolves.toBeUndefined();

    expect(test.state().sessions).toEqual([oldSession, replacementSession]);
    expect(test.state().selectedSession).toEqual(oldSession);
    expect(test.memory.latestSessionId(`local:${workspace.path}`)).toBe(oldSession.id);
    expect(test.updateUrl).toHaveBeenCalledOnce();
    expect(test.cache.read).not.toHaveBeenCalled();
    expect(test.api.transcriptSnapshot).not.toHaveBeenCalled();
    expect(test.notifications.prepareSelectedSession).not.toHaveBeenCalled();
    expect(test.notifications.refreshSelectedSession).not.toHaveBeenCalled();
    expect(test.socket.connectedSessionIds).toEqual([]);
    expect(test.ready).not.toHaveBeenCalled();

    expect(test.controller.isChatLoadDeferred).toBe(true);
    if (!visible) await test.controller.loadSelectedSession();
    await test.controller.refreshSelectedSession(undefined, { recoverNetwork: true });
    expect(test.api.transcriptSnapshot).not.toHaveBeenCalled();

    test.showChat();
    const loading = test.controller.loadSelectedSession();
    await test.controller.loadSelectedSession();
    await Promise.resolve();
    expect(test.socket.connectedSessionIds).toEqual([oldSession.id]);
    expect(test.api.transcriptSnapshot).toHaveBeenCalledOnce();
    expect(test.notifications.prepareSelectedSession).toHaveBeenCalledOnce();
    expect(test.cache.read).toHaveBeenCalled();
    expect(test.ready).not.toHaveBeenCalled();
    test.snapshot.resolve(snapshot(oldSession));
    await loading;
    expect(test.state().messages[0]?.parts).toEqual([{ type: "text", text: oldSession.id }]);
    expect(test.ready).toHaveBeenCalledWith({ machineId: "local", session: oldSession });
    // Revealing Chat does not republish the workspace's already-restored URL.
    expect(test.updateUrl).toHaveBeenCalledOnce();
  });

  it("loads only the latest hidden selection and does not retain a completed route's freshness token", async () => {
    const test = harness();
    let current = true;
    await test.controller.selectSession(oldSession, { navigation: { generation: 1, scope: ["session"], isCurrent: () => current } });
    current = false;
    expect(test.controller.canReuseSelectedSession()).toBe(true);
    await test.controller.selectSession(replacementSession);
    test.showChat();
    test.snapshot.resolve(snapshot(replacementSession));
    await test.controller.loadSelectedSession();

    expect(test.socket.connectedSessionIds).toEqual([replacementSession.id]);
    expect(test.state().selectedSession?.id).toBe(replacementSession.id);
    expect(test.state().messages[0]?.parts).toEqual([{ type: "text", text: replacementSession.id }]);
  });

  it("does not let a previous visible join overwrite a newer deferred selection", async () => {
    const test = harness(true);
    const previousJoin = test.controller.selectSession(oldSession);
    await Promise.resolve();
    test.hideChat();
    await test.controller.selectSession(replacementSession);
    test.snapshot.resolve(snapshot(oldSession));
    await previousJoin;

    expect(test.state().selectedSession?.id).toBe(replacementSession.id);
    expect(test.state().messages).toEqual([]);
    expect(test.ready).not.toHaveBeenCalled();
  });

  it.each(["clear", "dispose"] as const)("does not revive a deferred selection after %s", async (operation) => {
    const test = harness();
    await test.controller.selectSession(oldSession);
    if (operation === "clear") test.controller.clearActiveSession();
    else test.controller.dispose();
    test.showChat();
    await test.controller.loadSelectedSession();
    expect(test.api.transcriptSnapshot).not.toHaveBeenCalled();
    expect(test.socket.connectedSessionIds).toEqual([]);
  });

  it("defers archived history until Chat is shown without opening a live socket", async () => {
    const test = harness();
    const archived = { ...oldSession, archived: true };
    await test.controller.selectSession(archived);
    expect(test.api.messages).not.toHaveBeenCalled();
    expect(test.ready).not.toHaveBeenCalled();
    test.showChat();
    await test.controller.refreshSelectedSession();
    expect(test.api.messages).not.toHaveBeenCalled();
    await test.controller.loadSelectedSession();
    expect(test.api.messages).toHaveBeenCalledWith(archived, { limit: 100 }, "local");
    expect(test.socket.connectedSessionIds).toEqual([]);
    expect(test.ready).toHaveBeenCalledWith({ machineId: "local", session: archived });
  });

  it("binds a deferred join to the current machine even when its session id matches the old machine", async () => {
    const test = harness();
    await test.controller.selectSession(oldSession);
    test.controller.clearActiveSession();
    test.setState({ selectedMachine: { id: "remote", name: "Remote", kind: "remote", createdAt: "now", updatedAt: "now" } });
    await test.controller.selectSession(oldSession);
    test.showChat();
    test.snapshot.resolve(snapshot(oldSession));
    await test.controller.loadSelectedSession();

    expect(test.api.transcriptSnapshot).toHaveBeenCalledExactlyOnceWith(oldSession, { limit: 100 }, "remote");
    expect(test.ready).toHaveBeenCalledWith({ machineId: "remote", session: oldSession });
  });

  it("does not automatically retry a failed reveal on subsequent render hooks", async () => {
    const test = harness();
    await test.controller.selectSession(oldSession);
    test.showChat();
    const loading = test.controller.loadSelectedSession();
    test.snapshot.reject(new Error("Transcript unavailable"));
    await loading;
    await test.controller.loadSelectedSession();

    expect(test.api.transcriptSnapshot).toHaveBeenCalledOnce();
    expect(test.ready).not.toHaveBeenCalled();
    expect(Object.values(test.state().browserErrors).some((error) => error.message.includes("Transcript unavailable"))).toBe(true);
  });

  it("keeps visible Chat's existing eager join", async () => {
    const test = harness(true);
    test.snapshot.resolve(snapshot(oldSession));
    await test.controller.selectSession(oldSession);
    expect(test.api.transcriptSnapshot).toHaveBeenCalledOnce();
    expect(test.socket.connectedSessionIds).toEqual([oldSession.id]);
    expect(test.ready).toHaveBeenCalledOnce();
  });
});
