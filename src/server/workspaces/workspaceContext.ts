import type { ProjectService } from "../projects/projectService.js";
import type { Project, WorkspaceListing } from "../types.js";
import type { WorkspaceCatalog } from "./workspaceCatalog.js";

export interface WorkspaceContext {
  project: Project;
  workspace: WorkspaceListing;
  root: string;
}

export async function resolveWorkspaceContext(
  projects: ProjectService,
  workspaces: WorkspaceCatalog,
  projectId: string,
  workspaceId: string,
): Promise<WorkspaceContext> {
  const project = await projects.requireProject(projectId);
  const workspace = await workspaces.resolve(project.id, workspaceId);
  return { project, workspace, root: workspace.path };
}
