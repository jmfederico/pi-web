import type { PiWebPluginV5, PluginCapability, StylesheetIntegrationCapabilityV1 } from "@jmfederico/pi-web/plugin-api";
import { defineManagedMcpPanel } from "./ManagedMcpPanel.js";
import { createManagedMcpPanel } from "./panel.js";
import source from "./managedMcp.messages.js";

const stylesheetIntegration: PluginCapability<StylesheetIntegrationCapabilityV1> = {
  pluginId: "pi-web", id: "stylesheet-integration", version: 1,
  parse(value) {
    if (!isStylesheetIntegration(value)) {
      throw new Error("Stylesheet integration v1 unavailable");
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

export default {
  apiVersion: 5,
  name: "MCP manager",
  requires: [stylesheetIntegration],
  activate({ localization, runtimePluginId }) {
    if (!localization) throw new Error("MCP manager requires a localization-capable PI WEB host");
    const messages = localization.registerMessages("panel", source);
    let styles: StylesheetIntegrationCapabilityV1;
    return {
      start({ capabilities }) {
        styles = capabilities.resolve(stylesheetIntegration);
        defineManagedMcpPanel();
      },
      contributions: {
        applicationPanels: [createManagedMcpPanel(localization, messages, () => styles)],
        actions: [{
          id: "mcp.manage",
          shortcutAliases: ["core:mcp.manage"],
          get title() { return messages.t("action"); },
          get description() { return messages.t("actionDescription"); },
          get group() { return messages.t("title"); },
          run: (context) => context.navigate({ tool: `${runtimePluginId}:mcp`, view: "workspace" }, { mode: "patch" }),
        }],
      },
    };
  },
} satisfies PiWebPluginV5;
