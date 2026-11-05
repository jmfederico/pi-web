import { isAbsolute, resolve } from "node:path";
import { Readable } from "node:stream";
import type {
  JsonObject,
  JsonValue,
  ServerPluginPeerChannel,
  ServerPluginResourceResponse,
  ServerPluginPeerChannelOpenContextV5 as ServerPluginPeerChannelOpenContext,
  ServerPluginPeerRequestContextV5 as ServerPluginPeerRequestContext,
  ServerPluginPeerWorkspace,
  ServerPluginPeerScope,
  ProjectInput,
  WorkspaceProviderMetadata,
} from "../../server-plugin-api.js";
import { isPiWebPluginId } from "../../shared/pluginIds.js";
import { parsePluginResourceMetadata } from "../../shared/pluginResourceMetadata.js";
import {
  boundedPluginBackendChannelCloseReason,
  cloneBoundedPluginBackendJson,
  PLUGIN_BACKEND_CHANNEL_CALLBACK_TIMEOUT_MS,
  PLUGIN_BACKEND_CHANNEL_DATA_JSON_MAX_BYTES,
  PLUGIN_BACKEND_CHANNEL_MAX_LIFETIME_MS,
  PLUGIN_BACKEND_CHANNEL_MAX_PER_PLUGIN,
  PLUGIN_BACKEND_CHANNEL_MAX_PER_PLUGIN_WORKSPACE,
  PLUGIN_BACKEND_CHANNEL_MAX_TOTAL,
  PLUGIN_BACKEND_CHANNEL_OPEN_TIMEOUT_MS,
  PLUGIN_BACKEND_CHANNEL_TEARDOWN_TIMEOUT_MS,
  PLUGIN_BACKEND_DISPATCH_TIMEOUT_MS,
  PLUGIN_BACKEND_REQUEST_TIMEOUT_MS,
  PLUGIN_BACKEND_RESPONSE_JSON_MAX_BYTES,
  requirePluginBackendOperation,
  requirePluginBackendRevision,
} from "../../shared/pluginBackendProtocol.js";
import type { WorkspaceListing } from "../../shared/apiTypes.js";
import type { Project } from "../types.js";
import type {
  ServerPluginHealthInspection,
  ServerPluginPairedBackendContribution,
} from "./serverPluginRuntime.js";
import { PluginCallbackDrain } from "../pluginCallbackDrain.js";
import type { WorkspaceProviderRegistry } from "../workspaces/workspaceProviderRegistry.js";

export interface PluginBackendRequest {
  pluginId: string;
  moduleRevision: string;
  scope?: "machine" | "project" | "workspace" | undefined;
  project?: Project | undefined;
  workspaceId?: string | undefined;
  operation: string;
  input: unknown;
}

export interface PluginBackendResourceResponse extends Omit<ServerPluginResourceResponse, "body" | "statusCode"> {
  readonly body: Readable;
  readonly statusCode: 200 | 206 | 416;
}

export type PluginBackendRequestErrorCode =
  | "inactive-plugin"
  | "stale-plugin-revision"
  | "invalid-operation"
  | "invalid-input"
  | "workspace-not-found"
  | "invalid-scope"
  | "resolution-failed"
  | "operation-unavailable"
  | "request-failed"
  | "request-timeout"
  | "request-cancelled"
  | "shutdown"
  | "invalid-result";

export class PluginBackendRequestError extends Error {
  override name = "PluginBackendRequestError";

  constructor(
    readonly code: PluginBackendRequestErrorCode,
    readonly statusCode: number,
    message: string,
    options: ErrorOptions = {},
  ) {
    super(message, options);
  }
}

export interface PluginBackendRegistryOptions {
  /** Healthy direct contributions from one immutable server-plugin snapshot. */
  contributions: readonly ServerPluginPairedBackendContribution[];
  /** Established server-owned workspace identity; dispatch never starts discovery. */
  workspaces: Pick<WorkspaceProviderRegistry, "lookup">;
  callbackTimeoutMs?: number;
  dispatchTimeoutMs?: number;
  resourceLifetimeMs?: number;
  resourceMaxTotal?: number;
  channelCallbackTimeoutMs?: number;
  channelOpenTimeoutMs?: number;
  channelLifetimeMs?: number;
  channelMaxTotal?: number;
  channelMaxPerPlugin?: number;
  channelMaxPerPluginWorkspace?: number;
  logger?: {
    error(details: Record<string, unknown>, message: string): void;
  };
}

export interface PluginBackendChannelTransport {
  /** Queue one validated plugin-authored JSON payload for the browser. */
  send(data: JsonValue): void;
  /** Send one attributed host error envelope when the transport still permits it. */
  sendError(code: string, message: string): void;
  /** Close the host transport, draining accepted frames only for a clean close. */
  close(code: number, reason: string): void | Promise<void>;
}

export interface PluginBackendChannelSession {
  readonly pluginId: string;
  readonly workspaceId: string | undefined;
  receive(data: unknown): Promise<void>;
  close(code?: number, reason?: string): Promise<void>;
}

export interface PluginBackendChannelAdmissionRequest {
  readonly pluginId: string;
  readonly scope?: "machine" | "project" | "workspace" | undefined;
  readonly projectId?: string | undefined;
  readonly workspaceId?: string | undefined;
}

/** A connection-scoped reservation created before the client sends its open frame. */
export interface PluginBackendChannelAdmission {
  readonly signal: AbortSignal;
  release(): void;
}

export type PluginBackendChannelErrorCode =
  | "inactive-plugin"
  | "stale-plugin-revision"
  | "invalid-operation"
  | "invalid-input"
  | "workspace-not-found"
  | "invalid-scope"
  | "resolution-failed"
  | "channel-unavailable"
  | "admission-denied"
  | "open-failed"
  | "open-timeout"
  | "receive-failed"
  | "receive-timeout"
  | "channel-closed"
  | "send-failed"
  | "close-failed"
  | "lifetime-expired"
  | "shutdown";

export class PluginBackendChannelError extends Error {
  override name = "PluginBackendChannelError";

  constructor(
    readonly code: PluginBackendChannelErrorCode,
    readonly closeCode: number,
    message: string,
    options: ErrorOptions = {},
  ) {
    super(message, options);
  }
}

/** Keep active paired backends whose bounded startup health is not unhealthy. */
export function eligiblePluginBackendContributions(
  contributions: readonly ServerPluginPairedBackendContribution[],
  inspections: readonly ServerPluginHealthInspection[],
): readonly ServerPluginPairedBackendContribution[] {
  const healthByPluginId = new Map(inspections.map(({ pluginId, health }) => [pluginId, health.status]));
  return Object.freeze(contributions.filter(({ pluginId }) => {
    const status = healthByPluginId.get(pluginId);
    return status === "healthy" || status === "degraded";
  }));
}

/** Dispatches only to a browser package's revision-matched paired server entry. */
export class PluginBackendRegistry {
  private readonly contributions: readonly ServerPluginPairedBackendContribution[];
  private readonly callbackTimeoutMs: number;
  private readonly dispatchTimeoutMs: number;
  private readonly channelCallbackTimeoutMs: number;
  private readonly channelOpenTimeoutMs: number;
  private readonly channelLifetimeMs: number;
  private readonly channelMaxTotal: number;
  private readonly channelMaxPerPlugin: number;
  private readonly channelMaxPerPluginWorkspace: number;
  private readonly channels = new Set<ManagedPluginBackendChannel>();
  private readonly channelAdmissions = new Set<ManagedPluginBackendChannelAdmission>();
  private readonly openingChannelControllers = new Set<AbortController>();
  private readonly openingChannelTasks = new Set<Promise<void>>();
  private readonly openingChannelCleanup = new PluginCallbackDrain();
  private readonly requestTasks = new Set<Promise<JsonValue>>();
  private readonly requestCallbacks = new PluginCallbackDrain();
  private readonly resourceCallbacks = new PluginCallbackDrain();
  private readonly resourceControllers = new Set<AbortController>();
  private readonly resourceLifetimeMs: number;
  private readonly resourceMaxTotal: number;
  private readonly shutdown = new AbortController();
  private closePromise: Promise<void> | undefined;
  private channelAdmissionCount = 0;
  private readonly channelsByPlugin = new Map<string, number>();
  private readonly channelsByPluginWorkspace = new Map<string, number>();

  constructor(private readonly options: PluginBackendRegistryOptions) {
    this.contributions = snapshotContributions(options.contributions);
    this.callbackTimeoutMs = positiveInteger(
      options.callbackTimeoutMs,
      PLUGIN_BACKEND_REQUEST_TIMEOUT_MS,
      "callbackTimeoutMs",
    );
    this.dispatchTimeoutMs = positiveInteger(
      options.dispatchTimeoutMs,
      PLUGIN_BACKEND_DISPATCH_TIMEOUT_MS,
      "dispatchTimeoutMs",
    );
    this.resourceLifetimeMs = Math.min(positiveInteger(options.resourceLifetimeMs, 30 * 60_000, "resourceLifetimeMs"), 30 * 60_000);
    this.resourceMaxTotal = Math.min(positiveInteger(options.resourceMaxTotal, 128, "resourceMaxTotal"), 128);
    this.channelCallbackTimeoutMs = positiveInteger(options.channelCallbackTimeoutMs, PLUGIN_BACKEND_CHANNEL_CALLBACK_TIMEOUT_MS, "channelCallbackTimeoutMs");
    this.channelOpenTimeoutMs = positiveInteger(options.channelOpenTimeoutMs, PLUGIN_BACKEND_CHANNEL_OPEN_TIMEOUT_MS, "channelOpenTimeoutMs");
    this.channelLifetimeMs = positiveInteger(options.channelLifetimeMs, PLUGIN_BACKEND_CHANNEL_MAX_LIFETIME_MS, "channelLifetimeMs");
    this.channelMaxTotal = positiveInteger(options.channelMaxTotal, PLUGIN_BACKEND_CHANNEL_MAX_TOTAL, "channelMaxTotal");
    this.channelMaxPerPlugin = positiveInteger(options.channelMaxPerPlugin, PLUGIN_BACKEND_CHANNEL_MAX_PER_PLUGIN, "channelMaxPerPlugin");
    this.channelMaxPerPluginWorkspace = positiveInteger(options.channelMaxPerPluginWorkspace, PLUGIN_BACKEND_CHANNEL_MAX_PER_PLUGIN_WORKSPACE, "channelMaxPerPluginWorkspace");
  }

  async request(request: PluginBackendRequest, signal?: AbortSignal): Promise<JsonValue> {
    if (this.channelsAreShuttingDown()) throw requestShutdownError(request.pluginId);
    const operationSignal = signal === undefined
      ? this.shutdown.signal
      : AbortSignal.any([signal, this.shutdown.signal]);
    const task = runBoundedPluginBackendOperation(
      request.pluginId,
      "dispatch",
      this.dispatchTimeoutMs,
      (dispatchSignal) => this.dispatch(request, dispatchSignal),
      operationSignal,
    );
    this.requestTasks.add(task);
    try {
      return await task;
    } catch (error) {
      if (signal?.aborted === true) {
        throw backendError(
          "request-cancelled",
          499,
          `Server plugin ${request.pluginId} backend request was cancelled`,
          error,
        );
      }
      if (this.channelsAreShuttingDown()) throw requestShutdownError(request.pluginId, error);
      if (error instanceof PluginBackendTimeoutError) {
        throw backendError("request-timeout", 504, boundedErrorMessage(error), error);
      }
      throw error;
    } finally {
      this.requestTasks.delete(task);
    }
  }

  async resource(request: PluginBackendRequest & { range?: string }, signal?: AbortSignal): Promise<PluginBackendResourceResponse> {
    if (this.channelsAreShuttingDown()) throw requestShutdownError(request.pluginId);
    if (this.resourceControllers.size >= this.resourceMaxTotal) {
      throw backendError("request-failed", 503, "Plugin backend resource capacity is exhausted");
    }
    if (request.range !== undefined && (typeof request.range !== "string" || request.range.length > 1024 || /[\r\n]/.test(request.range))) {
      throw backendError("invalid-input", 400, "Invalid resource range");
    }
    const controller = new AbortController();
    this.resourceControllers.add(controller);
    let callbackSettled = false;
    let ended = false;
    let iterator: AsyncIterator<unknown> | undefined;
    let iteratorEnded = false;
    let cleanupStarted = false;
    let cleanupSettled = true;
    let pendingReads = 0;
    let body: Readable | undefined;
    let callbackTimer: ReturnType<typeof setTimeout> | undefined;
    const release = (): void => {
      if (ended && callbackSettled && cleanupSettled && pendingReads === 0) this.resourceControllers.delete(controller);
    };
    const cleanup = (): void => {
      if (iterator !== undefined && !iteratorEnded && !cleanupStarted) {
        cleanupStarted = true;
        cleanupSettled = false;
        const closing = Promise.resolve().then(() => iterator?.return?.());
        this.resourceCallbacks.track(closing);
        void closing.then(() => { cleanupSettled = true; release(); }, (error: unknown) => {
          this.options.logger?.error({ err: error, pluginId: request.pluginId }, "Plugin backend resource cleanup failed");
          cleanupSettled = true;
          release();
        });
      }
      release();
    };
    const callbackFinished = (): void => {
      callbackSettled = true;
      if (ended) cleanup();
    };
    const finish = (error?: Error): void => {
      if (!ended) {
        ended = true;
        clearTimeout(lifetimeTimer);
        clearTimeout(callbackTimer);
        signal?.removeEventListener("abort", cancel);
        controller.signal.removeEventListener("abort", aborted);
        if (!controller.signal.aborted) controller.abort(error ?? new DOMException("Resource completed", "AbortError"));
        if (body !== undefined && !body.destroyed) body.destroy(error);
      }
      cleanup();
    };
    const cancel = (): void => { controller.abort(backendError("request-cancelled", 499, "Plugin backend resource was cancelled")); };
    const aborted = (): void => { finish(abortError(controller.signal)); };
    const lifetimeTimer = setTimeout(() => {
      controller.abort(backendError("request-timeout", 504, "Plugin backend resource lifetime expired"));
    }, this.resourceLifetimeMs);
    lifetimeTimer.unref();
    controller.signal.addEventListener("abort", aborted, { once: true });
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted === true) cancel();
    const task = (async (): Promise<PluginBackendResourceResponse> => {
      try {
        const { contribution, context } = await runBoundedPluginBackendOperation(
          request.pluginId, "resource dispatch", this.dispatchTimeoutMs,
          (dispatchSignal) => this.prepareInvocation(request, dispatchSignal, "resource"), controller.signal,
        );
        controller.signal.throwIfAborted();
        callbackTimer = setTimeout(() => {
          controller.abort(backendError("request-timeout", 504, "Plugin backend resource callback timed out"));
        }, this.callbackTimeoutMs);
        callbackTimer.unref();
        const resource = contribution.backend.resource?.bind(contribution.backend);
        if (resource === undefined) throw backendError("operation-unavailable", 501, "Resource callback is unavailable");
        const result: unknown = await resource(Object.freeze({
          ...context, signal: controller.signal, ...(request.range === undefined ? {} : { range: request.range }),
        }));
        clearTimeout(callbackTimer);
        // Capture the iterator before metadata validation so invalid and late results are also closed.
        iterator = resourceIterator(result);
        controller.signal.throwIfAborted();
        const metadata = resourceMetadata(result);
        body = resourceReadable(iterator, metadata.contentLength, () => { iteratorEnded = true; },
          (pending) => {
            pendingReads += 1;
            this.resourceCallbacks.track(pending);
            const settled = (): void => { pendingReads -= 1; release(); };
            void pending.then(settled, settled);
          });
        // An aborted response may never reach a transport; avoid an unhandled error event.
        body.on("error", () => undefined);
        body.once("close", () => { finish(); });
        return { ...metadata, body };
      } catch (error) {
        const failure = controller.signal.aborted ? abortError(controller.signal)
          : error instanceof PluginBackendRequestError ? error
          : error instanceof PluginBackendTimeoutError ? backendError("request-timeout", 504, boundedErrorMessage(error), error)
          : backendError("request-failed", 502, boundedErrorMessage(error), error);
        finish(failure);
        throw failure;
      } finally {
        callbackFinished();
      }
    })();
    this.resourceCallbacks.track(task);
    return await raceResourceAbort(task, controller.signal);
  }

  reserveChannel(request: PluginBackendChannelAdmissionRequest): PluginBackendChannelAdmission {
    if (this.channelsAreShuttingDown()) throw channelError("shutdown", 1012, "Plugin backend channels are shutting down");
    if (!isPiWebPluginId(request.pluginId)) throw channelError("inactive-plugin", 1008, `Server plugin is not active: ${request.pluginId}`);
    const kind = requireScopeKind(request.scope);
    if ((kind === "machine" && (request.projectId !== undefined || request.workspaceId !== undefined))
      || (kind === "project" && request.workspaceId !== undefined)) {
      throw channelError("invalid-scope", 1008, "Invalid plugin backend channel admission scope");
    }
    if ((kind !== "machine" && (request.projectId === undefined || request.projectId === ""))
      || (kind === "workspace" && (request.workspaceId === undefined || request.workspaceId === ""))) {
      throw channelError("workspace-not-found", 1008, `Workspace not found for server plugin ${request.pluginId} channel`);
    }
    const pluginCount = this.channelsByPlugin.get(request.pluginId) ?? 0;
    const scopeKey = channelScopeKey(request.pluginId, request.projectId, request.workspaceId, request.scope);
    const scopeCount = this.channelsByPluginWorkspace.get(scopeKey) ?? 0;
    if (this.channelAdmissionCount >= this.channelMaxTotal || pluginCount >= this.channelMaxPerPlugin || scopeCount >= this.channelMaxPerPluginWorkspace) {
      throw channelError("admission-denied", 1013, `Server plugin ${request.pluginId} channel admission limit was reached`);
    }
    this.channelAdmissionCount += 1;
    this.channelsByPlugin.set(request.pluginId, pluginCount + 1);
    this.channelsByPluginWorkspace.set(scopeKey, scopeCount + 1);
    const admission = new ManagedPluginBackendChannelAdmission(
      request,
      () => {
        this.channelAdmissions.delete(admission);
        this.channelAdmissionCount -= 1;
        decrementCount(this.channelsByPlugin, request.pluginId);
        decrementCount(this.channelsByPluginWorkspace, scopeKey);
      },
    );
    this.channelAdmissions.add(admission);
    return admission;
  }

  async openChannel(
    request: PluginBackendRequest,
    transport: PluginBackendChannelTransport,
    signal?: AbortSignal,
    reservedAdmission?: PluginBackendChannelAdmission,
  ): Promise<PluginBackendChannelSession> {
    if (this.channelsAreShuttingDown()) throw channelError("shutdown", 1012, "Plugin backend channels are shutting down");
    const pluginId = parsePluginId(request.pluginId);
    const operation = parseOperation(request.operation);
    const moduleRevision = parseRevision(request.moduleRevision, operation);
    const input = parseInput(request.input, pluginId, operation, "channel open input");
    const contribution = this.contributions.find((candidate) => candidate.pluginId === pluginId);
    const openChannel = contribution?.backend.openChannel?.bind(contribution.backend);
    if (contribution === undefined || openChannel === undefined) {
      throw channelError("channel-unavailable", 1008, `Server plugin ${pluginId} does not expose channel operation ${operation}`);
    }
    if (contribution.moduleRevision !== moduleRevision) {
      throw channelError(
        "stale-plugin-revision",
        1008,
        `Server plugin ${pluginId} backend revision is stale for channel operation ${operation}; reload after the session daemon restarts`,
      );
    }

    requireSupportedScope(request, contribution, true);
    const admissionRequest = { pluginId, projectId: request.project?.id, workspaceId: request.workspaceId, scope: request.scope };
    const admission = reservedAdmission === undefined
      ? this.reserveChannel(admissionRequest)
      : requireManagedChannelAdmission(reservedAdmission, admissionRequest);
    const releaseAdmission = (): void => { admission.release(); };
    const releaseAdmissionOnManagedClose = reservedAdmission === undefined;
    const lifetimeController = new AbortController();
    this.openingChannelControllers.add(lifetimeController);
    let resolveOpeningTask: () => void = () => undefined;
    const openingTask = new Promise<void>((resolve) => { resolveOpeningTask = resolve; });
    this.openingChannelTasks.add(openingTask);
    const finishOpeningTask = (): void => {
      this.openingChannelControllers.delete(lifetimeController);
      this.openingChannelTasks.delete(openingTask);
      resolveOpeningTask();
    };
    const abortFromCaller = (): void => {
      if (!lifetimeController.signal.aborted) lifetimeController.abort(abortError(signal ?? lifetimeController.signal));
    };
    if (signal?.aborted === true) abortFromCaller();
    else signal?.addEventListener("abort", abortFromCaller, { once: true });

    let managed: ManagedPluginBackendChannel | undefined;
    let openingChannel: Promise<ServerPluginPeerChannel> | undefined;
    let sendFailure: Error | undefined;
    const send = (data: JsonValue): void => {
      if (lifetimeController.signal.aborted) throw channelError("channel-closed", 1008, `Server plugin ${pluginId} channel ${operation} is closed`);
      try {
        const cloned = cloneBoundedPluginBackendJson(
          data,
          `Server plugin ${pluginId} channel ${operation} data`,
          PLUGIN_BACKEND_CHANNEL_DATA_JSON_MAX_BYTES,
        );
        transport.send(cloned);
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        sendFailure = failure;
        if (managed !== undefined) {
          void managed.fail("send-failed", `Server plugin ${pluginId} channel ${operation} send failed: ${boundedErrorMessage(failure)}`, 1011).catch(() => undefined);
        }
        throw failure;
      }
    };

    try {
      const channel = await runBoundedPluginBackendOperation(
        pluginId,
        `channel ${operation} open`,
        this.channelOpenTimeoutMs,
        async (openSignal) => {
          const scope = await resolveBackendScope(this.options.workspaces, request, pluginId, operation, openSignal);
          const context: ServerPluginPeerChannelOpenContext = Object.freeze({
            scope,
            operation,
            input,
            signal: lifetimeController.signal,
            send,
          });
          openingChannel = Promise.resolve().then(() => openChannel(context));
          return await openingChannel;
        },
        lifetimeController.signal,
      );
      if (sendFailure !== undefined) throw sendFailure;
      managed = new ManagedPluginBackendChannel({
        pluginId,
        workspaceId: request.workspaceId,
        operation,
        channel,
        transport,
        lifetimeController,
        callbackTimeoutMs: this.channelCallbackTimeoutMs,
        lifetimeMs: this.channelLifetimeMs,
        onReleased: (released) => {
          this.channels.delete(released);
          if (releaseAdmissionOnManagedClose) releaseAdmission();
          signal?.removeEventListener("abort", abortFromCaller);
        },
        onCleanupFailure: (error) => {
          this.options.logger?.error({ err: error, pluginId, operation }, "plugin backend channel cleanup failed");
        },
      });
      finishOpeningTask();
      this.channels.add(managed);
      return managed;
    } catch (error) {
      signal?.removeEventListener("abort", abortFromCaller);
      if (!lifetimeController.signal.aborted) lifetimeController.abort(error);
      // A route-provided reservation remains tied to its physical socket; the
      // route releases it only after attributed teardown completes.
      if (reservedAdmission === undefined) releaseAdmission();
      if (openingChannel !== undefined) {
        const cleanup = openingChannel.then(async (channel) => {
          await closeUnpublishedChannel(
            channel,
            pluginId,
            operation,
            this.channelCallbackTimeoutMs,
            (callback) => { this.openingChannelCleanup.track(callback); },
          );
        }).catch((cleanupError: unknown) => {
          this.options.logger?.error({ err: cleanupError, pluginId, operation }, "unpublished plugin backend channel cleanup failed");
        });
        this.openingChannelCleanup.track(cleanup);
      }
      // Let shutdown snapshot the cleanup task only after this failed opening
      // has either registered its late-result cleanup or proved none can run.
      finishOpeningTask();
      if (error instanceof PluginBackendChannelError) throw error;
      if (error instanceof PluginBackendTimeoutError) {
        throw channelError("open-timeout", 1011, boundedErrorMessage(error), error);
      }
      if (this.channelsAreShuttingDown()) {
        throw channelError("shutdown", 1012, `Server plugin ${pluginId} channel ${operation} was interrupted by shutdown`, error);
      }
      if (signal?.aborted === true) {
        throw channelError("channel-closed", 1008, `Server plugin ${pluginId} channel ${operation} was cancelled`, error);
      }
      throw channelError(
        "open-failed",
        1011,
        `Server plugin ${pluginId} channel ${operation} failed to open: ${boundedErrorMessage(error)}`,
        error,
      );
    }
  }

  closeAll(reason = "Session daemon shutdown"): Promise<void> {
    this.closePromise ??= this.performCloseAll(reason);
    return this.closePromise;
  }

  private async performCloseAll(reason: string): Promise<void> {
    if (!this.shutdown.signal.aborted) this.shutdown.abort(new DOMException(reason, "AbortError"));
    const admissions = [...this.channelAdmissions];
    for (const admission of admissions) admission.abort(reason);
    for (const controller of this.openingChannelControllers) {
      if (!controller.signal.aborted) controller.abort(new DOMException(reason, "AbortError"));
    }
    for (const controller of this.resourceControllers) controller.abort(requestShutdownError("resource"));
    await Promise.allSettled([...this.requestTasks, ...this.openingChannelTasks]);
    const channels = [...this.channels];
    const results = await Promise.allSettled([
      this.resourceCallbacks.waitForSettled(this.callbackTimeoutMs, "Plugin backend resource callbacks and cleanup"),
      this.requestCallbacks.waitForSettled(
        this.callbackTimeoutMs,
        "Plugin backend request callbacks",
      ),
      // Allow a late open, its bounded close invocation, and one final
      // cooperative settlement window after the close signal aborts.
      this.openingChannelCleanup.waitForSettled(
        this.channelOpenTimeoutMs + (2 * this.channelCallbackTimeoutMs),
        "Plugin backend abandoned channel cleanup callbacks",
      ),
      ...channels.map(async (channel) => {
        await channel.fail("shutdown", reason, 1012);
      }),
    ]);
    const failures: unknown[] = [];
    for (const result of results) {
      if (result.status === "rejected") {
        const reason: unknown = result.reason;
        failures.push(reason);
      }
    }
    await Promise.all(admissions.map(async (admission) => {
      try {
        await waitForPromise(
          admission.released,
          PLUGIN_BACKEND_CHANNEL_CALLBACK_TIMEOUT_MS + (2 * PLUGIN_BACKEND_CHANNEL_TEARDOWN_TIMEOUT_MS),
          "Plugin backend channel admission teardown",
        );
      } catch (error) {
        // Do not counterfeit teardown by dropping admission while a physical
        // owner has not confirmed close; shutdown reports the bounded failure.
        failures.push(error);
      }
    }));
    if (failures.length !== 0) throw new AggregateError(failures, "One or more plugin backend channels failed to close");
  }

  activeChannelCount(): number {
    return this.channelAdmissionCount;
  }

  private channelsAreShuttingDown(): boolean {
    return this.shutdown.signal.aborted;
  }

  private async prepareInvocation(request: PluginBackendRequest, dispatchSignal: AbortSignal, kind: "request" | "resource") {
    const pluginId = parsePluginId(request.pluginId);
    const operation = parseOperation(request.operation);
    const moduleRevision = parseRevision(request.moduleRevision, operation);
    const input = parseInput(request.input, pluginId, operation);
    const contribution = this.contributions.find((candidate) => candidate.pluginId === pluginId);

    if (contribution === undefined) {
      throw backendError(
        "inactive-plugin",
        409,
        `Server plugin ${pluginId} does not expose a paired backend for operation ${operation}`,
      );
    }
    if (contribution.moduleRevision !== moduleRevision) {
      throw backendError(
        "stale-plugin-revision",
        409,
        `Server plugin ${pluginId} backend revision is stale for operation ${operation}; reload after the session daemon restarts`,
      );
    }
    if (contribution.backend[kind] === undefined || (kind === "resource" && contribution.apiVersion !== 5)) {
      throw backendError(
        "operation-unavailable",
        501,
        `Server plugin ${pluginId} does not expose paired ${kind} operation ${operation}`,
      );
    }
    requireSupportedScope(request, contribution, false);
    let scope: ServerPluginPeerScope;
    try {
      scope = await resolveBackendScope(this.options.workspaces, request, pluginId, operation, dispatchSignal);
    } catch (error) {
      if (dispatchSignal.aborted) throw abortError(dispatchSignal);
      if (error instanceof PluginBackendChannelError) {
        const code = error.code === "workspace-not-found" ? "workspace-not-found" : error.code === "resolution-failed" ? "resolution-failed" : "invalid-scope";
        throw backendError(code, code === "workspace-not-found" ? 404 : 502, error.message, error);
      }
      throw error;
    }
    const context: ServerPluginPeerRequestContext = Object.freeze({
      scope,
      operation,
      input,
      signal: dispatchSignal,
    });
    return { contribution, context };
  }

  private async dispatch(request: PluginBackendRequest, dispatchSignal: AbortSignal): Promise<JsonValue> {
    const { contribution, context } = await this.prepareInvocation(request, dispatchSignal, "request");
    const { operation } = context;
    const pluginId = contribution.pluginId;
    const pairedRequest = contribution.backend.request?.bind(contribution.backend);
    if (pairedRequest === undefined) throw backendError("operation-unavailable", 501, "Request callback is unavailable");
    let result: unknown;
    try {
      result = await runBoundedPluginBackendOperation(
        pluginId,
        operation,
        this.callbackTimeoutMs,
        (callbackSignal) => pairedRequest(Object.freeze({ ...context, signal: callbackSignal })),
        dispatchSignal,
        (callback) => { this.requestCallbacks.track(callback); },
      );
    } catch (error) {
      if (dispatchSignal.aborted) throw abortError(dispatchSignal);
      if (error instanceof PluginBackendTimeoutError) {
        throw backendError("request-timeout", 504, boundedErrorMessage(error), error);
      }
      throw backendError(
        "request-failed",
        502,
        `Server plugin ${pluginId} operation ${operation} failed: ${boundedErrorMessage(error)}`,
        error,
      );
    }

    try {
      return cloneBoundedPluginBackendJson(
        result,
        `Server plugin ${pluginId} operation ${operation} result`,
        PLUGIN_BACKEND_RESPONSE_JSON_MAX_BYTES,
      );
    } catch (error) {
      throw backendError("invalid-result", 502, boundedErrorMessage(error), error);
    }
  }
}

class ManagedPluginBackendChannelAdmission implements PluginBackendChannelAdmission {
  private readonly controller = new AbortController();
  private isReleased = false;
  private resolveReleased: () => void = () => undefined;
  readonly released = new Promise<void>((resolve) => { this.resolveReleased = resolve; });

  constructor(
    readonly request: PluginBackendChannelAdmissionRequest,
    private readonly onRelease: () => void,
  ) {}

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  abort(reason: string): void {
    if (!this.controller.signal.aborted) this.controller.abort(new DOMException(reason, "AbortError"));
  }

  release(): void {
    if (this.isReleased) return;
    this.isReleased = true;
    this.onRelease();
    this.resolveReleased();
  }
}

function requireManagedChannelAdmission(
  admission: PluginBackendChannelAdmission,
  expected: PluginBackendChannelAdmissionRequest,
): ManagedPluginBackendChannelAdmission {
  if (!(admission instanceof ManagedPluginBackendChannelAdmission)
    || admission.request.pluginId !== expected.pluginId
    || admission.request.projectId !== expected.projectId
    || admission.request.workspaceId !== expected.workspaceId
    || (admission.request.scope ?? "workspace") !== (expected.scope ?? "workspace")) {
    throw channelError("admission-denied", 1013, `Server plugin ${expected.pluginId} channel admission reservation is invalid`);
  }
  if (admission.signal.aborted) {
    throw channelError("shutdown", 1012, `Server plugin ${expected.pluginId} channel admission was cancelled`);
  }
  return admission;
}

interface ManagedPluginBackendChannelOptions {
  pluginId: string;
  workspaceId: string | undefined;
  operation: string;
  channel: ServerPluginPeerChannel;
  transport: PluginBackendChannelTransport;
  lifetimeController: AbortController;
  callbackTimeoutMs: number;
  lifetimeMs: number;
  onReleased: (channel: ManagedPluginBackendChannel) => void;
  onCleanupFailure: (error: unknown) => void;
}

class ManagedPluginBackendChannel implements PluginBackendChannelSession {
  readonly pluginId: string;
  readonly workspaceId: string | undefined;
  private readonly lifetimeTimer: ReturnType<typeof setTimeout>;
  private readonly receiveCallbacks = new PluginCallbackDrain();
  private readonly closeCallbacks = new PluginCallbackDrain();
  private closePromise: Promise<void> | undefined;
  private failureSignalled = false;

  constructor(private readonly options: ManagedPluginBackendChannelOptions) {
    this.pluginId = options.pluginId;
    this.workspaceId = options.workspaceId;
    this.lifetimeTimer = setTimeout(() => {
      void this.fail(
        "lifetime-expired",
        `Server plugin ${this.pluginId} channel ${options.operation} reached its maximum lifetime`,
        1001,
      ).catch(() => undefined);
    }, options.lifetimeMs);
    this.lifetimeTimer.unref();
    this.observePluginCompletion();
  }

  async receive(data: unknown): Promise<void> {
    if (this.isClosed()) {
      throw channelError("channel-closed", 1008, `Server plugin ${this.pluginId} channel ${this.options.operation} is closed`);
    }
    let cloned: JsonValue;
    try {
      cloned = cloneBoundedPluginBackendJson(
        data,
        `Server plugin ${this.pluginId} channel ${this.options.operation} data`,
        PLUGIN_BACKEND_CHANNEL_DATA_JSON_MAX_BYTES,
      );
    } catch (error) {
      throw channelError("invalid-input", 1008, boundedErrorMessage(error), error);
    }
    try {
      await runBoundedPluginBackendOperation(
        this.pluginId,
        `channel ${this.options.operation} receive`,
        this.options.callbackTimeoutMs,
        (signal) => this.options.channel.receive(cloned, signal),
        this.options.lifetimeController.signal,
        (callback) => { this.receiveCallbacks.track(callback); },
      );
    } catch (error) {
      if (this.isClosed()) {
        throw channelError("channel-closed", 1008, `Server plugin ${this.pluginId} channel ${this.options.operation} closed during receive`, error);
      }
      if (error instanceof PluginBackendTimeoutError) {
        throw channelError("receive-timeout", 1011, boundedErrorMessage(error), error);
      }
      throw channelError(
        "receive-failed",
        1011,
        `Server plugin ${this.pluginId} channel ${this.options.operation} receive failed: ${boundedErrorMessage(error)}`,
        error,
      );
    }
  }

  private isClosed(): boolean {
    return this.closePromise !== undefined || this.options.lifetimeController.signal.aborted;
  }

  private observePluginCompletion(): void {
    const closed = this.options.channel.closed;
    if (closed === undefined) return;
    void Promise.resolve(closed).then(async () => {
      if (this.isClosed()) return;
      const reason = "Plugin completed channel";
      try {
        await this.close(1000, reason);
        await this.options.transport.close(1000, reason);
      } catch (error) {
        await this.fail(
          "channel-closed",
          `Server plugin ${this.pluginId} channel ${this.options.operation} completion cleanup failed: ${boundedErrorMessage(error)}`,
          1011,
        );
      }
    }, async (error: unknown) => {
      if (this.isClosed()) return;
      await this.fail(
        "channel-closed",
        `Server plugin ${this.pluginId} channel ${this.options.operation} completion failed: ${boundedErrorMessage(error)}`,
        1011,
      );
    }).catch((error: unknown) => {
      this.options.onCleanupFailure(error);
    });
  }

  close(code = 1000, reason = "Channel closed"): Promise<void> {
    this.closePromise ??= this.performClose(code, boundedPluginBackendChannelCloseReason(reason));
    return this.closePromise;
  }

  async fail(code: PluginBackendChannelErrorCode, message: string, closeCode: number): Promise<void> {
    if (!this.failureSignalled) {
      this.failureSignalled = true;
      try {
        this.options.transport.sendError(code, message);
      } catch {
        // The transport may already be gone; cleanup and admission release remain authoritative.
      }
    }
    try {
      await this.close(closeCode, message);
    } finally {
      try {
        await this.options.transport.close(closeCode, boundedPluginBackendChannelCloseReason(message));
      } catch {
        // Closing an already-disconnected transport is expected and does not change cleanup ownership.
      }
    }
  }

  private async performClose(code: number, reason: string): Promise<void> {
    clearTimeout(this.lifetimeTimer);
    if (!this.options.lifetimeController.signal.aborted) {
      this.options.lifetimeController.abort(new DOMException(reason || "Plugin backend channel closed", "AbortError"));
    }

    const failures: unknown[] = [];
    try {
      try {
        await this.receiveCallbacks.waitForSettled(
          this.options.callbackTimeoutMs,
          `Server plugin ${this.pluginId} channel ${this.options.operation} receive callbacks`,
        );
      } catch (error) {
        failures.push(error);
      }

      const close = this.options.channel.close?.bind(this.options.channel);
      if (close !== undefined) {
        try {
          await runBoundedPluginBackendOperation(
            this.pluginId,
            `channel ${this.options.operation} close`,
            this.options.callbackTimeoutMs,
            (signal) => close(Object.freeze({ code, reason, signal })),
            undefined,
            (callback) => { this.closeCallbacks.track(callback); },
          );
        } catch (error) {
          failures.push(error);
        }
        try {
          await this.closeCallbacks.waitForSettled(
            this.options.callbackTimeoutMs,
            `Server plugin ${this.pluginId} channel ${this.options.operation} close callbacks`,
          );
        } catch (error) {
          failures.push(error);
        }
      }
    } finally {
      this.options.onReleased(this);
    }

    if (failures.length !== 0) {
      const failure = failures.length === 1
        ? failures[0]
        : new AggregateError(failures, `Server plugin ${this.pluginId} channel ${this.options.operation} cleanup failed`);
      this.options.onCleanupFailure(failure);
      throw channelError(
        "close-failed",
        1011,
        `Server plugin ${this.pluginId} channel ${this.options.operation} close failed: ${boundedErrorMessage(failure)}`,
        failure,
      );
    }
  }
}

async function closeUnpublishedChannel(
  channel: ServerPluginPeerChannel,
  pluginId: string,
  operation: string,
  callbackTimeoutMs: number,
  onCallbackStarted: (callback: Promise<void>) => void,
): Promise<void> {
  const close = channel.close?.bind(channel);
  if (close === undefined) return;
  await runBoundedPluginBackendOperation(
    pluginId,
    `channel ${operation} abandoned-open close`,
    callbackTimeoutMs,
    (signal) => close(Object.freeze({
      code: 1011,
      reason: "Channel open did not complete",
      signal,
    })),
    undefined,
    onCallbackStarted,
  );
}

async function resolveBackendScope(
  workspaces: Pick<WorkspaceProviderRegistry, "lookup">,
  request: PluginBackendRequest,
  pluginId: string,
  operation: string,
  signal: AbortSignal,
): Promise<ServerPluginPeerScope> {
  const kind = requireScopeKind(request.scope);
  if (kind === "machine") {
    if (request.project !== undefined || request.workspaceId !== undefined) throw channelError("invalid-scope", 1008, "Machine scope cannot contain project or workspace authority");
    return Object.freeze({ kind });
  }
  if (request.project === undefined) throw channelError("invalid-scope", 1008, "Project authority is required");
  if (kind === "project" && request.workspaceId !== undefined) throw channelError("invalid-scope", 1008, "Project scope cannot contain workspace authority");
  if (kind === "workspace" && (request.workspaceId === undefined || request.workspaceId === "")) {
    throw channelError("workspace-not-found", 1008, `Workspace not found for server plugin ${pluginId} channel ${operation}`);
  }
  let project: ProjectInput;
  try {
    project = snapshotProject(request.project);
  } catch (error) {
    throw channelError("invalid-scope", 1011, boundedErrorMessage(error), error);
  }
  if (kind === "project") return Object.freeze({ kind, project });
  let target: WorkspaceListing | undefined;
  try {
    const resolution = await workspaces.lookup(request.project, signal);
    if (resolution === undefined) throw new Error("Workspace discovery is not ready; refresh the project's workspace list");
    target = resolution.workspaces.find((workspace) => workspace.id === request.workspaceId);
  } catch (error) {
    if (signal.aborted) throw abortError(signal);
    throw channelError(
      "resolution-failed",
      1011,
      `Server plugin ${pluginId} could not resolve workspace scope for channel ${operation}: ${boundedErrorMessage(error)}`,
      error,
    );
  }
  if (target === undefined) {
    throw channelError(
      "workspace-not-found",
      1008,
      `Workspace ${request.workspaceId ?? "missing"} is stale or unavailable for server plugin ${pluginId} channel ${operation}`,
    );
  }
  try {
    return Object.freeze({ kind: "workspace", project, workspace: snapshotWorkspace(target, project.id) });
  } catch (error) {
    throw channelError(
      "invalid-scope",
      1011,
      `Server plugin ${pluginId} received an invalid host workspace scope for channel ${operation}: ${boundedErrorMessage(error)}`,
      error,
    );
  }
}

function requireScopeKind(value: unknown): "machine" | "project" | "workspace" {
  if (value === undefined) return "workspace";
  if (value === "machine" || value === "project" || value === "workspace") return value;
  throw channelError("invalid-scope", 1008, "Unknown plugin backend scope");
}

function requireSupportedScope(request: PluginBackendRequest, contribution: ServerPluginPairedBackendContribution, channel: boolean): void {
  if (contribution.apiVersion !== 5 && (request.scope ?? "workspace") !== "workspace") {
    const message = `Server plugin ${request.pluginId} API v3 requires workspace scope`;
    if (channel) throw channelError("invalid-scope", 1008, message);
    throw backendError("invalid-scope", 400, message);
  }
}

function channelScopeKey(pluginId: string, projectId?: string, workspaceId?: string, scope = "workspace"): string {
  return JSON.stringify([pluginId, scope, projectId, workspaceId]);
}

function decrementCount(map: Map<string, number>, key: string): void {
  const count = map.get(key);
  if (count === undefined || count <= 1) map.delete(key);
  else map.set(key, count - 1);
}

function channelError(
  code: PluginBackendChannelErrorCode,
  closeCode: number,
  message: string,
  cause?: unknown,
): PluginBackendChannelError {
  return new PluginBackendChannelError(code, closeCode, message, cause === undefined ? {} : { cause });
}

function invalidResource(message: string): PluginBackendRequestError {
  return backendError("invalid-result", 502, `Invalid plugin resource: ${message}`);
}

function isResourceRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function resourceIterator(result: unknown): AsyncIterator<unknown> {
  if (typeof result !== "object" || result === null || !("body" in result)) throw invalidResource("missing body");
  const body: unknown = result.body;
  if (body instanceof Uint8Array) {
    return (async function* () { yield await Promise.resolve(body); })();
  }
  if (typeof body !== "object" || body === null || !(Symbol.asyncIterator in body)
    || typeof body[Symbol.asyncIterator] !== "function") throw invalidResource("body must contain bytes or an async iterable of bytes");
  const createIterator: unknown = body[Symbol.asyncIterator];
  if (typeof createIterator !== "function") throw invalidResource("invalid body iterator factory");
  const iterator: unknown = Reflect.apply(createIterator, body, []);
  if (typeof iterator !== "object" || iterator === null || !("next" in iterator) || typeof iterator.next !== "function") {
    throw invalidResource("invalid body iterator");
  }
  const next = iterator.next;
  const close = "return" in iterator && typeof iterator.return === "function" ? iterator.return : undefined;
  return {
    async next() {
      const chunk: unknown = await Reflect.apply(next, iterator, []);
      if (!isResourceRecord(chunk)) throw invalidResource("invalid iterator result");
      return chunk["done"] === true ? { done: true, value: undefined } : { done: false, value: chunk["value"] };
    },
    ...(close === undefined ? {} : { async return() { await Reflect.apply(close, iterator, []); return { done: true as const, value: undefined }; } }),
  };
}

function resourceMetadata(result: unknown): Omit<PluginBackendResourceResponse, "body"> {
  let metadata;
  try { metadata = parsePluginResourceMetadata(result); }
  catch (error) { throw invalidResource(boundedErrorMessage(error)); }
  const responseBody: unknown = typeof result === "object" && result !== null ? Reflect.get(result, "body") : undefined;
  if (responseBody instanceof Uint8Array && metadata.contentLength !== undefined && responseBody.byteLength !== metadata.contentLength) {
    throw invalidResource("body length does not match contentLength");
  }
  return metadata;
}

function resourceReadable(
  iterator: AsyncIterator<unknown>, contentLength: number | undefined, onEnd: () => void,
  track: (pending: Promise<unknown>) => void,
): Readable {
  let reading = false;
  let bytes = 0;
  const body = new Readable({
    read() {
      if (reading) return;
      reading = true;
      const pending = Promise.resolve().then(() => iterator.next()).then((chunk) => {
        reading = false;
        if (body.destroyed) return;
        if (chunk.done === true) {
          onEnd();
          if (contentLength !== undefined && bytes !== contentLength) throw invalidResource("truncated body");
          body.push(null);
          return;
        }
        if (!(chunk.value instanceof Uint8Array)) throw invalidResource("body chunk must be Uint8Array");
        bytes += chunk.value.byteLength;
        if (!Number.isSafeInteger(bytes) || (contentLength !== undefined && bytes > contentLength)) throw invalidResource("body exceeds contentLength");
        body.push(Buffer.from(chunk.value));
      }).catch((error: unknown) => { body.destroy(error instanceof Error ? error : invalidResource("body stream failed")); });
      track(pending);
    },
  });
  return body;
}

async function raceResourceAbort<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
  let onAbort: () => void = () => undefined;
  const cancelled = new Promise<never>((_resolve, reject) => {
    onAbort = () => { reject(abortError(signal)); };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([task, cancelled]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function snapshotContributions(
  contributions: readonly ServerPluginPairedBackendContribution[],
): readonly ServerPluginPairedBackendContribution[] {
  const sorted = [...contributions].sort((left, right) => left.pluginId.localeCompare(right.pluginId));
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index - 1]?.pluginId === sorted[index]?.pluginId) {
      throw new Error(`Duplicate paired plugin backend contribution: ${String(sorted[index]?.pluginId)}`);
    }
  }
  return Object.freeze(sorted);
}

function parsePluginId(value: string): string {
  if (!isPiWebPluginId(value)) {
    throw backendError("inactive-plugin", 409, `Server plugin is not active: ${value}`);
  }
  return value;
}

function parseOperation(value: string): string {
  try {
    return requirePluginBackendOperation(value);
  } catch (error) {
    throw backendError("invalid-operation", 400, boundedErrorMessage(error), error);
  }
}

function parseRevision(value: string, operation: string): string {
  try {
    return requirePluginBackendRevision(value);
  } catch (error) {
    throw backendError(
      "stale-plugin-revision",
      409,
      `Plugin backend revision is unavailable for operation ${operation}: ${boundedErrorMessage(error)}`,
      error,
    );
  }
}

function parseInput(value: unknown, pluginId: string, operation: string, suffix = "input"): JsonValue {
  try {
    return cloneBoundedPluginBackendJson(value, `Server plugin ${pluginId} operation ${operation} ${suffix}`);
  } catch (error) {
    throw backendError("invalid-input", 400, boundedErrorMessage(error), error);
  }
}

function snapshotProject(project: Project): ProjectInput {
  if (typeof project.id !== "string" || project.id === "") {
    throw backendError("invalid-scope", 500, "Project id must be a non-empty string");
  }
  if (typeof project.name !== "string" || project.name === "") {
    throw backendError("invalid-scope", 500, "Project name must be a non-empty string");
  }
  if (!isAbsolute(project.path)) {
    throw backendError("invalid-scope", 500, "Project path must be absolute");
  }
  return Object.freeze({ id: project.id, name: project.name, path: resolve(project.path) });
}

function snapshotWorkspace(workspace: WorkspaceListing, projectId: string): ServerPluginPeerWorkspace {
  if (workspace.id === "") throw new Error("Workspace id must be non-empty");
  if (workspace.projectId !== projectId) throw new Error("Workspace project scope does not match the resolved project");
  if (!isAbsolute(workspace.path)) throw new Error("Workspace path must be absolute");
  if (workspace.label === "") throw new Error("Workspace label must be non-empty");
  const provider = workspace.provider === undefined ? undefined : snapshotProvider(workspace.provider);
  return Object.freeze({
    id: workspace.id,
    projectId: workspace.projectId,
    path: resolve(workspace.path),
    label: workspace.label,
    isMain: workspace.isMain,
    ...(provider === undefined ? {} : { provider }),
  });
}

function snapshotProvider(provider: WorkspaceProviderMetadata): WorkspaceProviderMetadata {
  if (!isPiWebPluginId(provider.pluginId)) throw new Error("Workspace provider plugin id is invalid");
  const metadata = provider.metadata === undefined
    ? undefined
    : cloneJsonObject(provider.metadata, "Workspace provider public metadata");
  return Object.freeze({
    pluginId: provider.pluginId,
    capabilities: Object.freeze({ ...provider.capabilities }),
    ...(metadata === undefined ? {} : { metadata }),
  });
}

function cloneJsonObject(value: JsonObject, label: string): JsonObject {
  const cloned = cloneBoundedPluginBackendJson(value, label);
  if (!isJsonObject(cloned)) throw new Error(`${label} must be a JSON object`);
  return cloned;
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function waitForPromise<T>(operation: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { reject(new Error(`${label} timed out after ${String(timeoutMs)}ms`)); }, timeoutMs);
    timer.unref();
  });
  try {
    return await Promise.race([operation, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function runBoundedPluginBackendOperation<T>(
  pluginId: string,
  operation: string,
  timeoutMs: number,
  callback: (signal: AbortSignal) => T | Promise<T>,
  parentSignal?: AbortSignal,
  onCallbackStarted?: (callback: Promise<T>) => void,
): Promise<T> {
  const controller = new AbortController();
  const abortFromParent = (): void => {
    if (parentSignal !== undefined && !controller.signal.aborted) {
      controller.abort(abortError(parentSignal));
    }
  };
  if (parentSignal?.aborted === true) abortFromParent();
  else parentSignal?.addEventListener("abort", abortFromParent, { once: true });

  const timeoutError = new PluginBackendTimeoutError(
    `Server plugin ${pluginId} operation ${operation} timed out after ${String(timeoutMs)}ms`,
  );
  const timeout = setTimeout(() => { controller.abort(timeoutError); }, timeoutMs);
  timeout.unref();
  const deadline = controller.signal.aborted
    ? Promise.reject(abortError(controller.signal))
    : new Promise<never>((_resolve, rejectPromise) => {
        controller.signal.addEventListener("abort", () => { rejectPromise(abortError(controller.signal)); }, { once: true });
      });
  const result = controller.signal.aborted
    ? new Promise<T>(() => { /* An existing cancellation already won. */ })
    : Promise.resolve().then(() => callback(controller.signal));
  if (!controller.signal.aborted) onCallbackStarted?.(result);
  try {
    return await Promise.race([result, deadline]);
  } finally {
    clearTimeout(timeout);
    parentSignal?.removeEventListener("abort", abortFromParent);
    if (!controller.signal.aborted) {
      controller.abort(new DOMException("Plugin backend operation completed", "AbortError"));
    }
  }
}

function requestShutdownError(pluginId: string, cause?: unknown): PluginBackendRequestError {
  return backendError(
    "shutdown",
    503,
    `Server plugin ${pluginId} backend requests are shutting down`,
    cause,
  );
}

function backendError(
  code: ConstructorParameters<typeof PluginBackendRequestError>[0],
  statusCode: number,
  message: string,
  cause?: unknown,
): PluginBackendRequestError {
  return new PluginBackendRequestError(code, statusCode, message, cause === undefined ? {} : { cause });
}

function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new Error("Plugin backend operation aborted", { cause: reason });
}

function positiveInteger(value: number | undefined, fallback: number, key: string): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved <= 0) throw new Error(`${key} must be a positive integer`);
  return resolved;
}

function boundedErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length <= 2_048 ? message : `${message.slice(0, 2_045)}...`;
}

class PluginBackendTimeoutError extends Error {
  override name = "TimeoutError";
}
