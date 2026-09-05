import { WebSocket, type Data, type RawData, type WebSocketServer } from "ws";
import {
  boundedPluginBackendChannelCloseReason,
  PLUGIN_BACKEND_CHANNEL_DATA_FRAME_MAX_BYTES,
  PLUGIN_BACKEND_CHANNEL_DRAIN_TIMEOUT_MS,
  PLUGIN_BACKEND_CHANNEL_OPEN_FRAME_MAX_BYTES,
  PLUGIN_BACKEND_CHANNEL_QUEUE_MAX_BYTES,
  PLUGIN_BACKEND_CHANNEL_QUEUE_MAX_FRAMES,
  PLUGIN_BACKEND_CHANNEL_SERVER_TO_BROWSER_QUEUE_MAX_BYTES,
  PLUGIN_BACKEND_CHANNEL_TEARDOWN_TIMEOUT_MS,
  utf8ByteLength,
} from "../shared/pluginBackendProtocol.js";

const pluginChannelLimitedServers = new WeakSet<WebSocketServer>();

export class PluginBackendChannelTransportFrameError extends Error {
  override name = "PluginBackendChannelTransportFrameError";

  constructor(
    readonly closeCode: number,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

/** Decode one opaque text frame while enforcing only physical-hop bounds. */
export function decodeBoundedPluginBackendChannelTextFrame(
  data: RawData | string,
  isBinary: boolean,
  maxBytes: number,
  label: string,
): string {
  if (isBinary) {
    throw new PluginBackendChannelTransportFrameError(1003, "Plugin backend channels accept text frames only");
  }
  if (typeof data === "string") {
    if (utf8ByteLength(data) > maxBytes) {
      throw new PluginBackendChannelTransportFrameError(1009, `${label} exceeds the ${String(maxBytes)} byte transport limit`);
    }
    return data;
  }

  const bytes = data instanceof ArrayBuffer
    ? new Uint8Array(data)
    : Array.isArray(data)
      ? Buffer.concat(data)
      : data;
  if (bytes.byteLength > maxBytes) {
    throw new PluginBackendChannelTransportFrameError(1009, `${label} exceeds the ${String(maxBytes)} byte transport limit`);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new PluginBackendChannelTransportFrameError(1007, `${label} must be valid UTF-8 text`, { cause: error });
  }
}

/** Select the plugin-channel ingress cap before ws allocates its receiver. */
export function installPluginBackendChannelWebSocketPayloadLimit(server: WebSocketServer): void {
  if (pluginChannelLimitedServers.has(server)) return;
  pluginChannelLimitedServers.add(server);
  const defaultMaxPayload = server.options.maxPayload;
  server.on("headers", (_headers, request) => {
    // The ws `headers` event runs synchronously immediately before setSocket()
    // reads this option. Reset every unrelated upgrade so session protocols keep
    // the server's configured allowance.
    server.options.maxPayload = isPluginBackendChannelUpgradePath(request.url)
      ? PLUGIN_BACKEND_CHANNEL_OPEN_FRAME_MAX_BYTES
      : defaultMaxPayload;
  });
}

export function bridgeSockets(client: WebSocket, upstream: WebSocket): void {
  const sendToClient = createBufferedSender(client);
  const sendToUpstream = createBufferedSender(upstream);
  client.on("message", (data) => { sendToUpstream(data); });
  upstream.on("message", (data) => { sendToClient(data); });
  client.on("close", () => { upstream.close(); });
  upstream.on("close", () => { client.close(); });
  upstream.on("error", () => { client.close(); });
  client.on("error", () => { upstream.close(); });
}

export function createBufferedSender(socket: WebSocket): (data: Data) => void {
  const queue: Data[] = [];
  const flush = () => {
    while (socket.readyState === WebSocket.OPEN) {
      const data = queue.shift();
      if (data === undefined) return;
      socket.send(data);
    }
  };
  socket.on("open", flush);
  return (data) => {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(data);
      return;
    }
    if (socket.readyState === WebSocket.CONNECTING) queue.push(data);
  };
}

export interface BoundedTextWebSocketSenderOptions {
  maxFrames?: number;
  maxBytes?: number;
  onOverflow?: (error: Error) => void;
}

export interface BoundedTextWebSocketSender {
  (text: string): void;
  /** Resolve after every accepted frame has completed its socket write callback. */
  drain(timeoutMs?: number): Promise<void>;
}

interface SenderDrainWaiter {
  resolve(): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

/** One-at-a-time sender whose connecting and socket-write queue is explicitly bounded. */
export function createBoundedTextWebSocketSender(
  socket: WebSocket,
  options: BoundedTextWebSocketSenderOptions = {},
): BoundedTextWebSocketSender {
  const maxFrames = options.maxFrames ?? PLUGIN_BACKEND_CHANNEL_QUEUE_MAX_FRAMES;
  const maxBytes = options.maxBytes ?? PLUGIN_BACKEND_CHANNEL_QUEUE_MAX_BYTES;
  const queue: { text: string; bytes: number }[] = [];
  const drainWaiters = new Set<SenderDrainWaiter>();
  let queuedBytes = 0;
  let sending = false;
  let failure: Error | undefined;

  const settleDrainWaiters = (): void => {
    if (failure === undefined && (sending || queue.length !== 0)) return;
    for (const waiter of drainWaiters) {
      clearTimeout(waiter.timer);
      if (failure === undefined) waiter.resolve();
      else waiter.reject(failure);
    }
    drainWaiters.clear();
  };
  const fail = (error: Error): void => {
    if (failure !== undefined) return;
    failure = error;
    options.onOverflow?.(error);
    settleDrainWaiters();
  };
  const flush = (): void => {
    if (sending || failure !== undefined || socket.readyState !== WebSocket.OPEN) return;
    const frame = queue[0];
    if (frame === undefined) {
      settleDrainWaiters();
      return;
    }
    sending = true;
    try {
      socket.send(frame.text, { binary: false }, (error) => {
        sending = false;
        if (queue[0] === frame) {
          queue.shift();
          queuedBytes -= frame.bytes;
        }
        if (error) {
          fail(new Error(`Plugin backend channel socket send failed: ${error.message}`, { cause: error }));
          return;
        }
        flush();
      });
    } catch (error) {
      sending = false;
      if (queue[0] === frame) {
        queue.shift();
        queuedBytes -= frame.bytes;
      }
      fail(error instanceof Error ? error : new Error(String(error)));
    }
  };
  if (socket.readyState === WebSocket.CONNECTING) socket.once("open", flush);

  const send = (text: string): void => {
    if (failure !== undefined || (socket.readyState !== WebSocket.OPEN && socket.readyState !== WebSocket.CONNECTING)) {
      throw new Error("Plugin backend channel socket is not open");
    }
    const bytes = utf8ByteLength(text);
    if (queue.length >= maxFrames || queuedBytes + bytes > maxBytes) {
      const error = new Error("Plugin backend channel socket queue limit was exceeded");
      fail(error);
      throw error;
    }
    queue.push({ text, bytes });
    queuedBytes += bytes;
    flush();
  };
  const drain = (timeoutMs = PLUGIN_BACKEND_CHANNEL_DRAIN_TIMEOUT_MS): Promise<void> => {
    if (failure !== undefined) return Promise.reject(failure);
    if (!sending && queue.length === 0) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const waiter: SenderDrainWaiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          drainWaiters.delete(waiter);
          reject(new Error(`Plugin backend channel socket drain timed out after ${String(timeoutMs)}ms`));
        }, timeoutMs),
      };
      waiter.timer.unref();
      drainWaiters.add(waiter);
    });
  };
  return Object.assign(send, { drain });
}

export interface PluginBackendChannelBridgeOptions {
  /** Opaque bounded text frames captured while an asynchronous upstream was resolved. */
  initialClientFrames?: readonly string[];
}

/**
 * Boundedly bridge opaque generic-channel text without reading plugin or host
 * envelope semantics. The returned lifetime resolves only after both physical
 * sockets have closed and accepted clean-close frames have drained.
 */
export function bridgePluginBackendChannelSockets(
  client: WebSocket,
  upstream: WebSocket,
  options: PluginBackendChannelBridgeOptions = {},
): Promise<void> {
  setPluginBackendChannelSocketPayloadLimit(client, PLUGIN_BACKEND_CHANNEL_OPEN_FRAME_MAX_BYTES);
  let closing = false;
  let closeNotified = false;
  let receivedClientFrame = false;
  let resolveCompletion: () => void = () => undefined;
  const completion = new Promise<void>((resolve) => { resolveCompletion = resolve; });
  const isClosing = (): boolean => closing;
  const detachBridgeListeners = (): void => {
    client.off("message", onClientMessage);
    upstream.off("message", onUpstreamMessage);
    client.off("close", onClientClose);
    upstream.off("close", onUpstreamClose);
    client.off("error", onClientError);
    upstream.off("error", onUpstreamError);
  };
  const notifyClosed = (): void => {
    if (closeNotified) return;
    closeNotified = true;
    detachBridgeListeners();
    resolveCompletion();
  };
  const fail = (code: number, reason: string): void => {
    if (closing) return;
    closing = true;
    void Promise.allSettled([
      closePluginBackendChannelWebSocket(client, code, reason),
      closePluginBackendChannelWebSocket(upstream, code, reason),
    ]).finally(notifyClosed);
  };
  const sendToClient = createBoundedTextWebSocketSender(client, {
    maxBytes: PLUGIN_BACKEND_CHANNEL_SERVER_TO_BROWSER_QUEUE_MAX_BYTES,
    onOverflow: (error) => { fail(1013, error.message); },
  });
  const sendToUpstream = createBoundedTextWebSocketSender(upstream, {
    onOverflow: (error) => { fail(1013, error.message); },
  });

  const forwardClientFrame = (data: RawData | string, isBinary: boolean): void => {
    const firstFrame = !receivedClientFrame;
    const text = decodeBoundedPluginBackendChannelTextFrame(
      data,
      isBinary,
      firstFrame ? PLUGIN_BACKEND_CHANNEL_OPEN_FRAME_MAX_BYTES : PLUGIN_BACKEND_CHANNEL_DATA_FRAME_MAX_BYTES,
      firstFrame ? "Plugin backend channel first client frame" : "Plugin backend channel client frame",
    );
    if (firstFrame) {
      receivedClientFrame = true;
      setPluginBackendChannelSocketPayloadLimit(client, PLUGIN_BACKEND_CHANNEL_DATA_FRAME_MAX_BYTES);
    }
    sendToUpstream(text);
  };
  function onClientMessage(data: RawData, isBinary: boolean): void {
    try {
      forwardClientFrame(data, isBinary);
    } catch (error) {
      fail(transportFrameCloseCode(error), bridgeErrorMessage(error));
    }
  }
  function onUpstreamMessage(data: RawData, isBinary: boolean): void {
    try {
      const text = decodeBoundedPluginBackendChannelTextFrame(
        data,
        isBinary,
        PLUGIN_BACKEND_CHANNEL_DATA_FRAME_MAX_BYTES,
        "Plugin backend channel upstream frame",
      );
      sendToClient(text);
    } catch (error) {
      fail(transportFrameCloseCode(error), bridgeErrorMessage(error));
    }
  }
  function onClientClose(code: number, reason: Buffer): void {
    if (closing) return;
    closing = true;
    void propagatePluginChannelClose(upstream, sendToUpstream, code, decodeCloseReason(reason)).finally(notifyClosed);
  }
  function onUpstreamClose(code: number, reason: Buffer): void {
    if (closing) return;
    closing = true;
    void propagatePluginChannelClose(client, sendToClient, code, decodeCloseReason(reason)).finally(notifyClosed);
  }
  function onClientError(error: Error): void {
    fail(1011, `Plugin backend channel client transport failed: ${bridgeErrorMessage(error)}`);
  }
  function onUpstreamError(error: Error): void {
    fail(1011, `Plugin backend channel upstream transport failed: ${bridgeErrorMessage(error)}`);
  }
  client.on("message", onClientMessage);
  upstream.on("message", onUpstreamMessage);
  client.once("close", onClientClose);
  upstream.once("close", onUpstreamClose);
  client.once("error", onClientError);
  upstream.once("error", onUpstreamError);

  for (const text of options.initialClientFrames ?? []) {
    if (isClosing()) break;
    try {
      forwardClientFrame(text, false);
    } catch (error) {
      fail(transportFrameCloseCode(error), bridgeErrorMessage(error));
    }
  }
  return completion;
}

async function propagatePluginChannelClose(
  target: WebSocket,
  sender: BoundedTextWebSocketSender,
  code: number,
  reason: string,
): Promise<void> {
  const closeCode = transferableCloseCode(code);
  if (closeCode === 1000) {
    try {
      await sender.drain();
    } catch (error) {
      await closePluginBackendChannelWebSocket(target, 1011, `Plugin backend channel clean-close drain failed: ${bridgeErrorMessage(error)}`);
      return;
    }
  }
  await closePluginBackendChannelWebSocket(target, closeCode, reason);
}

/**
 * `@fastify/websocket` owns one ws server for unrelated routes, so its public
 * maxPayload option cannot express this route's smaller protocol bound. Update
 * the ws receiver before route listeners run, then tighten it after the larger
 * first open frame. Keep this compatibility seam isolated and fail loudly if a
 * future ws version changes the receiver shape.
 */
export function setPluginBackendChannelSocketPayloadLimit(socket: WebSocket, maxPayload: number): void {
  const receiver: unknown = Reflect.get(socket, "_receiver");
  if (typeof receiver !== "object" || receiver === null || typeof Reflect.get(receiver, "_maxPayload") !== "number") {
    throw new Error("Plugin backend channel transport cannot apply its payload limit");
  }
  if (!Reflect.set(receiver, "_maxPayload", maxPayload)) {
    throw new Error("Plugin backend channel transport cannot apply its payload limit");
  }
}

function isPluginBackendChannelUpgradePath(rawUrl: string | undefined): boolean {
  if (rawUrl === undefined) return false;
  let pathname: string;
  try {
    pathname = new URL(rawUrl, "http://pi-web.local").pathname;
  } catch {
    return false;
  }
  const segments = pathname.split("/").filter((segment) => segment !== "");
  let index = 0;
  if (segments[index] === "api") index += 1;
  if (segments[index] === "machines") index += 2;
  return segments.length - index === 8
    && segments[index] === "plugin-backends"
    && segments[index + 2] === "projects"
    && segments[index + 4] === "workspaces"
    && segments[index + 6] === "channels";
}

function transportFrameCloseCode(error: unknown): number {
  return error instanceof PluginBackendChannelTransportFrameError ? error.closeCode : 1011;
}

function decodeCloseReason(reason: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(reason);
  } catch {
    return "Invalid close reason";
  }
}

function transferableCloseCode(code: number): number {
  return code === 1000 || (code >= 1001 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006)
    ? code
    : 1011;
}

export interface PluginBackendChannelWebSocketCloseOptions {
  /** Skip the close handshake after any attributed frame has been queued. */
  terminateImmediately?: boolean;
  teardownTimeoutMs?: number;
}

/** Resolve only after the physical socket closes, terminating a non-cooperating peer at the hard deadline. */
export function closePluginBackendChannelWebSocket(
  socket: WebSocket,
  code: number,
  reason: string,
  options: PluginBackendChannelWebSocketCloseOptions = {},
): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise<void>((resolve) => {
    let settled = false;
    const consumeExpectedError = (): void => undefined;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off("close", finish);
      socket.off("error", consumeExpectedError);
      resolve();
    };
    const timer = setTimeout(() => {
      if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
    }, options.teardownTimeoutMs ?? PLUGIN_BACKEND_CHANNEL_TEARDOWN_TIMEOUT_MS);
    timer.unref();
    socket.once("close", finish);
    socket.once("error", consumeExpectedError);

    if (options.terminateImmediately === true || socket.readyState === WebSocket.CONNECTING) {
      socket.terminate();
    } else if (socket.readyState === WebSocket.OPEN) {
      socket.close(code, boundedPluginBackendChannelCloseReason(reason));
    }
    if (socket.readyState === WebSocket.CLOSED) finish();
  });
}

function bridgeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return boundedPluginBackendChannelCloseReason(message);
}
