import { EventEmitter } from "node:events";
import { resolve } from "node:path";
import type { Plugin } from "vite";
import { describe, expect, it, vi } from "vitest";
import type { PiWebManagedAllowedHost } from "../../shared/apiTypes.js";
import {
  createSafeTunnelViteHostPlugin,
  createViteProxyHostBypass,
} from "./safeTunnelVitePlugin.js";

const registeredHost: PiWebManagedAllowedHost = {
  source: "safe-tunnel",
  hostname: "machine.namespace.tunnels.example.test",
};

describe("Safe Tunnel Vite host refresh plugin", () => {
  it("watches atomic state publication and restarts only when the managed host changes", async () => {
    const statePath = resolve("/private/safe-tunnel/config.json");
    const replacementHost: PiWebManagedAllowedHost = {
      source: "safe-tunnel",
      hostname: "replacement.namespace.tunnels.example.test",
    };
    let loadedHosts: readonly PiWebManagedAllowedHost[] = [registeredHost];
    const loadHosts = vi.fn(() => Promise.resolve(loadedHosts));
    const restart = vi.fn(() => Promise.resolve());
    const add = vi.fn();
    const server = {
      httpServer: null,
      restart,
      watcher: { add },
    };
    const plugin = createSafeTunnelViteHostPlugin({
      statePath,
      appliedHosts: [registeredHost],
      loadHosts,
      refreshDelayMs: 0,
    });

    await callPluginHook(plugin.configureServer, server);
    expect(add).toHaveBeenCalledWith([statePath, resolve("/private/safe-tunnel")]);

    await callPluginHook(plugin.hotUpdate, {
      file: resolve("/private/safe-tunnel/frpc.log"),
      server,
    });
    expect(loadHosts).not.toHaveBeenCalled();

    await callPluginHook(plugin.hotUpdate, { file: statePath, server });
    expect(restart).not.toHaveBeenCalled();

    loadedHosts = [replacementHost];
    await Promise.all([
      callPluginHook(plugin.hotUpdate, { file: statePath, server }),
      callPluginHook(plugin.hotUpdate, { file: statePath, server }),
    ]);
    expect(restart).toHaveBeenCalledOnce();
    expect(loadHosts).toHaveBeenCalledTimes(2);
  });

  it("rechecks state when another write arrives during an in-flight refresh", async () => {
    const statePath = resolve("/private/safe-tunnel/config.json");
    const replacementHost: PiWebManagedAllowedHost = {
      source: "safe-tunnel",
      hostname: "replacement.namespace.tunnels.example.test",
    };
    const firstRead = deferred<readonly PiWebManagedAllowedHost[]>();
    const firstReadStarted = deferredSignal();
    const loadHosts = vi.fn()
      .mockImplementationOnce(() => {
        firstReadStarted.resolve();
        return firstRead.promise;
      })
      .mockResolvedValueOnce([replacementHost]);
    const restart = vi.fn(() => Promise.resolve());
    const server = { httpServer: null, restart, watcher: { add: vi.fn() } };
    const plugin = createSafeTunnelViteHostPlugin({
      statePath,
      appliedHosts: [registeredHost],
      loadHosts,
      refreshDelayMs: 0,
    });

    const firstRefresh = callPluginHook(plugin.hotUpdate, { file: statePath, server });
    await firstReadStarted.promise;
    const secondRefresh = callPluginHook(plugin.hotUpdate, { file: statePath, server });
    firstRead.resolve([registeredHost]);
    await Promise.all([firstRefresh, secondRefresh]);

    expect(loadHosts).toHaveBeenCalledTimes(2);
    expect(restart).toHaveBeenCalledOnce();
  });

  it("validates the applied snapshot again when a newly built Vite server starts", async () => {
    const statePath = resolve("/private/safe-tunnel/config.json");
    const httpServer = Object.assign(new EventEmitter(), { listening: false });
    const restarted = deferredSignal();
    const restart = vi.fn(() => {
      restarted.resolve();
      return Promise.resolve();
    });
    const server = {
      config: { logger: { warn: vi.fn() } },
      httpServer,
      restart,
      watcher: { add: vi.fn() },
    };
    const plugin = createSafeTunnelViteHostPlugin({
      statePath,
      appliedHosts: [registeredHost],
      loadHosts: () => Promise.resolve([{
        source: "safe-tunnel",
        hostname: "replacement.namespace.tunnels.example.test",
      }]),
      refreshDelayMs: 0,
    });

    await callPluginHook(plugin.configureServer, server);
    httpServer.emit("listening");
    await restarted.promise;
    await callPluginHook(plugin.closeBundle, undefined);

    expect(restart).toHaveBeenCalledOnce();
  });

  it("cancels a pending refresh when Vite closes the plugin", async () => {
    const statePath = resolve("/private/safe-tunnel/config.json");
    const loadHosts = vi.fn(() => Promise.resolve([registeredHost]));
    const restart = vi.fn(() => Promise.resolve());
    const server = { httpServer: null, restart, watcher: { add: vi.fn() } };
    const plugin = createSafeTunnelViteHostPlugin({
      statePath,
      appliedHosts: [],
      loadHosts,
      refreshDelayMs: 60_000,
    });

    const pendingRefresh = callPluginHook(plugin.hotUpdate, { file: statePath, server });
    await callPluginHook(plugin.closeBundle, undefined);
    await pendingRefresh;

    expect(loadHosts).not.toHaveBeenCalled();
    expect(restart).not.toHaveBeenCalled();
  });

  it("removes stale trust when state disappears", async () => {
    const statePath = resolve("/private/safe-tunnel/config.json");
    const restart = vi.fn(() => Promise.resolve());
    const server = {
      httpServer: null,
      restart,
      watcher: { add: vi.fn() },
    };
    const plugin = createSafeTunnelViteHostPlugin({
      statePath,
      appliedHosts: [registeredHost],
      loadHosts: () => Promise.resolve([]),
      refreshDelayMs: 0,
    });

    await callPluginHook(plugin.hotUpdate, { file: statePath, server });

    expect(restart).toHaveBeenCalledOnce();
  });
});

describe("Vite `/api` WebSocket proxy host bypass", () => {
  it("allows configured and managed hosts while rejecting unrelated hosts", async () => {
    const bypass = createViteProxyHostBypass([
      "gateway.example.test",
      registeredHost.hostname,
    ]);

    await expect(callPluginHook(bypass, {
      headers: { host: registeredHost.hostname },
    })).resolves.toBeUndefined();
    await expect(callPluginHook(bypass, {
      headers: { host: "attacker.example.test" },
    })).resolves.toBe(false);
  });
});

function deferredSignal(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolvePromise!: () => void;
  const promise = new Promise<void>((resolveValue) => {
    resolvePromise = resolveValue;
  });
  return { promise, resolve: resolvePromise };
}

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolveValue) => {
    resolvePromise = resolveValue;
  });
  return { promise, resolve: resolvePromise };
}

async function callPluginHook(
  hook: Plugin["configureServer"] | Plugin["hotUpdate"] | Plugin["closeBundle"] | ReturnType<typeof createViteProxyHostBypass>,
  argument: unknown,
): Promise<unknown> {
  if (typeof hook !== "function") throw new Error("Expected a function plugin hook");
  return await Reflect.apply(hook, {}, [argument]);
}
