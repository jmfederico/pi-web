import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { PLUGIN_BACKEND_CHANNEL_DATA_FRAME_MAX_BYTES, PLUGIN_BACKEND_CHANNEL_ROUTE_PATH } from "../../shared/pluginBackendProtocol.js";
import {
  type PluginBackendChannelProxyAdmissionPool,
  pluginBackendChannelProxyAdmissionPool,
} from "./pluginBackendChannelProxyAdmission.js";
import {
  coordinatePluginBackendChannelProxy,
  PluginBackendChannelProxyConnectionError,
} from "./pluginBackendChannelProxyCoordinator.js";

interface PluginBackendChannelProxyParams {
  pluginId: string;
  projectId: string;
  workspaceId: string;
  operation: string;
}

export interface PluginBackendChannelProxyDaemon {
  connectWebSocket(path: string, options?: { maxPayload?: number }): WebSocket;
}

/** Browser-facing local route; session ownership stays in sessiond while this hop bounds transport resources. */
export function registerPluginBackendChannelProxyRoutes(
  app: FastifyInstance,
  daemon: PluginBackendChannelProxyDaemon,
  prefix = "/api",
  admissions: PluginBackendChannelProxyAdmissionPool = pluginBackendChannelProxyAdmissionPool(app),
): void {
  app.get<{ Params: PluginBackendChannelProxyParams }>(
    `${prefix}${PLUGIN_BACKEND_CHANNEL_ROUTE_PATH}`,
    { websocket: true },
    (socket, request) => {
      const upstreamPath = daemonPluginBackendChannelPath(request.params);
      void coordinatePluginBackendChannelProxy({
        downstream: socket,
        admissions,
        scope: {
          authorityId: "local",
          pluginId: request.params.pluginId,
          projectId: request.params.projectId,
          workspaceId: request.params.workspaceId,
        },
        connectUpstream() {
          try {
            return daemon.connectWebSocket(upstreamPath, {
              maxPayload: PLUGIN_BACKEND_CHANNEL_DATA_FRAME_MAX_BYTES,
            });
          } catch (error) {
            throw new PluginBackendChannelProxyConnectionError(
              1011,
              `Session daemon unavailable: ${errorMessage(error)}`,
              { cause: error },
            );
          }
        },
      });
    },
  );
}

function daemonPluginBackendChannelPath(params: PluginBackendChannelProxyParams): string {
  return [
    "/plugin-backends",
    encodeURIComponent(params.pluginId),
    "projects",
    encodeURIComponent(params.projectId),
    "workspaces",
    encodeURIComponent(params.workspaceId),
    "channels",
    encodeURIComponent(params.operation),
  ].join("/");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
