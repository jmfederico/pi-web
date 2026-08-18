import type { JsonValue, PiWebPlugin, Workspace } from "@jmfederico/pi-web/plugin-api";

const plugin: PiWebPlugin = {
  apiVersion: 2,
  name: "Browser declaration fixture",
  activate: (context) => ({
    contributions: {
      actions: [{
        id: "identity",
        title: context.pluginId,
        run: ({ selectWorkspaceTool }) => {
          selectWorkspaceTool(`${context.runtimePluginId}:workspace.fixture`);
        },
      }],
    },
  }),
};

const echoJson = (value: JsonValue): JsonValue => value;
export { echoJson, plugin };
export type BrowserWorkspace = Workspace;
