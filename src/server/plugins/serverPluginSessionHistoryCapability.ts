import { isAbsolute, resolve } from "node:path";
import {
  PI_WEB_HOST_PI_SESSION_HISTORY_CAPABILITY,
  type PluginSessionHistoryPage,
  type PluginSessionHistoryPageRequest,
  type PluginSessionHistoryV1,
} from "../../shared/pluginSessionHistoryTypes.js";
import type { PluginCatalogReadOptions, PluginSessionSelection, PluginSessionSnapshot, PluginWorkspaceSelection } from "../../shared/pluginCatalogTypes.js";
import type { ProjectService } from "../projects/projectService.js";
import type { WorkspaceProviderRegistry } from "../workspaces/workspaceProviderRegistry.js";
import type { ServerPluginHostCapabilityContext, ServerPluginHostCapabilityFactory } from "./serverPluginRuntime.js";

export interface CreateServerPluginSessionHistoryCapabilityOptions {
  readonly projects: Pick<ProjectService, "requireProject">;
  readonly workspaces: Pick<WorkspaceProviderRegistry, "resolve">;
  readonly sessions: {
    /** Read disk/archive records and already-hosted runtimes only; never reconcile or open a runtime. */
    readonly listCatalogSessions: (cwd: string, signal?: AbortSignal) => Promise<readonly PluginSessionSnapshot[]>;
    /** Read bounded history without opening a cold runtime. */
    readonly inspectionMessages: (ref: { readonly id: string; readonly cwd: string }, page?: PluginSessionHistoryPageRequest, signal?: AbortSignal) => Promise<PluginSessionHistoryPage>;
  };
}

export function createServerPluginSessionHistoryCapabilityFactory(
  options: CreateServerPluginSessionHistoryCapabilityOptions,
): ServerPluginHostCapabilityFactory<PluginSessionHistoryV1> {
  return Object.freeze({
    capability: PI_WEB_HOST_PI_SESSION_HISTORY_CAPABILITY,
    create(context: ServerPluginHostCapabilityContext) {
      const disposal = new AbortController();
      const lifetime = AbortSignal.any([context.lifetimeSignal, disposal.signal]);
      async function read<T>(requested: PluginCatalogReadOptions | undefined, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
        const signal = requested?.signal === undefined ? lifetime : AbortSignal.any([lifetime, requested.signal]);
        signal.throwIfAborted();
        try {
          const result = await operation(signal);
          signal.throwIfAborted();
          return result;
        } catch (error) {
          signal.throwIfAborted();
          throw error;
        }
      }
      async function workspace(selection: PluginWorkspaceSelection, signal: AbortSignal) {
        const project = await options.projects.requireProject(selection.projectId);
        signal.throwIfAborted();
        if (project.id !== selection.projectId) throw new Error("Session history project authority returned a mismatched project");
        const resolution = await options.workspaces.resolve(project, signal);
        signal.throwIfAborted();
        if (resolution.projectId !== selection.projectId) throw new Error("Session history workspace authority returned a mismatched project");
        const selected = resolution.workspaces.find(({ id, projectId }) => id === selection.workspaceId && projectId === selection.projectId);
        if (selected === undefined) throw new Error("Session history selected workspace is stale or unavailable");
        if (!isAbsolute(selected.path)) throw new Error("Session history authority returned a non-absolute workspace path");
        return resolve(selected.path);
      }
      const value = PI_WEB_HOST_PI_SESSION_HISTORY_CAPABILITY.parse({
        version: 1,
        readMessages: (selection: PluginSessionSelection, page?: PluginSessionHistoryPageRequest, requested?: PluginCatalogReadOptions) =>
          read(requested, async (signal) => {
            const cwd = await workspace(selection, signal);
            const rows = await options.sessions.listCatalogSessions(cwd, signal);
            signal.throwIfAborted();
            if (rows.some((row) => !isAbsolute(row.cwd) || resolve(row.cwd) !== cwd)) throw new Error("Session history is outside selected workspace");
            const matches = rows.filter(({ id }) => id === selection.sessionId);
            if (matches.length > 1) throw new Error("Session history selected session is ambiguous");
            if (matches.length === 0) throw new Error("Session history selected session is stale or unavailable");
            const result = await options.sessions.inspectionMessages({ id: selection.sessionId, cwd }, page, signal);
            signal.throwIfAborted();
            return result;
          }),
      });
      return Object.freeze({ value, dispose: () => { disposal.abort(); } });
    },
  });
}
