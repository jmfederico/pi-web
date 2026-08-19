import type { FastifyInstance, FastifyReply } from "fastify";
import {
  PLUGIN_BACKEND_BINARY_BODY_MAX_BYTES,
  PLUGIN_BACKEND_BINARY_REVISION_HEADER,
  PLUGIN_BACKEND_BINARY_ROUTE_SUFFIX,
  PLUGIN_BACKEND_REQUEST_BODY_MAX_BYTES,
  PLUGIN_BACKEND_RESPONSE_BODY_MAX_BYTES,
  utf8ByteLength,
} from "../../shared/pluginBackendProtocol.js";
import type {
  SessionDaemonRawRequestClient,
  SessionDaemonRequestResult,
} from "../../sessiond/sessionDaemonClient.js";

interface PluginBackendProxyParams {
  pluginId: string;
  projectId: string;
  workspaceId: string;
  operation: string;
}

/** Browser-facing local route; all owner resolution and execution stays in sessiond. */
export function registerPluginBackendProxyRoutes(
  app: FastifyInstance,
  daemon: SessionDaemonRawRequestClient,
  prefix = "/api/plugin-backends",
): void {
  // The binary sibling route receives raw bodies. Register the parser here so
  // this module does not depend on another feature's parser registration.
  try {
    app.addContentTypeParser("application/octet-stream", { parseAs: "buffer" }, (_request, body, done) => { done(null, body); });
  } catch { /* already registered */ }

  app.post<{ Params: PluginBackendProxyParams; Body: unknown }>(
    `${prefix}/:pluginId/projects/:projectId/workspaces/:workspaceId/:operation`,
    { bodyLimit: PLUGIN_BACKEND_REQUEST_BODY_MAX_BYTES },
    async (request, reply) => {
      const path = daemonPluginBackendPath(request.params);
      let upstream: SessionDaemonRequestResult;
      try {
        upstream = await daemon.request("POST", path, request.body);
      } catch (error) {
        return daemonUnavailableError(reply, request.params, error);
      }
      return await forwardDaemonPluginBackendResponse(reply, request.params, upstream);
    },
  );

  // Opt-in raw binary sibling of the JSON route. The revision travels in a
  // header because the body is an opaque byte payload, not a JSON envelope.
  app.post<{ Params: PluginBackendProxyParams; Body: unknown }>(
    `${prefix}/:pluginId/projects/:projectId/workspaces/:workspaceId/:operation/${PLUGIN_BACKEND_BINARY_ROUTE_SUFFIX}`,
    { bodyLimit: PLUGIN_BACKEND_BINARY_BODY_MAX_BYTES },
    async (request, reply) => {
      const body: unknown = request.body;
      if (!Buffer.isBuffer(body)) {
        return reply.code(400).send({
          error: "Plugin backend binary request body must use content type application/octet-stream",
          code: "invalid-request",
          pluginId: request.params.pluginId,
          operation: request.params.operation,
        });
      }

      const path = `${daemonPluginBackendPath(request.params)}/${PLUGIN_BACKEND_BINARY_ROUTE_SUFFIX}`;
      const revision = firstHeaderValue(request.headers[PLUGIN_BACKEND_BINARY_REVISION_HEADER]);
      let upstream: SessionDaemonRequestResult;
      try {
        upstream = await daemon.requestRaw("POST", path, body, revision === undefined ? undefined : {
          headers: { [PLUGIN_BACKEND_BINARY_REVISION_HEADER]: revision },
        });
      } catch (error) {
        return daemonUnavailableError(reply, request.params, error);
      }
      return await forwardDaemonPluginBackendResponse(reply, request.params, upstream);
    },
  );
}

/** Map a daemon response onto the browser reply; identical for both body modes. */
async function forwardDaemonPluginBackendResponse(
  reply: FastifyReply,
  params: PluginBackendProxyParams,
  upstream: SessionDaemonRequestResult,
): Promise<FastifyReply> {
  if (upstream.body === "" || utf8ByteLength(upstream.body) > PLUGIN_BACKEND_RESPONSE_BODY_MAX_BYTES) {
    return daemonProtocolError(reply, params, "Session daemon plugin backend returned an invalid response size");
  }

  let body: unknown;
  try {
    body = JSON.parse(upstream.body);
  } catch {
    return daemonProtocolError(reply, params, "Session daemon plugin backend returned invalid JSON");
  }
  if (isUnknownPluginBackendRoute(upstream.statusCode, body)) {
    return daemonProtocolError(
      reply,
      params,
      "Session daemon does not support plugin backend requests; restart or upgrade the session daemon",
    );
  }

  return await reply
    .code(upstream.statusCode)
    .type("application/json; charset=utf-8")
    .send(upstream.body);
}

function daemonUnavailableError(reply: FastifyReply, params: PluginBackendProxyParams, error: unknown): FastifyReply {
  return reply.code(502).send({
    error: `Session daemon unavailable: ${errorMessage(error)}`,
    code: "daemon-unavailable",
    pluginId: params.pluginId,
    operation: params.operation,
  });
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

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
