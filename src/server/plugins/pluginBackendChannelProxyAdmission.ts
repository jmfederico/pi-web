import { WebSocket } from "ws";
import {
  PLUGIN_BACKEND_CHANNEL_MAX_TOTAL,
  PLUGIN_BACKEND_CHANNEL_OPEN_TIMEOUT_MS,
  PLUGIN_BACKEND_CHANNEL_TEARDOWN_TIMEOUT_MS,
  serializePluginBackendChannelErrorEnvelope,
} from "../../shared/pluginBackendProtocol.js";
import { closePluginBackendChannelWebSocket } from "../webSocketBridge.js";

export interface PluginBackendChannelProxyScope {
  readonly authorityId: string;
  readonly pluginId: string;
  readonly projectId: string;
  readonly workspaceId: string;
}

export interface PluginBackendChannelProxyAdmissionPoolOptions {
  transportConnectTimeoutMs?: number;
  maxTotal?: number;
}

export interface PluginBackendChannelProxyReservation {
  readonly transportConnectTimeoutMs: number;
  release(): void;
}

export class PluginBackendChannelProxyAdmissionError extends Error {
  override name = "PluginBackendChannelProxyAdmissionError";

  constructor(
    readonly code: string,
    readonly closeCode: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Browser/API-process accounting is intentionally separate from sessiond's
 * authoritative semantic and scoped admission. It only bounds edge transport
 * ownership while a proxy channel is physically alive.
 */
export class PluginBackendChannelProxyAdmissionPool {
  private readonly transportConnectTimeoutMs: number;
  private readonly maxTotal: number;
  private total = 0;

  constructor(options: PluginBackendChannelProxyAdmissionPoolOptions = {}) {
    this.transportConnectTimeoutMs = positiveInteger(
      options.transportConnectTimeoutMs,
      PLUGIN_BACKEND_CHANNEL_OPEN_TIMEOUT_MS,
      "transportConnectTimeoutMs",
    );
    this.maxTotal = positiveInteger(options.maxTotal, PLUGIN_BACKEND_CHANNEL_MAX_TOTAL, "maxTotal");
  }

  get activeCount(): number {
    return this.total;
  }

  admit(scope: PluginBackendChannelProxyScope): PluginBackendChannelProxyReservation {
    if (this.total >= this.maxTotal) {
      throw new PluginBackendChannelProxyAdmissionError(
        "admission-denied",
        1013,
        `Plugin backend channel edge resource limit was reached for ${scope.pluginId} in ${scope.projectId}/${scope.workspaceId} via ${scope.authorityId}`,
      );
    }

    this.total += 1;
    let active = true;
    return {
      transportConnectTimeoutMs: this.transportConnectTimeoutMs,
      release: () => {
        if (!active) return;
        active = false;
        this.total -= 1;
      },
    };
  }
}

const poolsByOwner = new WeakMap<object, PluginBackendChannelProxyAdmissionPool>();

/** Share one aggregate proxy limit across local and federated channel routes. */
export function pluginBackendChannelProxyAdmissionPool(owner: object): PluginBackendChannelProxyAdmissionPool {
  const existing = poolsByOwner.get(owner);
  if (existing !== undefined) return existing;
  const created = new PluginBackendChannelProxyAdmissionPool();
  poolsByOwner.set(owner, created);
  return created;
}

/** Send a best-effort attributed rejection, then await immediate physical teardown. */
export function rejectPluginBackendChannelProxyAdmission(
  socket: WebSocket,
  error: PluginBackendChannelProxyAdmissionError,
): Promise<void> {
  if (socket.readyState !== WebSocket.OPEN) {
    return closePluginBackendChannelWebSocket(socket, error.closeCode, error.message, { terminateImmediately: true });
  }

  return new Promise<void>((resolve) => {
    let teardownStarted = false;
    function teardown(): void {
      if (teardownStarted) return;
      teardownStarted = true;
      clearTimeout(deadline);
      void closePluginBackendChannelWebSocket(socket, error.closeCode, error.message, { terminateImmediately: true })
        .then(resolve, resolve);
    }
    const deadline = setTimeout(teardown, PLUGIN_BACKEND_CHANNEL_TEARDOWN_TIMEOUT_MS);
    deadline.unref();
    try {
      socket.send(serializePluginBackendChannelErrorEnvelope(error.code, error.message), { binary: false }, teardown);
    } catch {
      teardown();
    }
  });
}

function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved <= 0) throw new Error(`${label} must be a positive integer`);
  return resolved;
}
