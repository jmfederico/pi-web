import type { JsonValue } from "../../../shared/apiTypes";
import { isPiWebPluginId } from "../../../shared/pluginIds";
import {
  cloneBoundedPluginBackendJson,
  parseBoundedPluginBackendJson,
  parsePluginBackendChannelServerEnvelope,
  PLUGIN_BACKEND_CHANNEL_OPEN_TIMEOUT_MS,
  PLUGIN_BACKEND_CHANNEL_QUEUE_MAX_BYTES,
  PLUGIN_BACKEND_CHANNEL_QUEUE_MAX_FRAMES,
  PLUGIN_BACKEND_REQUEST_BODY_MAX_BYTES,
  PLUGIN_BACKEND_RESPONSE_BODY_MAX_BYTES,
  PLUGIN_BACKEND_RESPONSE_JSON_MAX_BYTES,
  requirePluginBackendChannelCloseReason,
  requirePluginBackendOperation,
  requirePluginBackendRevision,
  serializePluginBackendChannelDataEnvelope,
  serializePluginBackendChannelOpenEnvelope,
  utf8ByteLength,
} from "../../../shared/pluginBackendProtocol";
import { resolveAppUrl, resolveAppWebSocketUrl, type AppUrlContext } from "../appUrl";

export interface PluginBackendRequestTarget {
  pluginId: string;
  backendRevision: string;
  machineId: string;
  projectId: string;
  workspaceId: string;
}

export interface PluginBackendRequestOptions {
  readonly signal?: AbortSignal;
}

export interface PluginBackendChannelOptions {
  readonly signal?: AbortSignal;
  readonly onData: (data: JsonValue) => void;
}

export interface PluginBackendChannelClose {
  readonly code: number;
  readonly reason: string;
  readonly wasClean: boolean;
  readonly error?: Readonly<{ code: string; message: string }>;
}

export interface PluginBackendChannel {
  readonly closed: Promise<PluginBackendChannelClose>;
  send(data: JsonValue): void;
  close(reason?: string): void;
}

export type PluginBackendWebSocketFactory = (url: string) => WebSocket;

export function pluginBackendRequestPath(
  target: Pick<PluginBackendRequestTarget, "pluginId" | "machineId" | "projectId" | "workspaceId">,
  operation: string,
): string {
  if (!isPiWebPluginId(target.pluginId)) throw new Error(`Invalid PI WEB plugin id: ${target.pluginId}`);
  if (target.machineId === "") throw new Error("Machine id is required");
  if (target.projectId === "") throw new Error("Project id is required");
  if (target.workspaceId === "") throw new Error("Workspace id is required");
  const validatedOperation = requirePluginBackendOperation(operation);
  const prefix = target.machineId === "local"
    ? "api"
    : `api/machines/${encodeURIComponent(target.machineId)}`;
  return `${prefix}/plugin-backends/${encodeURIComponent(target.pluginId)}/projects/${encodeURIComponent(target.projectId)}/workspaces/${encodeURIComponent(target.workspaceId)}/${encodeURIComponent(validatedOperation)}`;
}

export function pluginBackendRequestUrl(
  target: Pick<PluginBackendRequestTarget, "pluginId" | "machineId" | "projectId" | "workspaceId">,
  operation: string,
  context?: AppUrlContext,
): string {
  const path = pluginBackendRequestPath(target, operation);
  return context === undefined ? resolveAppUrl(path) : resolveAppUrl(path, context);
}

export function pluginBackendChannelPath(
  target: Pick<PluginBackendRequestTarget, "pluginId" | "machineId" | "projectId" | "workspaceId">,
  operation: string,
): string {
  const requestPath = pluginBackendRequestPath(target, operation);
  const separator = requestPath.lastIndexOf("/");
  return `${requestPath.slice(0, separator)}/channels${requestPath.slice(separator)}`;
}

export function pluginBackendChannelUrl(
  target: Pick<PluginBackendRequestTarget, "pluginId" | "machineId" | "projectId" | "workspaceId">,
  operation: string,
  context?: AppUrlContext,
): string {
  const path = pluginBackendChannelPath(target, operation);
  return context === undefined ? resolveAppWebSocketUrl(path) : resolveAppWebSocketUrl(path, context);
}

export async function requestPluginBackend(
  target: PluginBackendRequestTarget,
  operation: string,
  input: JsonValue,
  options: PluginBackendRequestOptions = {},
): Promise<JsonValue> {
  const revision = requirePluginBackendRevision(target.backendRevision);
  const clonedInput = cloneBoundedPluginBackendJson(input, "Plugin backend request input");
  const body = JSON.stringify({ revision, input: clonedInput });
  if (utf8ByteLength(body) > PLUGIN_BACKEND_REQUEST_BODY_MAX_BYTES) {
    throw new Error(`Plugin backend request exceeds the ${String(PLUGIN_BACKEND_REQUEST_BODY_MAX_BYTES)} byte wire limit`);
  }

  let response: Response;
  try {
    response = await fetch(pluginBackendRequestUrl(target, operation), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch (error) {
    if (options.signal?.aborted === true) throw abortError(options.signal);
    throw new Error(`Plugin backend request unavailable: ${errorMessage(error)}`, { cause: error });
  }

  const text = await readBoundedResponseText(response);
  if (!response.ok) {
    throw new Error(pluginBackendErrorMessage(text) ?? `Plugin backend request returned HTTP ${String(response.status)}`);
  }
  return parseBoundedPluginBackendJson(text, "Plugin backend response", PLUGIN_BACKEND_RESPONSE_JSON_MAX_BYTES);
}

export function openPluginBackendChannel(
  target: PluginBackendRequestTarget,
  operation: string,
  input: JsonValue,
  options: PluginBackendChannelOptions,
  socketFactory: PluginBackendWebSocketFactory = (url) => new WebSocket(url),
): Promise<PluginBackendChannel> {
  if (options.signal?.aborted === true) return Promise.reject(abortError(options.signal));
  const openFrame = serializePluginBackendChannelOpenEnvelope(target.backendRevision, input);
  const url = pluginBackendChannelUrl(target, operation);
  let socket: WebSocket;
  try {
    socket = socketFactory(url);
  } catch (error) {
    return Promise.reject(new Error(`Plugin backend channel unavailable: ${errorMessage(error)}`, { cause: error }));
  }

  let ready = false;
  let closed = false;
  let bufferedFrames = 0;
  let channelError: Readonly<{ code: string; message: string }> | undefined;
  let resolveClosed: (value: PluginBackendChannelClose) => void = () => undefined;
  const closedPromise = new Promise<PluginBackendChannelClose>((resolve) => { resolveClosed = resolve; });

  const channel: PluginBackendChannel = Object.freeze({
    closed: closedPromise,
    send(data: JsonValue): void {
      if (!ready || closed || socket.readyState !== 1) throw new Error("Plugin backend channel is not open");
      const frame = serializePluginBackendChannelDataEnvelope(data);
      const bytes = utf8ByteLength(frame);
      if (socket.bufferedAmount === 0) bufferedFrames = 0;
      if (bufferedFrames >= PLUGIN_BACKEND_CHANNEL_QUEUE_MAX_FRAMES || socket.bufferedAmount + bytes > PLUGIN_BACKEND_CHANNEL_QUEUE_MAX_BYTES) {
        const error = new Error("Plugin backend channel browser queue limit was exceeded");
        channelError = Object.freeze({ code: "queue-overflow", message: error.message });
        closeBrowserSocket(socket, "Channel queue overflow");
        throw error;
      }
      try {
        socket.send(frame);
        bufferedFrames += 1;
      } catch (error) {
        channelError = Object.freeze({ code: "send-failed", message: errorMessage(error) });
        closeBrowserSocket(socket, "Channel send failed");
        throw error;
      }
    },
    close(reason = "Channel closed"): void {
      closeBrowserSocket(socket, requirePluginBackendChannelCloseReason(reason));
    },
  });

  return new Promise<PluginBackendChannel>((resolve, reject) => {
    const handshakeTimer = setTimeout(() => {
      const error = new Error(`Plugin backend channel open timed out after ${String(PLUGIN_BACKEND_CHANNEL_OPEN_TIMEOUT_MS)}ms`);
      channelError = Object.freeze({ code: "open-timeout", message: error.message });
      reject(error);
      closeBrowserSocket(socket, "Channel open timed out");
    }, PLUGIN_BACKEND_CHANNEL_OPEN_TIMEOUT_MS);

    const onAbort = (): void => {
      const signal = options.signal;
      if (signal === undefined) return;
      const error = abortError(signal);
      if (!ready) reject(error);
      channelError = Object.freeze({ code: "cancelled", message: error.message });
      closeBrowserSocket(socket, "Channel cancelled");
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    socket.addEventListener("open", () => {
      try {
        socket.send(openFrame);
      } catch (error) {
        reject(new Error(`Plugin backend channel unavailable: ${errorMessage(error)}`, { cause: error }));
        closeBrowserSocket(socket, "Channel open failed");
      }
    });
    socket.addEventListener("message", (event) => {
      try {
        if (typeof event.data !== "string") throw new Error("Plugin backend channels accept text JSON frames only");
        const envelope = parsePluginBackendChannelServerEnvelope(event.data);
        if (envelope.kind === "ready") {
          if (ready) throw new Error("Plugin backend channel sent more than one ready envelope");
          ready = true;
          clearTimeout(handshakeTimer);
          resolve(channel);
          return;
        }
        if (envelope.kind === "error") {
          channelError = Object.freeze({ code: envelope.code, message: envelope.message });
          if (!ready) reject(new Error(envelope.message));
          closeBrowserSocket(socket, "Channel failed");
          return;
        }
        if (!ready) throw new Error("Plugin backend channel sent data before ready");
        options.onData(envelope.data);
      } catch (error) {
        channelError = Object.freeze({ code: "protocol-error", message: errorMessage(error) });
        if (!ready) reject(error instanceof Error ? error : new Error(String(error)));
        closeBrowserSocket(socket, "Channel protocol error");
      }
    });
    socket.addEventListener("error", () => {
      channelError ??= Object.freeze({ code: "transport-error", message: "Plugin backend channel transport failed" });
      if (!ready) reject(new Error("Plugin backend channel unavailable"));
      closeBrowserSocket(socket, "Channel transport error");
    });
    socket.addEventListener("close", (event) => {
      if (closed) return;
      closed = true;
      clearTimeout(handshakeTimer);
      options.signal?.removeEventListener("abort", onAbort);
      if (!ready) reject(new Error(channelError?.message ?? `Plugin backend channel closed before ready (${String(event.code)})`));
      const closeError = channelError ?? (event.code === 1000 ? undefined : Object.freeze({
        code: "channel-closed",
        message: event.reason || `Plugin backend channel closed with code ${String(event.code)}`,
      }));
      resolveClosed(Object.freeze({
        code: event.code,
        reason: event.reason,
        wasClean: event.wasClean,
        ...(closeError === undefined ? {} : { error: closeError }),
      }));
    });
  });
}

async function readBoundedResponseText(response: Response): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && /^\d+$/u.test(contentLength) && Number(contentLength) > PLUGIN_BACKEND_RESPONSE_BODY_MAX_BYTES) {
    await response.body?.cancel();
    throw new Error(`Plugin backend response exceeds the ${String(PLUGIN_BACKEND_RESPONSE_BODY_MAX_BYTES)} byte wire limit`);
  }
  if (response.body === null) {
    const text = await response.text();
    if (utf8ByteLength(text) > PLUGIN_BACKEND_RESPONSE_BODY_MAX_BYTES) throw responseTooLargeError();
    return text;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let byteLength = 0;
  let text = "";
  try {
    let chunk = await reader.read();
    while (!chunk.done) {
      byteLength += chunk.value.byteLength;
      if (byteLength > PLUGIN_BACKEND_RESPONSE_BODY_MAX_BYTES) {
        await reader.cancel();
        throw responseTooLargeError();
      }
      text += decoder.decode(chunk.value, { stream: true });
      chunk = await reader.read();
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

function closeBrowserSocket(socket: WebSocket, reason: string): void {
  if (socket.readyState !== 0 && socket.readyState !== 1) return;
  try {
    socket.close(1000, requirePluginBackendChannelCloseReason(reason));
  } catch {
    socket.close();
  }
}

function responseTooLargeError(): Error {
  return new Error(`Plugin backend response exceeds the ${String(PLUGIN_BACKEND_RESPONSE_BODY_MAX_BYTES)} byte wire limit`);
}

function pluginBackendErrorMessage(text: string): string | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) && typeof value["error"] === "string" ? value["error"] : undefined;
  } catch {
    return undefined;
  }
}

function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new DOMException("Plugin backend request cancelled", "AbortError");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
