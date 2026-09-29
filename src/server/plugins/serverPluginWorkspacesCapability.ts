import { isAbsolute, resolve } from "node:path";
import {
  PI_WEB_HOST_WORKSPACES_CAPABILITY,
  type PiWebHostWorkspaceAuthority,
  type PiWebHostWorkspaceSelection,
  type PiWebHostWorkspacesV1,
  type ProjectInput,
  type ServerPluginPeerWorkspace,
} from "../../server-plugin-api.js";
import type { WorkspaceListing } from "../../shared/apiTypes.js";
import type { Project } from "../types.js";
import type { ProjectService } from "../projects/projectService.js";
import type { WorkspaceProviderRegistry } from "../workspaces/workspaceProviderRegistry.js";
import type { ServerPluginHostCapabilityContext, ServerPluginHostCapabilityFactory } from "./serverPluginRuntime.js";

export interface CreateServerPluginWorkspacesCapabilityOptions {
  readonly projects: Pick<ProjectService, "requireProject">;
  readonly workspaces: Pick<WorkspaceProviderRegistry, "resolve">;
}

/** Creates the late workspaces v1 factory against one settled provider topology. */
export function createServerPluginWorkspacesCapabilityFactory(
  options: CreateServerPluginWorkspacesCapabilityOptions,
): ServerPluginHostCapabilityFactory<PiWebHostWorkspacesV1> {
  return Object.freeze({
    capability: PI_WEB_HOST_WORKSPACES_CAPABILITY,
    create(context: ServerPluginHostCapabilityContext) {
      return Object.freeze({
        value: Object.freeze({
          version: 1,
          resolve: async (selection: PiWebHostWorkspaceSelection): Promise<PiWebHostWorkspaceAuthority> => {
            assertActive(context);
            const requested = parseSelection(selection);
            let project: Project;
            try {
              project = await options.projects.requireProject(requested.projectId);
            } catch (error) {
              assertActive(context);
              throw authorityError(context.pluginId, "could not resolve the selected project", error);
            }
            assertActive(context);

            const projectProjection = snapshotProject(project, requested.projectId, context.pluginId);
            let workspaces: readonly WorkspaceListing[];
            try {
              const resolution = await options.workspaces.resolve(project, context.lifetimeSignal);
              if (resolution.projectId !== projectProjection.id) {
                throw new Error("Workspace authority returned a mismatched project id");
              }
              workspaces = resolution.workspaces;
            } catch (error) {
              assertActive(context);
              throw authorityError(context.pluginId, "could not resolve current workspace authority", error);
            }
            assertActive(context);

            const selected = workspaces.find(({ id }) => id === requested.workspaceId);
            if (selected === undefined) {
              throw authorityError(context.pluginId, "selected workspace is stale or unavailable");
            }
            return Object.freeze({
              project: projectProjection,
              workspace: snapshotWorkspace(selected, projectProjection.id, context.pluginId),
            });
          },
        } satisfies PiWebHostWorkspacesV1),
      });
    },
  });
}

function parseSelection(value: unknown): PiWebHostWorkspaceSelection {
  if (!isPlainRecord(value)) throw new Error("PI WEB host workspaces selection must be an object");
  const supportedKeys = new Set(["projectId", "workspaceId"]);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !supportedKeys.has(key)) {
      throw new Error(`Unsupported PI WEB host workspaces selection field: ${String(key)}`);
    }
  }
  if (!Object.hasOwn(value, "projectId") || !Object.hasOwn(value, "workspaceId")) {
    throw new Error("PI WEB host workspaces selection must contain projectId and workspaceId");
  }
  const projectId = value["projectId"];
  const workspaceId = value["workspaceId"];
  if (typeof projectId !== "string" || projectId === "") {
    throw new Error("PI WEB host workspaces selection projectId must be a non-empty string");
  }
  if (typeof workspaceId !== "string" || workspaceId === "") {
    throw new Error("PI WEB host workspaces selection workspaceId must be a non-empty string");
  }
  return Object.freeze({ projectId, workspaceId });
}

function snapshotProject(project: Project, requestedId: string, pluginId: string): ProjectInput {
  if (project.id !== requestedId) throw authorityError(pluginId, "resolved a mismatched project");
  if (project.name === "") throw authorityError(pluginId, "resolved a project with no name");
  if (!isAbsolute(project.path)) throw authorityError(pluginId, "resolved a project with a non-absolute path");
  return Object.freeze({ id: project.id, name: project.name, path: resolve(project.path) });
}

function snapshotWorkspace(
  workspace: WorkspaceListing,
  projectId: string,
  pluginId: string,
): ServerPluginPeerWorkspace {
  if (workspace.id === "") throw authorityError(pluginId, "resolved a workspace with no id");
  if (workspace.projectId !== projectId) throw authorityError(pluginId, "resolved a workspace outside the selected project");
  if (workspace.label === "") throw authorityError(pluginId, "resolved a workspace with no label");
  if (!isAbsolute(workspace.path)) throw authorityError(pluginId, "resolved a workspace with a non-absolute path");
  return {
    id: workspace.id,
    projectId: workspace.projectId,
    path: resolve(workspace.path),
    label: workspace.label,
    isMain: workspace.isMain,
    ...(workspace.provider === undefined ? {} : { provider: workspace.provider }),
  };
}

function assertActive(context: ServerPluginHostCapabilityContext): void {
  if (!context.lifetimeSignal.aborted) return;
  throw authorityError(
    context.pluginId,
    "is no longer active",
    context.lifetimeSignal.reason,
  );
}

function authorityError(pluginId: string, message: string, cause?: unknown): Error {
  return new Error(
    `PI WEB host workspace authority for server plugin ${pluginId} ${message}`,
    cause === undefined ? {} : { cause },
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
