import { html } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { DeleteWorkspaceFileResponse, FileContentResponse, MoveWorkspaceFileResponse, SessionInfo, SessionStatus, WriteWorkspaceFileResponse, Workspace } from "../api";
import { initialAppState, type AppState } from "../appState";
import { markCachedNewSessionInfo } from "../cachedNewSessions";
import { PI_WEB_CAPABILITIES } from "../../../shared/capabilities";
import { machineScopedPluginId } from "../../../shared/machinePluginIds";
import { corePlugin } from "./core";
import { PluginRegistry } from "./registry";
import { themePackPlugin } from "./themes";
import type { PluginRuntimeContext, ThemeTokens, WorkspaceFiles, WorkspaceHost, WorkspaceLabelContext, WorkspaceLabelItem, WorkspacePanelContext } from "./types";

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
    selectMainView: vi.fn((view: AppState["mainView"]) => { calls.push(`selectMainView:${view}`); }),
    selectWorkspaceTool: vi.fn((tool: AppState["workspaceTool"]) => { calls.push(`selectWorkspaceTool:${tool}`); }),
    openTerminal: vi.fn((options?: { terminalId?: string | undefined }) => { calls.push(`openTerminal:${options?.terminalId ?? ""}`); }),
    refreshFiles: vi.fn(() => { calls.push("refreshFiles"); }),
    refreshGit: vi.fn(() => { calls.push("refreshGit"); }),
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
    expect(registry.getWorkspacePanels().map((panel) => panel.id)).toEqual(["core:workspace.files", "core:workspace.git", "core:workspace.terminal"]);
  });

  it("provides html and svg helpers to plugin activation", () => {
    const registry = new PluginRegistry();
    registry.register({
      id: "example",
      plugin: {
        apiVersion: 1,
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

    expect(registry.getWorkspacePanels()[0]?.icon).toBeDefined();
  });

  it("exposes the prompt helper to workspace panel callbacks", () => {
    const registry = new PluginRegistry();
    registry.register({
      id: "example",
      plugin: {
        apiVersion: 1,
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
          apiVersion: 1,
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

    const deletable = registry.getActions(createContext({ selectedWorkspace: testWorkspace({ isMain: false, isGitWorktree: true }) }).context);
    expect(deletable.find((action) => action.id === "core:workspace.delete")?.enabled).toBe(true);
  });

  it("routes workspace delete through the runtime context", () => {
    const registry = new PluginRegistry();
    registry.register({ id: "core", plugin: corePlugin });
    const { context, calls } = createContext({ selectedWorkspace: testWorkspace({ isMain: false, isGitWorktree: true }) });
    const action = registry.getActions(context).find((candidate) => candidate.id === "core:workspace.delete");

    if (action !== undefined) void action.run();

    expect(calls).toEqual(["deleteWorkspace"]);
  });

  it("offers archive only for persisted sessions and delete only for browser-cached new sessions", () => {
    const registry = new PluginRegistry();
    registry.register({ id: "core", plugin: corePlugin });

    const persistedActions = registry.getActions(createContext({ selectedSession: testSession() }).context);
    expect(persistedActions.find((action) => action.id === "core:session.archive")?.enabled).toBe(true);
    expect(persistedActions.find((action) => action.id === "core:session.delete")?.enabled).toBe(false);

    const cachedActions = registry.getActions(createContext({ selectedSession: markCachedNewSessionInfo(testSession()) }).context);
    expect(cachedActions.find((action) => action.id === "core:session.archive")?.enabled).toBe(false);
    expect(cachedActions.find((action) => action.id === "core:session.delete")?.enabled).toBe(true);

    const archivedActions = registry.getActions(createContext({ selectedSession: { ...testSession(), archived: true, archivedAt: "2026-05-20T00:00:00.000Z" } }).context);
    expect(archivedActions.find((action) => action.id === "core:session.archive")?.enabled).toBe(false);
    expect(archivedActions.find((action) => action.id === "core:session.delete")?.enabled).toBe(false);
  });

  it("enables session reload only for a writable session on a capable, idle runtime", () => {
    const registry = new PluginRegistry();
    registry.register({ id: "core", plugin: corePlugin });
    const reloadRuntime = { local: { machineId: "local", ok: true as const, checkedAt: "now", capabilities: [PI_WEB_CAPABILITIES.sessionsReload] } };

    const reloadable = registry.getActions(createContext({ selectedSession: testSession(), machineRuntimes: reloadRuntime }).context);
    expect(reloadable.find((action) => action.id === "core:session.reload")?.enabled).toBe(true);

    const noCapability = registry.getActions(createContext({ selectedSession: testSession() }).context);
    expect(noCapability.find((action) => action.id === "core:session.reload")?.enabled).toBe(false);

    const archived = registry.getActions(createContext({ selectedSession: { ...testSession(), archived: true, archivedAt: "2026-05-20T00:00:00.000Z" }, machineRuntimes: reloadRuntime }).context);
    expect(archived.find((action) => action.id === "core:session.reload")?.enabled).toBe(false);

    const busy = registry.getActions(createContext({ selectedSession: testSession(), machineRuntimes: reloadRuntime, status: testStatus({ isStreaming: true }) }).context);
    expect(busy.find((action) => action.id === "core:session.reload")?.enabled).toBe(false);
  });

  it("routes session reload through the runtime context", () => {
    const registry = new PluginRegistry();
    registry.register({ id: "core", plugin: corePlugin });
    const { context, calls } = createContext({ selectedSession: testSession(), machineRuntimes: { local: { machineId: "local", ok: true, checkedAt: "now", capabilities: [PI_WEB_CAPABILITIES.sessionsReload] } } });
    const action = registry.getActions(context).find((candidate) => candidate.id === "core:session.reload");

    if (action !== undefined) void action.run();

    expect(calls).toEqual(["reloadSession"]);
  });

  it("routes browser-cached new session delete through the runtime context", () => {
    const registry = new PluginRegistry();
    registry.register({ id: "core", plugin: corePlugin });
    const { context, calls } = createContext({ selectedSession: markCachedNewSessionInfo(testSession()) });
    const action = registry.getActions(context).find((candidate) => candidate.id === "core:session.delete");

    if (action !== undefined) void action.run();

    expect(calls).toEqual(["deleteCachedNewSession"]);
  });

  it("routes refresh current to the active core workspace panel", () => {
    const registry = new PluginRegistry();
    registry.register({ id: "core", plugin: corePlugin });
    const { context, calls } = createContext({
      selectedWorkspace: testWorkspace(),
      workspaceTool: "core:workspace.git",
    });
    const action = registry.getActions(context).find((candidate) => candidate.id === "core:workspace.refresh-current");

    if (action !== undefined) void action.run();

    expect(calls).toEqual(["refreshGit"]);
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
      ["core:view.git", "mod+3"],
      ["core:view.terminal", "mod+4"],
      ["core:workspace.refresh-files", "mod+shift+f"],
      ["core:workspace.refresh-git", "mod+shift+g"],
      ["core:workspace.refresh-current", "mod+shift+r"],
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
        apiVersion: 1,
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
        apiVersion: 1,
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
    const context = createWorkspaceLabelContext("remote-1", workspace, { files: { readFile, writeFile: vi.fn<WorkspaceFiles["writeFile"]>(() => Promise.resolve(testWriteFileResponse())), deleteFile: vi.fn<WorkspaceFiles["deleteFile"]>(() => Promise.resolve(testDeleteFileResponse())), moveFile: vi.fn<WorkspaceFiles["moveFile"]>(() => Promise.resolve(testMoveFileResponse())) }, host: { requestRender } });

    registry.register({
      id: "example",
      plugin: {
        apiVersion: 1,
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
        apiVersion: 1,
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

  it("prefers gateway plugins over remote plugins with the same source id", () => {
    const registry = new PluginRegistry();
    const remotePluginId = machineScopedPluginId("remote-1", "shared-tools");
    const workspace = testWorkspace();
    registry.register({
      id: remotePluginId,
      machineId: "remote-1",
      sourcePluginId: "shared-tools",
      plugin: {
        apiVersion: 1,
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
        apiVersion: 1,
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
        apiVersion: 1,
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
        apiVersion: 1,
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
        apiVersion: 1,
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
        apiVersion: 1,
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
    registry.register({ id: "shared-tools", plugin: { apiVersion: 1, name: "Gateway Shared Tools", activate: () => ({ contributions: {} }) } });

    registry.register({
      id: machineScopedPluginId("remote-1", "shared-tools"),
      machineId: "remote-1",
      sourcePluginId: "shared-tools",
      plugin: { apiVersion: 1, name: "Remote Shared Tools", activate: remoteActivate },
    });

    expect(remoteActivate).not.toHaveBeenCalled();
  });
});

function testWorkspace(patch: Partial<Workspace> = {}): Workspace {
  return { id: "w1", projectId: "p1", path: "/tmp/project", label: "main", isMain: true, isGitRepo: true, isGitWorktree: false, ...patch };
}

function createWorkspaceLabelContext(machineId: string, workspace = testWorkspace(), helpers: Partial<Pick<WorkspaceLabelContext, "files" | "host">> = {}): WorkspaceLabelContext {
  const files: WorkspaceFiles = helpers.files ?? { readFile: vi.fn<WorkspaceFiles["readFile"]>(() => Promise.resolve(testFileContent())), writeFile: vi.fn<WorkspaceFiles["writeFile"]>(() => Promise.resolve(testWriteFileResponse())), deleteFile: vi.fn<WorkspaceFiles["deleteFile"]>(() => Promise.resolve(testDeleteFileResponse())), moveFile: vi.fn<WorkspaceFiles["moveFile"]>(() => Promise.resolve(testMoveFileResponse())) };
  const host: WorkspaceHost = helpers.host ?? { requestRender: vi.fn<WorkspaceHost["requestRender"]>() };
  return {
    machine: { id: machineId, name: machineId, kind: machineId === "local" ? "local" : "remote" },
    workspace,
    state: { ...initialAppState(), selectedMachine: testMachine(machineId) },
    files,
    host,
  };
}

function createWorkspacePanelContext(machineId: string, prompt: WorkspacePanelContext["prompt"] = { insertText: vi.fn(), getText: vi.fn(() => ""), getSelection: vi.fn(() => null) }): WorkspacePanelContext {
  const workspace = testWorkspace();
  return {
    machine: { id: machineId, name: machineId, kind: machineId === "local" ? "local" : "remote" },
    workspace,
    state: { ...initialAppState(), selectedMachine: testMachine(machineId) },
    files: { readFile: vi.fn(), writeFile: vi.fn(), deleteFile: vi.fn(), moveFile: vi.fn() },
    prompt,
    terminal: { open: vi.fn(), runCommand: vi.fn() },
    host: { requestRender: vi.fn() },
    fileTree: [],
    expandedDirs: {},
    selectedFilePath: undefined,
    selectedFileContent: undefined,
    fileTreeStale: false,
    gitStatus: undefined,
    selectedDiffPath: undefined,
    selectedDiff: undefined,
    selectedStagedDiff: undefined,
    gitStale: false,
    activeTerminalCount: 0,
    selectedTerminalId: undefined,
    terminalAutoStart: false,
    onRefreshFiles: vi.fn(),
    onExpandDir: vi.fn(),
    onSelectFile: vi.fn(),
    onRefreshGit: vi.fn(),
    onSelectDiff: vi.fn(),
    onSelectTerminal: vi.fn(),
  };
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
