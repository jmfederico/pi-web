import type { FileIconsCapability, StylesheetIntegrationCapabilityV1, FilePreviewingCapability, MarkdownRenderingCapability, PluginCapability, PiWebPlugin, PluginActivationContextV5, PluginActivationResultV5 } from "@jmfederico/pi-web/plugin-api";
import { createFilesContent } from "./filesLocalization";
import { FileIcon } from "./FileIcon";
import { FilesCodeViewer } from "./FilesCodeViewer";
import { FilesDocumentPreview } from "./FilesDocumentPreview";
import { createDocumentPreviewers } from "./documentPreviewers";
import { WorkspaceFilesPanel } from "./FilesPanel";
import { FilesRuntime } from "./FilesRuntime";
import { WorkspaceFileViewer } from "./FilesViewer";
import filesIconUrl from "./files-icon.svg?url";
import filesStyles from "./files.css?inline";

export { FilesRuntime, filesIconUrl, filesStyles };
export { loadFilesViewerDependencies } from "./viewerLoader";
export type { FilesViewerDependencies } from "./viewerLoader";

export const FILES_PANEL_ELEMENT = "pi-web-files-panel";
export const FILES_VIEWER_ELEMENT = "pi-web-files-viewer";
export const FILES_CODE_VIEWER_ELEMENT = "pi-web-files-code-viewer";
export const FILES_DOCUMENT_PREVIEW_ELEMENT = "pi-web-files-document-preview";

const filesCustomElementOwnersKey = Symbol.for("pi-web.files.custom-element-owners.v1");

const markdownRenderingCapability: PluginCapability<MarkdownRenderingCapability> = {
  pluginId: "pi-web", id: "markdown-rendering", version: 1,
  parse: (value) => {
    if (!isMarkdownRenderingCapability(value)) throw new Error("Files requires Markdown rendering capability v1");
    return value;
  },
};

function isMarkdownRenderingCapability(value: unknown): value is MarkdownRenderingCapability {
  return typeof value === "object" && value !== null
    && "render" in value && typeof value.render === "function";
}

function isFilePreviewingCapability(value: unknown): value is FilePreviewingCapability {
  return typeof value === "object" && value !== null
    && "listPreviewers" in value && typeof value.listPreviewers === "function"
    && "renderPreview" in value && typeof value.renderPreview === "function";
}

const filePreviewingCapability: PluginCapability<FilePreviewingCapability> = {
  pluginId: "pi-web", id: "file-previewing", version: 1,
  parse(value) {
    if (!isFilePreviewingCapability(value)) throw new Error("Files requires file previewing capability v1");
    return value;
  },
};

const fileIconsCapability: PluginCapability<FileIconsCapability> = {
  pluginId: "pi-web", id: "file-icons", version: 1,
  parse(value) {
    if (!isFileIconsCapability(value)) {
      throw new Error("Files requires file icons capability v1");
    }
    return value;
  },
};

function isFileIconsCapability(value: unknown): value is FileIconsCapability {
  return typeof value === "object" && value !== null
    && "resolveIcon" in value && typeof value.resolveIcon === "function"
    && "subscribe" in value && typeof value.subscribe === "function";
}

const stylesheetIntegrationCapability: PluginCapability<StylesheetIntegrationCapabilityV1, 1> = {
  pluginId: "pi-web", id: "stylesheet-integration", version: 1,
  parse(value) {
    if (!isStylesheetIntegration(value)) {
      throw new Error("Stylesheet integration capability v1 requires registerRoot and createController");
    }
    return value;
  },
};

function isStylesheetIntegration(value: unknown): value is StylesheetIntegrationCapabilityV1 {
  return typeof value === "object" && value !== null
    && "registerRoot" in value && typeof value.registerRoot === "function"
    && "createController" in value && typeof value.createController === "function"
    && "subscribe" in value && typeof value.subscribe === "function";
}

const plugin = {
  requires: [stylesheetIntegrationCapability, markdownRenderingCapability, filePreviewingCapability, fileIconsCapability],
  apiVersion: 5,
  name: "Files",
  activate: (context) => activateFilesPlugin(context, new FilesRuntime()),
} satisfies PiWebPlugin;

export default plugin;

export function activateFilesPlugin(context: PluginActivationContextV5, filesRuntime: FilesRuntime): PluginActivationResultV5 {
  if (context.localization === undefined) throw new Error("The Files plugin requires a localization-capable PI WEB host");
  const content = createFilesContent(context.localization);
  filesRuntime.setLocalization(context.localization);
  defineFilesCustomElements();
  let markdownRendering: MarkdownRenderingCapability | undefined;
  let filePreviewing: FilePreviewingCapability | undefined;
  let fileIcons: FileIconsCapability | undefined;
  let stylesheetIntegration: StylesheetIntegrationCapabilityV1 | undefined;
  const panelId = `${context.runtimePluginId}:workspace.files`;
  const icon = context.svg`
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
      <path d="M3 6.5A2.5 2.5 0 0 1 5.5 4H10l2 2h6.5A2.5 2.5 0 0 1 21 8.5v8A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5z"></path>
    </svg>
  `;
  return {
    start: ({ capabilities }) => {
      markdownRendering = capabilities.resolve(markdownRenderingCapability);
      filePreviewing = capabilities.resolve(filePreviewingCapability);
      fileIcons = capabilities.resolve(fileIconsCapability);
      stylesheetIntegration = capabilities.resolve(stylesheetIntegrationCapability);
    },
    contributions: {
      filePreviewers: createDocumentPreviewers({
        html: context.html,
        content,
        getMarkdownRendering: () => markdownRendering,
        getStylesheetIntegration: () => stylesheetIntegration,
      }),
      workspacePanels: [{
        id: "workspace.files",
        get title() { return content.messages.t("files"); },
        icon,
        order: 10,
        invalidationResources: ["workspace.files"],
        fileOpenQuery: (_workspaceContext, path) => ({ file: path }),
        onInvalidate: (workspaceContext, invalidation) => filesRuntime.invalidate(workspaceContext, invalidation),
        render: (workspaceContext) => context.html`<pi-web-files-panel .content=${content} .stylesheetIntegration=${stylesheetIntegration} .context=${workspaceContext} .runtime=${filesRuntime} .fileIcons=${fileIcons} .filePreviewing=${filePreviewing}></pi-web-files-panel>`,
      }],
      actions: [
        {
          id: "view.files",
          get title() { return content.messages.t("goFiles"); },
          shortcut: "mod+2",
          shortcutAliases: ["core:view.files"],
          get group() { return content.messages.t("navigation"); },
          enabled: (runtimeContext) => runtimeContext.state.selectedWorkspace !== undefined,
          run: (runtimeContext) => { runtimeContext.selectWorkspaceTool(panelId); },
        },
        {
          id: "workspace.refresh-files",
          get title() { return content.messages.t("refreshFiles"); },
          shortcut: "mod+shift+f",
          shortcutAliases: ["core:workspace.refresh-files"],
          get group() { return content.messages.t("workspace"); },
          enabled: (runtimeContext) => runtimeContext.state.selectedWorkspace !== undefined,
          run: (runtimeContext) => runtimeContext.refreshWorkspacePanels(panelId),
        },
      ],
    },
  };
}

export function defineFilesCustomElements(): void {
  if (typeof customElements === "undefined") throw new Error("Files requires browser Custom Elements support");
  defineCustomElement(FILES_CODE_VIEWER_ELEMENT, FilesCodeViewer);
  defineCustomElement(FILES_VIEWER_ELEMENT, WorkspaceFileViewer);
  defineCustomElement(FILES_DOCUMENT_PREVIEW_ELEMENT, FilesDocumentPreview);
  defineCustomElement(FILES_PANEL_ELEMENT, WorkspaceFilesPanel);
  defineCustomElement("pi-web-files-icon", FileIcon);
}

function defineCustomElement(name: string, constructor: CustomElementConstructor): void {
  const existing = customElements.get(name);
  const owners = filesCustomElementOwners();
  if (existing === undefined) {
    customElements.define(name, constructor);
    owners.set(name, constructor);
    return;
  }
  if (existing === constructor) {
    owners.set(name, constructor);
    return;
  }
  // Portable copies loaded from distinct machine module URLs have distinct
  // constructors. Reuse the first same-source element implementation; the
  // rendered element still receives this registration's context and runtime.
  if (owners.get(name) === existing) return;
  throw new Error(`Files custom element name is already owned: ${name}`);
}

function filesCustomElementOwners(): Map<string, CustomElementConstructor> {
  const existing: unknown = Reflect.get(globalThis, filesCustomElementOwnersKey);
  if (existing instanceof Map) {
    // The Symbol.for key is private to this bundled source and every value is
    // written only by defineCustomElement above.
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- Reflect.get cannot preserve the private Symbol.for registry's value type.
    return existing as Map<string, CustomElementConstructor>;
  }
  const owners = new Map<string, CustomElementConstructor>();
  Reflect.set(globalThis, filesCustomElementOwnersKey, owners);
  return owners;
}
