// @vitest-environment happy-dom

import type { PluginActivationContext, PluginCapability, PluginRuntimeContext, WorkspacePanelContext } from "@jmfederico/pi-web/plugin-api";
import { html, svg, type TemplateResult } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FilesRuntime } from "./FilesRuntime";
import plugin, { FILES_CODE_VIEWER_ELEMENT, FILES_PANEL_ELEMENT, FILES_VIEWER_ELEMENT, activateFilesPlugin } from "./pi-web-plugin";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Files plugin activation", () => {
  it("requires stylesheet integration v1 and passes the start-resolved capability across the panel boundary", async () => {
    expect(plugin.requires.map(({ id, version }) => ({ id, version }))).toEqual([
      { id: "stylesheet-integration", version: 1 },
      { id: "content-rendering", version: 1 },
    ]);
    const result = activateFilesPlugin(activationContext(), new FilesRuntime());
    const integration = { registerRoot: vi.fn(() => vi.fn()), createController: vi.fn(), subscribe: vi.fn(() => vi.fn()) };
    const requests: string[] = [];
    await result.start?.({ signal: new AbortController().signal, capabilities: {
      resolve<Value>(token: PluginCapability<Value>): Value {
        requests.push(token.id);
        return token.parse(token.id === "stylesheet-integration" ? integration : { listRenderers: vi.fn(), renderText: vi.fn(), renderMarkdown: vi.fn() });
      },
    } });
    expect(requests).toEqual(["content-rendering", "stylesheet-integration"]);
    const panel = result.contributions.workspacePanels?.[0]?.render(createWorkspaceContext());
    expect(panel?.values).toContain(integration);
    const requirement = plugin.requires.find(({ id }) => id === "stylesheet-integration");
    if (requirement === undefined) throw new Error("Missing stylesheet integration requirement");
    for (const value of [null, {}, { ...integration, registerRoot: undefined }, { ...integration, createController: undefined }, { ...integration, subscribe: undefined }]) {
      expect(() => requirement.parse(value)).toThrow("Stylesheet integration capability v1");
    }
  });

  it("registers the canonical panel, actions, and custom elements synchronously", () => {
    const runtime = new FilesRuntime();
    const result = activateFilesPlugin(activationContext(), runtime);
    const panel = result.contributions.workspacePanels?.[0];
    const actions = result.contributions.actions ?? [];

    expect(panel?.fileOpenQuery?.(createWorkspaceContext(), "reports/a #1.txt")).toEqual({ file: "reports/a #1.txt" });
    expect(plugin).toMatchObject({ apiVersion: 4, name: "Files" });
    expect(panel).toMatchObject({
      id: "workspace.files",
      title: "Files",
      order: 10,
      invalidationResources: ["workspace.files"],
    });
    expect(actions.map((action) => ({ id: action.id, shortcut: action.shortcut, aliases: action.shortcutAliases }))).toEqual([
      { id: "view.files", shortcut: "mod+2", aliases: ["core:view.files"] },
      { id: "workspace.refresh-files", shortcut: "mod+shift+f", aliases: ["core:workspace.refresh-files"] },
    ]);
    expect(customElements.get(FILES_PANEL_ELEMENT)).toBeDefined();
    expect(customElements.get(FILES_VIEWER_ELEMENT)).toBeDefined();
    expect(customElements.get(FILES_CODE_VIEWER_ELEMENT)).toBeDefined();
  });

  it("allocates registration-local runtime state for repeated module activation", () => {
    const firstContext = createWorkspaceContext();
    const secondContext = { ...createWorkspaceContext(), machine: { id: "remote-2", name: "Remote 2", kind: "remote" as const } };
    const firstPanel = plugin.activate(activationContext("remote-1.files")).contributions.workspacePanels?.[0];
    const secondPanel = plugin.activate(activationContext("remote-2.files")).contributions.workspacePanels?.[0];
    const firstRendered = firstPanel?.render(firstContext);
    const secondRendered = secondPanel?.render(secondContext);
    const firstRuntime = firstRendered?.values.find((value) => value instanceof FilesRuntime);
    const secondRuntime = secondRendered?.values.find((value) => value instanceof FilesRuntime);

    expect(firstRendered?.values).toContain(firstContext);
    expect(secondRendered?.values).toContain(secondContext);
    expect(firstRuntime).toBeInstanceOf(FilesRuntime);
    expect(secondRuntime).toBeInstanceOf(FilesRuntime);
    expect(secondRuntime).not.toBe(firstRuntime);
  });

  it("still rejects an unrelated owner of a reserved Files element name", () => {
    class UnrelatedElement extends HTMLElement {}
    const registry = {
      get: vi.fn((name: string) => name === FILES_CODE_VIEWER_ELEMENT ? UnrelatedElement : undefined),
      define: vi.fn(),
    };
    vi.stubGlobal("customElements", registry);

    expect(() => activateFilesPlugin(activationContext(), new FilesRuntime()))
      .toThrow(`Files custom element name is already owned: ${FILES_CODE_VIEWER_ELEMENT}`);
    expect(registry.define).not.toHaveBeenCalled();
  });

  it("uses the host template boundary and routes actions through public runtime callbacks", async () => {
    const runtime = new FilesRuntime();
    const result = activateFilesPlugin(activationContext(), runtime);
    const panel = result.contributions.workspacePanels?.[0];
    const workspaceContext = createWorkspaceContext();
    const rendered = panel?.render(workspaceContext);
    if (rendered === undefined) throw new Error("Files panel contribution was unavailable");

    expect(templateText(rendered)).toContain("pi-web-files-panel");
    expect(rendered.values).toContain(workspaceContext);
    expect(rendered.values).toContain(runtime);

    const selectWorkspaceTool = vi.fn<PluginRuntimeContext["selectWorkspaceTool"]>();
    const refreshWorkspacePanels = vi.fn<PluginRuntimeContext["refreshWorkspacePanels"]>();
    const actionContext = createRuntimeContext({ selectWorkspaceTool, refreshWorkspacePanels });
    const view = result.contributions.actions?.find((action) => action.id === "view.files");
    const refresh = result.contributions.actions?.find((action) => action.id === "workspace.refresh-files");

    await view?.run(actionContext);
    await refresh?.run(actionContext);

    expect(selectWorkspaceTool).toHaveBeenCalledWith("files:workspace.files");
    expect(refreshWorkspacePanels).toHaveBeenCalledWith("files:workspace.files");
  });
});

function activationContext(runtimePluginId = "files"): PluginActivationContext {
  return Object.freeze({
    apiVersion: 4,
    pluginId: "files",
    runtimePluginId,
    html,
    svg,
    signal: new AbortController().signal,
    lifetimeSignal: new AbortController().signal,
  });
}

function createRuntimeContext(overrides: Partial<PluginRuntimeContext> = {}): PluginRuntimeContext {
  const context = {
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
    openTerminal: vi.fn(),
    refreshFiles: vi.fn(),
    refreshWorkspacePanels: vi.fn(),
    refreshAppData: vi.fn(),
    reloadPage: vi.fn(),
    startSession: vi.fn(),
    archiveSession: vi.fn(),
    stopActiveWork: vi.fn(),
    ...overrides,
  } satisfies PluginRuntimeContext;
  return context;
}

function createWorkspaceContext(): WorkspacePanelContext {
  return {
    navigate: () => Promise.resolve(),
    machine: { id: "local", name: "Local", kind: "local" },
    workspace: { id: "workspace-1", projectId: "project-1", path: "/repo", label: "main", isMain: true },
    files: {
      capabilityVersion: 1,
      defaultUploadFolder: ".pi-web/uploads",
      maxInlinePreviewBytes: 1024 * 1024,
      readFile: vi.fn(),
      listFiles: vi.fn(),
      writeFile: vi.fn(),
      deleteFile: vi.fn(),
      moveFile: vi.fn(),
      previewUrl: vi.fn(() => "about:blank"),
      downloadUrl: vi.fn(() => "about:blank"),
      uploadFile: vi.fn(),
    },
    host: { requestRender: vi.fn() },
    prompt: { insertText: vi.fn(), getText: vi.fn(() => ""), getSelection: vi.fn(() => null) },
    terminal: { open: vi.fn(), runCommand: vi.fn() },
    navigation: { version: 1, contributionId: "files:workspace.files", query: {}, set: vi.fn() },
  };
}

function templateText(result: TemplateResult): string {
  return result.strings.join("");
}
