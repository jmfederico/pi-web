import type { PluginProjects } from "../../../plugin-api";
import type { projectsApi } from "../api/clients";

type ProjectDiscoveryClient = Pick<typeof projectsApi, "projects" | "projectDirectories">;

/** Capture the host context's machine once; never read live selection or substitute local data. */
export function createPluginProjects(client: ProjectDiscoveryClient, machineId: string): PluginProjects {
  return Object.freeze({
    machineId,
    listProjects: async () => (await client.projects(machineId)).map(({ id, name, path }) => ({ id, name, path })),
    suggestDirectories: async (query: string) => (await client.projectDirectories(query, machineId)).map(({ path }) => ({ path })),
  });
}
