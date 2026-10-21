import { isAbsolute, resolve } from "node:path";
import {
  PI_WEB_HOST_PI_SESSION_ACTIVITY_CAPABILITY,
  type PluginSessionActivityV1,
  type PluginSessionActivityV1Snapshot,
} from "../../shared/pluginSessionActivityTypes.js";
import type { PluginCatalogReadOptions, PluginSessionSelection, PluginSessionSnapshot } from "../../shared/pluginCatalogTypes.js";
import type { ProjectService } from "../projects/projectService.js";
import type { WorkspaceProviderRegistry } from "../workspaces/workspaceProviderRegistry.js";
import type { ServerPluginHostCapabilityContext, ServerPluginHostCapabilityFactory } from "./serverPluginRuntime.js";

export interface CreateServerPluginSessionActivityCapabilityOptions {
  readonly projects: Pick<ProjectService, "requireProject">;
  readonly workspaces: Pick<WorkspaceProviderRegistry, "resolve">;
  readonly sessions: {
    readonly listCatalogSessions: (cwd: string, signal?: AbortSignal) => Promise<readonly PluginSessionSnapshot[]>;
    readonly inspectSessionActivity: (cwd: string, sessionId: string, signal?: AbortSignal) => Promise<PluginSessionActivityV1Snapshot>;
  };
}

export function createServerPluginSessionActivityCapabilityFactory(
  options: CreateServerPluginSessionActivityCapabilityOptions,
): ServerPluginHostCapabilityFactory<PluginSessionActivityV1> {
  return Object.freeze({
    capability: PI_WEB_HOST_PI_SESSION_ACTIVITY_CAPABILITY,
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
      async function workspace(selection: PluginSessionSelection, signal: AbortSignal): Promise<string> {
        const project = await options.projects.requireProject(selection.projectId);
        signal.throwIfAborted();
        if (project.id !== selection.projectId) throw new Error("Session activity project authority returned a mismatched project");
        const resolution = await options.workspaces.resolve(project, signal);
        signal.throwIfAborted();
        if (resolution.projectId !== selection.projectId) throw new Error("Session activity workspace authority returned a mismatched project");
        const selected = resolution.workspaces.find(({ id, projectId }) => id === selection.workspaceId && projectId === selection.projectId);
        if (selected === undefined) throw new Error("Session activity selected workspace is stale or unavailable");
        if (!isAbsolute(selected.path)) throw new Error("Session activity authority returned a non-absolute workspace path");
        return resolve(selected.path);
      }
      const value = PI_WEB_HOST_PI_SESSION_ACTIVITY_CAPABILITY.parse({
        version: 1,
        inspect: (selection: PluginSessionSelection, requested?: PluginCatalogReadOptions) => read(requested, async (signal) => {
          const cwd = await workspace(selection, signal);
          const rows = await options.sessions.listCatalogSessions(cwd, signal);
          signal.throwIfAborted();
          if (rows.some((row) => !isAbsolute(row.cwd) || resolve(row.cwd) !== cwd)) throw new Error("Session activity selection resolved outside the authorized workspace");
          const matches = rows.filter(({ id }) => id === selection.sessionId);
          if (matches.length > 1) throw new Error("Session activity selected session is ambiguous");
          if (matches.length === 0) throw new Error("Session activity selected session is stale or unavailable");
          const result = await options.sessions.inspectSessionActivity(cwd, selection.sessionId, signal);
          signal.throwIfAborted();
          if (result.session.id !== selection.sessionId || resolve(result.session.cwd) !== cwd) throw new Error("Session activity result is outside the authorized workspace");
          return result;
        }),
      });
      return Object.freeze({ value, dispose: () => { disposal.abort(); } });
    },
  });
}
