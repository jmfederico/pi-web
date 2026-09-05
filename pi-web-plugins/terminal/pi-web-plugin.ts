import type { PiWebPlugin, PluginActivationContext, PluginActivationResult, PluginRuntimeContext, WorkspacePanelContext } from "@jmfederico/pi-web/plugin-api";
import { html as staticHtml, unsafeStatic } from "lit/static-html.js";
import { TerminalBrowserRuntime } from "./TerminalBrowserRuntime";
import { TerminalFacade, type RequiredTerminalBrowserFacadeV1 } from "./TerminalFacade";
import { TerminalPanel } from "./TerminalPanel";
import { TerminalSoftKeys } from "./TerminalSoftKeys";

export const TERMINAL_PANEL_ELEMENT = terminalPanelElementName("terminal");
export const TERMINAL_SOFT_KEYS_ELEMENT = terminalSoftKeysElementName("terminal");

const terminalCustomElementOwnersKey = Symbol.for("pi-web.terminal.custom-element-owners.v1");

export interface TerminalPluginActivation extends PluginActivationResult {
  readonly requiredTerminalFacade: RequiredTerminalBrowserFacadeV1;
}

const plugin: PiWebPlugin = {
  apiVersion: 2,
  name: "Terminal",
  activate: (context) => activateTerminalPlugin(context),
};

export default plugin;

export function activateTerminalPlugin(
  context: PluginActivationContext,
  runtime = new TerminalBrowserRuntime(),
  facade: RequiredTerminalBrowserFacadeV1 = new TerminalFacade(),
): TerminalPluginActivation {
  if (context.pluginId !== "terminal") {
    throw new Error(`Terminal browser entry must activate as plugin id terminal, received ${context.pluginId}`);
  }
  const panelElement = terminalPanelElementName(context.runtimePluginId);
  const softKeysElement = terminalSoftKeysElementName(context.runtimePluginId);
  defineTerminalCustomElements(panelElement, softKeysElement);
  const panelTag = unsafeStatic(panelElement);
  const icon = context.svg`
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
      <rect x="3" y="4" width="18" height="16" rx="2"></rect>
      <path d="m7 9 3 3-3 3M13 15h4"></path>
    </svg>
  `;
  return Object.freeze({
    requiredTerminalFacade: facade,
    contributions: {
      workspacePanels: [{
        id: "workspace.terminal",
        title: "Terminal",
        icon,
        order: 30,
        routeAliases: ["core:workspace.terminal"],
        navigationAliases: ["core:workspace.terminal"],
        badge: (workspaceContext: WorkspacePanelContext) => runtime.activeTerminalBadge(workspaceContext),
        onInvalidate: (workspaceContext: WorkspacePanelContext) => runtime.invalidate(workspaceContext),
        render: (workspaceContext: WorkspacePanelContext) => context.html`${staticHtml`<${panelTag} .context=${workspaceContext} .runtime=${runtime} .softKeysElementName=${softKeysElement}></${panelTag}>`}`,
      }],
      actions: [{
        id: "view.terminal",
        title: "Go to Terminal",
        shortcut: "mod+4",
        shortcutAliases: ["core:view.terminal"],
        group: "Navigation",
        enabled: (runtimeContext: PluginRuntimeContext) => runtimeContext.state.selectedWorkspace !== undefined,
        run: (runtimeContext: PluginRuntimeContext) => { runtimeContext.openTerminal(); },
      }],
    },
  });
}

export function defineTerminalCustomElements(
  panelElement = TERMINAL_PANEL_ELEMENT,
  softKeysElement = TERMINAL_SOFT_KEYS_ELEMENT,
): void {
  if (typeof customElements === "undefined") throw new Error("Terminal requires browser Custom Elements support");
  // A CustomElementRegistry permits one constructor under only one name. Each
  // registration gets tiny local subclasses while sharing package-owned logic.
  defineCustomElement(softKeysElement, class extends TerminalSoftKeys {});
  defineCustomElement(panelElement, class extends TerminalPanel {});
}

export function terminalPanelElementName(runtimePluginId: string): string {
  return `pi-web-terminal-panel-${terminalElementSuffix(runtimePluginId)}`;
}

export function terminalSoftKeysElementName(runtimePluginId: string): string {
  return `pi-web-terminal-soft-keys-${terminalElementSuffix(runtimePluginId)}`;
}

function terminalElementSuffix(runtimePluginId: string): string {
  const suffix = runtimePluginId.replaceAll(/[^a-z0-9]+/gu, "-").replaceAll(/^-|-$/gu, "");
  if (suffix === "") throw new Error("Terminal runtime plugin id cannot produce a custom element name");
  return suffix;
}

function defineCustomElement(name: string, constructor: CustomElementConstructor): void {
  const existing = customElements.get(name);
  const owners = terminalCustomElementOwners();
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
  // constructors. Reuse the first same-source implementation; each rendered
  // element still receives this activation's machine-scoped context/runtime.
  if (owners.get(name) === existing) return;
  throw new Error(`Terminal custom element name is already owned: ${name}`);
}

function terminalCustomElementOwners(): Map<string, CustomElementConstructor> {
  const existing: unknown = Reflect.get(globalThis, terminalCustomElementOwnersKey);
  if (existing instanceof Map) {
    // The Symbol.for key is private to this bundled source and all values are
    // written only by defineCustomElement above.
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- Reflect.get cannot preserve this private registry's value type.
    return existing as Map<string, CustomElementConstructor>;
  }
  const owners = new Map<string, CustomElementConstructor>();
  Reflect.set(globalThis, terminalCustomElementOwnersKey, owners);
  return owners;
}
