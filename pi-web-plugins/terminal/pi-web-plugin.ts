import type { StylesheetIntegrationCapabilityV1, PluginCapability, PiWebPlugin, PluginActivationContextV5, PluginActivationResultV5, ApplicationPanelContextV5, PluginStartContext, PluginRuntimeContext } from "@jmfederico/pi-web/plugin-api";
import { html as staticHtml, unsafeStatic } from "lit/static-html.js";
import { applicationTerminalContext } from "./TerminalContext";
import { TerminalBrowserRuntime } from "./TerminalBrowserRuntime";
import { TERMINAL_BROWSER_FACADE_CAPABILITY, TerminalFacade, type RequiredTerminalBrowserFacadeV1 } from "./TerminalFacade";
import { TerminalPanel } from "./TerminalPanel";
import { TerminalSoftKeys } from "./TerminalSoftKeys";

export const TERMINAL_PANEL_ELEMENT = terminalPanelElementName("pi-web.terminal");
export const TERMINAL_SOFT_KEYS_ELEMENT = terminalSoftKeysElementName("pi-web.terminal");

const terminalCustomElementOwnersKey = Symbol.for("pi-web.terminal.custom-element-owners.v1");

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
  requires: [stylesheetIntegrationCapability],
  apiVersion: 5,
  name: "Terminal",
  activate: (context) => activateTerminalPlugin(context),
} satisfies PiWebPlugin;

export default plugin;

export function activateTerminalPlugin(
  context: PluginActivationContextV5,
  runtime = new TerminalBrowserRuntime(),
  facade: RequiredTerminalBrowserFacadeV1 & Partial<Pick<TerminalFacade, "dispose">> = new TerminalFacade({ requestMaintenanceTerminal: (machineId, terminalId) => { runtime.requestMaintenanceTerminal(machineId, terminalId); } }),
): PluginActivationResultV5 {
  if (context.pluginId !== "pi-web.terminal") {
    throw new Error(`Terminal browser entry must activate as plugin id pi-web.terminal, received ${context.pluginId}`);
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
  let stylesheetIntegration: StylesheetIntegrationCapabilityV1 | undefined;
  let disposed = false;
  const disposeResources = (): void => {
    if (disposed) return;
    disposed = true;
    runtime.dispose();
    facade.dispose?.();
  };
  context.lifetimeSignal.addEventListener("abort", disposeResources, { once: true });
  return Object.freeze({
    start: ({ capabilities }: PluginStartContext) => {
      stylesheetIntegration = capabilities.resolve(stylesheetIntegrationCapability);
    },
    provides: [{ capability: TERMINAL_BROWSER_FACADE_CAPABILITY, value: facade }],
    dispose: () => {
      context.lifetimeSignal.removeEventListener("abort", disposeResources);
      disposeResources();
    },
    contributions: {
      applicationPanels: [{
        id: "workspace.terminal",
        title: "Terminal",
        icon,
        order: 30,
        badge: (applicationContext: ApplicationPanelContextV5) => runtime.activeTerminalBadge(applicationTerminalContext(applicationContext)),
        onInvalidate: (applicationContext: ApplicationPanelContextV5) => runtime.invalidate(applicationTerminalContext(applicationContext)),
        render: (applicationContext: ApplicationPanelContextV5) => {
          const terminalContext = applicationTerminalContext(applicationContext);
          return context.html`${staticHtml`<${panelTag} .stylesheetIntegration=${stylesheetIntegration} .context=${terminalContext} .runtime=${runtime} .softKeysElementName=${softKeysElement}></${panelTag}>`}`;
        },
      }],
      actions: [{
        id: "view.terminal",
        title: "Go to Terminal",
        shortcut: "mod+4",
        shortcutAliases: ["core:view.terminal"],
        group: "Navigation",
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
