import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { PAIRED_PLUGIN_BACKEND_CHANNEL_ROUTE_PATHS, pairedPluginBackendPath, pluginBackendScopeFromRoute, PLUGIN_BACKEND_CHANNEL_DATA_FRAME_MAX_BYTES } from "../../shared/pluginBackendProtocol.js";
import { markPluginBackendChannelUpgradeRequest } from "../webSocketBridge.js";
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
  projectId?: string;
  workspaceId?: string;
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
  for (const path of PAIRED_PLUGIN_BACKEND_CHANNEL_ROUTE_PATHS) app.get<{ Params: PluginBackendChannelProxyParams }>(
    `${prefix}${path}`,
    {
      websocket: true,
      onRequest(request, _reply, done) {
        markPluginBackendChannelUpgradeRequest(request.raw);
        done();
      },
    },
    (socket, request) => {
      const upstreamPath = daemonPluginBackendChannelPath(request.params);
      void coordinatePluginBackendChannelProxy({
        downstream: socket,
        admissions,
        scope: {
          authorityId: "local",
          scope: pluginBackendScopeFromRoute(request.params),
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
  return pairedPluginBackendPath(params, true);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
