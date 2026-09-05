import type { FastifyInstance, FastifyReply } from "fastify";
import {
  PLUGIN_BACKEND_REQUEST_BODY_MAX_BYTES,
  PLUGIN_BACKEND_RESPONSE_BODY_MAX_BYTES,
  utf8ByteLength,
} from "../../shared/pluginBackendProtocol.js";
import type { SessionDaemonRequestClient } from "../../sessiond/sessionDaemonClient.js";
import { requestCancellation } from "../requestCancellation.js";

interface PluginBackendProxyParams {
  pluginId: string;
  projectId: string;
  workspaceId: string;
  operation: string;
}

/** Browser-facing local route; workspace authority and execution stay in sessiond. */
export function registerPluginBackendProxyRoutes(
  app: FastifyInstance,
  daemon: SessionDaemonRequestClient,
  prefix = "/api/plugin-backends",
): void {
  app.post<{ Params: PluginBackendProxyParams; Body: unknown }>(
    `${prefix}/:pluginId/projects/:projectId/workspaces/:workspaceId/:operation`,
    { bodyLimit: PLUGIN_BACKEND_REQUEST_BODY_MAX_BYTES },
    async (request, reply) => {
      const path = daemonPluginBackendPath(request.params);
      const cancellation = requestCancellation(request, reply);
      try {
        let upstream: Awaited<ReturnType<SessionDaemonRequestClient["request"]>>;
        try {
          upstream = await daemon.request("POST", path, request.body, { signal: cancellation.signal });
        } catch (error) {
          return await reply.code(502).send({
            error: `Session daemon unavailable: ${errorMessage(error)}`,
            code: "daemon-unavailable",
            pluginId: request.params.pluginId,
            operation: request.params.operation,
          });
        }

        if (upstream.body === "" || utf8ByteLength(upstream.body) > PLUGIN_BACKEND_RESPONSE_BODY_MAX_BYTES) {
          return await daemonProtocolError(reply, request.params, "Session daemon plugin backend returned an invalid response size");
        }

        let body: unknown;
        try {
          body = JSON.parse(upstream.body);
        } catch {
          return await daemonProtocolError(reply, request.params, "Session daemon plugin backend returned invalid JSON");
        }
        if (isUnknownPluginBackendRoute(upstream.statusCode, body)) {
          return await daemonProtocolError(
            reply,
            request.params,
            "Session daemon does not support plugin backend requests; restart or upgrade the session daemon",
          );
        }

        return await reply
          .code(upstream.statusCode)
          .type("application/json; charset=utf-8")
          .send(upstream.body);
      } finally {
        cancellation.dispose();
      }
    },
  );
}

function daemonPluginBackendPath(params: PluginBackendProxyParams): string {
  return [
    "/plugin-backends",
    encodeURIComponent(params.pluginId),
    "projects",
    encodeURIComponent(params.projectId),
    "workspaces",
    encodeURIComponent(params.workspaceId),
    encodeURIComponent(params.operation),
  ].join("/");
}

function daemonProtocolError(reply: FastifyReply, params: PluginBackendProxyParams, message: string): FastifyReply {
  return reply.code(502).send({
    error: message,
    code: "daemon-protocol-error",
    pluginId: params.pluginId,
    operation: params.operation,
  });
}

function isUnknownPluginBackendRoute(statusCode: number, body: unknown): boolean {
  if (statusCode !== 404 || !isRecord(body)) return false;
  const error = body["error"];
  const message = body["message"];
  return error === "Not Found" || (typeof message === "string" && /^Route .* not found$/u.test(message));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
