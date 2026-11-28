import type { PluginCatalogV1 } from "@jmfederico/pi-web/plugin-api";
import type { TaskView } from "./responses.js";

export interface TargetNames {
  projects: ReadonlyMap<string, string>;
  workspaces: ReadonlyMap<string, ReadonlyMap<string, string>>;
}

export async function loadTargetNames(catalog: PluginCatalogV1, tasks: readonly TaskView[], signal: AbortSignal): Promise<TargetNames> {
  if (tasks.length === 0) return { projects: new Map(), workspaces: new Map() };
  const projectIds = [...new Set(tasks.map((task) => task.projectId))];
  const [projects, workspaces] = await Promise.all([
    catalog.projects.list({ signal }).catch(() => []),
    Promise.allSettled(projectIds.map(async (projectId) => {
      const rows = await catalog.workspaces.list(projectId, { signal });
      return [projectId, new Map(rows.map((workspace) => [workspace.id, workspace.label]))] as const;
    })),
  ]);
  return {
    projects: new Map(projects.map((project) => [project.id, project.name])),
    workspaces: new Map(workspaces.flatMap((entry) => entry.status === "fulfilled" ? [entry.value] : [])),
  };
}
