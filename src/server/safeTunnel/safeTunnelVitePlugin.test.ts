import { EventEmitter } from "node:events";
import { resolve } from "node:path";
import type { Plugin } from "vite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PiWebManagedAllowedHost } from "../../shared/apiTypes.js";
import { createSafeTunnelViteHostPlugin, createViteProxyHostBypass } from "./safeTunnelVitePlugin.js";

const registeredHost: PiWebManagedAllowedHost = {
  source: "safe-tunnel",
  hostname: "machine.namespace.tunnels.example.test",
};
const statePath = resolve("/private/safe-tunnel/config.json");

function fixture() {
  const loadHosts = vi.fn(() => Promise.resolve<readonly PiWebManagedAllowedHost[]>([registeredHost]));
  const server = {
    config: { logger: { warn: vi.fn() } },
    httpServer: Object.assign(new EventEmitter(), { listening: false }),
    restart: vi.fn(() => Promise.resolve()),
    watcher: Object.assign(new EventEmitter(), { add: vi.fn() }),
  };
  const plugin = createSafeTunnelViteHostPlugin({
    statePath, appliedHosts: [registeredHost], loadHosts, refreshDelayMs: 25,
  });
  return { plugin, server, loadHosts };
}

describe("Safe Tunnel Vite host refresh plugin", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("watches atomic publication independently of HMR and coalesces changed trust", async () => {
    const { plugin, server, loadHosts } = fixture();
    await callPluginHook(plugin.configureServer, server);
    expect(server.watcher.add).toHaveBeenCalledWith([statePath, resolve("/private/safe-tunnel")]);
    server.watcher.emit("change", resolve("/private/safe-tunnel/frpc.log"));
    await vi.runAllTimersAsync();
    expect(loadHosts).not.toHaveBeenCalled();
    server.watcher.emit("add", statePath);
    await vi.runAllTimersAsync();
    expect(server.restart).not.toHaveBeenCalled();
    loadHosts.mockResolvedValue([{ ...registeredHost, hostname: "replacement.namespace.tunnels.example.test" }]);
    server.watcher.emit("change", statePath);
    server.watcher.emit("change", statePath);
    await vi.runAllTimersAsync();
    expect(server.restart).toHaveBeenCalledOnce();
    expect(loadHosts).toHaveBeenCalledTimes(2);
    await callPluginHook(plugin.closeBundle, undefined);
  });

  it("rechecks state when another write arrives during an in-flight refresh", async () => {
    const { plugin, server, loadHosts } = fixture();
    let finishRead!: (hosts: readonly PiWebManagedAllowedHost[]) => void;
    loadHosts.mockImplementationOnce(() => new Promise(resolveRead => { finishRead = resolveRead; }));
    loadHosts.mockResolvedValue([]);
    await callPluginHook(plugin.configureServer, server);
    server.watcher.emit("change", statePath);
    await vi.advanceTimersByTimeAsync(25);
    server.watcher.emit("change", statePath);
    finishRead([registeredHost]);
    await vi.runAllTimersAsync();
    expect(loadHosts).toHaveBeenCalledTimes(2);
    expect(server.restart).toHaveBeenCalledOnce();
    await callPluginHook(plugin.closeBundle, undefined);
  });

  it("validates the applied snapshot again when the server starts", async () => {
    const { plugin, server, loadHosts } = fixture();
    loadHosts.mockResolvedValue([]);
    await callPluginHook(plugin.configureServer, server);
    server.httpServer.emit("listening");
    await vi.runAllTimersAsync();
    expect(server.restart).toHaveBeenCalledOnce();
    await callPluginHook(plugin.closeBundle, undefined);
    expect(server.httpServer.listenerCount("listening")).toBe(0);
  });

  it("cancels pending refresh and removes watcher listeners when Vite closes", async () => {
    const { plugin, server, loadHosts } = fixture();
    await callPluginHook(plugin.configureServer, server);
    server.watcher.emit("change", statePath);
    await callPluginHook(plugin.closeBundle, undefined);
    for (const event of ["add", "change", "unlink"]) {
      expect(server.watcher.listenerCount(event)).toBe(0);
      server.watcher.emit(event, statePath);
    }
    await vi.runAllTimersAsync();
    expect(loadHosts).not.toHaveBeenCalled();
    expect(server.restart).not.toHaveBeenCalled();
  });

  it("removes stale trust when state disappears", async () => {
    const { plugin, server, loadHosts } = fixture();
    loadHosts.mockResolvedValue([]);
    await callPluginHook(plugin.configureServer, server);
    server.watcher.emit("unlink", statePath);
    await vi.runAllTimersAsync();
    expect(server.restart).toHaveBeenCalledOnce();
    await callPluginHook(plugin.closeBundle, undefined);
  });
});

describe("Vite `/api` WebSocket proxy host bypass", () => {
  it("allows configured and managed hosts while rejecting unrelated hosts", async () => {
    const bypass = createViteProxyHostBypass(["gateway.example.test", registeredHost.hostname]);
    await expect(callPluginHook(bypass, { headers: { host: registeredHost.hostname } })).resolves.toBeUndefined();
    await expect(callPluginHook(bypass, { headers: { host: "attacker.example.test" } })).resolves.toBe(false);
  });
});

async function callPluginHook(
  hook: Plugin["configureServer"] | Plugin["closeBundle"] | ReturnType<typeof createViteProxyHostBypass>,
  argument: unknown,
): Promise<unknown> {
  if (typeof hook !== "function") throw new Error("Expected a function plugin hook");
  return await Reflect.apply(hook, {}, [argument]);
}
