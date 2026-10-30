import { isAbsolute, resolve } from "node:path";
import type { PluginSessionSelection } from "../../shared/pluginCatalogTypes.js";
import {
  PI_WEB_HOST_SESSION_LIFECYCLE_CAPABILITY,
  type PluginSessionLifecycleOptions,
  type PluginSessionLifecycleState,
  type PluginSessionLifecycleV1,
} from "../../shared/pluginSessionLifecycleTypes.js";
import type { PiSessionService } from "../sessions/piSessionService.js";
import { createServerPluginWorkspacesCapabilityFactory, type CreateServerPluginWorkspacesCapabilityOptions } from "./serverPluginWorkspacesCapability.js";
import type { ServerPluginHostCapabilityContext, ServerPluginHostCapabilityFactory } from "./serverPluginRuntime.js";

interface PinScope {
  readonly kind: "session-pins";
  readonly projectId: string;
  readonly workspaceId: string;
}

export interface CreateServerPluginSessionLifecycleCapabilityOptions extends CreateServerPluginWorkspacesCapabilityOptions {
  readonly sessions: Pick<PiSessionService, "listCatalogSessions" | "archiveMany" | "restore" | "deleteArchivedMany">;
  /** Notify observers after a successful native archive, restore, or delete. */
  readonly onMutation?: (selection: PluginSessionSelection) => void;
  readonly pins: {
    readonly pinnedSessionIds: () => Promise<readonly string[]>;
    readonly setPinned: (scope: PinScope, sessionId: string, pinned: boolean) => Promise<unknown>;
  };
}

type Operation = "get" | "pin" | "unpin" | "archive" | "restore" | "delete";

/** Authority checks never open a runtime; admitted mutations belong to the native services. */
export function createServerPluginSessionLifecycleCapabilityFactory(
  options: CreateServerPluginSessionLifecycleCapabilityOptions,
): ServerPluginHostCapabilityFactory<PluginSessionLifecycleV1> {
  const workspaceFactory = createServerPluginWorkspacesCapabilityFactory(options);
  return Object.freeze({
    capability: PI_WEB_HOST_SESSION_LIFECYCLE_CAPABILITY,
    create(context: ServerPluginHostCapabilityContext) {
      const disposal = new AbortController();
      const lifetime = AbortSignal.any([context.lifetimeSignal, disposal.signal]);
      function assertActive(signal: AbortSignal): void {
        if (lifetime.aborted) throw new Error(`PI WEB host session lifecycle for server plugin ${context.pluginId} is no longer active`, { cause: lifetime.reason });
        signal.throwIfAborted();
      }
      async function perform(operation: Operation, selection: PluginSessionSelection, requested?: PluginSessionLifecycleOptions): Promise<PluginSessionLifecycleState | undefined> {
        const signal = requested?.signal === undefined ? lifetime : AbortSignal.any([lifetime, requested.signal]);
        assertActive(signal);
        const authority = workspaceFactory.create({ ...context, lifetimeSignal: signal }).value;
        const { workspace } = await authority.resolve({ projectId: selection.projectId, workspaceId: selection.workspaceId });
        assertActive(signal);
        const scope: PinScope = { kind: "session-pins", projectId: selection.projectId, workspaceId: selection.workspaceId };
        // Removing an obsolete pin needs workspace authority, not a surviving session record.
        if (operation === "unpin") {
          await options.pins.setPinned(scope, selection.sessionId, false);
          return undefined;
        }
        const rows = await options.sessions.listCatalogSessions(workspace.path, signal);
        assertActive(signal);
        if (rows.some((row) => !isAbsolute(row.cwd) || resolve(row.cwd) !== workspace.path)) throw new Error("Session lifecycle session is outside selected workspace");
        const session = rows.find(({ id }) => id === selection.sessionId);
        if (session === undefined) throw new Error("Session lifecycle selected session is stale or unavailable");
        if (operation === "get") {
          const pinnedIds = await options.pins.pinnedSessionIds();
          assertActive(signal);
          return { sessionId: session.id, pinned: pinnedIds.includes(session.id), archived: session.archived };
        }
        if (operation === "pin") {
          assertActive(signal);
          await options.pins.setPinned(scope, session.id, true);
          return undefined;
        }
        if (session.runtime === "busy") throw new Error("Stop current session activity before changing session lifecycle");
        const ref = { id: session.id, cwd: workspace.path };
        assertActive(signal);
        // Do not check cancellation after admission: cancellation cannot undo native work.
        if (operation === "archive") {
          const result = await options.sessions.archiveMany([ref]);
          requireSuccess(session.id, result.archivedSessionIds, result.failures);
        } else if (operation === "restore") {
          if (!session.archived) throw new Error("Session must be archived before restoring");
          await options.sessions.restore(ref);
        } else {
          if (!session.archived) throw new Error("Session must be archived before deletion");
          const result = await options.sessions.deleteArchivedMany([ref]);
          requireSuccess(session.id, result.deletedSessionIds, result.failures);
        }
        options.onMutation?.(selection);
        return undefined;
      }
      const mutation = (operation: Exclude<Operation, "get">) => async (selection: PluginSessionSelection, requested?: PluginSessionLifecycleOptions): Promise<void> => {
        await perform(operation, selection, requested);
      };
      const value = PI_WEB_HOST_SESSION_LIFECYCLE_CAPABILITY.parse({
        version: 1,
        get: (selection: PluginSessionSelection, requested?: PluginSessionLifecycleOptions) => perform("get", selection, requested),
        pin: mutation("pin"), unpin: mutation("unpin"), archive: mutation("archive"), restore: mutation("restore"), delete: mutation("delete"),
      });
      return Object.freeze({ value, dispose: () => { disposal.abort(); } });
    },
  });
}

function requireSuccess(id: string, succeeded: readonly string[], failures: readonly { sessionId: string; error: string }[]): void {
  if (failures.length > 0) throw new Error(failures.map(({ error }) => error).join("; "));
  if (!succeeded.includes(id)) throw new Error("Session lifecycle mutation did not complete for selected session");
}
