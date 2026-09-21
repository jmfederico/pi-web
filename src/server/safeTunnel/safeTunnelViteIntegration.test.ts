import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type ViteDevServer } from "vite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import {
  createDefaultSafeTunnelState,
  FileSafeTunnelStateStorage,
} from "./safeTunnelState.js";
import {
  createSafeTunnelViteHostPlugin,
  createViteProxyHostBypass,
} from "./safeTunnelVitePlugin.js";

const managedHostname = "machine.namespace.tunnels.example.test";
const tempDirectories: string[] = [];
const viteServers: ViteDevServer[] = [];
const webSocketServers: WebSocketServer[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await Promise.all(webSocketServers.splice(0).map((server) => closeWebSocketServer(server)));
  await Promise.all(viteServers.splice(0).map((server) => server.close()));
  await Promise.all(tempDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

describe("Vite managed Safe Tunnel host integration", () => {
  it("serves HTTP and HMR only for Vite-trusted hosts", async () => {
    const server = await startViteServer();
    const port = vitePort(server);

    await expect(httpStatus(port, managedHostname)).resolves.toBe(200);
    await expect(httpStatus(port, "attacker.example.test")).resolves.toBe(403);
    await expect(httpStatus(port, "sibling.namespace.tunnels.example.test")).resolves.toBe(403);
    await expect(webSocketUpgradeStatus(port, managedHostname, "/", "vite-hmr"))
      .resolves.toBe(101);
    await expect(webSocketUpgradeStatus(port, "attacker.example.test", "/", "vite-hmr"))
      .resolves.toBe(400);
    await expect(webSocketUpgradeStatus(port, "sibling.namespace.tunnels.example.test", "/", "vite-hmr"))
      .resolves.toBe(400);
  });

  it("observes atomic registration with HMR and Vite WebSockets disabled", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-web-vite-host-watch-"));
    tempDirectories.push(root);
    await writeFile(join(root, "index.html"), "<html>PI WEB</html>");
    const statePath = join(root, "private", "safe-tunnel", "config.json");
    const server = await createServer({
      configFile: false,
      root,
      logLevel: "silent",
      plugins: [createSafeTunnelViteHostPlugin({ statePath, appliedHosts: [] })],
      server: { host: "127.0.0.1", port: 0, strictPort: true, allowedHosts: [], hmr: false, ws: false },
    });
    viteServers.push(server);
    await server.listen();
    const restarted = deferred();
    const restart = vi.spyOn(server, "restart").mockImplementation(() => {
      restarted.resolve();
      return Promise.resolve();
    });
    const storage = new FileSafeTunnelStateStorage({ filePath: statePath, platform: "linux" });

    await storage.save({
      ...createDefaultSafeTunnelState(),
      machine: {
        controlApiBaseUrl: "https://control.example.test",
        machineId: "machine_123",
        machineToken: "machine-token",
        publicUrl: `https://${managedHostname}`,
      },
    });
    await withTimeout(restarted.promise, 3_000, "Vite did not observe Safe Tunnel registration");

    expect(restart).toHaveBeenCalledOnce();
  });

  it("blocks untrusted application WebSockets with Vite's own WebSocket listener disabled", async () => {
    const upstream = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    webSocketServers.push(upstream);
    await listening(upstream);
    let upstreamConnections = 0;
    upstream.on("connection", () => { upstreamConnections += 1; });
    const upstreamAddress = upstream.address();
    if (upstreamAddress === null || typeof upstreamAddress === "string") {
      throw new Error("WebSocket upstream did not expose a TCP listener");
    }
    const upstreamPort = upstreamAddress.port;
    const server = await startViteServer({
      "/api": {
        target: `ws://127.0.0.1:${upstreamPort.toString()}`,
        ws: true,
        bypass: createViteProxyHostBypass([managedHostname]),
      },
    }, false);
    const port = vitePort(server);

    await expect(webSocketUpgradeStatus(port, "attacker.example.test", "/api/socket"))
      .resolves.toBe(404);
    await expect(webSocketUpgradeStatus(port, "sibling.namespace.tunnels.example.test", "/api/socket"))
      .resolves.toBe(404);
    expect(upstreamConnections).toBe(0);

    await expect(webSocketUpgradeStatus(port, managedHostname, "/api/socket"))
      .resolves.toBe(101);
    expect(upstreamConnections).toBe(1);
  });
});

async function startViteServer(proxy?: Record<string, object>, liveReload = true): Promise<ViteDevServer> {
  const root = await mkdtemp(join(tmpdir(), "pi-web-vite-host-"));
  tempDirectories.push(root);
  await writeFile(join(root, "index.html"), "<html>PI WEB</html>");
  const server = await createServer({
    configFile: false,
    root,
    logLevel: "silent",
    server: {
      host: "127.0.0.1",
      port: 0,
      strictPort: true,
      allowedHosts: [managedHostname],
      ...(liveReload ? {} : { hmr: false as const, ws: false }),
      ...(proxy === undefined ? {} : { proxy }),
    },
  });
  viteServers.push(server);
  await server.listen();
  return server;
}

function vitePort(server: ViteDevServer): number {
  const address = server.httpServer?.address();
  if (address === null || address === undefined || typeof address === "string") {
    throw new Error("Vite did not expose a TCP listener");
  }
  return address.port;
}

function httpStatus(port: number, host: string): Promise<number> {
  return new Promise((resolveStatus, reject) => {
    const outgoing = request({
      host: "127.0.0.1",
      port,
      path: "/",
      headers: { host },
    }, (response) => {
      response.resume();
      resolveStatus(response.statusCode ?? 0);
    });
    outgoing.once("error", reject);
    outgoing.end();
  });
}

function webSocketUpgradeStatus(
  port: number,
  host: string,
  path: string,
  protocol?: string,
): Promise<number> {
  return new Promise((resolveStatus, reject) => {
    const socket = protocol === undefined
      ? new WebSocket(`ws://127.0.0.1:${port.toString()}${path}`, { headers: { host } })
      : new WebSocket(`ws://127.0.0.1:${port.toString()}${path}`, protocol, { headers: { host } });
    sockets.push(socket);
    const timeout = setTimeout(() => {
      reject(new Error("Timed out waiting for WebSocket upgrade"));
      socket.terminate();
    }, 3_000);
    socket.once("open", () => {
      clearTimeout(timeout);
      resolveStatus(101);
      socket.close();
    });
    socket.once("unexpected-response", (_request, response) => {
      clearTimeout(timeout);
      response.resume();
      resolveStatus(response.statusCode ?? 0);
    });
    socket.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

function listening(server: WebSocketServer): Promise<void> {
  if (server.address() !== null) return Promise.resolve();
  return new Promise((resolveListening, reject) => {
    server.once("listening", resolveListening);
    server.once("error", reject);
  });
}

function closeWebSocketServer(server: WebSocketServer): Promise<void> {
  return new Promise((resolveClose) => {
    server.close(() => { resolveClose(); });
  });
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolvePromise!: () => void;
  const promise = new Promise<void>((resolveValue) => {
    resolvePromise = resolveValue;
  });
  return { promise, resolve: resolvePromise };
}

async function withTimeout(
  promise: Promise<void>,
  milliseconds: number,
  message: string,
): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<void>((_resolve, reject) => {
        timeout = setTimeout(() => { reject(new Error(message)); }, milliseconds);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
