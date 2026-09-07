import type { PairedPluginBackendV1, PiWebServerPlugin } from "@jmfederico/pi-web/server-plugin-api";

const channelOnlyBackend: PairedPluginBackendV1 = {
  version: 1,
  openChannel: () => ({ receive: () => undefined }),
};

const plugin: PiWebServerPlugin = {
  apiVersion: 1,
  name: "Server declaration fixture",
  activate: (context) => {
    context.notices?.record({
      severity: "info",
      message: "Server declaration fixture activated",
      scope: { projectId: "fixture-project" },
      context: { phase: "activate" },
    });
    return {
      pairedBackend: {
        version: 1,
        request: ({ workspace, operation, input }) => ({ workspaceId: workspace.id, operation, input }),
      },
      workspaceProvider: {
        probe: async () => "claim",
        list: async (project) => [{
          key: "main",
          path: project.path,
          label: project.name,
          isMain: true,
        }],
      },
    };
  },
};

export { channelOnlyBackend };
export default plugin;
