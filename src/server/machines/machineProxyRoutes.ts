import type { FastifyInstance, FastifyReply } from "fastify";
import type { WebSocket } from "ws";
import { FEDERATED_HTTP_ROUTES, FEDERATED_WEBSOCKET_ROUTES, WORKSPACE_FILE_PREVIEW_ROUTE_PATH, type FederatedHttpRouteSpec } from "../../shared/federatedRoutes.js";
import {
  PAIRED_PLUGIN_BACKEND_CHANNEL_ROUTE_PATH,
  PLUGIN_BACKEND_CHANNEL_DATA_FRAME_MAX_BYTES,
} from "../../shared/pluginBackendProtocol.js";
import { mergeSelectedMachineConfig, parsePiWebConfigResponseBody, parseSelectedMachineConfigRequest, selectedMachineConfigResponse } from "../configRoutes.js";
import {
  type PluginBackendChannelProxyAdmissionPool,
  type PluginBackendChannelProxyScope,
  pluginBackendChannelProxyAdmissionPool,
} from "../plugins/pluginBackendChannelProxyAdmission.js";
import {
  coordinatePluginBackendChannelProxy,
  PluginBackendChannelProxyConnectionError,
} from "../plugins/pluginBackendChannelProxyCoordinator.js";
import { requestCancellation } from "../requestCancellation.js";
import { isSessionImageMimeType } from "../sessions/sessionMediaIndex.js";
import { bridgeSockets, markPluginBackendChannelUpgradeRequest } from "../webSocketBridge.js";
import { applyWorkspaceFilePreviewErrorResponsePolicy, applyWorkspaceFilePreviewResponsePolicy } from "../workspaces/filePreviewResponseHeaders.js";
import { workspaceFilePreviewErrorResponsePolicy, workspaceFilePreviewResponsePolicy, type WorkspaceFilePreviewResponsePolicy } from "../workspaces/filePreviewResponsePolicy.js";
import { DEFAULT_REMOTE_REQUEST_TIMEOUT_MS, RemoteMachineRequestError, type MachineClient, type MachineHttpResponse, type MachineJsonResponse, type MachineRequestOptions } from "./machineClient.js";
import { MachineService } from "./machineService.js";
import { destroyReadable, readBoundedRemoteBody } from "./boundedRemoteBody.js";

export const REMOTE_HTTP_ROUTES = FEDERATED_HTTP_ROUTES;
export const REMOTE_WEBSOCKET_ROUTES = FEDERATED_WEBSOCKET_ROUTES;

const SAFE_RESPONSE_HEADERS = new Set([
  "content-type",
  "content-length",
  "content-disposition",
  "cache-control",
  "last-modified",
  "etag",
  "content-security-policy",
  "x-content-type-options",
]);

type MachineProxyService = Pick<MachineService, "remoteClient">;

interface MachineProxyWebSocketParams {
  machineId: string;
  pluginId: string;
  projectId: string;
  workspaceId: string;
}

export function registerMachineProxyRoutes(
  app: FastifyInstance,
  machines: MachineProxyService = new MachineService(),
  pluginChannelAdmissions: PluginBackendChannelProxyAdmissionPool = pluginBackendChannelProxyAdmissionPool(app),
): void {
  for (const spec of REMOTE_HTTP_ROUTES) {
    app.route<{ Params: { machineId: string }; Body: unknown }>({
      method: spec.method,
      url: `/api/machines/:machineId${spec.path}`,
      ...("bodyLimit" in spec ? { bodyLimit: spec.bodyLimit } : {}),
      handler: async (request, reply) => {
        const cancellation = "propagateCancellation" in spec
          ? requestCancellation(request, reply)
          : undefined;
        try {
          return await proxyHttpRequest(
            machines,
            spec,
            request.params.machineId,
            request.method,
            request.url,
            request.body,
            request.headers["content-type"],
            reply,
            cancellation?.signal,
          );
        } finally {
          cancellation?.dispose();
        }
      },
    });
  }

  for (const path of REMOTE_WEBSOCKET_ROUTES) {
    const isPluginBackendChannel = path === PAIRED_PLUGIN_BACKEND_CHANNEL_ROUTE_PATH;
    app.get<{ Params: MachineProxyWebSocketParams }>(
      `/api/machines/:machineId${path}`,
      {
        websocket: true,
        ...(isPluginBackendChannel
          ? {
              onRequest(request, _reply, done) {
                markPluginBackendChannelUpgradeRequest(request.raw);
                done();
              },
            }
          : {}),
      },
      async (socket, request) => {
        await proxyWebSocket(
          machines,
          request.params.machineId,
          request.url,
          socket,
          isPluginBackendChannel
            ? {
                admissions: pluginChannelAdmissions,
                scope: {
                  authorityId: request.params.machineId,
                  pluginId: request.params.pluginId,
                  projectId: request.params.projectId,
                  workspaceId: request.params.workspaceId,
                },
              }
            : undefined,
        );
      },
    );
  }
}

async function proxyHttpRequest(
  machines: MachineProxyService,
  spec: FederatedHttpRouteSpec,
  machineId: string,
  method: string,
  requestUrl: string,
  body: unknown,
  contentType: string | string[] | undefined,
  reply: FastifyReply,
  signal?: AbortSignal,
): Promise<FastifyReply> {
  const sessionMedia = spec.path === "/sessions/:sessionId/media/:mediaId";
  if (sessionMedia) applySessionMediaResponsePolicy(reply);

  if (machineId === "local") {
    return reply.code(501).send({ error: "Local machine route is not registered for this endpoint" });
  }

  const client = await machines.remoteClient(machineId);
  if (client === undefined) {
    return reply.code(404).send({ error: "Machine not found" });
  }

  try {
    const remotePath = remoteApiPath(machineId, requestUrl);
    if (spec.path === "/config") return await proxySelectedMachineConfigRequest(client, machineId, method, remotePath, body, reply);

    let preview: RemoteFilePreviewRequest | undefined;
    try {
      preview = remoteFilePreviewRequest(spec, remotePath);
    } catch (error) {
      applyWorkspaceFilePreviewErrorResponsePolicy(reply);
      return await reply.code(400).send({ error: errorMessage(error) });
    }
    const previewPolicy = preview?.policy;
    const responseBodyLimit = preview === undefined ? spec.responseBodyLimit : preview.responseBodyLimit;

    const startedAt = Date.now();
    const requestOptions = proxyRequestOptions(spec, body, contentType, signal);
    const upstream = requestOptions === undefined
      ? await client.request(method, remotePath, body)
      : await client.request(method, remotePath, body, requestOptions);
    if (sessionMedia) return await proxySessionMediaResponse(reply, upstream);

    const responseBody = upstream.body === undefined || responseBodyLimit === undefined
      ? upstream.body
      : await readBoundedRemoteBody(
          upstream.body,
          responseBodyLimit,
          remainingResponseTimeout(startedAt, spec.timeoutMs),
          signal,
        );
    if (isUnknownRemotePluginBackendRoute(spec, method, remotePath, upstream.statusCode, responseBody)) {
      return await reply.code(409).send({
        error: "Remote machine plugin lifecycle is incompatible",
        code: "plugin-lifecycle-incompatible",
        machineId,
        detail: "The remote machine does not support this plugin backend route. Update and restart PI WEB on the remote machine.",
      });
    }
    reply.code(upstream.statusCode);
    applySafeHeaders(reply, upstream.headers);
    if (previewPolicy !== undefined) {
      const enforcedPolicy = isSuccessfulStatus(upstream.statusCode) ? previewPolicy : workspaceFilePreviewErrorResponsePolicy();
      applyWorkspaceFilePreviewResponsePolicy(reply, enforcedPolicy);
    }
    if (responseBody === undefined) return await reply.send();
    // A bounded body is authoritative over whatever length the remote claimed.
    if (Buffer.isBuffer(responseBody)) reply.header("Content-Length", String(responseBody.byteLength));
    return await reply.send(responseBody);
  } catch (error) {
    if (isSelectedMachineConfigRequestError(error)) return reply.code(400).send({ error: errorMessage(error) });
    return sendGatewayError(reply, machineId, error);
  }
}

function applySessionMediaResponsePolicy(reply: FastifyReply): void {
  reply
    .header("Content-Security-Policy", "sandbox; default-src 'none'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'")
    .header("X-Content-Type-Options", "nosniff")
    .header("Content-Disposition", "inline");
}

function proxySessionMediaResponse(reply: FastifyReply, upstream: MachineHttpResponse): FastifyReply {
  const successful = isSuccessfulStatus(upstream.statusCode);
  const contentType = firstHeaderValue(upstream.headers["content-type"])?.split(";", 1)[0]?.trim().toLowerCase();
  if ((successful && isSessionImageMimeType(contentType))
    || (!successful && contentType === "application/json" && upstream.body !== undefined)) {
    applySafeHeaders(reply, upstream.headers);
    // Remote security headers are never authoritative. Canonical JSON plus this
    // policy also makes a mislabeled error page inert, without buffering errors
    // or imposing a new limit on the existing media streaming contract.
    applySessionMediaResponsePolicy(reply);
    reply.type(successful ? contentType : "application/json; charset=utf-8");
    return reply.code(upstream.statusCode).send(upstream.body);
  }

  if (upstream.body !== undefined) destroyReadable(upstream.body);
  if (successful) throw new RemoteMachineRequestError("Remote machine returned an unsupported session image MIME type", 502);
  return reply.code(upstream.statusCode).send({ error: "Remote session media request failed", statusCode: upstream.statusCode });
}

async function proxySelectedMachineConfigRequest(client: MachineClient, machineId: string, method: string, remotePath: string, body: unknown, reply: FastifyReply): Promise<FastifyReply> {
  if (method === "GET") {
    return sendSelectedMachineConfigResponse(reply, await client.requestJson("GET", remotePath), machineId);
  }

  if (method === "PUT") {
    const patch = parseSelectedMachineConfigRequest(configPayload(body), "portable");
    const currentResponse = await client.requestJson("GET", remotePath);
    if (!isSuccessfulStatus(currentResponse.statusCode)) return sendUpstreamJsonResponse(reply, currentResponse, machineId);

    const current = parsePiWebConfigResponseBody(currentResponse.body, "Remote machine config response");
    const merged = mergeSelectedMachineConfig(current.config, patch);
    return sendSelectedMachineConfigResponse(reply, await client.requestJson("PUT", remotePath, { config: merged }), machineId);
  }

  return reply.code(405).send({ error: "Method not allowed" });
}

function configPayload(body: unknown): unknown {
  return isRecord(body) ? body["config"] : undefined;
}

function sendSelectedMachineConfigResponse(reply: FastifyReply, upstream: MachineJsonResponse, machineId: string): FastifyReply {
  if (!isSuccessfulStatus(upstream.statusCode)) return sendUpstreamJsonResponse(reply, upstream, machineId);
  const response = parsePiWebConfigResponseBody(upstream.body, "Remote machine config response");
  reply.code(upstream.statusCode);
  applySafeHeaders(reply, upstream.headers);
  return reply.send(selectedMachineConfigResponse(response));
}

function sendUpstreamJsonResponse(reply: FastifyReply, upstream: MachineJsonResponse, machineId: string): FastifyReply {
  reply.code(upstream.statusCode);
  applySafeHeaders(reply, upstream.headers);
  return reply.send(upstream.body ?? { error: "Remote machine config request failed", machineId, statusCode: upstream.statusCode });
}

function isSuccessfulStatus(statusCode: number): boolean {
  return statusCode >= 200 && statusCode < 300;
}

interface BoundedPluginChannelProxyContext {
  admissions: PluginBackendChannelProxyAdmissionPool;
  scope: PluginBackendChannelProxyScope;
}

async function proxyWebSocket(
  machines: MachineProxyService,
  machineId: string,
  requestUrl: string,
  socket: WebSocket,
  boundedPluginChannel: BoundedPluginChannelProxyContext | undefined,
): Promise<void> {
  if (boundedPluginChannel !== undefined) {
    proxyBoundedPluginChannel(machines, machineId, requestUrl, socket, boundedPluginChannel);
    return;
  }

  if (machineId === "local") {
    socket.close(1011, "Local machine route is not registered for this endpoint");
    return;
  }

  const client = await machines.remoteClient(machineId);
  if (client === undefined) {
    socket.close(1008, "Machine not found");
    return;
  }

  try {
    bridgeSockets(socket, client.connectWebSocket(remoteApiPath(machineId, requestUrl)));
  } catch {
    socket.close(1011, "Remote machine unavailable");
  }
}

function proxyBoundedPluginChannel(
  machines: MachineProxyService,
  machineId: string,
  requestUrl: string,
  socket: WebSocket,
  context: BoundedPluginChannelProxyContext,
): void {
  void coordinatePluginBackendChannelProxy({
    downstream: socket,
    admissions: context.admissions,
    scope: context.scope,
    async connectUpstream(signal) {
      if (machineId === "local") {
        throw new PluginBackendChannelProxyConnectionError(
          1011,
          "Local machine route is not registered for this endpoint",
        );
      }

      let client: MachineClient | undefined;
      try {
        client = await machines.remoteClient(machineId);
      } catch (error) {
        if (signal.aborted) throw error;
        throw new PluginBackendChannelProxyConnectionError(1011, "Remote machine unavailable", { cause: error });
      }
      signal.throwIfAborted();
      if (client === undefined) {
        throw new PluginBackendChannelProxyConnectionError(1008, "Machine not found");
      }
      try {
        return client.connectWebSocket(remoteApiPath(machineId, requestUrl), {
          maxPayload: PLUGIN_BACKEND_CHANNEL_DATA_FRAME_MAX_BYTES,
        });
      } catch (error) {
        throw new PluginBackendChannelProxyConnectionError(1011, "Remote machine unavailable", { cause: error });
      }
    },
  });
}

function remoteApiPath(machineId: string, requestUrl: string): string {
  const machinePrefix = `/api/machines/${encodeURIComponent(machineId)}`;
  const stripped = requestUrl.startsWith(machinePrefix) ? requestUrl.slice(machinePrefix.length) : requestUrl;
  const compatPath = stripped.startsWith("/") ? stripped : `/${stripped}`;
  return `/api${compatPath}`;
}

interface RemoteFilePreviewRequest {
  policy: WorkspaceFilePreviewResponsePolicy;
  responseBodyLimit: number | undefined;
}

function remoteFilePreviewRequest(spec: FederatedHttpRouteSpec, remotePath: string): RemoteFilePreviewRequest | undefined {
  if (spec.path !== WORKSPACE_FILE_PREVIEW_ROUTE_PATH) return undefined;
  const url = new URL(remotePath, "http://pi-web.local");
  const path = url.searchParams.get("path");
  if (path === null || path === "") throw new Error("path query parameter is required");
  const downloadValue = url.searchParams.get("download");
  const download = downloadValue === "1" || downloadValue === "true";
  return {
    policy: workspaceFilePreviewResponsePolicy(path, { download }),
    // Inline previews keep the local inline contract even when the remote is
    // hostile or racy; attachment downloads stay deliberately uncapped.
    responseBodyLimit: download ? undefined : spec.responseBodyLimit,
  };
}

function proxyRequestOptions(
  spec: Pick<FederatedHttpRouteSpec, "timeoutMs" | "propagateCancellation">,
  body: unknown,
  contentType: string | string[] | undefined,
  signal?: AbortSignal,
): MachineRequestOptions | undefined {
  const options: MachineRequestOptions = {};
  if (spec.timeoutMs !== undefined) options.timeoutMs = spec.timeoutMs;
  if (spec.propagateCancellation === true && signal !== undefined) options.signal = signal;
  if (isRawProxyBody(body)) {
    const value = firstHeaderValue(contentType);
    if (value !== undefined && value !== "") options.contentType = value;
  }
  return Object.keys(options).length === 0 ? undefined : options;
}

function isUnknownRemotePluginBackendRoute(
  spec: FederatedHttpRouteSpec,
  method: string,
  remotePath: string,
  statusCode: number,
  body: NodeJS.ReadableStream | Buffer | undefined,
): boolean {
  if (!spec.path.startsWith("/paired-plugin-backends/")
    || statusCode !== 404
    || !(body instanceof Buffer)) return false;
  try {
    const value: unknown = JSON.parse(body.toString("utf8"));
    if (!isRecord(value) || value["statusCode"] !== 404 || value["error"] !== "Not Found") return false;
    const message = value["message"];
    const queryIndex = remotePath.indexOf("?");
    const requestPath = queryIndex === -1 ? remotePath : remotePath.slice(0, queryIndex);
    if (typeof message !== "string") return false;
    const routePrefix = `Route ${method.toUpperCase()}:`;
    return message === `${routePrefix}${requestPath} not found` || message === `${routePrefix}${remotePath} not found`;
  } catch {
    return false;
  }
}

function isRawProxyBody(body: unknown): boolean {
  return typeof body === "string" || body instanceof ArrayBuffer || ArrayBuffer.isView(body);
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function applySafeHeaders(reply: FastifyReply, headers: Record<string, string | string[] | undefined>): void {
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (!SAFE_RESPONSE_HEADERS.has(name.toLowerCase())) continue;
    reply.header(name, value);
  }
}

function remainingResponseTimeout(startedAt: number, timeoutMs: number | undefined): number {
  return Math.max(1, (timeoutMs ?? DEFAULT_REMOTE_REQUEST_TIMEOUT_MS) - (Date.now() - startedAt));
}

function isSelectedMachineConfigRequestError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("PI WEB selected-machine config");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sendGatewayError(reply: FastifyReply, machineId: string, error: unknown): FastifyReply {
  const statusCode = error instanceof RemoteMachineRequestError ? error.statusCode : 502;
  const label = statusCode === 504 ? "Remote machine timeout" : "Remote machine unavailable";
  return reply.code(statusCode).send({
    error: label,
    machineId,
    statusCode,
    detail: errorMessage(error),
  });
}
