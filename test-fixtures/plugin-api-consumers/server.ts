import type { PiWebServerPlugin } from "@jmfederico/pi-web/server-plugin-api";

const plugin: PiWebServerPlugin = {
  apiVersion: 1,
  name: "Server declaration fixture",
  activate: () => ({
    workspaceBackend: {
      request: async ({ workspace, operation, input }) => ({ workspaceId: workspace.id, operation, input }),
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
    ready: async ({ backgroundSessions }) => {
      backgroundSessions.listModels();
      const lease = await backgroundSessions.create({ projectId: "project-1", workspaceId: "workspace-1" });
      const snapshot = await lease.snapshot();
      const estimatedCostUsd: number | undefined = snapshot.usage.estimatedCostUsd;
      if (estimatedCostUsd !== undefined && estimatedCostUsd < 0) throw new Error("Invalid estimated cost");
      await lease.release();
    },
  }),
};

export default plugin;
