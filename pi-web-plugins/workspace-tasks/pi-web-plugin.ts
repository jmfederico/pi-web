import type { StylesheetIntegrationCapabilityV1, PiWebPlugin, PluginCapability, UiStylesCapabilityV1 } from "@jmfederico/pi-web/plugin-api";
import { TASKS_CONFIG_PATH } from "./config.js";
import { defineTasksPanelElement, tasksPanelBadge } from "./tasksPanelElement.js";

const uiStylesCapability: PluginCapability<UiStylesCapabilityV1, 1> = {
  pluginId: "pi-web", id: "ui-styles", version: 1,
  parse(value) {
    if (typeof value !== "object" || value === null || !("cssText" in value) || typeof value.cssText !== "string") {
      throw new Error("Workspace Tasks requires UI styles capability v1 with cssText");
    }
    return { cssText: value.cssText };
  },
};

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
  apiVersion: 4,
  name: "Workspace Tasks",
  requires: [stylesheetIntegrationCapability, uiStylesCapability],
  activate: ({ runtimePluginId, html, svg }) => {
    defineTasksPanelElement();
    let uiCssText = "";
    let stylesheetIntegration: StylesheetIntegrationCapabilityV1 | undefined;

    return {
      start({ capabilities }) {
        uiCssText = capabilities.resolve(uiStylesCapability).cssText;
        stylesheetIntegration = capabilities.resolve(stylesheetIntegrationCapability);
      },
      contributions: {
        actions: [
          {
            id: "workspace.open-tasks",
            title: "Open Workspace Tasks",
            description: `Open the workspace Tasks tab. Configure tasks in ${TASKS_CONFIG_PATH}.`,
            group: "Workspace",
            enabled: (context) => context.state.selectedWorkspace !== undefined,
            run: (context) => {
              if (context.state.selectedWorkspace === undefined) return;
              context.selectWorkspaceTool(`${runtimePluginId}:workspace.tasks`);
            },
          },
        ],
        workspacePanels: [
          {
            id: "workspace.tasks",
            title: "Tasks",
            icon: svg`
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M9 6h11"></path>
                <path d="M9 12h11"></path>
                <path d="M9 18h11"></path>
                <path d="m4 6 .8 .8L6.5 5"></path>
                <path d="m4 12 .8 .8 1.7-1.8"></path>
                <path d="m4 18 .8 .8 1.7-1.8"></path>
              </svg>
            `,
            order: 40,
            badge: (context) => tasksPanelBadge(context),
            render: (context) => html`<pi-web-workspace-tasks-panel .stylesheetIntegration=${stylesheetIntegration} .context=${context} .uiCssText=${uiCssText}></pi-web-workspace-tasks-panel>`,
          },
        ],
      },
    };
  },
} satisfies PiWebPlugin;

export default plugin;
