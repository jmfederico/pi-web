import { PI_WEB_HOST_SESSION_STATE_CAPABILITY, type PluginSessionStateOptions, type PluginSessionStateV1 } from "../../shared/pluginSessionStateTypes.js";
import type { PluginSessionSelection } from "../../shared/pluginCatalogTypes.js";
import type { SessionStateWrite } from "../../shared/sessionState.js";
import type { PiSessionService } from "../sessions/piSessionService.js";
import { createServerPluginWorkspacesCapabilityFactory, type CreateServerPluginWorkspacesCapabilityOptions } from "./serverPluginWorkspacesCapability.js";
import type { ServerPluginHostCapabilityContext, ServerPluginHostCapabilityFactory } from "./serverPluginRuntime.js";

export function createServerPluginSessionStateCapabilityFactory(
  options: CreateServerPluginWorkspacesCapabilityOptions & { readonly sessions: Pick<PiSessionService, "readSessionState" | "writeSessionState"> },
): ServerPluginHostCapabilityFactory<PluginSessionStateV1> {
  const workspaceFactory = createServerPluginWorkspacesCapabilityFactory(options);
  return Object.freeze({
    capability: PI_WEB_HOST_SESSION_STATE_CAPABILITY,
    create(context: ServerPluginHostCapabilityContext) {
      const disposal = new AbortController();
      const lifetime = AbortSignal.any([context.lifetimeSignal, disposal.signal]);
      async function resolve(selection: PluginSessionSelection, requested?: PluginSessionStateOptions) {
        const signal = requested?.signal === undefined ? lifetime : AbortSignal.any([lifetime, requested.signal]);
        signal.throwIfAborted();
        const authority = workspaceFactory.create({ ...context, lifetimeSignal: signal }).value;
        const { workspace } = await authority.resolve({ projectId: selection.projectId, workspaceId: selection.workspaceId });
        signal.throwIfAborted();
        return { ref: { id: selection.sessionId, cwd: workspace.path }, signal };
      }
      const value = PI_WEB_HOST_SESSION_STATE_CAPABILITY.parse({
        version: 1,
        read: async (selection: PluginSessionSelection, namespace: string, requested?: PluginSessionStateOptions) => {
          const { ref, signal } = await resolve(selection, requested);
          return options.sessions.readSessionState(ref, namespace, signal);
        },
        write: async (selection: PluginSessionSelection, namespace: string, input: SessionStateWrite, requested?: PluginSessionStateOptions) => {
          const { ref, signal } = await resolve(selection, requested);
          return options.sessions.writeSessionState(ref, namespace, input, signal);
        },
      });
      return Object.freeze({ value, dispose: () => { disposal.abort(); } });
    },
  });
}
