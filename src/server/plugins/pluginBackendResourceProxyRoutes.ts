import type { FastifyInstance } from "fastify";
import { PAIRED_PLUGIN_BACKEND_RESOURCE_ROUTE_PATHS, pairedPluginBackendResourcePath, parsePluginBackendResourceQuery } from "../../shared/pluginBackendProtocol.js";
import type { SessionDaemonClient } from "../../sessiond/sessionDaemonClient.js";
import type { PluginBackendResourceParams } from "../sessiond/pluginBackendResourceRoutes.js";
import { requestCancellation } from "../requestCancellation.js";
import { isObservedDaemonBodyError, logDaemonRequestFailure, logInvalidDaemonResponse, observeDaemonBody } from "../sessiond/daemonProxyDiagnostics.js";
import { applyPluginResourcePolicy, pluginResourceError, pluginResourceRange, sendPluginResourceResponse } from "./pluginBackendResourceResponse.js";

export function registerPluginBackendResourceProxyRoutes(app: FastifyInstance, daemon: Pick<SessionDaemonClient, "requestStream">, prefix = "/api"): void {
  for (const path of PAIRED_PLUGIN_BACKEND_RESOURCE_ROUTE_PATHS) app.route<{ Params: PluginBackendResourceParams; Querystring: unknown }>({
    method: "GET", url: `${prefix}${path}`, exposeHeadRoute: false,
    handler: async (request, reply) => {
      applyPluginResourcePolicy(reply);
      const cancellation = requestCancellation(request, reply);
      try {
        let envelope;
        let range;
        try {
          envelope = parsePluginBackendResourceQuery(request.query);
          range = pluginResourceRange(request.headers.range);
        } catch (error) { return await pluginResourceError(reply, 400, error); }
        const query = new URLSearchParams({ revision: envelope.revision, input: JSON.stringify(envelope.input) });
        let upstream;
        try {
          upstream = await daemon.requestStream(`${pairedPluginBackendResourcePath(request.params)}?${query.toString()}`, {
            signal: cancellation.signal, headers: range === undefined ? {} : { range }, timeoutMs: 30_000,
          });
        } catch (error) {
          logDaemonRequestFailure(request, error, cancellation.signal);
          return await pluginResourceError(reply, 502, error);
        }
        const stopObserving = observeDaemonBody(request, upstream.body, cancellation.signal);
        try {
          return await sendPluginResourceResponse(reply, upstream, cancellation.signal);
        } catch (error) {
          if (cancellation.signal.aborted) return;
          if (!isObservedDaemonBodyError(request, error)) logInvalidDaemonResponse(request);
          if (reply.raw.headersSent) return;
          return await pluginResourceError(reply, 502, error);
        } finally { stopObserving(); }
      } finally { cancellation.dispose(); }
    },
  });
}
