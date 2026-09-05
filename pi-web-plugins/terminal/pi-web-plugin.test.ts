// @vitest-environment happy-dom

import type { PluginActivationContext, PluginRuntimeContext, WorkspacePanelContext } from "@jmfederico/pi-web/plugin-api";
import { html, svg, type TemplateResult } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TerminalBrowserRuntime } from "./TerminalBrowserRuntime";
import plugin, { TERMINAL_PANEL_ELEMENT, TERMINAL_SOFT_KEYS_ELEMENT, activateTerminalPlugin, terminalPanelElementName, terminalSoftKeysElementName } from "./pi-web-plugin";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Terminal browser plugin activation", () => {
  it("registers its compatible panel/action identities, facade, and custom elements", () => {
    const result = activateTerminalPlugin(activationContext());
    const panel = result.contributions.workspacePanels?.[0];
    const action = result.contributions.actions?.[0];

    expect(plugin).toMatchObject({ apiVersion: 2, name: "Terminal" });
    expect(result.requiredTerminalFacade).toMatchObject({ version: 1 });
    expect(panel).toMatchObject({
      id: "workspace.terminal",
      title: "Terminal",
      order: 30,
      routeAliases: ["core:workspace.terminal"],
      navigationAliases: ["core:workspace.terminal"],
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
    const firstContext = workspaceContext("remote-1");
    const secondContext = workspaceContext("remote-2");
    const first = plugin.activate(activationContext("machine.one.terminal")).contributions.workspacePanels?.[0]?.render(firstContext);
    const second = plugin.activate(activationContext("machine.two.terminal")).contributions.workspacePanels?.[0]?.render(secondContext);
    const firstValues = templateValues(first);
    const secondValues = templateValues(second);
    const firstRuntime = firstValues.find((value) => value instanceof TerminalBrowserRuntime);
    const secondRuntime = secondValues.find((value) => value instanceof TerminalBrowserRuntime);

    expect(templateText(first)).toContain("pi-web-terminal-panel-machine-one-terminal");
    expect(firstValues).toContain(firstContext);
    expect(secondValues).toContain(secondContext);
    expect(customElements.get(terminalPanelElementName("machine.one.terminal"))).toBeDefined();
    expect(customElements.get(terminalPanelElementName("machine.two.terminal"))).toBeDefined();
    expect(customElements.get(terminalPanelElementName("machine.two.terminal")))
      .not.toBe(customElements.get(terminalPanelElementName("machine.one.terminal")));
    expect(firstValues).toContain(terminalSoftKeysElementName("machine.one.terminal"));
    expect(secondValues).toContain(terminalSoftKeysElementName("machine.two.terminal"));
    expect(customElements.get(terminalSoftKeysElementName("machine.one.terminal"))).toBeDefined();
    expect(customElements.get(terminalSoftKeysElementName("machine.two.terminal")))
      .not.toBe(customElements.get(terminalSoftKeysElementName("machine.one.terminal")));
    expect(firstRuntime).toBeInstanceOf(TerminalBrowserRuntime);
    expect(secondRuntime).toBeInstanceOf(TerminalBrowserRuntime);
    expect(secondRuntime).not.toBe(firstRuntime);
  });

  it("routes the navigation action through the required Terminal host facade", async () => {
    const result = activateTerminalPlugin(activationContext("machine.remote.terminal"));
    const openTerminal = vi.fn<PluginRuntimeContext["openTerminal"]>();
    const context = runtimeContext(openTerminal);

    await result.contributions.actions?.[0]?.run(context);

    expect(openTerminal).toHaveBeenCalledOnce();
  });

  it("rejects activation under any source identity other than terminal", () => {
    expect(() => activateTerminalPlugin({ ...activationContext(), pluginId: "other" }))
      .toThrow("must activate as plugin id terminal");
  });
});

function activationContext(runtimePluginId = "terminal"): PluginActivationContext {
  return Object.freeze({ apiVersion: 2, pluginId: "terminal", runtimePluginId, html, svg });
}

function workspaceContext(machineId: string): WorkspacePanelContext {
  return {
    machine: { id: machineId, name: machineId, kind: machineId === "local" ? "local" : "remote" },
    workspace: { id: "workspace-1", projectId: "project-1", path: "/repo", label: "main", isMain: true },
    files: { readFile: vi.fn(), listFiles: vi.fn(), writeFile: vi.fn(), deleteFile: vi.fn(), moveFile: vi.fn() },
    backend: { capabilityVersion: 1, channelVersion: 1, request: vi.fn(() => Promise.resolve([])), openChannel: vi.fn() },
    host: { requestRender: vi.fn() },
    prompt: { insertText: vi.fn(), getText: vi.fn(() => ""), getSelection: vi.fn(() => null) },
    terminal: { open: vi.fn(), runCommand: vi.fn() },
    navigation: { version: 1, contributionId: "terminal:workspace.terminal", query: {}, set: vi.fn() },
  };
}

function runtimeContext(openTerminal: PluginRuntimeContext["openTerminal"]): PluginRuntimeContext {
  return {
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
