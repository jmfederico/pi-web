import type { FastifyInstance } from "fastify";
import { McpCheckService } from "../mcpCheckService.js";
import { FileMcpConfigService } from "../mcpConfigService.js";
import { registerMcpRoutes } from "../mcpRoutes.js";
import type { WorkspaceCatalogProjectReader, WorkspaceCatalogResolver } from "./workspaceCatalogRoutes.js";

/** MCP operations belong to the target daemon's active profile and environment. */
export function registerSessionDaemonMcpRoutes(
  app: FastifyInstance,
  dependencies: { agentDir: string; projects: WorkspaceCatalogProjectReader; workspaces: WorkspaceCatalogResolver },
): void {
  const config = new FileMcpConfigService(dependencies.agentDir);
  const checker = new McpCheckService({ agentDir: dependencies.agentDir });
  const shutdown = new AbortController();
  // Close diagnostic subprocesses before Fastify waits for requests to drain.
  app.addHook("preClose", () => {
    shutdown.abort(new Error("Session daemon is shutting down"));
    return Promise.resolve();
  });
  registerMcpRoutes(app, config, {
    check: (cwd, signal) => checker.check(cwd, signal === undefined ? shutdown.signal : AbortSignal.any([shutdown.signal, signal])),
    resolveWorkspace: async (projectId, workspaceId) => {
      const project = await dependencies.projects.requireProject(projectId);
      const resolution = await dependencies.workspaces.resolve(project);
      const workspace = resolution.workspaces.find((candidate) => candidate.id === workspaceId);
      if (workspace === undefined) throw new Error("Workspace not found");
      return workspace.path;
    },
  });
}
