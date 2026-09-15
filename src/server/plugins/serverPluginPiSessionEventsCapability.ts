import {
  PI_WEB_HOST_PI_SESSION_EVENTS_CAPABILITY,
  type PiWebHostPiSessionConnection,
  type PiWebHostPiSessionEventsV1,
  type PiWebHostPiSessionSelection,
} from "../../server-plugin-api.js";
import type { ProjectService } from "../projects/projectService.js";
import type { WorkspaceProviderRegistry } from "../workspaces/workspaceProviderRegistry.js";
import type { ServerPluginHostCapabilityContext, ServerPluginHostCapabilityFactory } from "./serverPluginRuntime.js";
import { createServerPluginWorkspacesCapabilityFactory } from "./serverPluginWorkspacesCapability.js";

export function createServerPluginPiSessionEventsCapabilityFactory(options: {
  readonly projects: Pick<ProjectService, "requireProject">;
  readonly workspaces: Pick<WorkspaceProviderRegistry, "resolve">;
  readonly sessions: {
    connectSessionEvents(ref: { id: string; cwd: string }, lifetime: AbortSignal): PiWebHostPiSessionConnection;
  };
}): ServerPluginHostCapabilityFactory<PiWebHostPiSessionEventsV1> {
  const workspaceFactory = createServerPluginWorkspacesCapabilityFactory(options);
  return Object.freeze({
    capability: PI_WEB_HOST_PI_SESSION_EVENTS_CAPABILITY,
    create(context: ServerPluginHostCapabilityContext) {
      const authority = workspaceFactory.create(context).value;
      const lifetime = new AbortController();
      const revoke = (): void => { lifetime.abort(new Error("PI session events plugin lifetime ended")); };
      if (context.lifetimeSignal.aborted) revoke();
      else context.lifetimeSignal.addEventListener("abort", revoke, { once: true });
      return Object.freeze({
        value: Object.freeze({
          version: 1,
          connect: async (selection: PiWebHostPiSessionSelection): Promise<PiWebHostPiSessionConnection> => {
            lifetime.signal.throwIfAborted();
            const resolved = await authority.resolve({ projectId: selection.projectId, workspaceId: selection.workspaceId });
            lifetime.signal.throwIfAborted();
            return options.sessions.connectSessionEvents({ id: selection.sessionId, cwd: resolved.workspace.path }, lifetime.signal);
          },
        }),
        dispose: (): Promise<void> => {
          revoke();
          context.lifetimeSignal.removeEventListener("abort", revoke);
          return Promise.resolve();
        },
      });
    },
  });
}
