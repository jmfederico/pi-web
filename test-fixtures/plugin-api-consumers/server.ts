import type { PiWebServerPlugin } from "@jmfederico/pi-web/server-plugin-api";

const plugin: PiWebServerPlugin = {
  apiVersion: 1,
  name: "Server declaration fixture",
  activate: () => ({
    workspaceProvider: {
      probe: async () => "claim",
      list: async (project) => [{
        key: "main",
        path: project.path,
        label: project.name,
        isMain: true,
      }],
    },
  }),
};

export default plugin;
