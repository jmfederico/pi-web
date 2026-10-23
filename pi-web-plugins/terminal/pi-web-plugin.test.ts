// @vitest-environment happy-dom

import type { ApplicationPanelContextV5, PluginActivationContextV5, PluginRuntimeContextV5, WorkspacePanelContextV5 } from "@jmfederico/pi-web/plugin-api";
import { html, svg, type TemplateResult } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TerminalBrowserRuntime } from "./TerminalBrowserRuntime";
import { applicationTerminalContext } from "./TerminalContext";
import { TERMINAL_BROWSER_FACADE_CAPABILITY } from "./TerminalFacade";
import plugin, { TERMINAL_PANEL_ELEMENT, TERMINAL_SOFT_KEYS_ELEMENT, activateTerminalPlugin, terminalPanelElementName, terminalSoftKeysElementName } from "./pi-web-plugin";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Terminal browser plugin activation", () => {
  it("registers its canonical panel/action identities, facade, and custom elements", () => {
    const result = activateTerminalPlugin(activationContext());
    const panel = result.contributions.applicationPanels?.[0];
    const action = result.contributions.actions?.[0];

    expect(plugin).toMatchObject({ apiVersion: 5, name: "Terminal" });
    const provides = result.provides;
    if (provides === undefined) throw new Error("Expected Terminal facade provision");
    expect(provides).toHaveLength(1);
    expect(provides[0]?.capability).toBe(TERMINAL_BROWSER_FACADE_CAPABILITY);
    expect(TERMINAL_BROWSER_FACADE_CAPABILITY.parse(provides[0]?.value).version).toBe(1);
    expect(panel).toMatchObject({
      id: "workspace.terminal",
      title: "Terminal",
      order: 30,
    });
    expect(action).toMatchObject({
      id: "view.terminal",
      shortcut: "mod+4",
      shortcutAliases: ["core:view.terminal"],
    });
    expect(customElements.get(TERMINAL_PANEL_ELEMENT)).toBeDefined();
    expect(customElements.get(TERMINAL_SOFT_KEYS_ELEMENT)).toBeDefined();
  });

  it("allocates browser product state per local or remote registration", () => {
    const firstContext = applicationContext("remote-1");
    const secondContext = applicationContext("remote-2");
    const first = plugin.activate(activationContext("machine.one.pi-web.terminal")).contributions.applicationPanels?.[0]?.render(firstContext);
    const second = plugin.activate(activationContext("machine.two.pi-web.terminal")).contributions.applicationPanels?.[0]?.render(secondContext);
    const firstValues = templateValues(first);
    const secondValues = templateValues(second);
    const firstRuntime = firstValues.find((value) => value instanceof TerminalBrowserRuntime);
    const secondRuntime = secondValues.find((value) => value instanceof TerminalBrowserRuntime);

    expect(templateText(first)).toContain("pi-web-terminal-panel-machine-one-pi-web-terminal");
    expect(firstValues).toContainEqual(applicationTerminalContext(firstContext));
    expect(secondValues).toContainEqual(applicationTerminalContext(secondContext));
    expect(customElements.get(terminalPanelElementName("machine.one.pi-web.terminal"))).toBeDefined();
    expect(customElements.get(terminalPanelElementName("machine.two.pi-web.terminal"))).toBeDefined();
    expect(customElements.get(terminalPanelElementName("machine.two.pi-web.terminal")))
      .not.toBe(customElements.get(terminalPanelElementName("machine.one.pi-web.terminal")));
    expect(firstValues).toContain(terminalSoftKeysElementName("machine.one.pi-web.terminal"));
    expect(secondValues).toContain(terminalSoftKeysElementName("machine.two.pi-web.terminal"));
    expect(customElements.get(terminalSoftKeysElementName("machine.one.pi-web.terminal"))).toBeDefined();
    expect(customElements.get(terminalSoftKeysElementName("machine.two.pi-web.terminal")))
      .not.toBe(customElements.get(terminalSoftKeysElementName("machine.one.pi-web.terminal")));
    expect(firstRuntime).toBeInstanceOf(TerminalBrowserRuntime);
    expect(secondRuntime).toBeInstanceOf(TerminalBrowserRuntime);
    expect(secondRuntime).not.toBe(firstRuntime);
  });

  it("publishes a parsed facade snapshot and disposes plugin-owned runtime resources", async () => {
    const result = activateTerminalPlugin(activationContext());
    const provision = result.provides?.[0];
    if (provision === undefined) throw new Error("Expected Terminal facade provision");
    const facade = TERMINAL_BROWSER_FACADE_CAPABILITY.parse(provision.value);
    const context = workspaceContext("local");
    if (context.peer === undefined) throw new Error("Expected Terminal peer");
    const rendered = result.contributions.applicationPanels?.[0]?.render(applicationContext("local"));
    const runtime = templateValues(rendered).find((value) => value instanceof TerminalBrowserRuntime);
    if (!(runtime instanceof TerminalBrowserRuntime)) throw new Error("Expected Terminal browser runtime");
    const terminal = facade.createWorkspaceTerminal({
      origin: "test",
      registrationPluginId: "pi-web.terminal",
      workspace: context.workspace,
      peer: context.peer,
      host: { navigateWorkspaceContribution: vi.fn() },
    });

    expect(Object.isFrozen(facade)).toBe(true);
    await result.dispose?.(new AbortController().signal);

    expect(() => { terminal.open(); }).toThrow(expect.objectContaining({ name: "AbortError" }));
    await expect(runtime.refresh(applicationTerminalContext(applicationContext("local")))).rejects.toMatchObject({ name: "AbortError" });
  });

  it("routes the navigation action through the required Terminal host facade", async () => {
    const result = activateTerminalPlugin(activationContext("machine.remote.pi-web.terminal"));
    const openTerminal = vi.fn<PluginRuntimeContextV5["openTerminal"]>();
    const context = runtimeContext(openTerminal);

    await result.contributions.actions?.[0]?.run(context);

    expect(openTerminal).toHaveBeenCalledOnce();
  });

  it.each([false, true])("renders maintenance with a machine peer regardless of workspace selection (%s)", (selected) => {
    const result = activateTerminalPlugin(activationContext());
    const panel = result.contributions.applicationPanels?.[0];
    const workspace = workspaceContext("remote");
    const peer = workspace.peer;
    if (peer === undefined) throw new Error("Expected Terminal peer");
    const forScope = vi.fn(() => peer);
    expect(panel).toMatchObject({ id: "workspace.terminal", title: "Terminal" });
    expect(result.contributions.workspacePanels).toBeUndefined();
    const rendered = panel?.render({
      machine: workspace.machine,
      host: workspace.host,
      catalog: workspace.catalog,
      navigate: workspace.navigate,
      prompt: workspace.prompt,
      ...(selected ? { workspace: workspace.workspace, terminal: workspace.terminal } : {}),
      state: selected ? { selectedWorkspace: workspace.workspace } : {},
      backend: { machineId: "remote", forScope },
    });
    expect(forScope).toHaveBeenCalledWith({ kind: "machine" });
    expect(templateValues(rendered)).toContainEqual(expect.objectContaining({ machine: workspace.machine, host: workspace.host, maintenance: { scope: "maintenance", peer } }));
    if (selected) expect(forScope).toHaveBeenCalledWith({ kind: "workspace", projectId: workspace.workspace.projectId, workspaceId: workspace.workspace.id });
    void result.dispose?.(new AbortController().signal);
  });

  it("rejects activation under any source identity other than pi-web.terminal", () => {
    expect(() => activateTerminalPlugin({ ...activationContext(), pluginId: "other" }))
      .toThrow("must activate as plugin id pi-web.terminal");
  });
});

function activationContext(runtimePluginId = "pi-web.terminal"): PluginActivationContextV5 {
  return Object.freeze({
    apiVersion: 5,
    pluginId: "pi-web.terminal",
    runtimePluginId,
    html,
    svg,
    signal: new AbortController().signal,
    lifetimeSignal: new AbortController().signal,
  });
}

function workspaceContext(machineId: string): WorkspacePanelContextV5 {
  return {
    catalog: catalog(machineId),
    navigate: () => Promise.resolve(),
    machine: { id: machineId, name: machineId, kind: machineId === "local" ? "local" : "remote" },
    workspace: { id: "workspace-1", projectId: "project-1", path: "/repo", label: "main", isMain: true },
    files: { readFile: vi.fn(), listFiles: vi.fn(), writeFile: vi.fn(), deleteFile: vi.fn(), moveFile: vi.fn() },
    peer: { request: vi.fn(() => Promise.resolve([])), openChannel: vi.fn() },
    host: { requestRender: vi.fn() },
    prompt: { insertText: vi.fn(), getText: vi.fn(() => ""), getSelection: vi.fn(() => null) },
    terminal: { open: vi.fn(), runCommand: vi.fn() },
    navigation: { version: 1, contributionId: "pi-web.terminal:workspace.terminal", query: {}, set: vi.fn() },
  };
}

function applicationContext(machineId: string): ApplicationPanelContextV5 {
  const context = workspaceContext(machineId);
  const peer = context.peer;
  if (peer === undefined) throw new Error("Expected peer");
  return { ...context, state: { selectedWorkspace: context.workspace }, backend: { machineId, forScope: () => peer } };
}

function runtimeContext(openTerminal: PluginRuntimeContextV5["openTerminal"]): PluginRuntimeContextV5 {
  return {
    catalog: catalog("local"),
    navigate: () => Promise.resolve(),
    state: { selectedWorkspace: { id: "workspace-1", projectId: "project-1", path: "/repo", label: "main", isMain: true } },
    prompt: { insertText: vi.fn(), getText: vi.fn(() => ""), getSelection: vi.fn(() => null) },
    openActionPalette: vi.fn(),
    focusPrompt: vi.fn(),
    addProject: vi.fn(),
    configureAuth: vi.fn(),
    logoutAuth: vi.fn(),
    openThemePicker: vi.fn(),
    selectMainView: vi.fn(),
    selectWorkspaceTool: vi.fn(),
    openTerminal,
    refreshFiles: vi.fn(),
    refreshWorkspacePanels: vi.fn(),
    refreshAppData: vi.fn(),
    reloadPage: vi.fn(),
    startSession: vi.fn(),
    archiveSession: vi.fn(),
    stopActiveWork: vi.fn(),
  };
}

function catalog(machineId: string): WorkspacePanelContextV5["catalog"] {
  return {
    version: 1, machineId,
    projects: { list: vi.fn(), get: vi.fn() },
    workspaces: { list: vi.fn(), get: vi.fn() },
    sessions: { list: vi.fn(), get: vi.fn() },
  };
}

function templateText(result: TemplateResult | undefined): string {
  if (result === undefined) return "";
  return `${result.strings.join("")}${result.values.map((value) => isTemplateResult(value) ? templateText(value) : "").join("")}`;
}

function templateValues(result: TemplateResult | undefined): unknown[] {
  if (result === undefined) return [];
  return result.values.flatMap((value) => isTemplateResult(value) ? templateValues(value) : [value]);
}

function isTemplateResult(value: unknown): value is TemplateResult {
  return typeof value === "object" && value !== null && "strings" in value && "values" in value;
}
