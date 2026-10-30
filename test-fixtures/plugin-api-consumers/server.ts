import {
  createCompanionBackend,
  PI_WEB_HOST_PI_SESSIONS_CAPABILITY,
  PI_WEB_HOST_CATALOG_CAPABILITY,
  PI_WEB_HOST_SESSION_LIFECYCLE_CAPABILITY,
  PI_WEB_HOST_WORKSPACES_CAPABILITY,
} from "@jmfederico/pi-web/server-plugin-api";
import type {
  PiWebHostPiSessionsV1,
  PiWebHostWorkspacesV1,
  PluginCapability,
  ServerPluginPeer,
  PiWebServerPlugin,
} from "@jmfederico/pi-web/server-plugin-api";

interface FixtureDependencyV1 {
  readonly status: () => string;
}

const fixtureDependency = {
  pluginId: "fixture.provider",
  id: "status",
  version: 1,
  parse(value: unknown): FixtureDependencyV1 {
    if (!isFixtureDependency(value)) throw new Error("Fixture dependency is invalid");
    return Object.freeze({ status: () => value.status() });
  },
} satisfies PluginCapability<FixtureDependencyV1, 1>;

function isFixtureDependency(value: unknown): value is FixtureDependencyV1 {
  return typeof value === "object" && value !== null && typeof Reflect.get(value, "status") === "function";
}

const channelOnlyPeer: ServerPluginPeer = {
  openChannel: () => ({ receive: () => undefined }),
};

const plugin: PiWebServerPlugin = {
  apiVersion: 3,
  name: "Server declaration fixture",
  requires: [
    fixtureDependency,
    PI_WEB_HOST_CATALOG_CAPABILITY,
    PI_WEB_HOST_SESSION_LIFECYCLE_CAPABILITY,
    PI_WEB_HOST_WORKSPACES_CAPABILITY,
    PI_WEB_HOST_PI_SESSIONS_CAPABILITY,
  ],
  activate: (context) => {
    context.notices?.record({
      severity: "info",
      message: "Server declaration fixture activated",
      scope: { projectId: "fixture-project" },
      context: { phase: "activate" },
    });
    return {
      start: async ({ capabilities, signal }) => {
        signal.throwIfAborted();
        context.logger.info(capabilities.resolve(fixtureDependency).status());
        context.logger.info(context.dataDirectory);
        // Capability versions are independent of the legacy v3 entrypoint.
        const catalog = capabilities.resolve(PI_WEB_HOST_CATALOG_CAPABILITY);
        await catalog.projects.list({ signal });
        const lifecycle = capabilities.resolve(PI_WEB_HOST_SESSION_LIFECYCLE_CAPABILITY);
        const selected = { projectId: "fixture-project", workspaceId: "fixture-workspace", sessionId: "fixture-session" };
        await lifecycle.get(selected, { signal });
        await lifecycle.pin(selected, { signal });
        await lifecycle.unpin(selected, { signal });
        await lifecycle.archive(selected, { signal });
        await lifecycle.restore(selected, { signal });
        await lifecycle.delete(selected, { signal });
        const workspaces: PiWebHostWorkspacesV1 = capabilities.resolve(PI_WEB_HOST_WORKSPACES_CAPABILITY);
        const authority = await workspaces.resolve({
          projectId: "fixture-project",
          workspaceId: "fixture-workspace",
        });
        context.logger.info(authority.workspace.label, { projectId: authority.project.id });
        const piSessions: PiWebHostPiSessionsV1 = capabilities.resolve(PI_WEB_HOST_PI_SESSIONS_CAPABILITY);
        const run = await piSessions.run({
          projectId: authority.project.id,
          workspaceId: authority.workspace.id,
          prompt: "Inspect the current workspace",
        });
        const completion = await run.completion;
        context.logger.info(completion.status, { sessionId: run.sessionId });
      },
      peer: {
        request: ({ workspace, operation, input }) => ({ workspaceId: workspace.id, operation, input }),
      },
    };
  },
};

export async function requestCompanionBackend(events: Parameters<typeof createCompanionBackend>[0], signal: AbortSignal) {
  const backend = createCompanionBackend(events, "fixture.server");
  const machine = backend.forScope({ kind: "machine" });
  const project = backend.forScope({ kind: "project", projectId: "fixture-project" });
  const workspace = backend.forScope({ kind: "workspace", projectId: "fixture-project", workspaceId: "fixture-workspace" });
  const result = await machine.request?.("fixture.summary", null, { signal });
  await project.request?.("fixture.summary", null, { signal });
  const channel = await workspace.openChannel?.("fixture.watch", null, { signal, onData: () => undefined });
  channel?.send(null);
  channel?.close();
  return { machineId: backend.machineId, result };
}

export { channelOnlyPeer };
export default plugin;

export const pluginV5: PiWebServerPlugin = {
  apiVersion: 5,
  name: "V5 server consumer",
  requires: [PI_WEB_HOST_CATALOG_CAPABILITY],
  activate(context) {
    const version: 5 = context.apiVersion;
    return {
      async start({ capabilities, signal }) {
        const catalog = capabilities.resolve(PI_WEB_HOST_CATALOG_CAPABILITY);
        context.logger.info(`Catalog v${String(version)}`, { count: (await catalog.projects.list({ signal })).length });
      },
      peer: {
        request({ scope, operation, input }) {
          return { operation, input, scope: scope.kind,
            ...(scope.kind === "machine" ? {} : { projectId: scope.project.id }),
            ...(scope.kind === "workspace" ? { workspaceId: scope.workspace.id } : {}),
          };
        },
      },
    };
  },
};
