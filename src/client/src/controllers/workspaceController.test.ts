import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppState } from "../appState";
import { initialAppState } from "../appState";
import type { Machine, MessagePage, Project, SessionInfo, SessionRef, Workspace } from "../api";
import type { SessionController } from "./sessionController";
import { WorkspaceController } from "./workspaceController";

function machine(id: string): Machine {
  return { id, name: id, kind: id === "local" ? "local" : "remote", createdAt: "now", updatedAt: "now" };
}

function project(id: string, path: string): Project {
  return { id, name: id, path, createdAt: "now" };
}

function workspace(projectId: string, path: string, options: Partial<Workspace> = {}): Workspace {
  return {
    id: path,
    projectId,
    path,
    label: path,
    isMain: false,
    effectiveConfig: {},
    ...options,
  };
}

function session(cwd: string, id = "s1"): SessionInfo {
  return { id, cwd, path: `${cwd}/.sessions/${id}`, created: "now", modified: "now", messageCount: 1, firstMessage: "hello" };
}

function requireWorkspaceProvider(workspace: Workspace): NonNullable<Workspace["provider"]> {
  if (workspace.provider === undefined) throw new Error("Expected workspace provider");
  return workspace.provider;
}

type LoadWorkspaces = (projectId: string, machineId?: string) => Promise<Workspace[]>;

interface Harness {
  controller: WorkspaceController;
  state: () => AppState;
  clearActiveSession: ReturnType<typeof vi.fn>;
  preferredSession: ReturnType<typeof vi.fn>;
  selectSession: ReturnType<typeof vi.fn>;
  updateUrl: ReturnType<typeof vi.fn>;
  backgroundErrors: { message: string; error: unknown }[];
  setState: (patch: Partial<AppState>) => void;
}

function harness(
  initial: Partial<AppState>,
  loadWorkspaces: LoadWorkspaces,
  options: { topologyRefreshDebounceMs?: number; loadSessions?: (path: string, machineId?: string) => Promise<SessionInfo[]>; loadMessages?: (session: SessionRef, opts?: { limit?: number; before?: number }, machineId?: string) => Promise<MessagePage> } = {},
): Harness {
  let state: AppState = { ...initialAppState(), ...initial };
  const setState = (patch: Partial<AppState>) => { state = { ...state, ...patch }; };
  const clearActiveSession = vi.fn();
  const preferredSession = vi.fn();
  const selectSession = vi.fn();
  const sessions: Pick<SessionController, "clearActiveSession" | "preferredSession" | "selectSession"> = {
    clearActiveSession,
    preferredSession,
    selectSession,
  };
  const updateUrl = vi.fn();
  const backgroundErrors: { message: string; error: unknown }[] = [];
  const controller = new WorkspaceController(
    () => state,
    setState,
    updateUrl,
    sessions,
    undefined,
    {
      api: {
        workspaces: loadWorkspaces,
        sessions: options.loadSessions ?? vi.fn<(path: string, machineId?: string) => Promise<SessionInfo[]>>().mockResolvedValue([]),
        // Default: every transcript probe refuses, so unrelated tests keep the pre-probe behavior.
        messages: options.loadMessages ?? vi.fn<(session: SessionRef, opts?: { limit?: number; before?: number }, machineId?: string) => Promise<MessagePage>>().mockRejectedValue(new Error("session not found")),
      },
      onBackgroundError: (message, error) => { backgroundErrors.push({ message, error }); },
      topologyRefreshDebounceMs: options.topologyRefreshDebounceMs ?? 0,
    },
  );
  return { controller, state: () => state, clearActiveSession, preferredSession, selectSession, updateUrl, backgroundErrors, setState };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("WorkspaceController.refreshSelectedProjectTopology", () => {
  it("surfaces a worktree created outside PI WEB in both the selected list and the per-project cache", async () => {
    const repo = project("p1", "/repo");
    const main = workspace(repo.id, repo.path, { isMain: true });
    const created = workspace(repo.id, "/repo-feature");
    const loadWorkspaces = vi.fn().mockResolvedValue([main, created]);
    const test = harness(
      {
        selectedMachine: machine("local"),
        projects: [repo],
        selectedProject: repo,
        selectedWorkspace: main,
        workspaces: [main],
        workspacesByProjectId: { [repo.id]: [main] },
      },
      loadWorkspaces,
    );

    await test.controller.refreshSelectedProjectTopology();

    expect(loadWorkspaces).toHaveBeenCalledWith(repo.id, "local");
    expect(test.state().workspaces).toEqual([main, created]);
    expect(test.state().workspacesByProjectId[repo.id]).toEqual([main, created]);
  });

  it("preserves the selection and workspace-scoped state when the selected workspace still exists", async () => {
    const repo = project("p1", "/repo");
    const main = workspace(repo.id, repo.path, { isMain: true });
    const selected = workspace(repo.id, "/repo-feature");
    const loadWorkspaces = vi.fn().mockResolvedValue([main, selected, workspace(repo.id, "/repo-other")]);
    const test = harness(
      {
        selectedMachine: machine("local"),
        projects: [repo],
        selectedProject: repo,
        selectedWorkspace: selected,
        workspaces: [main, selected],
        workspacesByProjectId: { [repo.id]: [main, selected] },
        selectedSession: session(selected.path),
        sessions: [session(selected.path)],
        selectedFilePath: "src/index.ts",
        expandedDirs: { src: [] },
        selectedTerminalId: "t1",
      },
      loadWorkspaces,
    );
    const before = test.state();

    await test.controller.refreshSelectedProjectTopology();

    const after = test.state();
    expect(after.selectedWorkspace).toBe(selected);
    expect(after.selectedSession).toBe(before.selectedSession);
    expect(after.sessions).toBe(before.sessions);
    expect(after.selectedFilePath).toBe("src/index.ts");
    expect(after.expandedDirs).toBe(before.expandedDirs);
    expect(after.selectedTerminalId).toBe("t1");
    expect(test.clearActiveSession).not.toHaveBeenCalled();
    expect(test.updateUrl).not.toHaveBeenCalled();
  });

  it("leaves the selection alone when the selected workspace disappeared", async () => {
    const repo = project("p1", "/repo");
    const main = workspace(repo.id, repo.path, { isMain: true });
    const removed = workspace(repo.id, "/repo-gone");
    const loadWorkspaces = vi.fn().mockResolvedValue([main]);
    const test = harness(
      {
        selectedMachine: machine("local"),
        projects: [repo],
        selectedProject: repo,
        selectedWorkspace: removed,
        workspaces: [main, removed],
        workspacesByProjectId: { [repo.id]: [main, removed] },
      },
      loadWorkspaces,
    );

    await test.controller.refreshSelectedProjectTopology();

    expect(test.state().selectedWorkspace).toBe(removed);
    expect(test.state().workspaces).toEqual([main]);
    expect(test.clearActiveSession).not.toHaveBeenCalled();
  });

  it("discards a response for a project the user has since left", async () => {
    const repo = project("p1", "/repo");
    const other = project("p2", "/other");
    const main = workspace(repo.id, repo.path, { isMain: true });
    const created = workspace(repo.id, "/repo-feature");
    let resolveWorkspaces: ((workspaces: Workspace[]) => void) | undefined;
    const loadWorkspaces = vi.fn().mockReturnValue(new Promise<Workspace[]>((resolve) => { resolveWorkspaces = resolve; }));
    const test = harness(
      {
        selectedMachine: machine("local"),
        projects: [repo, other],
        selectedProject: repo,
        selectedWorkspace: main,
        workspaces: [main],
        workspacesByProjectId: { [repo.id]: [main] },
      },
      loadWorkspaces,
    );

    const pending = test.controller.refreshSelectedProjectTopology();
    test.setState({ selectedProject: other, selectedWorkspace: undefined, workspaces: [] });
    resolveWorkspaces?.([main, created]);
    await pending;

    expect(test.state().workspaces).toEqual([]);
    expect(test.state().workspacesByProjectId[repo.id]).toEqual([main]);
  });

  it("discards a response after the selected machine changed", async () => {
    const repo = project("p1", "/repo");
    const main = workspace(repo.id, repo.path, { isMain: true });
    let resolveWorkspaces: ((workspaces: Workspace[]) => void) | undefined;
    const loadWorkspaces = vi.fn().mockReturnValue(new Promise<Workspace[]>((resolve) => { resolveWorkspaces = resolve; }));
    const test = harness(
      {
        selectedMachine: machine("local"),
        projects: [repo],
        selectedProject: repo,
        selectedWorkspace: main,
        workspaces: [main],
        workspacesByProjectId: { [repo.id]: [main] },
      },
      loadWorkspaces,
    );

    const pending = test.controller.refreshSelectedProjectTopology();
    test.setState({ selectedMachine: machine("remote") });
    resolveWorkspaces?.([main, workspace(repo.id, "/repo-feature")]);
    await pending;

    expect(test.state().workspaces).toEqual([main]);
    expect(test.state().workspacesByProjectId[repo.id]).toEqual([main]);
  });

  it("reports a failed refresh to the background error sink without painting an error banner", async () => {
    const repo = project("p1", "/repo");
    const main = workspace(repo.id, repo.path, { isMain: true });
    const failure = new Error("git worktree list failed");
    const loadWorkspaces = vi.fn().mockRejectedValue(failure);
    const test = harness(
      {
        selectedMachine: machine("local"),
        projects: [repo],
        selectedProject: repo,
        selectedWorkspace: main,
        workspaces: [main],
        workspacesByProjectId: { [repo.id]: [main] },
      },
      loadWorkspaces,
    );

    await test.controller.refreshSelectedProjectTopology();

    expect(test.state().error).toBe("");
    expect(test.state().workspaces).toEqual([main]);
    expect(test.backgroundErrors).toEqual([{ message: `Failed to refresh workspaces for project ${repo.id} on local`, error: failure }]);
  });

  it("re-points the selected workspace when its provider-authored label changed outside PI WEB", async () => {
    const repo = project("p1", "/repo");
    const main = workspace(repo.id, repo.path, { isMain: true });
    const selected = { ...workspace(repo.id, "/repo-feature"), label: "feature-a" };
    const switched = { ...selected, label: "feature-b" };
    const loadWorkspaces = vi.fn().mockResolvedValue([main, switched]);
    const test = harness(
      {
        selectedMachine: machine("local"),
        projects: [repo],
        selectedProject: repo,
        selectedWorkspace: selected,
        workspaces: [main, selected],
        workspacesByProjectId: { [repo.id]: [main, selected] },
        selectedSession: session(selected.path),
      },
      loadWorkspaces,
    );

    await test.controller.refreshSelectedProjectTopology();

    // Same workspace (same id/path), so the session must survive; only the stale label moves.
    expect(test.state().selectedWorkspace).toEqual(switched);
    expect(test.state().selectedWorkspace?.id).toBe(selected.id);
    expect(test.state().selectedSession).toBeDefined();
    expect(test.clearActiveSession).not.toHaveBeenCalled();
  });

  it.each([
    {
      field: "provider id",
      refresh: (selected: Workspace): Workspace => ({
        ...selected,
        provider: { ...requireWorkspaceProvider(selected), pluginId: "replacement" },
      }),
    },
    {
      field: "provider request capability",
      refresh: (selected: Workspace): Workspace => ({
        ...selected,
        provider: {
          ...requireWorkspaceProvider(selected),
          capabilities: { ...requireWorkspaceProvider(selected).capabilities, request: true },
        },
      }),
    },
    {
      field: "provider remove capability",
      refresh: (selected: Workspace): Workspace => ({
        ...selected,
        provider: {
          ...requireWorkspaceProvider(selected),
          capabilities: { ...requireWorkspaceProvider(selected).capabilities, remove: true },
        },
      }),
    },
    {
      field: "provider public metadata",
      refresh: (selected: Workspace): Workspace => ({
        ...selected,
        provider: {
          ...requireWorkspaceProvider(selected),
          metadata: { nested: { marker: "current" }, list: [1, true] },
        },
      }),
    },
    {
      field: "effective config",
      refresh: (selected: Workspace): Workspace => ({
        ...selected,
        effectiveConfig: { uploads: { defaultFolder: "current-uploads" } },
      }),
    },
  ])("refreshes changed $field without resetting the selected session", async ({ refresh }) => {
    const repo = project("p1", "/repo");
    const main = workspace(repo.id, repo.path, { isMain: true });
    const selected = workspace(repo.id, "/repo-feature", {
      provider: {
        pluginId: "owner",
        capabilities: { request: false, remove: false },
        metadata: { nested: { marker: "old" }, list: [1, true] },
      },
      effectiveConfig: { uploads: { defaultFolder: "old-uploads" } },
    });
    const refreshed = refresh(selected);
    const test = harness(
      {
        selectedMachine: machine("local"),
        projects: [repo],
        selectedProject: repo,
        selectedWorkspace: selected,
        workspaces: [main, selected],
        workspacesByProjectId: { [repo.id]: [main, selected] },
        selectedSession: session(selected.path),
      },
      vi.fn().mockResolvedValue([main, refreshed]),
    );

    await test.controller.refreshSelectedProjectTopology();

    expect(test.state().selectedWorkspace).toBe(refreshed);
    expect(test.state().selectedSession).toBeDefined();
    expect(test.clearActiveSession).not.toHaveBeenCalled();
  });

  it("refreshes a changed removal precondition without resetting the selected session", async () => {
    const repo = project("p1", "/repo");
    const main = workspace(repo.id, repo.path, { isMain: true });
    const selected = workspace(repo.id, "/repo-feature", {
      removal: { actionLabel: "Disconnect", confirmation: "Disconnect old view?", precondition: "old-removal" },
    });
    const refreshed = {
      ...selected,
      removal: { actionLabel: "Disconnect", confirmation: "Disconnect old view?", precondition: "current-removal" },
    };
    const test = harness(
      {
        selectedMachine: machine("local"),
        projects: [repo],
        selectedProject: repo,
        selectedWorkspace: selected,
        workspaces: [main, selected],
        workspacesByProjectId: { [repo.id]: [main, selected] },
        selectedSession: session(selected.path),
      },
      vi.fn().mockResolvedValue([main, refreshed]),
    );

    await test.controller.refreshSelectedProjectTopology();

    expect(test.state().selectedWorkspace).toEqual(refreshed);
    expect(test.state().selectedSession).toBeDefined();
    expect(test.clearActiveSession).not.toHaveBeenCalled();
  });

  it("leaves the selected workspace object untouched when the refresh returns an identical snapshot", async () => {
    const repo = project("p1", "/repo");
    const main = workspace(repo.id, repo.path, { isMain: true });
    const selected = workspace(repo.id, "/repo-feature", {
      provider: {
        pluginId: "owner",
        capabilities: { request: true, remove: true },
        metadata: { nested: [1, { ready: true }] },
      },
      removal: { actionLabel: "Disconnect", confirmation: "Disconnect?", precondition: "v1.current" },
      effectiveConfig: { uploads: { defaultFolder: "uploads" } },
    });
    // Fresh, deeply equal objects, exactly what a real HTTP response produces every resume.
    const equalSelected = workspace(repo.id, "/repo-feature", {
      provider: {
        pluginId: "owner",
        capabilities: { request: true, remove: true },
        metadata: { nested: [1, { ready: true }] },
      },
      removal: { actionLabel: "Disconnect", confirmation: "Disconnect?", precondition: "v1.current" },
      effectiveConfig: { uploads: { defaultFolder: "uploads" } },
    });
    const loadWorkspaces = vi.fn().mockResolvedValue([{ ...main }, equalSelected]);
    const test = harness(
      {
        selectedMachine: machine("local"),
        projects: [repo],
        selectedProject: repo,
        selectedWorkspace: selected,
        workspaces: [main, selected],
        workspacesByProjectId: { [repo.id]: [main, selected] },
      },
      loadWorkspaces,
    );

    await test.controller.refreshSelectedProjectTopology();

    // Identity preserved: an unchanged resume must not churn selected-workspace identity
    // into state, or every focus would re-render surfaces keyed on this object.
    expect(test.state().selectedWorkspace).toBe(selected);
  });

  it("debounces rapid topology refresh bursts before opening a request", async () => {
    vi.useFakeTimers();
    const repo = project("p1", "/repo");
    const main = workspace(repo.id, repo.path, { isMain: true });
    const loadWorkspaces = vi.fn().mockResolvedValue([main]);
    const test = harness(
      {
        selectedMachine: machine("local"),
        projects: [repo],
        selectedProject: repo,
        selectedWorkspace: main,
        workspaces: [main],
        workspacesByProjectId: { [repo.id]: [main] },
      },
      loadWorkspaces,
      { topologyRefreshDebounceMs: 25 },
    );

    const resumeRefresh = test.controller.refreshSelectedProjectTopology();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(20);
    const appDataRefresh = test.controller.refreshSelectedProjectTopology();
    await vi.advanceTimersByTimeAsync(24);

    expect(loadWorkspaces).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await Promise.all([resumeRefresh, appDataRefresh]);

    expect(loadWorkspaces).toHaveBeenCalledOnce();
  });

  it("serializes overlapping refreshes so an earlier response cannot overwrite a newer list", async () => {
    const repo = project("p1", "/repo");
    const main = workspace(repo.id, repo.path, { isMain: true });
    const created = workspace(repo.id, "/repo-feature");
    const gates: ((workspaces: Workspace[]) => void)[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const loadWorkspaces = vi.fn(() => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      return new Promise<Workspace[]>((resolve) => {
        gates.push((workspaces) => { inFlight -= 1; resolve(workspaces); });
      });
    });
    const test = harness(
      {
        selectedMachine: machine("local"),
        projects: [repo],
        selectedProject: repo,
        selectedWorkspace: main,
        workspaces: [main],
        workspacesByProjectId: { [repo.id]: [main] },
      },
      loadWorkspaces,
    );

    const resumeRefresh = test.controller.refreshSelectedProjectTopology();
    await Promise.resolve();
    const appDataRefresh = test.controller.refreshSelectedProjectTopology();
    await Promise.resolve();

    // The second caller does not open its own request while the first is in flight; it gets
    // one trailing pass afterwards. Without this, two responses race and the slower-but-older
    // one can land last, making a just-created worktree disappear again.
    expect(maxInFlight).toBe(1);
    gates[0]?.([main]);
    await vi.waitFor(() => { expect(gates).toHaveLength(2); });
    gates[1]?.([main, created]);
    await Promise.all([resumeRefresh, appDataRefresh]);

    // The last response wins, so the newly created worktree stays visible.
    expect(test.state().workspaces).toEqual([main, created]);
  });

  it("does not request anything when no project is selected", async () => {
    const loadWorkspaces = vi.fn();
    const test = harness({ selectedMachine: machine("local") }, loadWorkspaces);

    await test.controller.refreshSelectedProjectTopology();

    expect(loadWorkspaces).not.toHaveBeenCalled();
  });
});

describe("WorkspaceController.selectWorkspace deep-link fallback", () => {
  it("selects a session absent from the fetched list when the transcript probe confirms content", async () => {
    const repo = project("p1", "/repo");
    const ws = workspace(repo.id, "/repo", { isMain: true });
    const messages = vi.fn().mockResolvedValue({ messages: [{ role: "assistant" }], start: 41, total: 42 });
    const test = harness(
      { selectedMachine: machine("local"), projects: [repo], selectedProject: repo, workspaces: [ws], workspacesByProjectId: { [repo.id]: [ws] } },
      vi.fn().mockResolvedValue([ws]),
      { loadSessions: vi.fn<(path: string, machineId?: string) => Promise<SessionInfo[]>>().mockResolvedValue([session("/repo", "listed-1")]), loadMessages: messages },
    );
    // The mocked preferredSession returns undefined: the deep-linked session is not in the fetched list.

    await test.controller.selectWorkspace(ws, { sessionId: "deep-target", updateUrl: false });

    expect(messages).toHaveBeenCalledWith({ id: "deep-target", cwd: "/repo" }, { limit: 1 }, "local");
    expect(test.selectSession).toHaveBeenCalledTimes(1);
    expect(test.selectSession.mock.calls[0]?.[0]).toMatchObject({ id: "deep-target", cwd: "/repo", messageCount: 42, persisted: true });
  });

  it("keeps the old dead-end behavior when the probe cannot confirm the session", async () => {
    const repo = project("p1", "/repo");
    const ws = workspace(repo.id, "/repo", { isMain: true });
    const test = harness(
      { selectedMachine: machine("local"), projects: [repo], selectedProject: repo, workspaces: [ws], workspacesByProjectId: { [repo.id]: [ws] } },
      vi.fn().mockResolvedValue([ws]),
      { loadSessions: vi.fn<(path: string, machineId?: string) => Promise<SessionInfo[]>>().mockResolvedValue([]) },
    );

    await test.controller.selectWorkspace(ws, { sessionId: "ghost-target", updateUrl: false });

    expect(test.selectSession).not.toHaveBeenCalled();
    expect(test.updateUrl).not.toHaveBeenCalled();
    expect(test.state().selectedSession).toBeUndefined();
  });
});
