// @vitest-environment happy-dom

import type { FilePreviewerInput, PluginActivationContextV5, PluginCapability, PluginRuntimeContextV5, WorkspacePanelContextV5, PluginCatalog } from "@jmfederico/pi-web/plugin-api";
import { html, render, svg } from "lit";
import { FilesDocumentPreview } from "./FilesDocumentPreview";
import { afterEach, describe, expect, it, vi } from "vitest";
import { filesLocalizationFixture } from "./filesLocalization.testSupport";
import { FilesRuntime } from "./FilesRuntime";
import plugin, { FILES_CODE_VIEWER_ELEMENT, FILES_DOCUMENT_PREVIEW_ELEMENT, FILES_PANEL_ELEMENT, FILES_VIEWER_ELEMENT, activateFilesPlugin } from "./pi-web-plugin";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Files plugin activation", () => {
  it("resolves contributed titles and action groups live in the activation namespace", async () => {
    const { service, localization } = filesLocalizationFixture();
    const result = activateFilesPlugin({ ...activationContext(), localization }, new FilesRuntime());
    const panel = result.contributions.workspacePanels?.[0];
    const action = result.contributions.actions?.[0];
    expect(panel?.title).toBe("Files");
    expect(action?.group).toBe("Navigation");
    service.registerCatalog({ id: "files-test", namespace: "plugin:files:files", locale: "fr", load: () => Promise.resolve({ files: "Fichiers", goFiles: "Afficher les fichiers", navigation: "Parcourir" }) });
    await service.setPreferences({ ...service.preferences, language: "fr" });
    expect(panel?.title).toBe("Fichiers");
    expect(action?.title).toBe("Afficher les fichiers");
    expect(action?.group).toBe("Parcourir");
  });

  it("requires stylesheet integration v1 and passes the start-resolved capability across the panel boundary", async () => {
    expect(plugin.requires.map(({ id, version }) => ({ id, version }))).toEqual([
      { id: "stylesheet-integration", version: 1 },
      { id: "markdown-rendering", version: 1 },
      { id: "file-previewing", version: 1 },
      { id: "file-icons", version: 1 },
    ]);
    const result = activateFilesPlugin(activationContext(), new FilesRuntime());
    const integration = { registerRoot: vi.fn(() => vi.fn()), createController: vi.fn(), subscribe: vi.fn(() => vi.fn()) };
    const icons = { resolveIcon: vi.fn(), subscribe: vi.fn(() => vi.fn()) };
    const markdownRendering = { render: vi.fn(() => html`<b>Host Markdown</b>`) };
    const requests: string[] = [];
    const previewer = result.contributions.filePreviewers?.[0];
    const previewInput: FilePreviewerInput = {
      machineId: "local", projectId: "project-1", workspaceId: "workspace-1",
      file: { path: "image.png", content: "", size: 10, modifiedAt: "revision", encoding: "utf8", truncated: false, binary: true, mediaType: "image" },
      files: createWorkspaceContext().files, signal: new AbortController().signal, fail: vi.fn(),
    };
    expect(previewer?.render(previewInput).values).not.toContain(integration);
    await result.start?.({ signal: new AbortController().signal, capabilities: {
      resolve<Value>(token: PluginCapability<Value>): Value {
        requests.push(token.id);
        return token.parse(token.id === "file-icons" ? icons : token.id === "stylesheet-integration" ? integration : token.id === "file-previewing" ? { listPreviewers: vi.fn(), renderPreview: vi.fn() } : markdownRendering);
      },
    } });
    expect(requests).toEqual(["markdown-rendering", "file-previewing", "file-icons", "stylesheet-integration"]);
    const panel = result.contributions.workspacePanels?.[0]?.render(createWorkspaceContext());
    expect(panel?.values).toContain(integration);
    expect(panel?.values).toContain(icons);
    expect(previewer?.render(previewInput).values).toContain(integration);
    const markdownPreviewer = result.contributions.filePreviewers?.find(({ id }) => id === "markdown");
    if (markdownPreviewer === undefined) throw new Error("Missing Markdown previewer");
    render(markdownPreviewer.render({ ...previewInput, file: { ...previewInput.file, mediaType: "markdown", content: "# Notes", binary: false } }), document.body);
    const documentPreview = document.body.querySelector("pi-web-files-document-preview");
    if (!(documentPreview instanceof FilesDocumentPreview)) throw new Error("Missing document preview");
    await documentPreview.updateComplete;
    expect(markdownRendering.render).toHaveBeenCalledWith(expect.objectContaining({ text: "# Notes", machineId: "local" }));
    expect(documentPreview.shadowRoot?.querySelector("b")?.textContent).toBe("Host Markdown");
    const markdownRequirement = plugin.requires.find(({ id }) => id === "markdown-rendering");
    if (markdownRequirement === undefined) throw new Error("Missing Markdown requirement");
    expect(markdownRequirement).toMatchObject({ pluginId: "pi-web", version: 1 });
    for (const value of [null, {}, { render: "not a function" }]) {
      expect(() => markdownRequirement.parse(value)).toThrow("Files requires Markdown rendering capability v1");
    }
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
    expect(plugin).toMatchObject({ apiVersion: 5, name: "Files" });
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
    expect(customElements.get(FILES_DOCUMENT_PREVIEW_ELEMENT)).toBeDefined();
    expect(result.contributions.filePreviewers).toHaveLength(5);
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

    expect(rendered.values).toContain(workspaceContext);
    expect(rendered.values).toContain(runtime);

    const selectWorkspaceTool = vi.fn<PluginRuntimeContextV5["selectWorkspaceTool"]>();
    const refreshWorkspacePanels = vi.fn<PluginRuntimeContextV5["refreshWorkspacePanels"]>();
    const actionContext = createRuntimeContext({ selectWorkspaceTool, refreshWorkspacePanels });
    const view = result.contributions.actions?.find((action) => action.id === "view.files");
    const refresh = result.contributions.actions?.find((action) => action.id === "workspace.refresh-files");

    await view?.run(actionContext);
    await refresh?.run(actionContext);

    expect(selectWorkspaceTool).toHaveBeenCalledWith("files:workspace.files");
    expect(refreshWorkspacePanels).toHaveBeenCalledWith("files:workspace.files");
  });
});

function activationContext(runtimePluginId = "files"): PluginActivationContextV5 {
  return Object.freeze({
    apiVersion: 5,
    pluginId: "files",
    runtimePluginId,
    localization: filesLocalizationFixture().localization,
    html,
    svg,
    signal: new AbortController().signal,
    lifetimeSignal: new AbortController().signal,
  });
}

function createRuntimeContext(overrides: Partial<PluginRuntimeContextV5> = {}): PluginRuntimeContextV5 {
  const context = {
    catalog: catalog(),
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
  } satisfies PluginRuntimeContextV5;
  return context;
}

function createWorkspaceContext(): WorkspacePanelContextV5 {
  return {
    catalog: catalog(),
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

function catalog(): PluginCatalog {
  return {
    version: 1, machineId: "local",
    projects: { list: vi.fn(), get: vi.fn() },
    workspaces: { list: vi.fn(), get: vi.fn() },
    sessions: { list: vi.fn(), get: vi.fn() },
  };
}
