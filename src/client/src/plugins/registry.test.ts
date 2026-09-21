import { html } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { DeleteWorkspaceFileResponse, FileContentResponse, FileTreeResponse, JsonValue, MoveWorkspaceFileResponse, SessionInfo, SessionStatus, WriteWorkspaceFileResponse, Workspace } from "../api";
import { initialAppState, type AppState } from "../appState";
import { markCachedNewSessionInfo } from "../cachedNewSessions";
import { machineScopedPluginId } from "../../../shared/machinePluginIds";
import { corePlugin } from "./core";
import { PluginRegistry, installWorkspaceLabelScope, installWorkspacePanelScope } from "./registry";
import { themePackPlugin } from "./themes";
import type { PiWebPlugin, PluginActivationResult, PluginCapability, PluginRuntimeContext, QualifiedContributionId, ThemeTokens, WorkspaceFiles, WorkspaceHost, WorkspaceInvalidation, WorkspaceLabelContext, WorkspaceLabelItem, WorkspacePanelContext, WorkspacePanelContribution, WorkspacePluginBinding } from "./types";
import { createPluginPeer } from "./pluginPeer";
import { adaptPublicPlugin, publicPluginState } from "./publicContext";
import type { PluginBackendRequestTarget } from "../api/pluginBackends";

it("resolves file-opening panels by availability, applicability, order and scoped context", async () => {
  let enabled = true;
  const registry = new PluginRegistry({ isContributionEnabled: () => enabled });
  const fileOpenQuery = vi.fn((_context: WorkspacePanelContext, path: string) => ({ file: path }));
  await registry.register({ id: "viewer", machineId: "remote", plugin: {
    apiVersion: 4, name: "Viewer", activate: () => ({ contributions: { workspacePanels: [
      { id: "hidden", title: "Hidden", order: 0, visible: () => false, fileOpenQuery, render: () => html`` },
      { id: "unsupported", title: "Unsupported", order: 1, fileOpenQuery: () => undefined, render: () => html`` },
      { id: "files", title: "Files", order: 2, fileOpenQuery, render: () => html`` },
    ] } }),
  } });
  const base = createWorkspacePanelContext("remote");
  const scoped: WorkspacePanelContext = { ...base, navigation: { version: 1, contributionId: "viewer:files", query: {}, set: vi.fn() } };
  installWorkspacePanelScope(base, () => scoped);
  expect(registry.resolveWorkspaceFileOpen(base, "a.txt")).toMatchObject({ contributionId: "viewer:files", query: { file: "a.txt" } });
  expect(fileOpenQuery).toHaveBeenCalledExactlyOnceWith(scoped, "a.txt");
  expect(registry.resolveWorkspaceFileOpen(createWorkspacePanelContext("local"), "a.txt")).toBeUndefined();
  enabled = false;
  expect(registry.resolveWorkspaceFileOpen(base, "a.txt")).toBeUndefined();
  enabled = true;
  await registry.dispose();
  expect(registry.resolveWorkspaceFileOpen(base, "a.txt")).toBeUndefined();
});

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
    selectWorkspaceTool: vi.fn((tool: QualifiedContributionId) => { calls.push(`selectWorkspaceTool:${tool}`); }),
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
  it("projects selected-session state for external action checks and execution", async () => {
    const registry = new PluginRegistry();
    const enabled = vi.fn(() => true);
    const disabledReason = vi.fn(() => undefined);
    const run = vi.fn();
    await registry.register({ id: "external", plugin: adaptPublicPlugin({
      apiVersion: 4, name: "External", activate: () => ({ contributions: {
        actions: [{ id: "action", title: "Action", enabled, disabledReason, run }],
      } }),
    }) });
    const { context } = createContext({ selectedSession: testSession() });
    const action = registry.getActions(context)[0];
    expect(action).toBeDefined();
    await action?.run();
    enabled.mockReturnValue(false);
    registry.getActions(context);
    for (const callback of [enabled, disabledReason, run]) {
      expect(callback).toHaveBeenCalledWith(expect.objectContaining({ state: publicPluginState(context.state) }));
    }
    expect(context.state.selectedSession).toHaveProperty("path");
  });

  it("namespaces contribution ids with the owning plugin id", async () => {
    const registry = new PluginRegistry();
    await registry.register({ id: "core", plugin: corePlugin });

    expect(registry.getActions(createContext().context).some((action) => action.id === "core:actions.show")).toBe(true);
    expect(registry.getWorkspacePanels()).toEqual([]);
    expect(registry.resolveWorkspacePanelRouteId("files", "local")).toBeUndefined();
    expect(registry.resolveWorkspacePanelRouteId("core:workspace.files", "local")).toBeUndefined();
  });

  it("dynamically gates every ordinary contribution surface without discarding registration", async () => {
    let enabled = true;
    const actionRun = vi.fn();
    const panelRender = vi.fn(() => html`<p>Panel</p>`);
    const panelInvalidate = vi.fn();
    const labelItems = vi.fn(() => [{ type: "text" as const, text: "label" }]);
    const activate = vi.fn<PiWebPlugin["activate"]>(() => ({
      contributions: {
        actions: [{ id: "act", title: "Act", run: actionRun }],
        workspacePanels: [{
          id: "workspace.panel",
          title: "Panel",
          routeAliases: ["legacy:workspace.panel"],
          onInvalidate: panelInvalidate,
          render: panelRender,
        }],
        workspaceLabels: [{ id: "label", items: labelItems }],
        themes: [{ id: "light", name: "Light", colorScheme: "light", tokens: testThemeTokens() }],
        themePairs: [{ id: "pair", name: "Pair", light: "light", dark: "light" }],
      },
    }));
    const registry = new PluginRegistry({ isContributionEnabled: () => enabled });
    await registry.register({ id: "ordinary", plugin: { apiVersion: 4, name: "Ordinary", activate } });
    const runtime = createContext({ selectedMachine: testMachine("local"), selectedWorkspace: testWorkspace() }).context;
    const panelContext = createWorkspacePanelContext("local");
    const labelContext = createWorkspaceLabelContext("local");
    const staleAction = registry.getActions(runtime)[0];
    const panel = registry.getWorkspacePanels()[0];

    expect(registry.resolveWorkspacePanelRouteId("legacy:workspace.panel", "local")).toBe("ordinary:workspace.panel");
    expect(registry.getWorkspaceLabelItems(labelContext)).toEqual([{ type: "text", text: "label" }]);
    expect(registry.getThemes()).toHaveLength(1);
    expect(registry.getThemePairs()).toHaveLength(1);

    enabled = false;
    expect(registry.hasPlugin("ordinary")).toBe(true);
    expect(registry.getActions(runtime)).toEqual([]);
    expect(registry.resolveWorkspacePanelRouteId("legacy:workspace.panel", "local")).toBeUndefined();
    expect(panel?.visible?.(panelContext)).toBe(false);
    panel?.render(panelContext);
    await registry.invalidateWorkspacePanels(panelContext);
    await staleAction?.run();
    expect(panelRender).not.toHaveBeenCalled();
    expect(panelInvalidate).not.toHaveBeenCalled();
    expect(actionRun).not.toHaveBeenCalled();
    expect(registry.getWorkspaceLabelItems(labelContext)).toEqual([]);
    expect(labelItems).toHaveBeenCalledOnce();
    expect(registry.getThemes()).toEqual([]);
    expect(registry.getThemePairs()).toEqual([]);

    enabled = true;
    expect(registry.getActions(runtime)).toHaveLength(1);
    expect(registry.getWorkspaceLabelItems(labelContext)).toEqual([{ type: "text", text: "label" }]);
    expect(registry.getThemes()).toHaveLength(1);
    expect(activate).toHaveBeenCalledOnce();
  });

  it("gates portable machine-using contributions against the selected machine and rechecks stale callbacks", async () => {
    const modes = new Map<string, boolean>([["local", false], ["remote-1", true]]);
    const actionRun = vi.fn();
    const registry = new PluginRegistry({
      isContributionEnabled: (_pluginId, effectiveMachineId) => effectiveMachineId === undefined
        ? true // themes are intentionally app-global
        : modes.get(effectiveMachineId) ?? false,
    });
    await registry.register({
      id: "portable",
      machineSpecific: false,
      plugin: {
        apiVersion: 4,
        name: "Portable",
        activate: () => ({
          contributions: {
            actions: [{ id: "act", title: "Act", run: actionRun }],
            workspacePanels: [{
              id: "workspace.panel",
              title: "Panel",
              routeAliases: ["portable-panel"],
              render: () => html`<p>Portable</p>`,
            }],
            workspaceLabels: [{ id: "label", items: () => [{ type: "text", text: "portable" }] }],
            themes: [{ id: "theme", name: "Portable", colorScheme: "light", tokens: testThemeTokens() }],
          },
        }),
      },
    });
    const remoteRuntime = createContext({ selectedMachine: testMachine("remote-1"), selectedWorkspace: testWorkspace() }).context;
    const localRuntime = createContext({ selectedMachine: testMachine("local"), selectedWorkspace: testWorkspace() }).context;
    const staleRemoteAction = registry.getActions(remoteRuntime)[0];

    expect(staleRemoteAction?.id).toBe("portable:act");
    expect(registry.getActions(localRuntime)).toEqual([]);
    expect(registry.resolveWorkspacePanelRouteId("portable-panel", "remote-1")).toBe("portable:workspace.panel");
    expect(registry.resolveWorkspacePanelRouteId("portable-panel", "local")).toBeUndefined();
    expect(registry.getWorkspaceLabelItems(createWorkspaceLabelContext("remote-1"))).toEqual([{ type: "text", text: "portable" }]);
    expect(registry.getWorkspaceLabelItems(createWorkspaceLabelContext("local"))).toEqual([]);
    expect(registry.getThemes()).toHaveLength(1);

    modes.set("local", true);
    modes.set("remote-1", false);
    expect(registry.getActions(remoteRuntime)).toEqual([]);
    expect(registry.getActions(localRuntime)).toHaveLength(1);
    expect(registry.resolveWorkspacePanelRouteId("portable-panel", "remote-1")).toBeUndefined();
    await staleRemoteAction?.run();
    expect(actionRun).not.toHaveBeenCalled();
    expect(registry.getThemes()).toHaveLength(1);

    modes.set("remote-1", true);
    expect(registry.getActions(remoteRuntime)).toHaveLength(1);
    await registry.getActions(remoteRuntime)[0]?.run();
    expect(actionRun).toHaveBeenCalledOnce();
  });

  it("rejects legacy browser plugins with an attributed API-version error", async () => {
    const registry = new PluginRegistry();
    const legacyPlugin: PiWebPlugin = {
      apiVersion: 4,
      name: "Legacy",
      activate: () => ({ contributions: {} }),
    };
    Reflect.set(legacyPlugin, "apiVersion", 3);

    await expect(registry.register({ id: "legacy", plugin: legacyPlugin })).rejects.toThrow(
      "Unsupported browser plugin API version for legacy: 3 (expected 4)",
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
    await registry.register({
      id: runtimePluginId,
      sourcePluginId: "board-tools",
      machineId: "remote-1",
      machineSpecific: true,
      plugin: { apiVersion: 4, name: "Board Tools", activate },
    });

    expect(activate).toHaveBeenCalledOnce();
    const activationContext = activate.mock.calls[0]?.[0];
    if (activationContext === undefined) throw new Error("Expected browser plugin activation context");
    expect(activationContext).toMatchObject({
      apiVersion: 4,
      pluginId: "board-tools",
      runtimePluginId,
    });
    expect(Object.isFrozen(activationContext)).toBe(true);

    const owned = createContext({
      selectedMachine: testMachine("remote-1"),
      selectedWorkspace: testWorkspace({ provider: { pluginId: "board-tools", capabilities: { remove: false } } }),
    });
    const action = registry.getActions(owned.context)[0];
    expect(action).toMatchObject({ id: `${runtimePluginId}:open`, enabled: true });
    await action?.run();
    expect(owned.calls).toEqual([`selectWorkspaceTool:${runtimePluginId}:workspace.board`]);

    const runtimeOwned = createContext({
      selectedMachine: testMachine("remote-1"),
      selectedWorkspace: testWorkspace({ provider: { pluginId: runtimePluginId, capabilities: { remove: false } } }),
    });
    expect(registry.getActions(runtimeOwned.context)[0]?.enabled).toBe(false);
  });

  it("resolves panel and shortcut migrations to the active machine-scoped contribution", async () => {
    const registry = new PluginRegistry();
    const plugin: PiWebPlugin = {
      apiVersion: 4,
      name: "VCS",
      activate: () => ({
        contributions: {
          actions: [{ id: "view.vcs", title: "View VCS", shortcutAliases: ["core:view.vcs"], run: () => undefined }],
          workspacePanels: [{
            id: "workspace.vcs",
            title: "VCS",
            routeAliases: ["vcs", "core:workspace.vcs"],
            navigationAliases: ["core:workspace.vcs"],
            render: () => html`<p>VCS</p>`,
          }],
        },
      }),
    };
    await registry.register({ id: "vcs", plugin, machineSpecific: true });
    const remotePluginId = machineScopedPluginId("remote-1", "vcs");
    await registry.register({ id: remotePluginId, sourcePluginId: "vcs", machineId: "remote-1", plugin, machineSpecific: true });

    expect(registry.resolveWorkspacePanelRouteId("core:workspace.vcs", "local")).toBe("vcs:workspace.vcs");
    expect(registry.resolveWorkspacePanelRouteId("vcs:workspace.vcs", "remote-1")).toBe(`${remotePluginId}:workspace.vcs`);
    expect(registry.getActions(createContext({ selectedMachine: testMachine("remote-1") }).context)[0]?.shortcutAliases)
      .toEqual(["core:view.vcs", "vcs:view.vcs"]);
    expect(registry.getWorkspacePanels().find((panel) => panel.id === "vcs:workspace.vcs")?.navigationAliases)
      .toEqual(["core:workspace.vcs"]);
    expect(registry.getWorkspacePanels().find((panel) => panel.id === `${remotePluginId}:workspace.vcs`)?.navigationAliases)
      .toEqual(["core:workspace.vcs", "vcs:workspace.vcs"]);
  });

  it("binds panel navigation to the qualified runtime contribution and validated aliases", async () => {
    const registry = new PluginRegistry();
    let renderedNavigation: WorkspacePanelContext["navigation"];
    await registry.register({
      id: "example",
      plugin: {
        apiVersion: 4,
        name: "Example",
        activate: () => ({
          contributions: {
            workspacePanels: [{
              id: "workspace.panel",
              title: "Panel",
              navigationAliases: ["legacy:workspace.panel"],
              render: (context) => {
                renderedNavigation = context.navigation;
                return html`<p>Panel</p>`;
              },
            }],
          },
        }),
      },
    });
    const base = createWorkspacePanelContext("local");
    const context = installWorkspacePanelScope(base, (binding, contributionId, aliases) => ({
      ...base,
      navigation: {
        version: 1,
        contributionId,
        query: { binding: binding.sourcePluginId, aliases },
        set: vi.fn(),
      },
    }));

    registry.getWorkspacePanels()[0]?.render(context);

    expect(renderedNavigation).toMatchObject({
      version: 1,
      contributionId: "example:workspace.panel",
      query: { binding: "example", aliases: ["legacy:workspace.panel"] },
    });
  });

  it("rejects invalid panel navigation aliases transactionally", async () => {
    const registry = new PluginRegistry();
    const panel: WorkspacePanelContribution = {
      id: "workspace.panel",
      title: "Panel",
      render: () => html`<p>Panel</p>`,
    };
    Reflect.set(panel, "navigationAliases", ["not-qualified"]);
    const plugin: PiWebPlugin = {
      apiVersion: 4,
      name: "Invalid navigation",
      activate: () => ({ contributions: { workspacePanels: [panel] } }),
    };

    await expect(registry.register({ id: "invalid-navigation", plugin }))
      .rejects.toThrow("Invalid workspace panel navigation alias for invalid-navigation:workspace.panel: not-qualified");
    expect(registry.hasPlugin("invalid-navigation")).toBe(false);
    expect(registry.getWorkspacePanels()).toEqual([]);
  });

  it("provides html and svg helpers to plugin activation and callbacks", async () => {
    const registry = new PluginRegistry();
    await registry.register({
      id: "example",
      plugin: {
        apiVersion: 4,
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

  it("exposes the prompt helper to workspace panel callbacks", async () => {
    const registry = new PluginRegistry();
    await registry.register({
      id: "example",
      plugin: {
        apiVersion: 4,
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

  it("rejects duplicate ids within the same namespace", async () => {
    const registry = new PluginRegistry();

    await expect(registry.register({
      id: "example",
      plugin: {
        apiVersion: 4,
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
    })).rejects.toThrow("Duplicate contribution id: example:duplicate");
  });

  it("rolls back every contribution when registration fails and allows a clean retry", async () => {
    const registry = new PluginRegistry();
    let fail = true;
    const plugin = {
      apiVersion: 4 as const,
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

    await expect(registry.register({ id: "retryable", plugin })).rejects.toThrow("Duplicate contribution id: retryable:action");
    expect(registry.hasPlugin("retryable")).toBe(false);
    expect(registry.getActions(createContext().context)).toEqual([]);
    expect(registry.shouldLoadRemotePlugin("retryable")).toBe(true);

    fail = false;
    await registry.register({ id: "retryable", plugin });

    expect(registry.hasPlugin("retryable")).toBe(true);
    expect(registry.getActions(createContext().context).map(({ id, title }) => ({ id, title }))).toEqual([
      { id: "retryable:action", title: "Ready" },
    ]);
    expect(registry.shouldLoadRemotePlugin("retryable")).toBe(false);
  });

  it("stages a dependency graph, snapshots exact capabilities, and shuts down in reverse dependency order", async () => {
    const registry = new PluginRegistry();
    const service = testPluginCapability("provider", "service", 1);
    const undeclared = testPluginCapability("other", "service", 1);
    const sourceValue = { label: "activation snapshot" };
    const events: string[] = [];
    const invocationSignals: AbortSignal[] = [];
    const lifetimes = new Map<string, AbortSignal>();
    let resolvedLabel = "";
    let undeclaredError = "";
    const result = await registry.registerBatch([
      {
        id: "consumer",
        plugin: {
          apiVersion: 4,
          name: "Consumer",
          requires: [service],
          activate: (context) => {
            lifetimes.set("consumer", context.lifetimeSignal);
            invocationSignals.push(context.signal);
            return {
              contributions: { actions: [{ id: "run", title: "Consumer", run: () => undefined }] },
              start: ({ capabilities, signal }) => {
                invocationSignals.push(signal);
                events.push("start:consumer");
                resolvedLabel = capabilities.resolve(service).label;
                try {
                  capabilities.resolve(undeclared);
                } catch (error) {
                  undeclaredError = error instanceof Error ? error.message : String(error);
                }
              },
              dispose: (signal) => {
                invocationSignals.push(signal);
                events.push(`dispose:consumer:${String(context.lifetimeSignal.aborted)}`);
              },
            };
          },
        },
      },
      {
        id: "provider",
        plugin: {
          apiVersion: 4,
          name: "Provider",
          activate: (context) => {
            lifetimes.set("provider", context.lifetimeSignal);
            invocationSignals.push(context.signal);
            return {
              contributions: { actions: [{ id: "run", title: "Provider", run: () => undefined }] },
              provides: [{ capability: service, value: sourceValue }],
              start: ({ signal }) => {
                invocationSignals.push(signal);
                events.push("start:provider");
                sourceValue.label = "mutated after snapshot";
              },
              dispose: (signal) => {
                invocationSignals.push(signal);
                events.push(`dispose:provider:${String(context.lifetimeSignal.aborted)}`);
              },
            };
          },
        },
      },
    ]);

    expect(result.failures).toEqual([]);
    expect(events).toEqual(["start:provider", "start:consumer"]);
    expect(resolvedLabel).toBe("activation snapshot");
    expect(undeclaredError).toContain("did not declare required capability other/service v1");
    expect(registry.getActions(createContext().context).map(({ id }) => id)).toEqual(["provider:run", "consumer:run"]);
    expect(registry.resolveCapability("provider", service)).toEqual({ label: "activation snapshot" });
    expect(invocationSignals).toHaveLength(4);
    expect(invocationSignals.every((signal) => signal.aborted)).toBe(true);
    expect([...lifetimes.values()].every((signal) => !signal.aborted)).toBe(true);

    registry.beginShutdown();
    expect([...lifetimes.values()].every((signal) => signal.aborted)).toBe(true);
    await registry.dispose();

    expect(events.slice(-2)).toEqual(["dispose:consumer:true", "dispose:provider:true"]);
    expect(invocationSignals).toHaveLength(6);
    expect(invocationSignals.every((signal) => signal.aborted)).toBe(true);
    expect(registry.getActions(createContext().context)).toEqual([]);
    expect(() => registry.resolveCapability("provider", service)).toThrow("is not active");
  });

  it.each(["host", "plugin"] as const)("keeps %s provision, requirement, and resolve parser boundaries distinct", async (source) => {
    const provider = testPluginCapability("provider", "service", 1);
    const requirement = { ...provider, parse: vi.fn((value: unknown) => ({ label: `requirement:${provider.parse(value).label}` })) };
    const request = { ...provider, parse: (value: unknown) => ({ label: `request:${provider.parse(value).label}` }) };
    const rejectingRequest = { ...provider, parse: () => { throw new Error("request rejected"); } };
    const provision = { capability: provider, value: { label: "ready" } };
    const registry = new PluginRegistry(source === "host" ? { hostCapabilities: [provision] } : {});
    if (source === "plugin") {
      await registry.register({ id: "provider", plugin: lifecyclePlugin("Provider", { provides: [provision] }) });
    }
    let resolved: TestPluginCapabilityValue | undefined;
    await registry.register({ id: "consumer", plugin: lifecyclePlugin("Consumer", {
      requires: [requirement],
      start: ({ capabilities }) => {
        expect(requirement.parse).toHaveBeenCalledWith({ label: "ready" });
        resolved = capabilities.resolve(request);
        expect(() => capabilities.resolve(rejectingRequest)).toThrow("request rejected");
      },
    }) });
    expect(resolved).toEqual({ label: "request:ready" });
    await registry.dispose();
  });

  it("retains the host-required capability snapshot that was validated before publication", async () => {
    const registry = new PluginRegistry();
    const providerToken = testPluginCapability("provider", "service", 1);
    let parseCount = 0;
    const hostToken: PluginCapability<TestPluginCapabilityValue, 1> = Object.freeze({
      pluginId: "provider",
      id: "service",
      version: 1,
      parse(value: unknown): TestPluginCapabilityValue {
        parseCount += 1;
        if (typeof value !== "object" || value === null) throw new Error("Expected a host capability object");
        const label: unknown = Reflect.get(value, "label");
        if (typeof label !== "string") throw new Error("Missing host capability label");
        return Object.freeze({ label: `host:${label}` });
      },
    });
    const result = await registry.registerBatch([{
      id: "provider",
      plugin: lifecyclePlugin("Provider", {
        provides: [{ capability: providerToken, value: { label: "ready" } }],
      }),
    }], {
      requiredCapabilities: [{ registrationPluginId: "provider", capability: hostToken }],
    });

    expect(result.failures).toEqual([]);
    expect(parseCount).toBe(1);
    expect(registry.resolveCapability("provider", hostToken)).toEqual({ label: "host:ready" });
    expect(parseCount).toBe(1);
  });

  it("contains failed providers and cycles, keeps independent publication, and retries the unpublished graph cleanly", async () => {
    const registry = new PluginRegistry();
    const service = testPluginCapability("provider", "service", 1);
    const alpha = testPluginCapability("alpha", "service", 1);
    const beta = testPluginCapability("beta", "service", 1);
    const events: string[] = [];
    const first = await registry.registerBatch([
      {
        id: "consumer",
        plugin: lifecyclePlugin("Consumer", {
          requires: [service],
          start: () => { events.push("unexpected:consumer"); },
          dispose: () => { events.push("dispose:consumer"); },
        }),
      },
      {
        id: "provider",
        plugin: lifecyclePlugin("Provider", {
          provides: [{ capability: service, value: { label: "failed" } }],
          start: () => { events.push("start:provider"); throw new Error("provider exploded"); },
          dispose: () => { events.push("dispose:provider"); },
        }),
      },
      {
        id: "alpha",
        plugin: lifecyclePlugin("Alpha", {
          requires: [beta],
          provides: [{ capability: alpha, value: { label: "alpha" } }],
          start: () => { events.push("unexpected:alpha"); },
        }),
      },
      {
        id: "beta",
        plugin: lifecyclePlugin("Beta", {
          requires: [alpha],
          provides: [{ capability: beta, value: { label: "beta" } }],
          start: () => { events.push("unexpected:beta"); },
        }),
      },
      {
        id: "independent",
        plugin: lifecyclePlugin("Independent", {
          start: () => { events.push("start:independent"); },
        }),
      },
    ]);

    expect(events).toEqual(expect.arrayContaining(["start:independent", "start:provider", "dispose:provider", "dispose:consumer"]));
    expect(events).not.toEqual(expect.arrayContaining(["unexpected:consumer", "unexpected:alpha", "unexpected:beta"]));
    expect(registry.hasPlugin("independent")).toBe(true);
    expect(["provider", "consumer", "alpha", "beta"].every((id) => !registry.hasPlugin(id))).toBe(true);
    expect(first.failures.find(({ declaration }) => declaration.id === "provider")?.error).toMatchObject({ message: "provider exploded" });
    const consumerFailure = first.failures.find(({ declaration }) => declaration.id === "consumer")?.error;
    expect(consumerFailure).toBeInstanceOf(Error);
    if (!(consumerFailure instanceof Error)) throw new Error("Expected consumer startup failure");
    expect(consumerFailure.message).toContain("did not start");
    expect(first.failures.filter(({ declaration }) => declaration.id === "alpha" || declaration.id === "beta").every(({ error }) => error instanceof Error && error.message.includes("dependency cycle"))).toBe(true);

    const retry = await registry.registerBatch([
      {
        id: "consumer",
        plugin: lifecyclePlugin("Consumer", { requires: [service], start: () => { events.push("retry:consumer"); } }),
      },
      {
        id: "provider",
        plugin: lifecyclePlugin("Provider", {
          provides: [{ capability: service, value: { label: "ready" } }],
          start: () => { events.push("retry:provider"); },
        }),
      },
    ]);

    expect(retry.failures).toEqual([]);
    expect(events.slice(-2)).toEqual(["retry:provider", "retry:consumer"]);
    expect(registry.hasPlugin("provider")).toBe(true);
    expect(registry.hasPlugin("consumer")).toBe(true);
  });

  it("scopes duplicate source capabilities by machine with portable fallback and failed same-machine shadowing", async () => {
    const registry = new PluginRegistry();
    const serviceV1 = testPluginCapability("service", "value", 1);
    const observed = new Map<string, string>();
    await registry.register({
      id: "service",
      plugin: lifecyclePlugin("Portable service", {
        provides: [{ capability: serviceV1, value: { label: "portable" } }],
      }),
    });
    const remoteProviderId = machineScopedPluginId("remote-1", "service");
    const remoteConsumerId = machineScopedPluginId("remote-1", "consumer");
    const fallbackConsumerId = machineScopedPluginId("remote-2", "consumer");
    const machineBatch = await registry.registerBatch([
      {
        id: remoteProviderId,
        sourcePluginId: "service",
        machineId: "remote-1",
        machineSpecific: true,
        plugin: lifecyclePlugin("Remote service", {
          provides: [{ capability: serviceV1, value: { label: "remote-1" } }],
        }),
      },
      {
        id: remoteConsumerId,
        sourcePluginId: "consumer",
        machineId: "remote-1",
        machineSpecific: true,
        plugin: lifecyclePlugin("Remote consumer", {
          requires: [serviceV1],
          start: ({ capabilities }) => { observed.set("remote-1", capabilities.resolve(serviceV1).label); },
        }),
      },
      {
        id: fallbackConsumerId,
        sourcePluginId: "consumer",
        machineId: "remote-2",
        machineSpecific: true,
        plugin: lifecyclePlugin("Fallback consumer", {
          requires: [serviceV1],
          start: ({ capabilities }) => { observed.set("remote-2", capabilities.resolve(serviceV1).label); },
        }),
      },
    ]);

    expect(machineBatch.failures).toEqual([]);
    expect(observed).toEqual(new Map([["remote-1", "remote-1"], ["remote-2", "portable"]]));
    expect(registry.resolveCapability("service", serviceV1)).toEqual({ label: "portable" });
    expect(registry.resolveCapability(remoteProviderId, serviceV1)).toEqual({ label: "remote-1" });

    const serviceV2 = testPluginCapability("service", "value", 2);
    const versionMismatch = await registry.registerBatch([{
      id: "version-mismatch",
      plugin: lifecyclePlugin("Version mismatch", {
        requires: [serviceV2],
        start: () => { observed.set("version-mismatch", "unexpected"); },
      }),
    }]);
    const versionError = versionMismatch.failures[0]?.error;
    expect(versionError).toBeInstanceOf(Error);
    if (!(versionError instanceof Error)) throw new Error("Expected exact-version capability failure");
    expect(versionError.message).toContain("requires unavailable capability service/value v2 from service");
    expect(observed.has("version-mismatch")).toBe(false);

    const shadowProviderId = machineScopedPluginId("remote-3", "service");
    const shadowConsumerId = machineScopedPluginId("remote-3", "shadow-consumer");
    const importFailure = new Error("remote service import failed");
    const shadow = await registry.registerBatch([{
      id: shadowConsumerId,
      sourcePluginId: "shadow-consumer",
      machineId: "remote-3",
      machineSpecific: true,
      plugin: lifecyclePlugin("Shadow consumer", {
        requires: [serviceV1],
        start: () => { observed.set("remote-3", "unexpected portable fallback"); },
      }),
    }], {
      declarations: [
        { id: shadowProviderId, sourcePluginId: "service", machineId: "remote-3", machineSpecific: true },
        { id: shadowConsumerId, sourcePluginId: "shadow-consumer", machineId: "remote-3", machineSpecific: true },
      ],
      failures: [{
        declaration: { id: shadowProviderId, sourcePluginId: "service", machineId: "remote-3", machineSpecific: true },
        phase: "import",
        error: importFailure,
      }],
    });

    expect(observed.has("remote-3")).toBe(false);
    expect(shadow.failures.some((failure) => failure.phase === "import" && failure.error === importFailure)).toBe(true);
    const shadowConsumerFailure = shadow.failures.find(({ declaration }) => declaration.id === shadowConsumerId)?.error;
    expect(shadowConsumerFailure).toBeInstanceOf(Error);
    if (!(shadowConsumerFailure instanceof Error)) throw new Error("Expected shadow consumer startup failure");
    expect(shadowConsumerFailure.message).toContain(`provider plugin ${shadowProviderId} did not start`);
  });

  it("rejects declaration/registration topology mismatches and registrations without declarations", async () => {
    const registry = new PluginRegistry();
    const activate = vi.fn(() => ({ contributions: {} }));
    const mismatch = await registry.registerBatch([{
      id: "topology",
      sourcePluginId: "registration-source",
      machineId: "remote-2",
      machineSpecific: true,
      manifestSource: "remote",
      plugin: { apiVersion: 4, name: "Topology", activate },
    }], {
      declarations: [{
        id: "topology",
        sourcePluginId: "declaration-source",
        machineId: "remote-1",
        machineSpecific: true,
        manifestSource: "bundled",
      }],
    });

    expect(activate).not.toHaveBeenCalled();
    expect(mismatch.failures[0]?.phase).toBe("validate");
    const mismatchError = mismatch.failures[0]?.error;
    expect(mismatchError).toBeInstanceOf(Error);
    if (!(mismatchError instanceof Error)) throw new Error("Expected topology mismatch failure");
    expect(mismatchError.message).toContain("topology does not match its declaration");

    const missing = await registry.registerBatch([{
      id: "undeclared",
      plugin: { apiVersion: 4, name: "Undeclared", activate },
    }], { declarations: [] });
    const missingError = missing.failures[0]?.error;
    expect(missingError).toBeInstanceOf(Error);
    if (!(missingError instanceof Error)) throw new Error("Expected missing declaration failure");
    expect(missingError.message).toContain("has no registration declaration");
    expect(registry.hasPlugin("topology")).toBe(false);
    expect(registry.hasPlugin("undeclared")).toBe(false);
  });

  it("rejects invalid, duplicate, and foreign capability provisions without partial publication", async () => {
    const registry = new PluginRegistry();
    const service = testPluginCapability("provider", "service", 1);
    const foreign = testPluginCapability("other", "service", 1);
    const dispose = vi.fn();
    const malformed = await registry.registerBatch([{
      id: "provider",
      plugin: {
        apiVersion: 4,
        name: "Malformed provider",
        activate: () => ({
          contributions: { actions: [{ id: "partial", title: "Partial", run: () => undefined }] },
          provides: [{ capability: service, value: {} }],
          dispose,
        }),
      },
    }]);
    const malformedError = malformed.failures[0]?.error;
    expect(malformedError).toBeInstanceOf(Error);
    if (!(malformedError instanceof Error)) throw new Error("Expected malformed capability failure");
    expect(malformedError.message).toContain("Provided capability provider/service v1 is invalid");
    expect(dispose).toHaveBeenCalledOnce();
    expect(registry.hasPlugin("provider")).toBe(false);
    expect(registry.getActions(createContext().context)).toEqual([]);

    const foreignResult = await registry.registerBatch([{
      id: "foreign-provider",
      sourcePluginId: "provider",
      plugin: lifecyclePlugin("Foreign provider", {
        provides: [{ capability: foreign, value: { label: "foreign" } }],
      }),
    }]);
    const foreignError = foreignResult.failures[0]?.error;
    expect(foreignError).toBeInstanceOf(Error);
    if (!(foreignError instanceof Error)) throw new Error("Expected foreign capability failure");
    expect(foreignError.message).toContain("provider cannot provide capability owned by other");

    const duplicateResult = await registry.registerBatch([{
      id: "duplicate-provider",
      sourcePluginId: "provider",
      plugin: lifecyclePlugin("Duplicate provider", {
        provides: [
          { capability: service, value: { label: "first" } },
          { capability: service, value: { label: "second" } },
        ],
      }),
    }]);
    const duplicateError = duplicateResult.failures[0]?.error;
    expect(duplicateError).toBeInstanceOf(Error);
    if (!(duplicateError instanceof Error)) throw new Error("Expected duplicate capability failure");
    expect(duplicateError.message).toContain("publishes provider/service v1 more than once");
  });

  it("serializes overlapping batches and aborts a timed-out activation invocation", async () => {
    const registry = new PluginRegistry({ lifecycleTimeoutMs: 50 });
    let releaseFirst: (value: { contributions: Record<string, never> }) => void = () => undefined;
    const firstActivation = new Promise<{ contributions: Record<string, never> }>((resolve) => { releaseFirst = resolve; });
    const secondActivate = vi.fn(() => ({ contributions: {} }));
    const first = registry.registerBatch([{
      id: "first",
      plugin: { apiVersion: 4, name: "First", activate: () => firstActivation },
    }]);
    const second = registry.registerBatch([{
      id: "second",
      plugin: { apiVersion: 4, name: "Second", activate: secondActivate },
    }]);
    await Promise.resolve();
    expect(secondActivate).not.toHaveBeenCalled();
    releaseFirst({ contributions: {} });
    await expect(first).resolves.toEqual({ failures: [] });
    await expect(second).resolves.toEqual({ failures: [] });
    expect(secondActivate).toHaveBeenCalledOnce();

    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const timedOut = registry.registerBatch([{
      id: "timed-out",
      plugin: {
        apiVersion: 4,
        name: "Timed out",
        activate: (context) => new Promise((_resolve, reject) => {
          signal = context.signal;
          context.signal.addEventListener("abort", () => {
            const reason: unknown = context.signal.reason;
            reject(reason instanceof Error ? reason : new Error("Timed-out activation aborted"));
          }, { once: true });
        }),
      },
    }]);
    await vi.advanceTimersByTimeAsync(50);
    const timedOutResult = await timedOut;
    vi.useRealTimers();

    expect(signal?.aborted).toBe(true);
    expect(timedOutResult.failures).toHaveLength(1);
    const timeoutFailure = timedOutResult.failures[0];
    expect(timeoutFailure?.phase).toBe("activate");
    expect(timeoutFailure?.error).toBeInstanceOf(Error);
    if (!(timeoutFailure?.error instanceof Error)) throw new Error("Expected activation timeout failure");
    expect(timeoutFailure.error.message).toContain("timed out");
    expect(registry.hasPlugin("timed-out")).toBe(false);
  });

  it("does not admit later activation after shutdown begins during a registration batch", async () => {
    const registry = new PluginRegistry({ lifecycleTimeoutMs: 1_000 });
    let firstSignal: AbortSignal | undefined;
    const firstActivate = vi.fn((context: Parameters<PiWebPlugin["activate"]>[0]) => new Promise<PluginActivationResult>((_resolve, reject) => {
      firstSignal = context.signal;
      context.signal.addEventListener("abort", () => {
        const reason: unknown = context.signal.reason;
        reject(reason instanceof Error ? reason : new Error("Activation aborted"));
      }, { once: true });
    }));
    const secondActivate = vi.fn(() => ({ contributions: {} }));
    const registration = registry.registerBatch([
      { id: "first-shutdown", plugin: { apiVersion: 4, name: "First", activate: firstActivate } },
      { id: "second-shutdown", plugin: { apiVersion: 4, name: "Second", activate: secondActivate } },
    ]);
    await vi.waitFor(() => { expect(firstActivate).toHaveBeenCalledOnce(); });

    registry.beginShutdown();
    const result = await registration;
    await registry.dispose();

    expect(firstSignal?.aborted).toBe(true);
    expect(secondActivate).not.toHaveBeenCalled();
    expect(result.failures.map(({ declaration }) => declaration.id)).toEqual(["first-shutdown", "second-shutdown"]);
    expect(result.failures.every(({ error }) => error instanceof Error && error.message.includes("shutting down"))).toBe(true);
  });

  it("bounds start and disposal independently while aborting the failed plugin lifetime before rollback", async () => {
    vi.useFakeTimers();
    const registry = new PluginRegistry({ lifecycleTimeoutMs: 25 });
    let lifetimeSignal: AbortSignal | undefined;
    let startSignal: AbortSignal | undefined;
    const rollback = vi.fn();
    const registration = registry.registerBatch([{
      id: "start-timeout",
      plugin: {
        apiVersion: 4,
        name: "Start timeout",
        activate: (context) => {
          lifetimeSignal = context.lifetimeSignal;
          return {
            contributions: {},
            start: ({ signal }) => new Promise<void>((_resolve, reject) => {
              startSignal = signal;
              signal.addEventListener("abort", () => {
                const reason: unknown = signal.reason;
                reject(reason instanceof Error ? reason : new Error("Start aborted"));
              }, { once: true });
            }),
            dispose: () => { rollback(lifetimeSignal?.aborted); },
          };
        },
      },
    }]);
    await vi.advanceTimersByTimeAsync(25);
    const result = await registration;

    expect(startSignal?.aborted).toBe(true);
    expect(lifetimeSignal?.aborted).toBe(true);
    expect(rollback).toHaveBeenCalledWith(true);
    expect(result.failures[0]?.phase).toBe("start");

    let disposeSignal: AbortSignal | undefined;
    const disposalRegistry = new PluginRegistry({ lifecycleTimeoutMs: 25 });
    await disposalRegistry.register({
      id: "dispose-timeout",
      plugin: lifecyclePlugin("Dispose timeout", {
        dispose: (signal) => new Promise<void>((_resolve, reject) => {
          disposeSignal = signal;
          signal.addEventListener("abort", () => {
            const reason: unknown = signal.reason;
            reject(reason instanceof Error ? reason : new Error("Disposal aborted"));
          }, { once: true });
        }),
      }),
    });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const disposing = disposalRegistry.dispose();
    await vi.advanceTimersByTimeAsync(25);
    await disposing;
    vi.useRealTimers();

    expect(disposeSignal?.aborted).toBe(true);
    expect(warning).toHaveBeenCalledWith("Failed to dispose PI WEB plugin dispose-timeout", expect.any(Error));
  });

  it("isolates workspace-panel invalidation failures", async () => {
    const registry = new PluginRegistry();
    const invalidated = vi.fn();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await registry.register({
      id: "example",
      plugin: {
        apiVersion: 4,
        name: "Example",
        activate: () => ({
          contributions: {
            workspacePanels: [
              { id: "broken", title: "Broken", invalidationResources: ["workspace.files"], onInvalidate: () => { throw new Error("broken refresh"); }, render: () => html`<p>Broken</p>` },
              { id: "healthy", title: "Healthy", invalidationResources: ["workspace.files"], onInvalidate: invalidated, render: () => html`<p>Healthy</p>` },
            ],
          },
        }),
      },
    });

    const invalidation: WorkspaceInvalidation = { reason: "mutation", resources: ["workspace.files"] };
    await registry.invalidateWorkspaceResources(createWorkspacePanelContext("local"), invalidation);

    expect(invalidated).toHaveBeenCalledOnce();
    expect(invalidated).toHaveBeenCalledWith(expect.any(Object), invalidation);
    expect(warning).toHaveBeenCalledWith("Failed to invalidate PI WEB plugin panel example:broken", expect.objectContaining({ message: "broken refresh" }));

    invalidated.mockClear();
    warning.mockClear();
    await registry.invalidateWorkspacePanels(createWorkspacePanelContext("local"), "example:healthy");
    expect(invalidated).toHaveBeenCalledOnce();
    expect(warning).not.toHaveBeenCalled();
  });

  it("keeps automatic resource invalidation subscribed while manual v2 invalidation remains broad", async () => {
    const registry = new PluginRegistry();
    const subscribed = vi.fn();
    const legacy = vi.fn();
    await registry.register({
      id: "example",
      plugin: {
        apiVersion: 4,
        name: "Example",
        activate: () => ({
          contributions: {
            workspacePanels: [
              { id: "subscribed", title: "Subscribed", invalidationResources: ["workspace.files"], onInvalidate: subscribed, render: () => html`<p>Subscribed</p>` },
              { id: "legacy", title: "Legacy", onInvalidate: legacy, render: () => html`<p>Legacy</p>` },
            ],
          },
        }),
      },
    });
    const context = createWorkspacePanelContext("remote-1");
    const invalidation: WorkspaceInvalidation = { reason: "agent-activity", resources: ["workspace.files"] };

    await registry.invalidateWorkspaceResources(context, invalidation);

    expect(subscribed).toHaveBeenCalledWith(context, invalidation);
    expect(legacy).not.toHaveBeenCalled();

    await registry.invalidateWorkspacePanels(context);

    expect(subscribed).toHaveBeenLastCalledWith(context);
    expect(legacy).toHaveBeenCalledWith(context);
  });

  it("rejects unsupported workspace invalidation resources transactionally", async () => {
    const registry = new PluginRegistry();
    const panel = { id: "files", title: "Files", render: () => html`<p>Files</p>` };
    Reflect.set(panel, "invalidationResources", ["workspace.unknown"]);

    await expect(registry.register({
      id: "example",
      plugin: { apiVersion: 4, name: "Example", activate: () => ({ contributions: { workspacePanels: [panel] } }) },
    })).rejects.toThrow("Invalid workspace-panel invalidation resource for example:files: workspace.unknown");
    expect(registry.hasPlugin("example")).toBe(false);
    expect(registry.getWorkspacePanels()).toEqual([]);
  });

  it("evaluates core workspace action enablement against runtime state", async () => {
    const registry = new PluginRegistry();
    await registry.register({ id: "core", plugin: corePlugin });

    const inactive = registry.getActions(createContext().context);
    const active = registry.getActions(createContext({ selectedWorkspace: testWorkspace() }).context);

    expect(inactive.find((action) => action.id === "core:view.files")).toBeUndefined();
    expect(active.find((action) => action.id === "core:view.files")).toBeUndefined();
    expect(active.find((action) => action.id === "core:workspace.delete")?.enabled).toBe(false);

    const deletable = registry.getActions(createContext({ selectedWorkspace: testWorkspace({
      isMain: false,
      removal: { actionLabel: "Disconnect view", confirmation: "Disconnect this view?", precondition: "removal-v1" },
    }) }).context);
    const removalAction = deletable.find((action) => action.id === "core:workspace.delete");
    expect(removalAction?.enabled).toBe(true);
    expect(removalAction?.title).toBe("Remove Workspace");
  });

  it("routes workspace delete through the runtime context", async () => {
    const registry = new PluginRegistry();
    await registry.register({ id: "core", plugin: corePlugin });
    const { context, calls } = createContext({ selectedWorkspace: testWorkspace({
      isMain: false,
      removal: { actionLabel: "Disconnect view", confirmation: "Disconnect this view?", precondition: "removal-v1" },
    }) });
    const action = registry.getActions(context).find((candidate) => candidate.id === "core:workspace.delete");

    if (action !== undefined) void action.run();

    expect(calls).toEqual(["deleteWorkspace"]);
  });

  it("offers archive only for persisted sessions and delete only for transient new sessions", async () => {
    const registry = new PluginRegistry();
    await registry.register({ id: "core", plugin: corePlugin });

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

  it("uses selected session status as the freshest archive/delete persistence signal", async () => {
    const registry = new PluginRegistry();
    await registry.register({ id: "core", plugin: corePlugin });

    const statusPersisted = registry.getActions(createContext({ selectedSession: testSession({ persisted: false }), status: testStatus({ persisted: true }) }).context);
    expect(statusPersisted.find((action) => action.id === "core:session.archive")?.enabled).toBe(true);
    expect(statusPersisted.find((action) => action.id === "core:session.delete")?.enabled).toBe(false);

    const statusTransient = registry.getActions(createContext({ selectedSession: testSession({ persisted: true }), status: testStatus({ persisted: false }) }).context);
    expect(statusTransient.find((action) => action.id === "core:session.archive")?.enabled).toBe(false);
    expect(statusTransient.find((action) => action.id === "core:session.delete")?.enabled).toBe(true);
  });

  it("enables session disk reload only for a writable, idle session", async () => {
    const registry = new PluginRegistry();
    await registry.register({ id: "core", plugin: corePlugin });

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

  it("treats a session that is only starting up as having no work to stop or block", async () => {
    const registry = new PluginRegistry();
    await registry.register({ id: "core", plugin: corePlugin });
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

  it("routes session reload through the runtime context", async () => {
    const registry = new PluginRegistry();
    await registry.register({ id: "core", plugin: corePlugin });
    const { context, calls } = createContext({ selectedSession: testSession({ persisted: true }) });
    const action = registry.getActions(context).find((candidate) => candidate.id === "core:session.reload");

    if (action !== undefined) void action.run();

    expect(calls).toEqual(["reloadSession"]);
  });

  it("routes transient new session delete through the runtime context", async () => {
    const registry = new PluginRegistry();
    await registry.register({ id: "core", plugin: corePlugin });
    const { context, calls } = createContext({ selectedSession: testSession({ persisted: false }) });
    const action = registry.getActions(context).find((candidate) => candidate.id === "core:session.delete");

    if (action !== undefined) void action.run();

    expect(calls).toEqual(["deleteCachedNewSession"]);
  });

  it("exposes model and thinking selectors as configurable actions for writable sessions", async () => {
    const registry = new PluginRegistry();
    await registry.register({ id: "core", plugin: corePlugin });

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

  it("routes app reload and settings actions through the runtime context", async () => {
    const registry = new PluginRegistry();
    await registry.register({ id: "core", plugin: corePlugin });
    const { context, calls } = createContext();
    const actions = registry.getActions(context);

    expect(actions.some((candidate) => candidate.id === "core:app.refresh-data")).toBe(false);
    void actions.find((candidate) => candidate.id === "core:app.reload-page")?.run();
    void actions.find((candidate) => candidate.id === "core:settings.open")?.run();

    expect(calls).toEqual(["reloadPage", "openSettings"]);
  });

  it("keeps built-in keyboard shortcuts unique and action-backed", async () => {
    const registry = new PluginRegistry();
    await registry.register({ id: "core", plugin: corePlugin });
    const shortcuts = registry.getActions(createContext({ selectedWorkspace: testWorkspace() }).context)
      .filter((action) => action.shortcut !== undefined)
      .map((action) => [action.id, action.shortcut]);

    expect(shortcuts).toEqual([
      ["core:actions.show", "mod+k"],
      ["core:prompt.focus", "mod+g c"],
      ["core:settings.open", "mod+,"],
      ["core:view.chat", "mod+1"],
      ["core:session.start", "mod+enter"],
      ["core:session.stop", "mod+."],
    ]);
    expect(new Set(shortcuts.map(([, shortcut]) => shortcut)).size).toBe(shortcuts.length);
  });

  it("collects built-in PI WEB themes from an in-app plugin", async () => {
    const registry = new PluginRegistry();
    await registry.register({ id: "themes", plugin: themePackPlugin });

    expect(registry.getThemes().map((theme) => ({ id: theme.id, colorScheme: theme.colorScheme }))).toEqual([
      { id: "themes:pi-web-dark", colorScheme: "dark" },
      { id: "themes:pi-web-light", colorScheme: "light" },
      { id: "themes:classic", colorScheme: "dark" },
    ]);
    expect(registry.getThemePairs().map((pair) => ({ id: pair.id, light: pair.light, dark: pair.dark }))).toEqual([
      { id: "themes:pi-web", light: "themes:pi-web-light", dark: "themes:pi-web-dark" },
    ]);
  });

  it("collects theme contributions in contribution order", async () => {
    const registry = new PluginRegistry();
    await registry.register({
      id: "example",
      plugin: {
        apiVersion: 4,
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

  it("collects workspace label items in contribution order", async () => {
    const registry = new PluginRegistry();
    const workspace = testWorkspace();
    await registry.register({
      id: "example",
      plugin: {
        apiVersion: 4,
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

  it("passes workspace label file and host helpers to callbacks", async () => {
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

    await registry.register({
      id: "example",
      plugin: {
        apiVersion: 4,
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

  it("only exposes machine-scoped plugin contributions for their machine", async () => {
    const registry = new PluginRegistry();
    const pluginId = machineScopedPluginId("remote-1", "project-tools");
    const workspace = testWorkspace();
    await registry.register({
      id: pluginId,
      machineId: "remote-1",
      sourcePluginId: "project-tools",
      plugin: {
        apiVersion: 4,
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

  it("binds backend helpers to source identity rather than the machine-scoped registration id", async () => {
    const registry = new PluginRegistry();
    const registrationPluginId = machineScopedPluginId("remote-1", "board-tools");
    const observedBindings: WorkspacePluginBinding[] = [];
    const observedRequests: { target: PluginBackendRequestTarget; operation: string; input: JsonValue }[] = [];
    await registry.register({
      id: registrationPluginId,
      machineId: "remote-1",
      sourcePluginId: "board-tools",
      backendRevision: "server-r7",
      pairedRequestVersion: 1,
      pairedChannelVersion: 1,
      plugin: {
        apiVersion: 4,
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
                  void requiredPluginPeer(context.peer).request?.("cards.summary", { includeClosed: false });
                  return html`<p>Board</p>`;
                },
              }],
              workspaceLabels: [{
                id: "board-count",
                items: (context) => {
                  void requiredPluginPeer(context.peer).request?.("cards.count", null);
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
      peer: requiredPluginPeer(createPluginPeer(binding, panelBase.workspace, panelBase.machine.id, (target, operation, input) => {
        observedBindings.push(binding);
        observedRequests.push({ target, operation, input });
        return Promise.resolve(null);
      }, vi.fn())),
    }));
    const labelBase = createWorkspaceLabelContext("remote-1");
    const labelContext = installWorkspaceLabelScope(labelBase, (binding) => ({
      ...labelBase,
      peer: requiredPluginPeer(createPluginPeer(binding, labelBase.workspace, labelBase.machine.id, (target, operation, input) => {
        observedBindings.push(binding);
        observedRequests.push({ target, operation, input });
        return Promise.resolve(null);
      }, vi.fn())),
    }));

    registry.getWorkspacePanels().find(({ localId }) => localId === "workspace.board")?.render(panelContext);
    expect(registry.getWorkspaceLabelItems(labelContext)).toEqual([{ type: "text", text: "2 cards" }]);

    expect(observedBindings).toEqual([
      { registrationPluginId, sourcePluginId: "board-tools", backendRevision: "server-r7", pairedRequestVersion: 1, pairedChannelVersion: 1 },
      { registrationPluginId, sourcePluginId: "board-tools", backendRevision: "server-r7", pairedRequestVersion: 1, pairedChannelVersion: 1 },
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

  it("pairs machine-specific gateway and remote contributions with their own active backend revisions", async () => {
    const registry = new PluginRegistry();
    const remotePluginId = machineScopedPluginId("remote-1", "pair-tools");
    const pairedPlugin = (name: string) => ({
      apiVersion: 4 as const,
      name,
      activate: () => ({
        contributions: {
          workspacePanels: [{
            id: "workspace.pair",
            title: name,
            render: (context: WorkspacePanelContext) => {
              void requiredPluginPeer(context.peer).request?.("pair.check", null);
              return html`<p>${name}</p>`;
            },
          }],
        },
      }),
    });
    await registry.register({ id: "pair-tools", machineSpecific: true, backendRevision: "gateway-r1", pairedRequestVersion: 1, plugin: pairedPlugin("Gateway pair") });
    await registry.register({
      id: remotePluginId,
      machineId: "remote-1",
      sourcePluginId: "pair-tools",
      machineSpecific: true,
      backendRevision: "remote-r2",
      pairedRequestVersion: 1,
      plugin: pairedPlugin("Remote pair"),
    });
    const requests: PluginBackendRequestTarget[] = [];

    for (const machineId of ["local", "remote-1"]) {
      const base = createWorkspacePanelContext(machineId);
      const context = installWorkspacePanelScope(base, (binding) => ({
        ...base,
        peer: requiredPluginPeer(createPluginPeer(binding, base.workspace, machineId, (target) => {
          requests.push(target);
          return Promise.resolve(null);
        }, vi.fn())),
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

  it("prefers gateway plugins over remote plugins with the same source id", async () => {
    const registry = new PluginRegistry();
    const remotePluginId = machineScopedPluginId("remote-1", "shared-tools");
    const workspace = testWorkspace();
    await registry.register({
      id: remotePluginId,
      machineId: "remote-1",
      sourcePluginId: "shared-tools",
      plugin: {
        apiVersion: 4,
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

    await registry.register({
      id: "shared-tools",
      plugin: {
        apiVersion: 4,
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

  it("uses machine-specific remote duplicates instead of the gateway plugin for that machine", async () => {
    const registry = new PluginRegistry();
    const workspace = testWorkspace();
    const remotePluginId = machineScopedPluginId("remote-1", "updates");
    await registry.register({
      id: "updates",
      machineSpecific: true,
      plugin: {
        apiVersion: 4,
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

    await registry.register({
      id: remotePluginId,
      machineId: "remote-1",
      sourcePluginId: "updates",
      plugin: {
        apiVersion: 4,
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

  it("allows a machine-specific remote duplicate to override a portable gateway plugin for that machine", async () => {
    const registry = new PluginRegistry();
    const remotePluginId = machineScopedPluginId("remote-1", "status-tools");
    await registry.register({
      id: "status-tools",
      plugin: {
        apiVersion: 4,
        name: "Gateway Status Tools",
        activate: () => ({ contributions: { actions: [{ id: "open", title: "Open Gateway Status", run: () => undefined }] } }),
      },
    });

    expect(registry.shouldLoadRemotePlugin("status-tools")).toBe(false);
    expect(registry.shouldLoadRemotePlugin("status-tools", true)).toBe(true);
    await registry.register({
      id: remotePluginId,
      machineId: "remote-1",
      sourcePluginId: "status-tools",
      machineSpecific: true,
      plugin: {
        apiVersion: 4,
        name: "Remote Status Tools",
        activate: () => ({ contributions: { actions: [{ id: "open", title: "Open Remote Status", run: () => undefined }] } }),
      },
    });

    expect(registry.getActions(createContext().context).map((action) => action.id)).toEqual(["status-tools:open"]);
    expect(registry.getActions(createContext({ selectedMachine: testMachine("remote-1") }).context).map((action) => action.id)).toEqual([`${remotePluginId}:open`]);
  });

  it("does not activate remote duplicates when the gateway plugin is already registered", async () => {
    const registry = new PluginRegistry();
    const remoteActivate = vi.fn(() => ({ contributions: { actions: [{ id: "remote-action", title: "Remote Action", run: () => undefined }] } }));
    await registry.register({ id: "shared-tools", plugin: { apiVersion: 4, name: "Gateway Shared Tools", activate: () => ({ contributions: {} }) } });

    await registry.register({
      id: machineScopedPluginId("remote-1", "shared-tools"),
      machineId: "remote-1",
      sourcePluginId: "shared-tools",
      plugin: { apiVersion: 4, name: "Remote Shared Tools", activate: remoteActivate },
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
    peer: { request: vi.fn(() => Promise.resolve(null)) },
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
    peer: { request: vi.fn(() => Promise.resolve(null)) },
    prompt,
    terminal: { open: vi.fn(), runCommand: vi.fn() },
    host: { requestRender: vi.fn() },
  };
}

function requiredPluginPeer(peer: WorkspacePanelContext["peer"]): NonNullable<WorkspacePanelContext["peer"]> {
  if (peer === undefined) throw new Error("Expected a package peer");
  return peer;
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

interface TestPluginCapabilityValue {
  readonly label: string;
}

function testPluginCapability(pluginId: string, id: string, version: number): PluginCapability<TestPluginCapabilityValue> {
  return Object.freeze({
    pluginId,
    id,
    version,
    parse(value: unknown): TestPluginCapabilityValue {
      if (typeof value !== "object" || value === null) throw new Error("Expected a labelled test capability");
      const label: unknown = Reflect.get(value, "label");
      if (typeof label !== "string") throw new Error("Expected a labelled test capability");
      return Object.freeze({ label });
    },
  });
}

function lifecyclePlugin(
  name: string,
  options: Pick<PiWebPlugin, "requires"> & Partial<Pick<PluginActivationResult, "provides" | "start" | "dispose">> = {},
): PiWebPlugin {
  const { requires, ...activation } = options;
  return {
    apiVersion: 4,
    name,
    ...(requires === undefined ? {} : { requires }),
    activate: () => ({ contributions: {}, ...activation }),
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
