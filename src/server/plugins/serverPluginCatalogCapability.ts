import { isAbsolute, resolve } from "node:path";
import {
  PI_WEB_HOST_CATALOG_CAPABILITY,
  type PluginCatalogReadOptions,
  type PluginCatalogV1,
  type PluginCatalogWorkspace,
  type PluginSessionSelection,
  type PluginSessionSnapshot,
  type PluginWorkspaceSelection,
} from "../../shared/pluginCatalogTypes.js";
import type { ProjectService } from "../projects/projectService.js";
import type { WorkspaceProviderRegistry } from "../workspaces/workspaceProviderRegistry.js";
import type { ServerPluginHostCapabilityContext, ServerPluginHostCapabilityFactory } from "./serverPluginRuntime.js";

export interface CreateServerPluginCatalogCapabilityOptions {
  readonly projects: Pick<ProjectService, "list" | "requireProject">;
  readonly workspaces: Pick<WorkspaceProviderRegistry, "resolve">;
  readonly pins: {
    readonly pinnedSessionIds: () => Promise<readonly string[]>;
  };
  readonly sessions: {
    /** Read disk/archive records and already-hosted runtimes only; never reconcile or open a runtime. */
    readonly listCatalogSessions: (cwd: string, signal?: AbortSignal) => Promise<readonly Omit<PluginSessionSnapshot, "pinned">[]>;
  };
}

/** Register after provider topology settles, alongside the workspace authority factory. */
export function createServerPluginCatalogCapabilityFactory(
  options: CreateServerPluginCatalogCapabilityOptions,
): ServerPluginHostCapabilityFactory<PluginCatalogV1> {
  return Object.freeze({
    capability: PI_WEB_HOST_CATALOG_CAPABILITY,
    create(context: ServerPluginHostCapabilityContext) {
      const disposal = new AbortController();
      const lifetime = AbortSignal.any([context.lifetimeSignal, disposal.signal]);
      function signalFor(read?: PluginCatalogReadOptions): AbortSignal {
        return read?.signal === undefined ? lifetime : AbortSignal.any([lifetime, read.signal]);
      }
      function assertActive(signal: AbortSignal): void {
        if (lifetime.aborted) throw new Error(`PI WEB host catalog for server plugin ${context.pluginId} is no longer active`, { cause: lifetime.reason });
        signal.throwIfAborted();
      }
      async function read<T>(requested: PluginCatalogReadOptions | undefined, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
        const signal = signalFor(requested);
        assertActive(signal);
        try {
          const result = await operation(signal);
          assertActive(signal);
          return result;
        } catch (error) {
          assertActive(signal);
          throw error;
        }
      }
      async function project(projectId: string, signal: AbortSignal) {
        assertActive(signal);
        const result = await options.projects.requireProject(projectId);
        assertActive(signal);
        if (result.id !== projectId) throw new Error("Catalog project authority returned a mismatched project");
        return result;
      }
      async function workspaces(projectId: string, signal: AbortSignal): Promise<readonly PluginCatalogWorkspace[]> {
        const selected = await project(projectId, signal);
        const resolution = await options.workspaces.resolve(selected, signal);
        assertActive(signal);
        if (resolution.projectId !== projectId) throw new Error("Catalog workspace authority returned a mismatched project");
        return resolution.workspaces.map((workspace) => {
          if (workspace.projectId !== projectId) throw new Error("Catalog workspace is outside selected project");
          return {
            id: workspace.id, projectId, path: absolutePath(workspace.path), label: workspace.label, isMain: workspace.isMain,
            ...(workspace.provider === undefined ? {} : { provider: workspace.provider }),
            ...(workspace.removal === undefined ? {} : { removal: workspace.removal }),
          };
        });
      }
      async function workspace(selection: PluginWorkspaceSelection, signal: AbortSignal): Promise<PluginCatalogWorkspace> {
        const result = (await workspaces(selection.projectId, signal)).find(({ id }) => id === selection.workspaceId);
        if (result === undefined) throw new Error("Catalog selected workspace is stale or unavailable");
        return result;
      }
      async function sessions(selection: PluginWorkspaceSelection, signal: AbortSignal): Promise<readonly PluginSessionSnapshot[]> {
        const selected = await workspace(selection, signal);
        const [rows, pinnedSessionIds] = await Promise.all([
          options.sessions.listCatalogSessions(selected.path, signal),
          options.pins.pinnedSessionIds(),
        ]);
        assertActive(signal);
        // A reader must not supply records from a different workspace, even for get-by-id.
        if (rows.some((row) => absolutePath(row.cwd) !== selected.path)) throw new Error("Catalog session is outside selected workspace");
        // Match native cleanup: a pin in any retained scope protects this identity.
        const pinnedIds = new Set(pinnedSessionIds);
        return rows.map((row) => ({ ...row, pinned: pinnedIds.has(row.id) }));
      }
      const value = PI_WEB_HOST_CATALOG_CAPABILITY.parse({
        version: 1,
        projects: {
          list: (requested?: PluginCatalogReadOptions) => read(requested, async (signal) => {
            const rows = await options.projects.list();
            assertActive(signal);
            return rows.map(projectSnapshot);
          }),
          get: (id: string, requested?: PluginCatalogReadOptions) => read(requested, async (signal) => projectSnapshot(await project(id, signal))),
        },
        workspaces: {
          list: (id: string, requested?: PluginCatalogReadOptions) => read(requested, (signal) => workspaces(id, signal)),
          get: (selection: PluginWorkspaceSelection, requested?: PluginCatalogReadOptions) => read(requested, (signal) => workspace(selection, signal)),
        },
        sessions: {
          list: (selection: PluginWorkspaceSelection, requested?: PluginCatalogReadOptions) => read(requested, (signal) => sessions(selection, signal)),
          get: (selection: PluginSessionSelection, requested?: PluginCatalogReadOptions) => read(requested, async (signal) => {
            const result = (await sessions({ projectId: selection.projectId, workspaceId: selection.workspaceId }, signal)).find(({ id }) => id === selection.sessionId);
            if (result === undefined) throw new Error("Catalog selected session is stale or unavailable");
            return result;
          }),
        },
      });
      return Object.freeze({ value, dispose: () => { disposal.abort(); } });
    },
  });
}

function absolutePath(path: string): string {
  if (!isAbsolute(path)) throw new Error("Catalog authority returned a non-absolute path");
  return resolve(path);
}
function projectSnapshot(project: { id: string; name: string; path: string }) {
  return { id: project.id, name: project.name, path: absolutePath(project.path) };
}
