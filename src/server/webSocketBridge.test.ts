import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import {
  PLUGIN_BACKEND_CHANNEL_DATA_FRAME_MAX_BYTES,
  PLUGIN_BACKEND_CHANNEL_OPEN_FRAME_MAX_BYTES,
  serializePluginBackendChannelDataEnvelope,
} from "../shared/pluginBackendProtocol.js";
import {
  bridgePluginBackendChannelSockets,
  bridgeSockets,
  createBoundedTextWebSocketSender,
  createBufferedSender,
  installPluginBackendChannelWebSocketPayloadLimit,
  markPluginBackendChannelUpgradeRequest,
} from "./webSocketBridge.js";

const servers = new Set<WebSocketServer>();
const sockets = new Set<WebSocket>();

afterEach(async () => {
  for (const socket of sockets) closeSocket(socket);
  await Promise.all(Array.from(servers, closeSocketServer));
  sockets.clear();
  servers.clear();
});

describe("bridgeSockets", () => {
  it("forwards messages in both directions while sockets are open", async () => {
    const clientSide = await createSocketPair();
    const upstreamSide = await createSocketPair();
    bridgeSockets(clientSide.bridgeSocket, upstreamSide.bridgeSocket);

    const forwardedToUpstream = nextMessage(upstreamSide.peerSocket);
    clientSide.peerSocket.send("to-upstream");
    await expect(forwardedToUpstream).resolves.toBe("to-upstream");

    const forwardedToClient = nextMessage(clientSide.peerSocket);
    upstreamSide.peerSocket.send("to-client");
    await expect(forwardedToClient).resolves.toBe("to-client");
  });

  it("propagates close and error events to the opposite socket", async () => {
    const closeCaseClientSide = await createSocketPair();
    const closeCaseUpstreamSide = await createSocketPair();
    bridgeSockets(closeCaseClientSide.bridgeSocket, closeCaseUpstreamSide.bridgeSocket);

    const upstreamClosed = nextClose(closeCaseUpstreamSide.peerSocket);
    closeCaseClientSide.peerSocket.close();
    await upstreamClosed;

    const errorCaseClientSide = await createSocketPair();
    const errorCaseUpstreamSide = await createSocketPair();
    bridgeSockets(errorCaseClientSide.bridgeSocket, errorCaseUpstreamSide.bridgeSocket);

    const clientClosed = nextClose(errorCaseClientSide.peerSocket);
    errorCaseUpstreamSide.bridgeSocket.emit("error", new Error("upstream failed"));
    await clientClosed;
  });
});

describe("plugin backend channel upgrade payload limit", () => {
  it("caps marked paired upgrades without narrowing unmarked upgrades", async () => {
    const defaultMaxPayload = 8 * 1024 * 1024;
    const pairedPaths = [
      "/paired-plugin-backends/pi-web.terminal/projects/p/workspaces/w/channels/terminal.attach",
      "/api/paired-plugin-backends/pi-web.terminal/projects/p/workspaces/w/channels/terminal.attach?admission=denied",
      "/api/machines/remote-one/paired-plugin-backends/pi-web.terminal/projects/p/workspaces/w/channels/terminal.attach",
    ];
    const unrelatedPaths = [
      "/plugin-backends/pi-web.terminal/projects/p/workspaces/w/channels/terminal.attach",
      "/api/sessions/session-1/socket",
    ];
    const socketServer = new WebSocketServer({ host: "127.0.0.1", port: 0, maxPayload: defaultMaxPayload });
    servers.add(socketServer);
    const pairedPathSet = new Set(pairedPaths);
    socketServer.on("headers", (_headers, request) => {
      if (request.url !== undefined && pairedPathSet.has(request.url)) {
        markPluginBackendChannelUpgradeRequest(request);
      }
    });
    installPluginBackendChannelWebSocketPayloadLimit(socketServer);
    const receiverLimits = new Map<string, number>();
    socketServer.on("connection", (socket, request) => {
      sockets.add(socket);
      receiverLimits.set(request.url ?? "", webSocketReceiverMaxPayload(socket));
      if (request.url?.includes("admission=denied") === true) {
        socket.close(1013, "admission denied");
      }
    });
    await waitForListening(socketServer);

    for (const path of [...pairedPaths, ...unrelatedPaths]) {
      const client = new WebSocket(`${serverUrl(socketServer)}${path}`);
      sockets.add(client);
      const closed = nextClose(client);
      await nextOpen(client);
      if (!path.includes("admission=denied")) client.close();
      await closed;
    }

    expect(pairedPaths.map((path) => receiverLimits.get(path)))
      .toEqual(pairedPaths.map(() => PLUGIN_BACKEND_CHANNEL_OPEN_FRAME_MAX_BYTES));
    expect(unrelatedPaths.map((path) => receiverLimits.get(path)))
      .toEqual(unrelatedPaths.map(() => defaultMaxPayload));
  });
});

describe("bounded plugin backend channel bridge", () => {
  it("forwards opaque bounded UTF-8 text without interpreting envelope semantics", async () => {
    const clientSide = await createSocketPair();
    const upstreamSide = await createSocketPair();
    void bridgePluginBackendChannelSockets(clientSide.bridgeSocket, upstreamSide.bridgeSocket);

    const opaqueClientFrame = "not-json-and-not-an-envelope";
    const forwardedClientFrame = nextMessage(upstreamSide.peerSocket);
    clientSide.peerSocket.send(opaqueClientFrame);
    await expect(forwardedClientFrame).resolves.toBe(opaqueClientFrame);

    const opaqueUpstreamFrame = "also-not-json-and-not-an-envelope";
    const forwardedUpstreamFrame = nextMessage(clientSide.peerSocket);
    upstreamSide.peerSocket.send(opaqueUpstreamFrame);
    await expect(forwardedUpstreamFrame).resolves.toBe(opaqueUpstreamFrame);
  });

  it("drains bridged frames before propagating a clean upstream close", async () => {
    const clientSide = await createSocketPair();
    const upstreamSide = await createSocketPair();
    const completion = bridgePluginBackendChannelSockets(clientSide.bridgeSocket, upstreamSide.bridgeSocket);
    const messages = socketMessages(clientSide.peerSocket);
    const closed = nextClose(clientSide.peerSocket);
    const first = serializePluginBackendChannelDataEnvelope({ sequence: 1 });
    const second = serializePluginBackendChannelDataEnvelope({ sequence: 2 });

    upstreamSide.peerSocket.send(first);
    upstreamSide.peerSocket.send(second, () => { upstreamSide.peerSocket.close(1000, "complete"); });

    await expect(messages.next()).resolves.toBe(first);
    await expect(messages.next()).resolves.toBe(second);
    await closed;
    await completion;
  });

  it("closes both directions for binary or invalid UTF-8 frames", async () => {
    const binaryClientSide = await createSocketPair();
    const binaryUpstreamSide = await createSocketPair();
    void bridgePluginBackendChannelSockets(binaryClientSide.bridgeSocket, binaryUpstreamSide.bridgeSocket);
    const binaryClientClosed = nextCloseEvent(binaryClientSide.peerSocket);
    const binaryUpstreamClosed = nextCloseEvent(binaryUpstreamSide.peerSocket);
    binaryClientSide.peerSocket.send(Buffer.from("binary"), { binary: true });
    await expect(binaryClientClosed).resolves.toMatchObject({ code: 1003 });
    await expect(binaryUpstreamClosed).resolves.toMatchObject({ code: 1003 });

    const invalidUtf8ClientSide = await createSocketPair();
    const invalidUtf8UpstreamSide = await createSocketPair();
    void bridgePluginBackendChannelSockets(invalidUtf8ClientSide.bridgeSocket, invalidUtf8UpstreamSide.bridgeSocket);
    const invalidUtf8ClientClosed = nextCloseEvent(invalidUtf8ClientSide.peerSocket);
    const invalidUtf8UpstreamClosed = nextCloseEvent(invalidUtf8UpstreamSide.peerSocket);
    invalidUtf8ClientSide.bridgeSocket.emit("message", Buffer.from([0xc3, 0x28]), false);
    await expect(invalidUtf8ClientClosed).resolves.toMatchObject({ code: 1007 });
    await expect(invalidUtf8UpstreamClosed).resolves.toMatchObject({ code: 1007 });
  });

  it("allows the larger first client frame and enforces subsequent and upstream frame bounds", async () => {
    const clientSide = await createSocketPair();
    const upstreamSide = await createSocketPair();
    const completion = bridgePluginBackendChannelSockets(clientSide.bridgeSocket, upstreamSide.bridgeSocket);
    const largeFirstFrame = "f".repeat(PLUGIN_BACKEND_CHANNEL_DATA_FRAME_MAX_BYTES + 1);
    const forwardedFirstFrame = nextMessage(upstreamSide.peerSocket);
    clientSide.peerSocket.send(largeFirstFrame);
    await expect(forwardedFirstFrame).resolves.toBe(largeFirstFrame);

    const clientClosed = nextCloseEvent(clientSide.peerSocket);
    const upstreamClosed = nextCloseEvent(upstreamSide.peerSocket);
    clientSide.peerSocket.send(largeFirstFrame);
    await expect(clientClosed).resolves.toMatchObject({ code: 1009 });
    await expect(upstreamClosed).resolves.toMatchObject({ code: 1011 });
    await completion;

    const oversizedClientSide = await createSocketPair();
    const oversizedUpstreamSide = await createSocketPair();
    void bridgePluginBackendChannelSockets(oversizedClientSide.bridgeSocket, oversizedUpstreamSide.bridgeSocket);
    const oversizedClientClosed = nextCloseEvent(oversizedClientSide.peerSocket);
    const oversizedUpstreamClosed = nextCloseEvent(oversizedUpstreamSide.peerSocket);
    oversizedClientSide.peerSocket.send("o".repeat(PLUGIN_BACKEND_CHANNEL_OPEN_FRAME_MAX_BYTES + 1));
    await expect(oversizedClientClosed).resolves.toMatchObject({ code: 1009 });
    await expect(oversizedUpstreamClosed).resolves.toMatchObject({ code: 1011 });

    const upstreamOversizedClientSide = await createSocketPair();
    const upstreamOversizedSide = await createSocketPair();
    void bridgePluginBackendChannelSockets(upstreamOversizedClientSide.bridgeSocket, upstreamOversizedSide.bridgeSocket);
    const upstreamOversizedClientClosed = nextCloseEvent(upstreamOversizedClientSide.peerSocket);
    const upstreamOversizedClosed = nextCloseEvent(upstreamOversizedSide.peerSocket);
    upstreamOversizedSide.peerSocket.send("u".repeat(PLUGIN_BACKEND_CHANNEL_DATA_FRAME_MAX_BYTES + 1));
    await expect(upstreamOversizedClientClosed).resolves.toMatchObject({ code: 1009 });
    await expect(upstreamOversizedClosed).resolves.toMatchObject({ code: 1009 });
  });

  it("fails both physical sides when the active client-to-upstream queue overflows", async () => {
    const clientSide = await createSocketPair();
    const upstreamSide = await createSocketPair();
    const completion = bridgePluginBackendChannelSockets(clientSide.bridgeSocket, upstreamSide.bridgeSocket);
    const clientClosed = nextCloseEvent(clientSide.peerSocket);
    const upstreamClosed = nextCloseEvent(upstreamSide.peerSocket);
    const frame = "q".repeat(PLUGIN_BACKEND_CHANNEL_DATA_FRAME_MAX_BYTES);

    for (let index = 0; index < 20; index += 1) {
      clientSide.bridgeSocket.emit("message", frame, false);
    }

    await expect(clientClosed).resolves.toMatchObject({ code: 1013 });
    await expect(upstreamClosed).resolves.toMatchObject({ code: 1013 });
    await completion;
  });

  it("rejects sender queue overflow while a socket is connecting", async () => {
    const socketServer = createServer();
    await waitForListening(socketServer);
    const client = new WebSocket(serverUrl(socketServer));
    sockets.add(client);
    const onOverflow = vi.fn();
    const send = createBoundedTextWebSocketSender(client, { maxFrames: 1, maxBytes: 1024, onOverflow });

    send("first");
    expect(() => { send("second"); }).toThrow("queue limit");
    expect(onOverflow).toHaveBeenCalledOnce();
  });
});

describe("createBufferedSender", () => {
  it("queues messages while a WebSocket is still connecting", async () => {
    const socketServer = createServer();
    const connected = new Promise<WebSocket>((resolve) => {
      socketServer.once("connection", (socket) => {
        sockets.add(socket);
        resolve(socket);
      });
    });
    await waitForListening(socketServer);

    const client = new WebSocket(serverUrl(socketServer));
    sockets.add(client);
    const send = createBufferedSender(client);
    send("queued-before-open");

    const serverSocket = await connected;
    await expect(nextMessage(serverSocket)).resolves.toBe("queued-before-open");
    closeSocket(client);
    closeSocket(serverSocket);
  });
});

interface SocketPair {
  bridgeSocket: WebSocket;
  peerSocket: WebSocket;
}

async function createSocketPair(): Promise<SocketPair> {
  const socketServer = createServer();
  const connected = new Promise<WebSocket>((resolve) => {
    socketServer.once("connection", (socket) => {
      sockets.add(socket);
      resolve(socket);
    });
  });
  await waitForListening(socketServer);

  const peerSocket = new WebSocket(serverUrl(socketServer));
  sockets.add(peerSocket);
  const opened = nextOpen(peerSocket);
  const bridgeSocket = await connected;
  await opened;

  return { bridgeSocket, peerSocket };
}

function createServer(): WebSocketServer {
  const socketServer = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  servers.add(socketServer);
  return socketServer;
}

function closeSocket(socket: WebSocket): void {
  if (socket.readyState === WebSocket.CONNECTING) {
    socket.on("error", () => undefined);
    socket.terminate();
  } else if (socket.readyState === WebSocket.OPEN) socket.close();
}

function closeSocketServer(socketServer: WebSocketServer): Promise<void> {
  return new Promise<void>((resolve) => {
    socketServer.close(() => { resolve(); });
  });
}

function waitForListening(socketServer: WebSocketServer): Promise<void> {
  if (socketServer.address() !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    socketServer.once("error", reject);
    socketServer.once("listening", () => {
      socketServer.off("error", reject);
      resolve();
    });
  });
}

function serverUrl(socketServer: WebSocketServer): string {
  const address = socketServer.address();
  if (address === null || typeof address === "string") throw new Error("Expected TCP server address");
  return `ws://127.0.0.1:${String(address.port)}`;
}

function nextOpen(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) return Promise.resolve();
  return new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.once("open", () => {
      socket.off("error", reject);
      resolve();
    });
  });
}

function nextClose(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve) => {
    socket.once("close", () => { resolve(); });
  });
}

function nextCloseEvent(socket: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    socket.once("close", (code, reason) => {
      resolve({ code, reason: reason.toString("utf8") });
    });
  });
}

function nextMessage(socket: WebSocket): Promise<string> {
  return new Promise((resolve) => {
    socket.once("message", (data) => {
      resolve(rawDataToString(data));
    });
  });
}

function socketMessages(socket: WebSocket): { next(): Promise<string> } {
  const queued: string[] = [];
  const waiters: ((value: string) => void)[] = [];
  socket.on("message", (data) => {
    const value = rawDataToString(data);
    const waiter = waiters.shift();
    if (waiter === undefined) queued.push(value);
    else waiter(value);
  });
  return {
    next: () => {
      const value = queued.shift();
      return value === undefined
        ? new Promise<string>((resolve) => { waiters.push(resolve); })
        : Promise.resolve(value);
    },
  };
}

function webSocketReceiverMaxPayload(socket: WebSocket): number {
  const receiver: unknown = Reflect.get(socket, "_receiver");
  const maxPayload: unknown = typeof receiver === "object" && receiver !== null
    ? Reflect.get(receiver, "_maxPayload")
    : undefined;
  if (typeof maxPayload !== "number") throw new Error("Expected ws receiver payload limit");
  return maxPayload;
}

function rawDataToString(data: RawData): string {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return data.toString("utf8");
}
