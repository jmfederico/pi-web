import { html } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { DeleteWorkspaceFileResponse, FileContentResponse, FileTreeResponse, JsonValue, MoveWorkspaceFileResponse, SessionInfo, SessionStatus, WriteWorkspaceFileResponse, Workspace } from "../api";
import { initialAppState, type AppState } from "../appState";
import { markCachedNewSessionInfo } from "../cachedNewSessions";
import { machineScopedPluginId } from "../../../shared/machinePluginIds";
import { corePlugin } from "./core";
import { PluginRegistry, installWorkspaceLabelScope, installWorkspacePanelScope } from "./registry";
import { themePackPlugin } from "./themes";
import type { PiWebPlugin, PluginRuntimeContext, ThemeTokens, WorkspaceFiles, WorkspaceHost, WorkspaceLabelContext, WorkspaceLabelItem, WorkspacePanelContext, WorkspacePluginBinding } from "./types";
import { createPluginWorkspaceBackend } from "./workspaceBackend";
import type { PluginBackendRequestTarget } from "../api/pluginBackends";

function createContext(statePatch: Partial<AppState> = {}) {
  const calls: string[] = [];
  const context: PluginRuntimeContext = {
    state: { ...initialAppState(), ...statePatch },
    prompt: {
      insertText: vi.fn(),
      getText: vi.fn(() => ""),
      getSelection: vi.fn(() => null),
    },
    piWebUnstable: {
      terminalCommandRuns: {
        runCommand: vi.fn(),
        listCommandRuns: vi.fn(),
        getCommandRun: vi.fn(),
        open: vi.fn((options?: { terminalId?: string | undefined }) => { calls.push(`terminal.open:${options?.terminalId ?? ""}`); }),
      },
      openSettings: vi.fn(() => { calls.push("openSettings"); }),
    },
    openActionPalette: vi.fn(() => { calls.push("openActionPalette"); }),
    focusPrompt: vi.fn(() => { calls.push("focusPrompt"); }),
    addProject: vi.fn(() => { calls.push("addProject"); }),
    addMachine: vi.fn(() => { calls.push("addMachine"); }),
    refreshSelectedMachine: vi.fn(() => { calls.push("refreshSelectedMachine"); }),
    removeSelectedMachine: vi.fn(() => { calls.push("removeSelectedMachine"); }),
    openSelectedMachine: vi.fn(() => { calls.push("openSelectedMachine"); }),
    configureAuth: vi.fn(() => { calls.push("configureAuth"); }),
    logoutAuth: vi.fn(() => { calls.push("logoutAuth"); }),
    openThemePicker: vi.fn(() => { calls.push("openThemePicker"); }),
    openModelPicker: vi.fn(() => { calls.push("openModelPicker"); }),
    openThinkingLevelPicker: vi.fn(() => { calls.push("openThinkingLevelPicker"); }),
    selectMainView: vi.fn((view: AppState["mainView"]) => { calls.push(`selectMainView:${view}`); }),
    selectWorkspaceTool: vi.fn((tool: AppState["workspaceTool"]) => { calls.push(`selectWorkspaceTool:${tool}`); }),
    openTerminal: vi.fn((options?: { terminalId?: string | undefined }) => { calls.push(`openTerminal:${options?.terminalId ?? ""}`); }),
    refreshFiles: vi.fn(() => { calls.push("refreshFiles"); }),
    refreshWorkspacePanels: vi.fn(() => { calls.push("refreshWorkspacePanels"); }),
    refreshAppData: vi.fn(() => { calls.push("refreshAppData"); }),
    reloadPage: vi.fn(() => { calls.push("reloadPage"); }),
    deleteWorkspace: vi.fn(() => { calls.push("deleteWorkspace"); }),
    startSession: vi.fn(() => { calls.push("startSession"); }),
    archiveSession: vi.fn(() => { calls.push("archiveSession"); }),
    reloadSession: vi.fn(() => { calls.push("reloadSession"); }),
    deleteCachedNewSession: vi.fn(() => { calls.push("deleteCachedNewSession"); }),
    stopActiveWork: vi.fn(() => { calls.push("stopActiveWork"); }),
  };
  return { context, calls };
}

describe("PluginRegistry", () => {
  it("namespaces contribution ids with the owning plugin id", () => {
    const registry = new PluginRegistry();
    registry.register({ id: "core", plugin: corePlugin });

    expect(registry.getActions(createContext().context).some((action) => action.id === "core:actions.show")).toBe(true);
    expect(registry.getWorkspacePanels().map((panel) => panel.id)).toEqual(["core:workspace.files", "core:workspace.terminal"]);
  });

  it("rejects legacy browser plugins with an attributed API-version error", () => {
    const registry = new PluginRegistry();
    const legacyPlugin: PiWebPlugin = {
      apiVersion: 2,
      name: "Legacy",
      activate: () => ({ contributions: {} }),
    };
    Reflect.set(legacyPlugin, "apiVersion", 1);

    expect(() => { registry.register({ id: "legacy", plugin: legacyPlugin }); }).toThrow(
      "Unsupported browser plugin API version for legacy: 1 (expected 2)",
    );
    expect(registry.hasPlugin("legacy")).toBe(false);
  });

  it("gives federated plugins stable source identity and a separate runtime identity", async () => {
    const registry = new PluginRegistry();
    const runtimePluginId = machineScopedPluginId("remote-1", "board-tools");
    const activate = vi.fn<PiWebPlugin["activate"]>(({ pluginId, runtimePluginId: activationRuntimePluginId }) => ({
      contributions: {
        actions: [{
          id: "open",
          title: "Open Board",
          enabled: (context) => context.state.selectedWorkspace?.provider?.pluginId === pluginId,
          run: (context) => { context.selectWorkspaceTool(`${activationRuntimePluginId}:workspace.board`); },
        }],
      },
    }));
    registry.register({
      id: runtimePluginId,
      sourcePluginId: "board-tools",
      machineId: "remote-1",
      machineSpecific: true,
      plugin: { apiVersion: 2, name: "Board Tools", activate },
    });

    expect(activate).toHaveBeenCalledOnce();
    const activationContext = activate.mock.calls[0]?.[0];
    if (activationContext === undefined) throw new Error("Expected browser plugin activation context");
    expect(activationContext).toMatchObject({
      apiVersion: 2,
      pluginId: "board-tools",
      runtimePluginId,
    });
    expect(Object.isFrozen(activationContext)).toBe(true);

    const owned = createContext({
      selectedMachine: testMachine("remote-1"),
      selectedWorkspace: testWorkspace({ provider: { pluginId: "board-tools", capabilities: { request: true, remove: false } } }),
    });
    const action = registry.getActions(owned.context)[0];
    expect(action).toMatchObject({ id: `${runtimePluginId}:open`, enabled: true });
    await action?.run();
    expect(owned.calls).toEqual([`selectWorkspaceTool:${runtimePluginId}:workspace.board`]);

    const runtimeOwned = createContext({
      selectedMachine: testMachine("remote-1"),
      selectedWorkspace: testWorkspace({ provider: { pluginId: runtimePluginId, capabilities: { request: true, remove: false } } }),
    });
    expect(registry.getActions(runtimeOwned.context)[0]?.enabled).toBe(false);
  });

  it("resolves panel and shortcut migrations to the active machine-scoped contribution", () => {
    const registry = new PluginRegistry();
    const plugin: PiWebPlugin = {
      apiVersion: 2,
      name: "VCS",
      activate: () => ({
        contributions: {
          actions: [{ id: "view.vcs", title: "View VCS", shortcutAliases: ["core:view.vcs"], run: () => undefined }],
          workspacePanels: [{ id: "workspace.vcs", title: "VCS", routeAliases: ["vcs", "core:workspace.vcs"], render: () => html`<p>VCS</p>` }],
        },
      }),
    };
    registry.register({ id: "vcs", plugin, machineSpecific: true });
    const remotePluginId = machineScopedPluginId("remote-1", "vcs");
    registry.register({ id: remotePluginId, sourcePluginId: "vcs", machineId: "remote-1", plugin, machineSpecific: true });

    expect(registry.resolveWorkspacePanelRouteId("core:workspace.vcs", "local")).toBe("vcs:workspace.vcs");
    expect(registry.resolveWorkspacePanelRouteId("vcs:workspace.vcs", "remote-1")).toBe(`${remotePluginId}:workspace.vcs`);
    expect(registry.getActions(createContext({ selectedMachine: testMachine("remote-1") }).context)[0]?.shortcutAliases)
      .toEqual(["core:view.vcs", "vcs:view.vcs"]);
  });

  it("provides html and svg helpers to plugin activation and callbacks", () => {
    const registry = new PluginRegistry();
    registry.register({
      id: "example",
      plugin: {
        apiVersion: 2,
        name: "Example",
        activate: ({ html, svg }) => ({
          contributions: {
            workspacePanels: [
              {
                id: "workspace.logs",
                title: "Logs",
                icon: svg`<svg viewBox="0 0 24 24"><path d="M4 6h16"></path></svg>`,
                render: () => html`<p>Logs</p>`,
              },
            ],
          },
        }),
      },
    });

    const panel = registry.getWorkspacePanels()[0];

    expect(panel?.icon).toBeDefined();
    expect(panel?.render(createWorkspacePanelContext("local"))).toBeDefined();
  });

  it("exposes the prompt helper to workspace panel callbacks", () => {
    const registry = new PluginRegistry();
    registry.register({
      id: "example",
      plugin: {
        apiVersion: 2,
        name: "Example",
        activate: () => ({
          contributions: {
            workspacePanels: [
              {
                id: "workspace.prompt",
                title: "Prompt",
                render: (context) => {
                  context.prompt.insertText("@docs/example.md");
                  return html`<p>Prompt</p>`;
                },
              },
            ],
          },
        }),
      },
    });
    const insertText = vi.fn();
    const context = createWorkspacePanelContext("local", { insertText, getText: vi.fn(() => ""), getSelection: vi.fn(() => null) });

    registry.getWorkspacePanels()[0]?.render(context);

    expect(insertText).toHaveBeenCalledWith("@docs/example.md");
  });

  it("rejects duplicate ids within the same namespace", () => {
    const registry = new PluginRegistry();

    expect(() => {
      registry.register({
        id: "example",
        plugin: {
          apiVersion: 2,
          name: "Example",
          activate: () => ({
            contributions: {
              actions: [
                { id: "duplicate", title: "One", run: () => undefined },
                { id: "duplicate", title: "Two", run: () => undefined },
              ],
            },
          }),
        },
      });
    }).toThrow("Duplicate contribution id: example:duplicate");
  });

  it("rolls back every contribution when registration fails and allows a clean retry", () => {
    const registry = new PluginRegistry();
    let fail = true;
    const plugin = {
      apiVersion: 2 as const,
      name: "Retryable",
      activate: () => ({
        contributions: {
          actions: fail
            ? [
                { id: "action", title: "Partial", run: () => undefined },
                { id: "action", title: "Duplicate", run: () => undefined },
              ]
            : [{ id: "action", title: "Ready", run: () => undefined }],
        },
      }),
    };

    expect(() => { registry.register({ id: "retryable", plugin }); }).toThrow("Duplicate contribution id: retryable:action");
    expect(registry.hasPlugin("retryable")).toBe(false);
    expect(registry.getActions(createContext().context)).toEqual([]);
    expect(registry.shouldLoadRemotePlugin("retryable")).toBe(true);

    fail = false;
    registry.register({ id: "retryable", plugin });

    expect(registry.hasPlugin("retryable")).toBe(true);
    expect(registry.getActions(createContext().context).map(({ id, title }) => ({ id, title }))).toEqual([
      { id: "retryable:action", title: "Ready" },
    ]);
    expect(registry.shouldLoadRemotePlugin("retryable")).toBe(false);
  });

  it("isolates workspace-panel invalidation failures", async () => {
    const registry = new PluginRegistry();
    const invalidated = vi.fn();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    registry.register({
      id: "example",
      plugin: {
        apiVersion: 2,
        name: "Example",
        activate: () => ({
          contributions: {
            workspacePanels: [
              { id: "broken", title: "Broken", onInvalidate: () => { throw new Error("broken refresh"); }, render: () => html`<p>Broken</p>` },
              { id: "healthy", title: "Healthy", onInvalidate: invalidated, render: () => html`<p>Healthy</p>` },
            ],
          },
        }),
      },
    });

    await registry.invalidateWorkspacePanels(createWorkspacePanelContext("local"));

    expect(invalidated).toHaveBeenCalledOnce();
    expect(warning).toHaveBeenCalledWith("Failed to invalidate PI WEB plugin panel example:broken", expect.objectContaining({ message: "broken refresh" }));

    invalidated.mockClear();
    warning.mockClear();
    await registry.invalidateWorkspacePanels(createWorkspacePanelContext("local"), "example:healthy");
    expect(invalidated).toHaveBeenCalledOnce();
    expect(warning).not.toHaveBeenCalled();
  });

  it("evaluates core action enablement against runtime state", () => {
    const registry = new PluginRegistry();
    registry.register({ id: "core", plugin: corePlugin });

    const inactive = registry.getActions(createContext().context);
    const active = registry.getActions(createContext({ selectedWorkspace: testWorkspace() }).context);

    expect(inactive.find((action) => action.id === "core:view.files")?.enabled).toBe(false);
    expect(inactive.find((action) => action.id === "core:view.terminal")?.enabled).toBe(false);
    expect(active.find((action) => action.id === "core:view.files")?.enabled).toBe(true);
    expect(active.find((action) => action.id === "core:view.terminal")?.enabled).toBe(true);
    expect(active.find((action) => action.id === "core:workspace.delete")?.enabled).toBe(false);

    const deletable = registry.getActions(createContext({ selectedWorkspace: testWorkspace({
      isMain: false,
      removal: { actionLabel: "Disconnect view", confirmation: "Disconnect this view?", precondition: "removal-v1" },
    }) }).context);
    const removalAction = deletable.find((action) => action.id === "core:workspace.delete");
    expect(removalAction?.enabled).toBe(true);
    expect(removalAction?.title).toBe("Remove Workspace");
  });

  it("routes workspace delete through the runtime context", () => {
    const registry = new PluginRegistry();
    registry.register({ id: "core", plugin: corePlugin });
    const { context, calls } = createContext({ selectedWorkspace: testWorkspace({
      isMain: false,
      removal: { actionLabel: "Disconnect view", confirmation: "Disconnect this view?", precondition: "removal-v1" },
    }) });
    const action = registry.getActions(context).find((candidate) => candidate.id === "core:workspace.delete");

    if (action !== undefined) void action.run();

    expect(calls).toEqual(["deleteWorkspace"]);
  });

  it("offers archive only for persisted sessions and delete only for transient new sessions", () => {
    const registry = new PluginRegistry();
    registry.register({ id: "core", plugin: corePlugin });

    const persistedActions = registry.getActions(createContext({ selectedSession: testSession({ persisted: true }) }).context);
    expect(persistedActions.find((action) => action.id === "core:session.archive")?.enabled).toBe(true);
    expect(persistedActions.find((action) => action.id === "core:session.delete")?.enabled).toBe(false);

    const unknownActions = registry.getActions(createContext({ selectedSession: testSession() }).context);
    expect(unknownActions.find((action) => action.id === "core:session.archive")?.enabled).toBe(false);
    expect(unknownActions.find((action) => action.id === "core:session.delete")?.enabled).toBe(false);

    const transientActions = registry.getActions(createContext({ selectedSession: testSession({ persisted: false }) }).context);
    expect(transientActions.find((action) => action.id === "core:session.archive")?.enabled).toBe(false);
    expect(transientActions.find((action) => action.id === "core:session.delete")?.enabled).toBe(true);

    const cachedActions = registry.getActions(createContext({ selectedSession: markCachedNewSessionInfo(testSession()) }).context);
    expect(cachedActions.find((action) => action.id === "core:session.archive")?.enabled).toBe(false);
    expect(cachedActions.find((action) => action.id === "core:session.delete")?.enabled).toBe(true);

    const archivedActions = registry.getActions(createContext({ selectedSession: { ...testSession({ persisted: true }), archived: true, archivedAt: "2026-05-20T00:00:00.000Z" } }).context);
    expect(archivedActions.find((action) => action.id === "core:session.archive")?.enabled).toBe(false);
    expect(archivedActions.find((action) => action.id === "core:session.delete")?.enabled).toBe(false);
  });

  it("uses selected session status as the freshest archive/delete persistence signal", () => {
    const registry = new PluginRegistry();
    registry.register({ id: "core", plugin: corePlugin });

    const statusPersisted = registry.getActions(createContext({ selectedSession: testSession({ persisted: false }), status: testStatus({ persisted: true }) }).context);
    expect(statusPersisted.find((action) => action.id === "core:session.archive")?.enabled).toBe(true);
    expect(statusPersisted.find((action) => action.id === "core:session.delete")?.enabled).toBe(false);

    const statusTransient = registry.getActions(createContext({ selectedSession: testSession({ persisted: true }), status: testStatus({ persisted: false }) }).context);
    expect(statusTransient.find((action) => action.id === "core:session.archive")?.enabled).toBe(false);
    expect(statusTransient.find((action) => action.id === "core:session.delete")?.enabled).toBe(true);
  });

  it("enables session disk reload only for a writable, idle session", () => {
    const registry = new PluginRegistry();
    registry.register({ id: "core", plugin: corePlugin });

    const reloadable = registry.getActions(createContext({ selectedSession: testSession({ persisted: true }) }).context);
    const reloadableAction = reloadable.find((action) => action.id === "core:session.reload");
    expect(reloadableAction?.enabled).toBe(true);
    expect(reloadableAction?.title).toBe("Reload Session from Disk");
    expect(reloadableAction?.description).toContain("Use /reload in the prompt for Pi runtime resources");

    const noRuntime = registry.getActions(createContext({ selectedSession: testSession({ persisted: true }) }).context);
    expect(noRuntime.find((action) => action.id === "core:session.reload")?.enabled).toBe(true);

    const unknown = registry.getActions(createContext({ selectedSession: testSession() }).context);
    expect(unknown.find((action) => action.id === "core:session.reload")?.enabled).toBe(false);

    const transient = registry.getActions(createContext({ selectedSession: testSession({ persisted: false }) }).context);
    expect(transient.find((action) => action.id === "core:session.reload")?.enabled).toBe(false);

    const archived = registry.getActions(createContext({ selectedSession: { ...testSession({ persisted: true }), archived: true, archivedAt: "2026-05-20T00:00:00.000Z" } }).context);
    expect(archived.find((action) => action.id === "core:session.reload")?.enabled).toBe(false);

    const busy = registry.getActions(createContext({ selectedSession: testSession({ persisted: true }), status: testStatus({ persisted: true, isStreaming: true }) }).context);
    expect(busy.find((action) => action.id === "core:session.reload")?.enabled).toBe(false);
  });

  it("treats a session that is only starting up as having no work to stop or block", () => {
    const registry = new PluginRegistry();
    registry.register({ id: "core", plugin: corePlugin });
    const startupActivity = { sessionId: "s1", phase: "active" as const, label: "Opening session", detail: "Starting the Pi session", at: "now", startup: true };

    const opening = registry.getActions(createContext({ selectedSession: testSession({ persisted: true }), status: testStatus({ persisted: true }), activity: startupActivity }).context);

    // Nothing is being worked on, so there is nothing to stop and no reason to
    // block a reload with "Stop current session activity before reloading".
    expect(opening.find((action) => action.id === "core:session.stop")?.enabled).toBe(false);
    expect(opening.find((action) => action.id === "core:session.reload")?.enabled).toBe(true);

    // Real work is still real work, whatever else the session is doing.
    const working = registry.getActions(createContext({ selectedSession: testSession({ persisted: true }), status: testStatus({ persisted: true, isStreaming: true }), activity: startupActivity }).context);
    expect(working.find((action) => action.id === "core:session.stop")?.enabled).toBe(true);
    expect(working.find((action) => action.id === "core:session.reload")?.enabled).toBe(false);
  });

  it("routes session reload through the runtime context", () => {
    const registry = new PluginRegistry();
    registry.register({ id: "core", plugin: corePlugin });
    const { context, calls } = createContext({ selectedSession: testSession({ persisted: true }) });
    const action = registry.getActions(context).find((candidate) => candidate.id === "core:session.reload");

    if (action !== undefined) void action.run();

    expect(calls).toEqual(["reloadSession"]);
  });

  it("routes transient new session delete through the runtime context", () => {
    const registry = new PluginRegistry();
    registry.register({ id: "core", plugin: corePlugin });
    const { context, calls } = createContext({ selectedSession: testSession({ persisted: false }) });
    const action = registry.getActions(context).find((candidate) => candidate.id === "core:session.delete");

    if (action !== undefined) void action.run();

    expect(calls).toEqual(["deleteCachedNewSession"]);
  });

  it("exposes model and thinking selectors as configurable actions for writable sessions", () => {
    const registry = new PluginRegistry();
    registry.register({ id: "core", plugin: corePlugin });

    const unavailable = registry.getActions(createContext().context);
    expect(unavailable.find((action) => action.id === "core:model.select")?.enabled).toBe(false);
    expect(unavailable.find((action) => action.id === "core:thinking.select")?.enabled).toBe(false);

    const archivedSession = { ...testSession(), archived: true, archivedAt: "2026-05-20T00:00:00.000Z" };
    const archived = registry.getActions(createContext({ selectedSession: archivedSession }).context);
    expect(archived.find((action) => action.id === "core:model.select")?.enabled).toBe(false);
    expect(archived.find((action) => action.id === "core:thinking.select")?.enabled).toBe(false);

    const { context, calls } = createContext({ selectedSession: testSession() });
    const actions = registry.getActions(context);
    const modelAction = actions.find((action) => action.id === "core:model.select");
    const thinkingAction = actions.find((action) => action.id === "core:thinking.select");
    expect(modelAction).toMatchObject({ title: "Select Model", enabled: true });
    expect(modelAction?.shortcut).toBeUndefined();
    expect(thinkingAction).toMatchObject({ title: "Select Thinking Level", enabled: true });
    expect(thinkingAction?.shortcut).toBeUndefined();

    if (modelAction !== undefined) void modelAction.run();
    if (thinkingAction !== undefined) void thinkingAction.run();

    expect(calls).toEqual(["openModelPicker", "openThinkingLevelPicker"]);
  });

  it("routes app reload and settings actions through the runtime context", () => {
    const registry = new PluginRegistry();
    registry.register({ id: "core", plugin: corePlugin });
    const { context, calls } = createContext();
    const actions = registry.getActions(context);

    expect(actions.some((candidate) => candidate.id === "core:app.refresh-data")).toBe(false);
    void actions.find((candidate) => candidate.id === "core:app.reload-page")?.run();
    void actions.find((candidate) => candidate.id === "core:settings.open")?.run();

    expect(calls).toEqual(["reloadPage", "openSettings"]);
  });

  it("exposes terminal navigation as a shortcut-backed action", () => {
    const registry = new PluginRegistry();
    registry.register({ id: "core", plugin: corePlugin });
    const { context, calls } = createContext({ selectedWorkspace: testWorkspace() });
    const action = registry.getActions(context).find((candidate) => candidate.id === "core:view.terminal");

    expect(action?.shortcut).toBe("mod+4");
    if (action !== undefined) void action.run();

    expect(calls).toEqual(["selectMainView:core:workspace.terminal"]);
  });

  it("keeps built-in keyboard shortcuts unique and action-backed", () => {
    const registry = new PluginRegistry();
    registry.register({ id: "core", plugin: corePlugin });
    const shortcuts = registry.getActions(createContext({ selectedWorkspace: testWorkspace() }).context)
      .filter((action) => action.shortcut !== undefined)
      .map((action) => [action.id, action.shortcut]);

    expect(shortcuts).toEqual([
      ["core:actions.show", "mod+k"],
      ["core:prompt.focus", "mod+g c"],
      ["core:settings.open", "mod+,"],
      ["core:view.chat", "mod+1"],
      ["core:view.files", "mod+2"],
      ["core:view.terminal", "mod+4"],
      ["core:workspace.refresh-files", "mod+shift+f"],
      ["core:session.start", "mod+enter"],
      ["core:session.stop", "mod+."],
    ]);
    expect(new Set(shortcuts.map(([, shortcut]) => shortcut)).size).toBe(shortcuts.length);
  });

  it("collects built-in PI WEB themes from an in-app plugin", () => {
    const registry = new PluginRegistry();
    registry.register({ id: "themes", plugin: themePackPlugin });

    expect(registry.getThemes().map((theme) => ({ id: theme.id, colorScheme: theme.colorScheme }))).toEqual([
      { id: "themes:pi-web-dark", colorScheme: "dark" },
      { id: "themes:pi-web-light", colorScheme: "light" },
      { id: "themes:classic", colorScheme: "dark" },
    ]);
    expect(registry.getThemePairs().map((pair) => ({ id: pair.id, light: pair.light, dark: pair.dark }))).toEqual([
      { id: "themes:pi-web", light: "themes:pi-web-light", dark: "themes:pi-web-dark" },
    ]);
  });

  it("collects theme contributions in contribution order", () => {
    const registry = new PluginRegistry();
    registry.register({
      id: "example",
      plugin: {
        apiVersion: 2,
        name: "Example",
        activate: () => ({
          contributions: {
            themes: [
              { id: "last", name: "Last", order: 20, colorScheme: "dark", tokens: testThemeTokens() },
              { id: "first", name: "First", order: 10, colorScheme: "light", tokens: testThemeTokens() },
            ],
            themePairs: [
              { id: "pair", name: "Pair", light: "first", dark: "last" },
            ],
          },
        }),
      },
    });

    expect(registry.getThemes().map((theme) => ({ id: theme.id, pluginId: theme.pluginId, localId: theme.localId, name: theme.name }))).toEqual([
      { id: "example:first", pluginId: "example", localId: "first", name: "First" },
      { id: "example:last", pluginId: "example", localId: "last", name: "Last" },
    ]);
    expect(registry.getThemePairs().map((pair) => ({ id: pair.id, pluginId: pair.pluginId, localId: pair.localId, light: pair.light, dark: pair.dark }))).toEqual([
      { id: "example:pair", pluginId: "example", localId: "pair", light: "example:first", dark: "example:last" },
    ]);
  });

  it("collects workspace label items in contribution order", () => {
    const registry = new PluginRegistry();
    const workspace = testWorkspace();
    registry.register({
      id: "example",
      plugin: {
        apiVersion: 2,
        name: "Example",
        activate: () => ({
          contributions: {
            workspaceLabels: [
              { id: "last", order: 20, items: () => [{ type: "text", text: "last" }] },
              { id: "hidden", order: 5, visible: () => false, items: () => [{ type: "text", text: "hidden" }] },
              { id: "first", order: 10, items: () => [{ type: "link", text: "web", href: "http://localhost:5173" }] },
            ],
          },
        }),
      },
    });

    expect(registry.getWorkspaceLabelItems(createWorkspaceLabelContext("local", workspace))).toEqual([
      { type: "link", text: "web", href: "http://localhost:5173" },
      { type: "text", text: "last" },
    ]);
  });

  it("passes workspace label file and host helpers to callbacks", () => {
    const registry = new PluginRegistry();
    const workspace = testWorkspace();
    const readFile = vi.fn<WorkspaceFiles["readFile"]>(() => Promise.resolve(testFileContent("docker/development.be-go.local.env")));
    const requestRender = vi.fn<WorkspaceHost["requestRender"]>();
    const visible = vi.fn<(context: WorkspaceLabelContext) => boolean>(() => true);
    const items = vi.fn<(context: WorkspaceLabelContext) => WorkspaceLabelItem[]>((context) => {
      void context.files.readFile("docker/development.be-go.local.env");
      context.host.requestRender();
      return [{ type: "text", text: context.machine.id }];
    });
    const context = createWorkspaceLabelContext("remote-1", workspace, { files: { readFile, listFiles: vi.fn<WorkspaceFiles["listFiles"]>(() => Promise.resolve(testFileTreeResponse())), writeFile: vi.fn<WorkspaceFiles["writeFile"]>(() => Promise.resolve(testWriteFileResponse())), deleteFile: vi.fn<WorkspaceFiles["deleteFile"]>(() => Promise.resolve(testDeleteFileResponse())), moveFile: vi.fn<WorkspaceFiles["moveFile"]>(() => Promise.resolve(testMoveFileResponse())) }, host: { requestRender } });

    registry.register({
      id: "example",
      plugin: {
        apiVersion: 2,
        name: "Example",
        activate: () => ({
          contributions: {
            workspaceLabels: [{ id: "env", visible, items }],
          },
        }),
      },
    });

    expect(registry.getWorkspaceLabelItems(context)).toEqual([{ type: "text", text: "remote-1" }]);
    expect(visible).toHaveBeenCalledWith(context);
    expect(items).toHaveBeenCalledWith(context);
    expect(readFile).toHaveBeenCalledWith("docker/development.be-go.local.env");
    expect(requestRender).toHaveBeenCalledOnce();
  });

  it("only exposes machine-scoped plugin contributions for their machine", () => {
    const registry = new PluginRegistry();
    const pluginId = machineScopedPluginId("remote-1", "project-tools");
    const workspace = testWorkspace();
    registry.register({
      id: pluginId,
      machineId: "remote-1",
      sourcePluginId: "project-tools",
      plugin: {
        apiVersion: 2,
        name: "Project Tools",
        activate: () => ({
          contributions: {
            actions: [{ id: "do-thing", title: "Do Thing", run: () => undefined }],
            workspacePanels: [{ id: "workspace.tools", title: "Tools", render: () => html`<p>Tools</p>` }],
            workspaceLabels: [{ id: "badge", items: () => [{ type: "text", text: "remote" }] }],
            themes: [{ id: "remote-theme", name: "Remote Theme", colorScheme: "dark", tokens: testThemeTokens() }],
          },
        }),
      },
    });

    expect(registry.getActions(createContext().context).map((action) => action.id)).not.toContain(`${pluginId}:do-thing`);
    expect(registry.getActions(createContext({ selectedMachine: testMachine("remote-1") }).context).map((action) => action.id)).toContain(`${pluginId}:do-thing`);

    const panel = registry.getWorkspacePanels().find((candidate) => candidate.id === `${pluginId}:workspace.tools`);
    expect(panel?.visible?.(createWorkspacePanelContext("local"))).toBe(false);
    expect(panel?.visible?.(createWorkspacePanelContext("remote-1"))).toBe(true);

    expect(registry.getWorkspaceLabelItems(createWorkspaceLabelContext("local", workspace))).toEqual([]);
    expect(registry.getWorkspaceLabelItems(createWorkspaceLabelContext("remote-1", workspace))).toEqual([{ type: "text", text: "remote" }]);
    expect(registry.getThemes()).toEqual([]);
  });

  it("binds backend helpers to source identity rather than the machine-scoped registration id", () => {
    const registry = new PluginRegistry();
    const registrationPluginId = machineScopedPluginId("remote-1", "board-tools");
    const observedBindings: WorkspacePluginBinding[] = [];
    const observedRequests: { target: PluginBackendRequestTarget; operation: string; input: JsonValue }[] = [];
    registry.register({
      id: registrationPluginId,
      machineId: "remote-1",
      sourcePluginId: "board-tools",
      backendRevision: "server-r7",
      plugin: {
        apiVersion: 2,
        name: "Board Tools",
        activate: ({ pluginId, runtimePluginId }) => {
          expect(pluginId).toBe("board-tools");
          expect(runtimePluginId).toBe(registrationPluginId);
          return {
            contributions: {
              workspacePanels: [{
                id: "workspace.board",
                title: "Board",
                render: (context) => {
                  void requiredBackend(context.backend).request("cards.summary", { includeClosed: false });
                  return html`<p>Board</p>`;
                },
              }],
              workspaceLabels: [{
                id: "board-count",
                items: (context) => {
                  void requiredBackend(context.backend).request("cards.count", null);
                  return [{ type: "text", text: "2 cards" }];
                },
              }],
            },
          };
        },
      },
    });
    const panelBase = createWorkspacePanelContext("remote-1");
    const panelContext = installWorkspacePanelScope(panelBase, (binding) => ({
      ...panelBase,
      backend: requiredBackend(createPluginWorkspaceBackend(binding, panelBase.workspace, panelBase.machine.id, (target, operation, input) => {
        observedBindings.push(binding);
        observedRequests.push({ target, operation, input });
        return Promise.resolve(null);
      })),
    }));
    const labelBase = createWorkspaceLabelContext("remote-1");
    const labelContext = installWorkspaceLabelScope(labelBase, (binding) => ({
      ...labelBase,
      backend: requiredBackend(createPluginWorkspaceBackend(binding, labelBase.workspace, labelBase.machine.id, (target, operation, input) => {
        observedBindings.push(binding);
        observedRequests.push({ target, operation, input });
        return Promise.resolve(null);
      })),
    }));

    registry.getWorkspacePanels().find(({ localId }) => localId === "workspace.board")?.render(panelContext);
    expect(registry.getWorkspaceLabelItems(labelContext)).toEqual([{ type: "text", text: "2 cards" }]);

    expect(observedBindings).toEqual([
      { registrationPluginId, sourcePluginId: "board-tools", backendRevision: "server-r7" },
      { registrationPluginId, sourcePluginId: "board-tools", backendRevision: "server-r7" },
    ]);
    expect(observedRequests).toEqual([
      {
        target: { pluginId: "board-tools", backendRevision: "server-r7", machineId: "remote-1", projectId: "p1", workspaceId: "w1" },
        operation: "cards.summary",
        input: { includeClosed: false },
      },
      {
        target: { pluginId: "board-tools", backendRevision: "server-r7", machineId: "remote-1", projectId: "p1", workspaceId: "w1" },
        operation: "cards.count",
        input: null,
      },
    ]);
  });

  it("pairs machine-specific gateway and remote contributions with their own active backend revisions", () => {
    const registry = new PluginRegistry();
    const remotePluginId = machineScopedPluginId("remote-1", "pair-tools");
    const pairedPlugin = (name: string) => ({
      apiVersion: 2 as const,
      name,
      activate: () => ({
        contributions: {
          workspacePanels: [{
            id: "workspace.pair",
            title: name,
            render: (context: WorkspacePanelContext) => {
              void requiredBackend(context.backend).request("pair.check", null);
              return html`<p>${name}</p>`;
            },
          }],
        },
      }),
    });
    registry.register({ id: "pair-tools", machineSpecific: true, backendRevision: "gateway-r1", plugin: pairedPlugin("Gateway pair") });
    registry.register({
      id: remotePluginId,
      machineId: "remote-1",
      sourcePluginId: "pair-tools",
      machineSpecific: true,
      backendRevision: "remote-r2",
      plugin: pairedPlugin("Remote pair"),
    });
    const requests: PluginBackendRequestTarget[] = [];

    for (const machineId of ["local", "remote-1"]) {
      const base = createWorkspacePanelContext(machineId);
      const context = installWorkspacePanelScope(base, (binding) => ({
        ...base,
        backend: requiredBackend(createPluginWorkspaceBackend(binding, base.workspace, machineId, (target) => {
          requests.push(target);
          return Promise.resolve(null);
        })),
      }));
      const visible = registry.getWorkspacePanels().filter((panel) => panel.visible?.(context) !== false);
      expect(visible).toHaveLength(1);
      visible[0]?.render(context);
    }

    expect(requests).toEqual([
      { pluginId: "pair-tools", backendRevision: "gateway-r1", machineId: "local", projectId: "p1", workspaceId: "w1" },
      { pluginId: "pair-tools", backendRevision: "remote-r2", machineId: "remote-1", projectId: "p1", workspaceId: "w1" },
    ]);
  });

  it("prefers gateway plugins over remote plugins with the same source id", () => {
    const registry = new PluginRegistry();
    const remotePluginId = machineScopedPluginId("remote-1", "shared-tools");
    const workspace = testWorkspace();
    registry.register({
      id: remotePluginId,
      machineId: "remote-1",
      sourcePluginId: "shared-tools",
      plugin: {
        apiVersion: 2,
        name: "Remote Shared Tools",
        activate: () => ({
          contributions: {
            actions: [{ id: "remote-action", title: "Remote Action", run: () => undefined }],
            workspacePanels: [{ id: "workspace.remote", title: "Remote", render: () => html`<p>Remote</p>` }],
            workspaceLabels: [{ id: "remote-label", items: () => [{ type: "text", text: "remote" }] }],
          },
        }),
      },
    });

    expect(registry.getActions(createContext({ selectedMachine: testMachine("remote-1") }).context).map((action) => action.id)).toContain(`${remotePluginId}:remote-action`);

    registry.register({
      id: "shared-tools",
      plugin: {
        apiVersion: 2,
        name: "Gateway Shared Tools",
        activate: () => ({
          contributions: {
            actions: [{ id: "gateway-action", title: "Gateway Action", run: () => undefined }],
            workspacePanels: [{ id: "workspace.gateway", title: "Gateway", render: () => html`<p>Gateway</p>` }],
            workspaceLabels: [{ id: "gateway-label", items: () => [{ type: "text", text: "gateway" }] }],
          },
        }),
      },
    });

    const remoteActions = registry.getActions(createContext({ selectedMachine: testMachine("remote-1") }).context).map((action) => action.id);
    expect(remoteActions).toContain("shared-tools:gateway-action");
    expect(remoteActions).not.toContain(`${remotePluginId}:remote-action`);

    const panels = registry.getWorkspacePanels();
    expect(panels.find((panel) => panel.id === `${remotePluginId}:workspace.remote`)?.visible?.(createWorkspacePanelContext("remote-1"))).toBe(false);
    expect(panels.find((panel) => panel.id === "shared-tools:workspace.gateway")?.visible?.(createWorkspacePanelContext("remote-1"))).toBe(true);
    expect(registry.getWorkspaceLabelItems(createWorkspaceLabelContext("remote-1", workspace))).toEqual([{ type: "text", text: "gateway" }]);
    expect(registry.shouldLoadRemotePlugin("shared-tools")).toBe(false);
    expect(registry.shouldLoadRemotePlugin("shared-tools", true)).toBe(true);
  });

  it("uses machine-specific remote duplicates instead of the gateway plugin for that machine", () => {
    const registry = new PluginRegistry();
    const workspace = testWorkspace();
    const remotePluginId = machineScopedPluginId("remote-1", "updates");
    registry.register({
      id: "updates",
      machineSpecific: true,
      plugin: {
        apiVersion: 2,
        name: "Gateway Updates",
        activate: () => ({
          contributions: {
            actions: [{ id: "open", title: "Open Gateway Updates", run: () => undefined }],
            workspacePanels: [{ id: "workspace.updates", title: "Gateway Updates", render: () => html`<p>Gateway</p>` }],
            workspaceLabels: [{ id: "label", items: () => [{ type: "text", text: "gateway" }] }],
          },
        }),
      },
    });

    expect(registry.getActions(createContext().context).map((action) => action.id)).toContain("updates:open");
    expect(registry.getActions(createContext({ selectedMachine: testMachine("remote-1") }).context).map((action) => action.id)).not.toContain("updates:open");
    expect(registry.shouldLoadRemotePlugin("updates")).toBe(true);

    registry.register({
      id: remotePluginId,
      machineId: "remote-1",
      sourcePluginId: "updates",
      plugin: {
        apiVersion: 2,
        name: "Remote Updates",
        activate: () => ({
          contributions: {
            actions: [{ id: "open", title: "Open Remote Updates", run: () => undefined }],
            workspacePanels: [{ id: "workspace.updates", title: "Remote Updates", render: () => html`<p>Remote</p>` }],
            workspaceLabels: [{ id: "label", items: () => [{ type: "text", text: "remote" }] }],
          },
        }),
      },
    });

    expect(registry.getActions(createContext().context).map((action) => action.id)).toContain("updates:open");
    expect(registry.getActions(createContext({ selectedMachine: testMachine("remote-1") }).context).map((action) => action.id)).toEqual([`${remotePluginId}:open`]);

    const panels = registry.getWorkspacePanels();
    expect(panels.find((panel) => panel.id === "updates:workspace.updates")?.visible?.(createWorkspacePanelContext("local"))).toBe(true);
    expect(panels.find((panel) => panel.id === "updates:workspace.updates")?.visible?.(createWorkspacePanelContext("remote-1"))).toBe(false);
    expect(panels.find((panel) => panel.id === `${remotePluginId}:workspace.updates`)?.visible?.(createWorkspacePanelContext("remote-1"))).toBe(true);

    expect(registry.getWorkspaceLabelItems(createWorkspaceLabelContext("local", workspace))).toEqual([{ type: "text", text: "gateway" }]);
    expect(registry.getWorkspaceLabelItems(createWorkspaceLabelContext("remote-1", workspace))).toEqual([{ type: "text", text: "remote" }]);
  });

  it("allows a machine-specific remote duplicate to override a portable gateway plugin for that machine", () => {
    const registry = new PluginRegistry();
    const remotePluginId = machineScopedPluginId("remote-1", "status-tools");
    registry.register({
      id: "status-tools",
      plugin: {
        apiVersion: 2,
        name: "Gateway Status Tools",
        activate: () => ({ contributions: { actions: [{ id: "open", title: "Open Gateway Status", run: () => undefined }] } }),
      },
    });

    expect(registry.shouldLoadRemotePlugin("status-tools")).toBe(false);
    expect(registry.shouldLoadRemotePlugin("status-tools", true)).toBe(true);
    registry.register({
      id: remotePluginId,
      machineId: "remote-1",
      sourcePluginId: "status-tools",
      machineSpecific: true,
      plugin: {
        apiVersion: 2,
        name: "Remote Status Tools",
        activate: () => ({ contributions: { actions: [{ id: "open", title: "Open Remote Status", run: () => undefined }] } }),
      },
    });

    expect(registry.getActions(createContext().context).map((action) => action.id)).toEqual(["status-tools:open"]);
    expect(registry.getActions(createContext({ selectedMachine: testMachine("remote-1") }).context).map((action) => action.id)).toEqual([`${remotePluginId}:open`]);
  });

  it("does not activate remote duplicates when the gateway plugin is already registered", () => {
    const registry = new PluginRegistry();
    const remoteActivate = vi.fn(() => ({ contributions: { actions: [{ id: "remote-action", title: "Remote Action", run: () => undefined }] } }));
    registry.register({ id: "shared-tools", plugin: { apiVersion: 2, name: "Gateway Shared Tools", activate: () => ({ contributions: {} }) } });

    registry.register({
      id: machineScopedPluginId("remote-1", "shared-tools"),
      machineId: "remote-1",
      sourcePluginId: "shared-tools",
      plugin: { apiVersion: 2, name: "Remote Shared Tools", activate: remoteActivate },
    });

    expect(remoteActivate).not.toHaveBeenCalled();
  });
});

function testWorkspace(patch: Partial<Workspace> = {}): Workspace {
  return { id: "w1", projectId: "p1", path: "/tmp/project", label: "main", isMain: true, effectiveConfig: {}, ...patch };
}

function createWorkspaceLabelContext(machineId: string, workspace = testWorkspace(), helpers: Partial<Pick<WorkspaceLabelContext, "files" | "host">> = {}): WorkspaceLabelContext {
  const files: WorkspaceFiles = helpers.files ?? { readFile: vi.fn<WorkspaceFiles["readFile"]>(() => Promise.resolve(testFileContent())), listFiles: vi.fn<WorkspaceFiles["listFiles"]>(() => Promise.resolve(testFileTreeResponse())), writeFile: vi.fn<WorkspaceFiles["writeFile"]>(() => Promise.resolve(testWriteFileResponse())), deleteFile: vi.fn<WorkspaceFiles["deleteFile"]>(() => Promise.resolve(testDeleteFileResponse())), moveFile: vi.fn<WorkspaceFiles["moveFile"]>(() => Promise.resolve(testMoveFileResponse())) };
  const host: WorkspaceHost = helpers.host ?? { requestRender: vi.fn<WorkspaceHost["requestRender"]>() };
  return {
    machine: { id: machineId, name: machineId, kind: machineId === "local" ? "local" : "remote" },
    workspace,
    state: { ...initialAppState(), selectedMachine: testMachine(machineId) },
    files,
    backend: { request: vi.fn(() => Promise.resolve(null)) },
    host,
  };
}

function createWorkspacePanelContext(machineId: string, prompt: WorkspacePanelContext["prompt"] = { insertText: vi.fn(), getText: vi.fn(() => ""), getSelection: vi.fn(() => null) }): WorkspacePanelContext {
  const workspace = testWorkspace();
  return {
    machine: { id: machineId, name: machineId, kind: machineId === "local" ? "local" : "remote" },
    workspace,
    state: { ...initialAppState(), selectedMachine: testMachine(machineId) },
    files: { readFile: vi.fn(), listFiles: vi.fn(), writeFile: vi.fn(), deleteFile: vi.fn(), moveFile: vi.fn() },
    backend: { request: vi.fn(() => Promise.resolve(null)) },
    prompt,
    terminal: { open: vi.fn(), runCommand: vi.fn() },
    host: { requestRender: vi.fn() },
    review: {
      total: () => 0,
      countForFile: () => 0,
      commentsForLine: () => [],
      draftForLine: () => null,
      lineState: () => ({ selected: false, commented: false }),
      canAuthor: () => false,
      beginSelection: () => undefined,
      extendSelection: () => undefined,
      commitSelection: () => undefined,
      cancelSelection: () => undefined,
      setDraftBody: () => undefined,
      submitDraft: () => undefined,
      cancelDraft: () => undefined,
      updateComment: () => undefined,
      removeComment: () => undefined,
    },
    fileTree: [],
    expandedDirs: {},
    selectedFilePath: undefined,
    selectedFileContent: undefined,
    selectedFileLoadError: undefined,
    fileTreeStale: false,
    activeTerminalCount: 0,
    selectedTerminalId: undefined,
    terminalAutoStart: false,
    workspaceUploadDefaultFolder: ".pi-web/uploads",
    onRefreshFiles: vi.fn(),
    onExpandDir: vi.fn(),
    onSelectFile: vi.fn(),
    onStartWorkspaceUpload: vi.fn(),
    onCancelWorkspaceUpload: vi.fn(),
    onClearWorkspaceUpload: vi.fn(),
    onSelectTerminal: vi.fn(),
  };
}

function requiredBackend(backend: WorkspacePanelContext["backend"]): NonNullable<WorkspacePanelContext["backend"]> {
  if (backend === undefined) throw new Error("Expected a paired workspace backend");
  return backend;
}

function testFileContent(path = "README.md"): FileContentResponse {
  return {
    path,
    encoding: "utf8",
    size: 0,
    modifiedAt: "2026-05-20T00:00:00.000Z",
    content: "",
    truncated: false,
    binary: false,
  };
}

function testStatus(patch: Partial<SessionStatus> = {}): SessionStatus {
  return {
    sessionId: "s1",
    isStreaming: false,
    isCompacting: false,
    isBashRunning: false,
    pendingMessageCount: 0,
    queuedMessages: [],
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    cost: 0,
    ...patch,
  };
}

function testFileTreeResponse(path = ".pi-web/relays"): FileTreeResponse {
  return {
    path,
    entries: [],
    scannedAt: "2026-05-20T00:00:00.000Z",
    truncated: false,
  };
}

function testWriteFileResponse(path = "README.md"): WriteWorkspaceFileResponse {
  return {
    path,
    size: 0,
    modifiedAt: "2026-05-20T00:00:00.000Z",
    created: true,
  };
}

function testDeleteFileResponse(path = "README.md"): DeleteWorkspaceFileResponse {
  return {
    path,
    existed: true,
  };
}

function testMoveFileResponse(fromPath = "old.txt", toPath = "new.txt"): MoveWorkspaceFileResponse {
  return {
    fromPath,
    toPath,
    size: 0,
    modifiedAt: "2026-05-20T00:00:00.000Z",
  };
}

function testMachine(id: string) {
  return { id, name: id, kind: id === "local" ? "local" as const : "remote" as const, createdAt: "2026-05-20T00:00:00.000Z", updatedAt: "2026-05-20T00:00:00.000Z" };
}

function testSession(patch: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: "s1",
    path: "/tmp/s1.jsonl",
    cwd: "/tmp/project",
    created: "2026-05-20T00:00:00.000Z",
    modified: "2026-05-20T00:00:00.000Z",
    messageCount: 1,
    firstMessage: "Hello",
    ...patch,
  };
}

function testThemeTokens(): ThemeTokens {
  return {
    "--pi-bg": "#000000",
    "--pi-surface": "#000000",
    "--pi-surface-hover": "#000000",
    "--pi-terminal-bg": "#000000",
    "--pi-terminal-text": "#000000",
    "--pi-border": "#000000",
    "--pi-border-muted": "#000000",
    "--pi-text": "#000000",
    "--pi-text-secondary": "#000000",
    "--pi-text-bright": "#000000",
    "--pi-muted": "#000000",
    "--pi-dim": "#000000",
    "--pi-accent": "#000000",
    "--pi-accent-border": "#000000",
    "--pi-selection-bg": "#000000",
    "--pi-success": "#000000",
    "--pi-success-border": "#000000",
    "--pi-success-bg": "#000000",
    "--pi-success-surface": "#000000",
    "--pi-success-ring": "#000000",
    "--pi-warning": "#000000",
    "--pi-warning-border": "#000000",
    "--pi-warning-surface": "#000000",
    "--pi-danger": "#000000",
    "--pi-purple": "#000000",
    "--pi-purple-border": "#000000",
    "--pi-purple-surface": "#000000",
    "--pi-overlay": "#000000",
    "--pi-shadow-soft": "#000000",
    "--pi-shadow": "#000000",
    "--pi-shadow-strong": "#000000",
    "--pi-bg-overlay-soft": "#000000",
    "--pi-bg-overlay": "#000000",
    "--pi-success-bg-overlay": "#000000",
    "--pi-terminal-selection": "#000000",
  };
}
