import type { StylesheetIntegrationCapabilityV1, StylesheetRootOptions } from "../../../plugin-api";
import { createPluginStylesheetLoader } from "./styleLoader";
import { PluginStyleRegistry, PluginStylesController, type ActivePluginStylesheet } from "./styleRegistry";
import type { PluginCapability } from "../../../shared/pluginApiTypes";
import { sharedUiStyles } from "./sharedUiStyles";

// Shared by the application owner, host components and the public capability. No
// network, DOM registration or stylesheet compilation occurs until explicitly used.
export const pluginStyles = new PluginStyleRegistry(
  (url, signal) => createPluginStylesheetLoader()(url, signal),
  () => {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(sharedUiStyles.cssText);
    return sheet;
  }
);

export const stylesheetIntegrationCapability: StylesheetIntegrationCapabilityV1 = Object.freeze({
  registerRoot: (root: ShadowRoot, options?: StylesheetRootOptions) => pluginStyles.registerRoot(root, options),
  subscribe: (listener: () => void) => pluginStyles.subscribe(listener),
  createController: (host: Parameters<StylesheetIntegrationCapabilityV1["createController"]>[0], options?: StylesheetRootOptions) => {
    new PluginStylesController(host, pluginStyles, options);
  },
});

export const stylesheetIntegrationCapabilityToken: PluginCapability<StylesheetIntegrationCapabilityV1> = {
  pluginId: "pi-web", id: "stylesheet-integration", version: 1,
  parse: (value) => {
    if (!isStylesheetIntegration(value)) {
      throw new Error("Stylesheet integration capability v1 is unavailable");
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

/** Application-owned publication and error boundary; roots/sheets remain registry-owned. */
export class PluginStyleRuntime {
  private signature: string | undefined;
  private revision = 0;
  private releaseDocument: (() => void) | undefined;

  constructor(private readonly registry: PluginStyleRegistry, private readonly reportError: (error: unknown) => void) {}

  connect(document: Document): void {
    this.releaseDocument?.();
    this.releaseDocument = this.registry.registerRoot(document);
  }

  update(contributions: readonly ActivePluginStylesheet[]): void {
    const signature = JSON.stringify(contributions);
    if (this.signature === signature) return;
    this.signature = signature;
    const revision = ++this.revision;
    void this.registry.setContributions(contributions).catch((error: unknown) => {
      // Removal/theme replacement intentionally aborts old files; only report
      // failures for the publication that still owns the active selection.
      if (revision === this.revision) {
        // Allow the next publication to retry failed files; successful files stay cached.
        this.signature = undefined;
        this.reportError(error);
      }
    });
  }

  disconnect(): void {
    this.revision++;
    this.signature = undefined;
    this.releaseDocument?.();
    this.releaseDocument = undefined;
    this.registry.clear();
  }
}
