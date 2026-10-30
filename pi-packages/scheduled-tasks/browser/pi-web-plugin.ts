import type { PiWebPluginV5, PluginCapability, StylesheetIntegrationCapabilityV1 } from "@jmfederico/pi-web/plugin-api";
import definitions from "./messages.js";
import { definePanel, type PanelContent } from "./panel.js";

const stylesCapability: PluginCapability<StylesheetIntegrationCapabilityV1, 1> = {
  pluginId: "pi-web", id: "stylesheet-integration", version: 1,
  parse(value) {
    if (typeof value !== "object" || value === null
      || !("registerRoot" in value) || typeof value.registerRoot !== "function"
      || !("subscribe" in value) || typeof value.subscribe !== "function"
      || !("createController" in value) || typeof value.createController !== "function") throw new Error("Invalid stylesheet integration capability v1");
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- Public host capability validated above.
    return value as StylesheetIntegrationCapabilityV1;
  },
};

const plugin = {
  apiVersion: 5,
  name: "Scheduled agent tasks (beta)",
  requires: [stylesCapability],
  activate({ localization, lifetimeSignal, html, svg }) {
    if (!localization) throw new Error("Scheduled tasks requires a localization-capable host");
    definePanel();
    const messages = localization.registerMessages("dashboard", definitions);
    let content: PanelContent | undefined;
    return {
      start({ capabilities }) { content = { localization, messages, lifetimeSignal, styles: capabilities.resolve(stylesCapability) }; },
      contributions: {
        applicationPanels: [{
          id: "scheduled-tasks.overview",
          get title() { return messages.t("title"); },
          order: 60,
          icon: svg`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"></circle><path d="M12 7v5l3 2"></path></svg>`,
          render: (context) => html`<pi-web-scheduled-tasks-panel .content=${content} .context=${context}></pi-web-scheduled-tasks-panel>`,
        }],
      },
    };
  },
} satisfies PiWebPluginV5;
export default plugin;
