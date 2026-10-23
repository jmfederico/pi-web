import type { PiWebPlugin, PluginCapability, StylesheetIntegrationCapabilityV1 } from "@jmfederico/pi-web/plugin-api";
import { createGitBrowserContributions } from "./git-panel.js";

const stylesheetIntegrationCapability: PluginCapability<StylesheetIntegrationCapabilityV1, 1> = {
  pluginId: "pi-web", id: "stylesheet-integration", version: 1,
  parse: (value) => {
    if (!isStylesheetIntegration(value)) {
      throw new Error("Invalid PI WEB stylesheet integration capability v1");
    }
    return value;
  },
};

function isStylesheetIntegration(value: unknown): value is StylesheetIntegrationCapabilityV1 {
  return typeof value === "object" && value !== null
    && "registerRoot" in value && typeof value.registerRoot === "function"
    && "subscribe" in value && typeof value.subscribe === "function"
    && "createController" in value && typeof value.createController === "function";
}

const plugin = {
  apiVersion: 4,
  name: "Git",
  requires: [stylesheetIntegrationCapability],
  activate: ({ pluginId, runtimePluginId, html, svg }) => {
    let stylesheetIntegration: StylesheetIntegrationCapabilityV1 | undefined;
    return {
      start: ({ capabilities }) => {
        stylesheetIntegration = capabilities.resolve(stylesheetIntegrationCapability);
      },
      contributions: createGitBrowserContributions(pluginId, runtimePluginId, html, svg, () => stylesheetIntegration),
    };
  },
} satisfies PiWebPlugin;

export default plugin;
