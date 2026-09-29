import { WebSocket, type RawData } from "ws";
import {
  PLUGIN_BACKEND_CHANNEL_DATA_FRAME_MAX_BYTES,
  PLUGIN_BACKEND_CHANNEL_OPEN_FRAME_MAX_BYTES,
  PLUGIN_BACKEND_CHANNEL_QUEUE_MAX_BYTES,
  PLUGIN_BACKEND_CHANNEL_QUEUE_MAX_FRAMES,
  utf8ByteLength,
} from "../../shared/pluginBackendProtocol.js";
import {
  bridgePluginBackendChannelSockets,
  closePluginBackendChannelWebSocket,
  decodeBoundedPluginBackendChannelTextFrame,
  PluginBackendChannelTransportFrameError,
  setPluginBackendChannelSocketPayloadLimit,
} from "../webSocketBridge.js";
import {
  PluginBackendChannelProxyAdmissionError,
  type PluginBackendChannelProxyAdmissionPool,
  type PluginBackendChannelProxyReservation,
  type PluginBackendChannelProxyScope,
  rejectPluginBackendChannelProxyAdmission,
} from "./pluginBackendChannelProxyAdmission.js";

export type PluginBackendChannelProxyUpstreamConnector = (signal: AbortSignal) => WebSocket | Promise<WebSocket>;

export interface PluginBackendChannelProxyCoordinatorOptions {
  readonly downstream: WebSocket;
  readonly scope: PluginBackendChannelProxyScope;
  readonly admissions: PluginBackendChannelProxyAdmissionPool;
  readonly connectUpstream: PluginBackendChannelProxyUpstreamConnector;
}

export class PluginBackendChannelProxyConnectionError extends Error {
  override name = "PluginBackendChannelProxyConnectionError";

  constructor(
    readonly closeCode: number,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

/**
 * Own one proxy channel from edge admission through physical bridge teardown.
 * Routes provide attribution and an upstream connector, but cannot split setup
 * timeout ownership from the active bridge lifetime.
 */
export async function coordinatePluginBackendChannelProxy(
  options: PluginBackendChannelProxyCoordinatorOptions,
): Promise<void> {
  let reservation: PluginBackendChannelProxyReservation;
  try {
    reservation = options.admissions.admit(options.scope);
  } catch (error) {
    if (error instanceof PluginBackendChannelProxyAdmissionError) {
      await rejectPluginBackendChannelProxyAdmission(options.downstream, error);
    } else {
      await closePluginBackendChannelWebSocket(
        options.downstream,
        1011,
        `Plugin backend channel admission failed: ${errorMessage(error)}`,
        { terminateImmediately: true },
      );
    }
    return;
  }

  await new ManagedPluginBackendChannelProxy(options, reservation).start();
}

type ProxyPhase = "accepted" | "resolving" | "connecting" | "bridging" | "closing" | "closed";

class ManagedPluginBackendChannelProxy {
  private phase: ProxyPhase = "accepted";
  private prelude: PluginBackendChannelPrelude | undefined;
  private upstream: WebSocket | undefined;
  private transportConnectDeadline: ReturnType<typeof setTimeout> | undefined;
  private readonly connectionAbort = new AbortController();
  private resolveCompletion: () => void = () => undefined;
  private readonly completion = new Promise<void>((resolve) => { this.resolveCompletion = resolve; });

  private readonly onUpstreamOpen = (): void => {
    this.beginBridge();
  };

  private readonly onUpstreamClose = (): void => {
    this.beginClosing(1011, "Plugin backend channel upstream disconnected during transport setup");
  };

  private readonly onUpstreamError = (error: Error): void => {
    this.beginClosing(1011, `Plugin backend channel upstream transport setup failed: ${errorMessage(error)}`);
  };

  constructor(
    private readonly options: PluginBackendChannelProxyCoordinatorOptions,
    private readonly reservation: PluginBackendChannelProxyReservation,
  ) {}

  start(): Promise<void> {
    try {
      setPluginBackendChannelSocketPayloadLimit(
        this.options.downstream,
        PLUGIN_BACKEND_CHANNEL_OPEN_FRAME_MAX_BYTES,
      );
      this.prelude = new PluginBackendChannelPrelude(
        this.options.downstream,
        (code, reason) => { this.beginClosing(code, reason); },
      );
    } catch (error) {
      this.beginClosing(1011, `Plugin backend channel proxy setup failed: ${errorMessage(error)}`);
      return this.completion;
    }

    const timeoutMs = this.reservation.transportConnectTimeoutMs;
    this.transportConnectDeadline = setTimeout(() => {
      this.beginClosing(
        1011,
        `Plugin backend channel transport connection timed out after ${String(timeoutMs)}ms`,
      );
    }, timeoutMs);
    this.transportConnectDeadline.unref();
    this.phase = "resolving";

    let connection: WebSocket | Promise<WebSocket>;
    try {
      connection = this.options.connectUpstream(this.connectionAbort.signal);
    } catch (error) {
      this.handleConnectionFailure(error);
      return this.completion;
    }
    void Promise.resolve(connection)
      .then((upstream) => { this.attachUpstream(upstream); })
      .catch((error: unknown) => { this.handleConnectionFailure(error); });
    return this.completion;
  }

  private attachUpstream(upstream: WebSocket): void {
    if (this.phase !== "resolving") {
      void closePluginBackendChannelWebSocket(
        upstream,
        1001,
        "Plugin backend channel proxy setup was cancelled",
        { terminateImmediately: true },
      );
      return;
    }

    this.upstream = upstream;
    this.phase = "connecting";
    upstream.once("open", this.onUpstreamOpen);
    upstream.once("close", this.onUpstreamClose);
    upstream.once("error", this.onUpstreamError);
    if (upstream.readyState === WebSocket.OPEN) {
      this.beginBridge();
    } else if (upstream.readyState !== WebSocket.CONNECTING) {
      this.beginClosing(1011, "Plugin backend channel upstream was not available");
    }
  }

  private beginBridge(): void {
    const upstream = this.upstream;
    if (this.phase !== "connecting" || upstream === undefined) return;
    if (upstream.readyState !== WebSocket.OPEN) {
      this.beginClosing(1011, "Plugin backend channel upstream did not open cleanly");
      return;
    }
    if (this.options.downstream.readyState !== WebSocket.OPEN) {
      this.beginClosing(1001, "Plugin backend channel client disconnected during transport setup");
      return;
    }

    this.clearTransportConnectDeadline();
    this.detachUpstreamSetupListeners();
    const initialClientFrames = this.prelude?.takeFrames() ?? [];
    this.prelude = undefined;
    this.phase = "bridging";

    let bridgeCompletion: Promise<void>;
    try {
      bridgeCompletion = bridgePluginBackendChannelSockets(
        this.options.downstream,
        upstream,
        { initialClientFrames },
      );
    } catch (error) {
      this.beginClosing(1011, `Plugin backend channel bridge setup failed: ${errorMessage(error)}`);
      return;
    }
    void bridgeCompletion
      .then(() => { this.finishBridge(); })
      .catch((error: unknown) => {
        this.beginClosing(1011, `Plugin backend channel bridge failed: ${errorMessage(error)}`);
      });
  }

  private handleConnectionFailure(error: unknown): void {
    if (this.phase !== "resolving") return;
    if (error instanceof PluginBackendChannelProxyConnectionError) {
      this.beginClosing(error.closeCode, error.message);
      return;
    }
    this.beginClosing(1011, `Plugin backend channel upstream connection failed: ${errorMessage(error)}`);
  }

  private finishBridge(): void {
    if (this.phase !== "bridging") return;
    this.phase = "closing";
    this.finishClosed();
  }

  private beginClosing(code: number, reason: string): void {
    if (this.phase === "closing" || this.phase === "closed") return;
    this.phase = "closing";
    this.clearTransportConnectDeadline();
    this.connectionAbort.abort(new Error(reason));
    this.prelude?.dispose();
    this.prelude = undefined;
    this.detachUpstreamSetupListeners();
    const sockets = this.upstream === undefined
      ? [this.options.downstream]
      : [this.options.downstream, this.upstream];
    void Promise.allSettled(
      sockets.map(async (socket) => { await closePluginBackendChannelWebSocket(socket, code, reason); }),
    ).then(() => { this.finishClosed(); });
  }

  private finishClosed(): void {
    if (this.phase === "closed") return;
    this.phase = "closed";
    this.clearTransportConnectDeadline();
    this.prelude?.dispose();
    this.prelude = undefined;
    this.detachUpstreamSetupListeners();
    this.reservation.release();
    this.resolveCompletion();
  }

  private clearTransportConnectDeadline(): void {
    if (this.transportConnectDeadline === undefined) return;
    clearTimeout(this.transportConnectDeadline);
    this.transportConnectDeadline = undefined;
  }

  private detachUpstreamSetupListeners(): void {
    if (this.upstream === undefined) return;
    this.upstream.off("open", this.onUpstreamOpen);
    this.upstream.off("close", this.onUpstreamClose);
    this.upstream.off("error", this.onUpstreamError);
  }
}

class PluginBackendChannelPrelude {
  private readonly frames: string[] = [];
  private bytes = 0;
  private disposed = false;

  private readonly onMessage = (data: RawData, isBinary: boolean): void => {
    try {
      const firstFrame = this.frames.length === 0;
      const text = decodeBoundedPluginBackendChannelTextFrame(
        data,
        isBinary,
        firstFrame ? PLUGIN_BACKEND_CHANNEL_OPEN_FRAME_MAX_BYTES : PLUGIN_BACKEND_CHANNEL_DATA_FRAME_MAX_BYTES,
        firstFrame ? "Plugin backend channel first client frame" : "Plugin backend channel client frame",
      );
      if (firstFrame) {
        setPluginBackendChannelSocketPayloadLimit(
          this.downstream,
          PLUGIN_BACKEND_CHANNEL_DATA_FRAME_MAX_BYTES,
        );
      }
      const frameBytes = utf8ByteLength(text);
      if (this.frames.length >= PLUGIN_BACKEND_CHANNEL_QUEUE_MAX_FRAMES
        || this.bytes + frameBytes > PLUGIN_BACKEND_CHANNEL_QUEUE_MAX_BYTES) {
        this.onFailure(1013, "Plugin backend channel proxy prelude queue limit was exceeded");
        return;
      }
      this.frames.push(text);
      this.bytes += frameBytes;
    } catch (error) {
      this.onFailure(
        error instanceof PluginBackendChannelTransportFrameError ? error.closeCode : 1011,
        errorMessage(error),
      );
    }
  };

  private readonly onClose = (): void => {
    this.onFailure(1001, "Plugin backend channel client disconnected during transport setup");
  };

  private readonly onError = (error: Error): void => {
    this.onFailure(1011, `Plugin backend channel client transport setup failed: ${errorMessage(error)}`);
  };

  constructor(
    private readonly downstream: WebSocket,
    private readonly onFailure: (code: number, reason: string) => void,
  ) {
    downstream.on("message", this.onMessage);
    downstream.once("close", this.onClose);
    downstream.once("error", this.onError);
  }

  takeFrames(): readonly string[] {
    this.dispose();
    return this.frames;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.downstream.off("message", this.onMessage);
    this.downstream.off("close", this.onClose);
    this.downstream.off("error", this.onError);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
