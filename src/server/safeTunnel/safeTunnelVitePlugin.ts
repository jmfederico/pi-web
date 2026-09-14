import { dirname, resolve } from "node:path";
import type {
  Plugin,
  ProxyOptions,
  ViteDevServer,
} from "vite";
import type { PiWebManagedAllowedHost } from "../../shared/apiTypes.js";
import {
  isViteHostHeaderAllowed,
  loadSafeTunnelManagedAllowedHosts,
  managedAllowedHostnames,
} from "./safeTunnelManagedHosts.js";

export interface SafeTunnelViteHostPluginOptions {
  readonly statePath: string;
  readonly appliedHosts: readonly PiWebManagedAllowedHost[];
  readonly loadHosts?: (statePath: string) => Promise<readonly PiWebManagedAllowedHost[]>;
  readonly refreshDelayMs?: number;
}

/**
 * Vite freezes separate allowed-host snapshots for HTTP and HMR WebSockets.
 * Rebuilding the development server is therefore the supported way to apply a
 * registration created after Vite started.
 */
export function createSafeTunnelViteHostPlugin(
  options: SafeTunnelViteHostPluginOptions,
): Plugin {
  const statePath = resolve(options.statePath);
  const appliedHostnames = managedAllowedHostnames(options.appliedHosts);
  const loadHosts = options.loadHosts ?? loadSafeTunnelManagedAllowedHosts;
  const refreshDelayMs = options.refreshDelayMs ?? 25;
  let completedRefreshGeneration = 0;
  let requestedRefreshGeneration = 0;
  let disposed = false;
  let refreshDelay: ReturnType<typeof setTimeout> | undefined;
  let releaseRefreshDelay: (() => void) | undefined;
  let refreshPromise: Promise<void> | undefined;
  let startupHttpServer: NonNullable<ViteDevServer["httpServer"]> | undefined;
  let startupListener: (() => void) | undefined;
  const isDisposed = () => disposed;

  const waitForAtomicPublication = (): Promise<void> => new Promise((resolveDelay) => {
    const release = () => {
      if (refreshDelay !== undefined) clearTimeout(refreshDelay);
      refreshDelay = undefined;
      releaseRefreshDelay = undefined;
      resolveDelay();
    };
    releaseRefreshDelay = release;
    refreshDelay = setTimeout(release, refreshDelayMs);
  });

  const reportRefreshFailure = (server: ViteDevServer): void => {
    server.config.logger.warn("failed to refresh managed Safe Tunnel host trust");
  };

  const runRefreshLoop = async (server: ViteDevServer): Promise<void> => {
    while (!isDisposed() && completedRefreshGeneration < requestedRefreshGeneration) {
      await waitForAtomicPublication();
      if (isDisposed()) return;
      const generation = requestedRefreshGeneration;
      const nextHostnames = managedAllowedHostnames(await loadHosts(statePath));
      completedRefreshGeneration = generation;
      if (isDisposed()) return;
      if (!sameStrings(appliedHostnames, nextHostnames)) {
        await server.restart();
        return;
      }
    }
  };

  const ensureRefresh = (server: ViteDevServer): Promise<void> => {
    refreshPromise ??= runRefreshLoop(server)
      .finally(() => {
        refreshPromise = undefined;
        if (!isDisposed() && completedRefreshGeneration < requestedRefreshGeneration) {
          void ensureRefresh(server).catch(() => { reportRefreshFailure(server); });
        }
      });
    return refreshPromise;
  };

  const requestRefresh = (server: ViteDevServer): Promise<void> => {
    if (isDisposed()) return Promise.resolve();
    requestedRefreshGeneration += 1;
    return ensureRefresh(server);
  };

  const validateAfterStart = (server: ViteDevServer): void => {
    void requestRefresh(server).catch(() => { reportRefreshFailure(server); });
  };

  return {
    name: "pi-web-safe-tunnel-managed-host",
    apply: "serve",
    configureServer(server) {
      // The state writer publishes with a same-directory temporary file and
      // rename. Watching both the target and directory catches first creation,
      // replacement, and removal across Chokidar platforms.
      server.watcher.add([statePath, dirname(statePath)]);

      // Re-check once the newly built server starts. This closes the window in
      // which state can change after config evaluation but before the new
      // watcher takes ownership during a Vite restart.
      if (server.httpServer !== null) {
        startupHttpServer = server.httpServer;
        startupListener = () => { validateAfterStart(server); };
        if (server.httpServer.listening) startupListener();
        else server.httpServer.once("listening", startupListener);
      }
    },
    async hotUpdate({ file, server }) {
      if (resolve(file) !== statePath) return;
      await requestRefresh(server);
      return [];
    },
    closeBundle() {
      disposed = true;
      if (startupHttpServer !== undefined && startupListener !== undefined) {
        startupHttpServer.off("listening", startupListener);
      }
      releaseRefreshDelay?.();
    },
  };
}

/** Blocks untrusted `/api` WebSocket upgrades before Vite proxies them. */
export function createViteProxyHostBypass(
  allowedHosts: readonly string[] | true,
): NonNullable<ProxyOptions["bypass"]> {
  return (request) => (
    isViteHostHeaderAllowed(request.headers.host, allowedHosts)
      ? undefined
      : false
  );
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}
