import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  MachineRuntime,
  PiWebRuntimeResponse,
  SafeTunnelDisableResponse,
  SafeTunnelEnableResponse,
  SafeTunnelStatusResponse,
} from "../shared/apiTypes.js";
import {
  SAFE_TUNNEL_MUTATION_HEADER_NAME,
  SAFE_TUNNEL_MUTATION_HEADER_VALUE,
} from "../shared/safeTunnelHttp.js";
import { buildApp } from "./app.js";
import type { SafeTunnelBridgeService } from "./safeTunnel/safeTunnelBridgeService.js";
import type { SessionProxyDaemon } from "./sessiond/sessionProxyRoutes.js";
import {
  runWebProcess,
  WEB_PROCESS_SHUTDOWN_SIGNALS,
  type WebProcessShutdownSignal,
  type WebProcessSignalListener,
  type WebProcessSignalSource,
} from "./webProcessLifecycle.js";

const tempDirectories: string[] = [];
const safeTunnelStatus: SafeTunnelStatusResponse = {
  config: { exists: false, state: "missing" },
  desiredState: "disabled",
  runtime: { state: "stopped" },
};

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((path) => (
    rm(path, { recursive: true, force: true })
  )));
});

describe("Safe Tunnel app composition", () => {
  it("keeps disabled API probes and runtime capability signals generic", async () => {
    const clientDist = await createClientDist();
    const app = await buildApp({
      clientDist,
      logger: false,
      sessionDaemon: fakeSessionDaemon(),
    });

    try {
      const statusProbe = await app.inject({
        method: "GET",
        url: "/api/safe-tunnel/status",
      });
      const unknownProbe = await app.inject({
        method: "POST",
        url: "/api/safe-tunnel/not-a-route",
      });
      const runtimeResponse = await app.inject({
        method: "GET",
        url: "/api/pi-web/runtime",
      });
      const localRuntimeResponse = await app.inject({
        method: "GET",
        url: "/api/machines/local/runtime?refresh=1",
      });
      const deepLink = await app.inject({
        method: "GET",
        url: "/settings/safe-tunnel",
      });

      expect(statusProbe.statusCode).toBe(404);
      expect(statusProbe.headers["content-type"]).toContain("application/json");
      expect(statusProbe.json()).toEqual({
        message: "Route GET:/api/safe-tunnel/status not found",
        error: "Not Found",
        statusCode: 404,
      });
      expect(unknownProbe.statusCode).toBe(404);
      expect(unknownProbe.json()).toEqual({
        message: "Route POST:/api/safe-tunnel/not-a-route not found",
        error: "Not Found",
        statusCode: 404,
      });

      const runtime = runtimeResponse.json<PiWebRuntimeResponse>();
      const localRuntime = localRuntimeResponse.json<MachineRuntime>();
      expect(runtime.components.web.capabilities).not.toContain("safeTunnel");
      expect(runtime.capabilities).not.toContain("safeTunnel");
      expect(localRuntime.components?.web.capabilities).not.toContain("safeTunnel");
      expect(localRuntime.capabilities).not.toContain("safeTunnel");
      expect(deepLink.statusCode).toBe(200);
      expect(deepLink.body).toBe("<html>PI WEB</html>");
    } finally {
      await app.close();
    }
  });

  it("binds enabled API reads and mutations to startup-snapshot trusted hosts", async () => {
    const fixture = fakeBridge();
    const app = await buildApp({
      clientDist: false,
      logger: false,
      safeTunnel: fixture.bridge,
      safeTunnelMutationHosts: {
        listenerHost: "127.0.0.1",
        allowedHosts: ["gateway.example.test"],
      },
      sessionDaemon: fakeSessionDaemon(),
    });
    const mutationHeaders = {
      [SAFE_TUNNEL_MUTATION_HEADER_NAME]: SAFE_TUNNEL_MUTATION_HEADER_VALUE,
      "sec-fetch-site": "same-origin",
    } as const;

    try {
      const trusted = await app.inject({
        method: "POST",
        url: "/api/safe-tunnel/enable",
        headers: {
          ...mutationHeaders,
          host: "gateway.example.test",
          origin: "https://gateway.example.test",
        },
        payload: {},
      });
      const rebound = await app.inject({
        method: "POST",
        url: "/api/safe-tunnel/enable",
        headers: {
          ...mutationHeaders,
          host: "rebind.attacker.example:8504",
          origin: "http://rebind.attacker.example:8504",
        },
        payload: {},
      });
      const trustedRead = await app.inject({
        method: "GET",
        url: "/api/safe-tunnel/status",
        headers: { host: "gateway.example.test" },
      });
      const reboundRead = await app.inject({
        method: "GET",
        url: "/api/safe-tunnel/status",
        headers: { host: "rebind.attacker.example:8504" },
      });

      expect(trusted.statusCode).toBe(202);
      expect(rebound.statusCode).toBe(403);
      expect(rebound.json()).toEqual({ error: "Request forbidden." });
      expect(trustedRead.statusCode).toBe(200);
      expect(reboundRead.statusCode).toBe(403);
      expect(reboundRead.json()).toEqual({ error: "Request forbidden." });
    } finally {
      await app.close();
    }
  });

  it("starts, routes, advertises, and closes one injected enabled bridge", async () => {
    const fixture = fakeBridge();
    const app = await buildApp({
      clientDist: false,
      logger: false,
      safeTunnel: fixture.bridge,
      sessionDaemon: fakeSessionDaemon(),
    });

    try {
      expect(fixture.startup).not.toHaveBeenCalled();
      await app.ready();
      await app.ready();
      expect(fixture.startup).toHaveBeenCalledOnce();

      const statusResponse = await app.inject({
        method: "GET",
        url: "/api/safe-tunnel/status",
      });
      const runtimeResponse = await app.inject({
        method: "GET",
        url: "/api/pi-web/runtime",
      });
      const localRuntimeResponse = await app.inject({
        method: "GET",
        url: "/api/machines/local/runtime?refresh=1",
      });

      expect(statusResponse.statusCode).toBe(200);
      expect(statusResponse.json()).toEqual(safeTunnelStatus);
      expect(fixture.status).toHaveBeenCalledOnce();

      const runtime = runtimeResponse.json<PiWebRuntimeResponse>();
      const localRuntime = localRuntimeResponse.json<MachineRuntime>();
      expect(runtime.components.web.capabilities).toEqual([
        "plugins.lifecycle",
        "safeTunnel",
      ]);
      expect(runtime.capabilities).toEqual([
        "plugins.lifecycle",
        "safeTunnel",
      ]);
      expect(localRuntime.components?.web.capabilities).toEqual([
        "plugins.lifecycle",
        "safeTunnel",
      ]);
      expect(localRuntime.capabilities).toEqual([
        "plugins.lifecycle",
        "safeTunnel",
      ]);
    } finally {
      await app.close();
    }

    expect(fixture.shutdown).toHaveBeenCalledOnce();
  });
});

describe("web-process lifecycle", () => {
  it.each(WEB_PROCESS_SHUTDOWN_SIGNALS)(
    "closes an enabled Safe Tunnel bridge once on %s",
    async (signal) => {
      const fixture = fakeBridge();
      const signalSource = new FakeWebProcessSignalSource();
      const app = await buildApp({
        clientDist: false,
        logger: false,
        safeTunnel: fixture.bridge,
        sessionDaemon: fakeSessionDaemon(),
      });

      await runWebProcess(app, { port: 0 }, {
        listen: readyWithoutListening,
        signalSource,
      });
      await signalSource.emit(signal);
      await signalSource.emit(signal);

      expect(fixture.shutdown).toHaveBeenCalledOnce();
      expect(signalSource.listenerCount("SIGINT")).toBe(0);
      expect(signalSource.listenerCount("SIGTERM")).toBe(0);
    },
  );

  it("coalesces concurrent shutdown signals into one close operation", async () => {
    const app = Fastify({ logger: false });
    const signalSource = new FakeWebProcessSignalSource();
    const closeStarted = createDeferred();
    const releaseClose = createDeferred();
    const close = vi.fn((closingApp: FastifyInstance) => closingApp.close());
    app.addHook("onClose", async () => {
      closeStarted.resolve();
      await releaseClose.promise;
    });

    await runWebProcess(app, { port: 0 }, {
      close,
      listen: readyWithoutListening,
      signalSource,
    });
    const requests = [signalSource.emit("SIGINT")];
    await closeStarted.promise;
    requests.push(signalSource.emit("SIGTERM"));

    expect(close).toHaveBeenCalledOnce();
    releaseClose.resolve();
    await Promise.all(requests);
    expect(close).toHaveBeenCalledOnce();
    expect(signalSource.listenerCount("SIGINT")).toBe(0);
    expect(signalSource.listenerCount("SIGTERM")).toBe(0);
  });

  it("removes process listeners when the app is closed externally", async () => {
    const app = Fastify({ logger: false });
    const signalSource = new FakeWebProcessSignalSource();

    await runWebProcess(app, { port: 0 }, {
      listen: readyWithoutListening,
      signalSource,
    });
    await app.close();

    expect(signalSource.listenerCount("SIGINT")).toBe(0);
    expect(signalSource.listenerCount("SIGTERM")).toBe(0);
  });

  it("closes a ready app before surfacing its original listen failure", async () => {
    const app = Fastify({ logger: false });
    const signalSource = new FakeWebProcessSignalSource();
    const shutdown = vi.fn<() => Promise<void>>(() => Promise.resolve());
    const close = vi.fn((closingApp: FastifyInstance) => closingApp.close());
    const listenFailure = new Error("address already in use");
    app.addHook("onClose", shutdown);

    await expect(runWebProcess(app, { port: 8504 }, {
      close,
      signalSource,
      listen: async (readyApp) => {
        await readyApp.ready();
        throw listenFailure;
      },
    })).rejects.toBe(listenFailure);

    expect(shutdown).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(signalSource.listenerCount("SIGINT")).toBe(0);
    expect(signalSource.listenerCount("SIGTERM")).toBe(0);
  });
});

async function createClientDist(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-web-safe-tunnel-app-"));
  tempDirectories.push(directory);
  await writeFile(join(directory, "index.html"), "<html>PI WEB</html>", "utf8");
  return directory;
}

function fakeSessionDaemon(): SessionProxyDaemon {
  return {
    request: vi.fn(() => Promise.resolve({
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        component: "sessiond",
        label: "Session daemon",
        available: true,
        capabilities: [],
      }),
    })),
    connectWebSocket: () => {
      throw new Error("WebSocket not configured for test");
    },
  };
}

async function readyWithoutListening(app: FastifyInstance): Promise<void> {
  await app.ready();
}

class FakeWebProcessSignalSource implements WebProcessSignalSource {
  private readonly listeners = new Map<
    WebProcessShutdownSignal,
    Set<WebProcessSignalListener>
  >();

  subscribe(
    signal: WebProcessShutdownSignal,
    listener: WebProcessSignalListener,
  ): () => void {
    const listeners = this.listeners.get(signal) ?? new Set();
    listeners.add(listener);
    this.listeners.set(signal, listeners);
    return () => { listeners.delete(listener); };
  }

  async emit(signal: WebProcessShutdownSignal): Promise<void> {
    await Promise.all(
      [...(this.listeners.get(signal) ?? [])].map(async (listener) => listener()),
    );
  }

  listenerCount(signal: WebProcessShutdownSignal): number {
    return this.listeners.get(signal)?.size ?? 0;
  }
}

interface Deferred {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

function createDeferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function fakeBridge() {
  const startup = vi.fn<() => Promise<void>>(() => Promise.resolve());
  const shutdown = vi.fn<() => Promise<void>>(() => Promise.resolve());
  const status = vi.fn<() => Promise<SafeTunnelStatusResponse>>(() => (
    Promise.resolve(safeTunnelStatus)
  ));
  const disableResponse: SafeTunnelDisableResponse = { status: safeTunnelStatus };
  const enableResponse: SafeTunnelEnableResponse = {
    accepted: true,
    operation: {
      id: "op-1",
      kind: "enable",
      phase: "preparing",
      status: "running",
    },
    status: safeTunnelStatus,
  };
  const bridge: SafeTunnelBridgeService = {
    disable: vi.fn(() => Promise.resolve(disableResponse)),
    enable: vi.fn(() => Promise.resolve(enableResponse)),
    operation: vi.fn(() => undefined),
    registeredPublicOrigin: vi.fn(() => Promise.resolve(undefined)),
    shutdown,
    startup,
    status,
  };
  return { bridge, shutdown, startup, status };
}
