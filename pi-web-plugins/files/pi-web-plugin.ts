import type { ContentRenderingCapability, PluginCapability, PiWebPlugin, PluginActivationContext, PluginActivationResult } from "@jmfederico/pi-web/plugin-api";
import { FilesCodeViewer } from "./FilesCodeViewer";
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

const filesCustomElementOwnersKey = Symbol.for("pi-web.files.custom-element-owners.v1");

const contentRenderingCapability: PluginCapability<ContentRenderingCapability> = {
  pluginId: "pi-web", id: "content-rendering", version: 1,
  parse: (value) => {
    if (!isContentRenderingCapability(value)) throw new Error("Files requires content rendering capability v1");
    return value;
  },
};

function isContentRenderingCapability(value: unknown): value is ContentRenderingCapability {
  return typeof value === "object" && value !== null
    && "listRenderers" in value && typeof value.listRenderers === "function"
    && "renderText" in value && typeof value.renderText === "function"
    && "renderMarkdown" in value && typeof value.renderMarkdown === "function";
}

const plugin = {
  requires: [contentRenderingCapability],
  apiVersion: 4,
  name: "Files",
  activate: (context) => activateFilesPlugin(context, new FilesRuntime()),
} satisfies PiWebPlugin;

export default plugin;

export function activateFilesPlugin(context: PluginActivationContext, filesRuntime: FilesRuntime): PluginActivationResult {
  defineFilesCustomElements();
  let contentRendering: ContentRenderingCapability | undefined;
  const panelId = `${context.runtimePluginId}:workspace.files`;
  const icon = context.svg`
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
      <path d="M3 6.5A2.5 2.5 0 0 1 5.5 4H10l2 2h6.5A2.5 2.5 0 0 1 21 8.5v8A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5z"></path>
    </svg>
  `;
  return {
    start: ({ capabilities }) => { contentRendering = capabilities.resolve(contentRenderingCapability); },
    contributions: {
      workspacePanels: [{
        id: "workspace.files",
        title: "Files",
        icon,
        order: 10,
        routeAliases: ["files", "core:workspace.files"],
        navigationAliases: ["core:workspace.files"],
        invalidationResources: ["workspace.files"],
        fileOpenQuery: (_workspaceContext, path) => ({ file: path }),
        onInvalidate: (workspaceContext, invalidation) => filesRuntime.invalidate(workspaceContext, invalidation),
        render: (workspaceContext) => context.html`<pi-web-files-panel .context=${workspaceContext} .runtime=${filesRuntime} .contentRendering=${contentRendering}></pi-web-files-panel>`,
      }],
      actions: [
        {
          id: "view.files",
          title: "Go to Files",
          shortcut: "mod+2",
          shortcutAliases: ["core:view.files"],
          group: "Navigation",
          enabled: (runtimeContext) => runtimeContext.state.selectedWorkspace !== undefined,
          run: (runtimeContext) => { runtimeContext.selectWorkspaceTool(panelId); },
        },
        {
          id: "workspace.refresh-files",
          title: "Refresh Files",
          shortcut: "mod+shift+f",
          shortcutAliases: ["core:workspace.refresh-files"],
          group: "Workspace",
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
  defineCustomElement(FILES_PANEL_ELEMENT, WorkspaceFilesPanel);
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
