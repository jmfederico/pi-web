import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { bridgeSockets, createBufferedSender } from "./webSocketBridge.js";

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
  if (socket.readyState !== WebSocket.CONNECTING && socket.readyState !== WebSocket.OPEN) return;
  socket.close();
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

function nextMessage(socket: WebSocket): Promise<string> {
  return new Promise((resolve) => {
    socket.once("message", (data) => {
      resolve(rawDataToString(data));
    });
  });
}

function rawDataToString(data: RawData): string {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return data.toString("utf8");
}
