import { isAbsolute, resolve } from "node:path";
import type {
  JsonObject,
  JsonValue,
  PairedPluginChannel,
  PairedPluginChannelOpenContext,
  PairedPluginRequestContext,
  PairedPluginWorkspace,
  ProjectInput,
  WorkspaceProviderMetadata,
} from "../../server-plugin-api.js";
import { isPiWebPluginId } from "../../shared/pluginIds.js";
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
import {
  PluginBackendRequestError,
  type PluginBackendRequest,
  type WorkspaceProviderRegistry,
} from "../workspaces/workspaceProviderRegistry.js";

export interface PluginBackendRegistryOptions {
  /** Healthy direct contributions from one immutable server-plugin snapshot. */
  contributions: readonly ServerPluginPairedBackendContribution[];
  /** Authoritative workspace resolver and legacy owner-backed request fallback. */
  workspaces: Pick<WorkspaceProviderRegistry, "resolve" | "request">;
  callbackTimeoutMs?: number;
  dispatchTimeoutMs?: number;
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
  readonly workspaceId: string;
  receive(data: unknown): Promise<void>;
  close(code?: number, reason?: string): Promise<void>;
}

export interface PluginBackendChannelAdmissionRequest {
  readonly pluginId: string;
  readonly projectId: string;
  readonly workspaceId: string;
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

/**
 * Dispatches a browser plugin only to its revision-matched server entry. Direct
 * paired backends may address any host-resolved workspace; older provider
 * backends retain their owner-only behavior through the explicit fallback.
 */
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
  private channelAdmissionCount = 0;
  private channelShutdown = false;
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
    this.channelCallbackTimeoutMs = positiveInteger(options.channelCallbackTimeoutMs, PLUGIN_BACKEND_CHANNEL_CALLBACK_TIMEOUT_MS, "channelCallbackTimeoutMs");
    this.channelOpenTimeoutMs = positiveInteger(options.channelOpenTimeoutMs, PLUGIN_BACKEND_CHANNEL_OPEN_TIMEOUT_MS, "channelOpenTimeoutMs");
    this.channelLifetimeMs = positiveInteger(options.channelLifetimeMs, PLUGIN_BACKEND_CHANNEL_MAX_LIFETIME_MS, "channelLifetimeMs");
    this.channelMaxTotal = positiveInteger(options.channelMaxTotal, PLUGIN_BACKEND_CHANNEL_MAX_TOTAL, "channelMaxTotal");
    this.channelMaxPerPlugin = positiveInteger(options.channelMaxPerPlugin, PLUGIN_BACKEND_CHANNEL_MAX_PER_PLUGIN, "channelMaxPerPlugin");
    this.channelMaxPerPluginWorkspace = positiveInteger(options.channelMaxPerPluginWorkspace, PLUGIN_BACKEND_CHANNEL_MAX_PER_PLUGIN_WORKSPACE, "channelMaxPerPluginWorkspace");
  }

  async request(request: PluginBackendRequest, signal?: AbortSignal): Promise<JsonValue> {
    try {
      return await runBoundedPluginBackendOperation(
        request.pluginId,
        "dispatch",
        this.dispatchTimeoutMs,
        (dispatchSignal) => this.dispatch(request, dispatchSignal),
        signal,
      );
    } catch (error) {
      if (signal?.aborted === true) {
        throw backendError(
          "request-cancelled",
          499,
          `Server plugin ${request.pluginId} backend request was cancelled`,
          error,
        );
      }
      if (error instanceof PluginBackendTimeoutError) {
        throw backendError("request-timeout", 504, boundedErrorMessage(error), error);
      }
      throw error;
    }
  }

  reserveChannel(request: PluginBackendChannelAdmissionRequest): PluginBackendChannelAdmission {
    if (this.channelsAreShuttingDown()) throw channelError("shutdown", 1012, "Plugin backend channels are shutting down");
    if (!isPiWebPluginId(request.pluginId)) throw channelError("inactive-plugin", 1008, `Server plugin is not active: ${request.pluginId}`);
    if (request.projectId === "" || request.workspaceId === "") {
      throw channelError("workspace-not-found", 1008, `Workspace not found for server plugin ${request.pluginId} channel`);
    }
    const pluginCount = this.channelsByPlugin.get(request.pluginId) ?? 0;
    const scopeKey = channelScopeKey(request.pluginId, request.projectId, request.workspaceId);
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

    const admission = reservedAdmission === undefined
      ? this.reserveChannel({ pluginId, projectId: request.project.id, workspaceId: request.workspaceId })
      : requireManagedChannelAdmission(reservedAdmission, { pluginId, projectId: request.project.id, workspaceId: request.workspaceId });
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
    let openingChannel: Promise<PairedPluginChannel> | undefined;
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
          const { project, workspace } = await resolveDirectScope(this.options.workspaces, request, pluginId, operation, openSignal);
          const context: PairedPluginChannelOpenContext = Object.freeze({
            project,
            workspace,
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
      finishOpeningTask();
      if (!lifetimeController.signal.aborted) lifetimeController.abort(error);
      // A route-provided reservation remains tied to its physical socket; the
      // route releases it only after attributed teardown completes.
      if (reservedAdmission === undefined) releaseAdmission();
      if (openingChannel !== undefined) {
        void openingChannel.then(async (channel) => {
          await closeUnpublishedChannel(channel, pluginId, operation, this.channelCallbackTimeoutMs);
        }).catch((cleanupError: unknown) => {
          this.options.logger?.error({ err: cleanupError, pluginId, operation }, "unpublished plugin backend channel cleanup failed");
        });
      }
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

  async closeAll(reason = "Session daemon shutdown"): Promise<void> {
    this.channelShutdown = true;
    const admissions = [...this.channelAdmissions];
    for (const admission of admissions) admission.abort(reason);
    for (const controller of this.openingChannelControllers) {
      if (!controller.signal.aborted) controller.abort(new DOMException(reason, "AbortError"));
    }
    await Promise.allSettled([...this.openingChannelTasks]);
    const channels = [...this.channels];
    const results = await Promise.allSettled(channels.map(async (channel) => {
      await channel.fail("shutdown", reason, 1012);
    }));
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
    return this.channelShutdown;
  }

  private async dispatch(request: PluginBackendRequest, dispatchSignal: AbortSignal): Promise<JsonValue> {
    const pluginId = parsePluginId(request.pluginId);
    const operation = parseOperation(request.operation);
    const moduleRevision = parseRevision(request.moduleRevision, operation);
    const input = parseInput(request.input, pluginId, operation);
    const contribution = this.contributions.find((candidate) => candidate.pluginId === pluginId);

    if (contribution === undefined) {
      return await this.options.workspaces.request({
        ...request,
        pluginId,
        moduleRevision,
        operation,
        input,
      }, dispatchSignal);
    }
    if (contribution.moduleRevision !== moduleRevision) {
      throw backendError(
        "stale-plugin-revision",
        409,
        `Server plugin ${pluginId} backend revision is stale for operation ${operation}; reload after the session daemon restarts`,
      );
    }
    if (request.workspaceId === "") {
      throw backendError(
        "workspace-not-found",
        404,
        `Workspace not found for server plugin ${pluginId} operation ${operation}`,
      );
    }

    const project = snapshotProject(request.project);
    let target: WorkspaceListing | undefined;
    try {
      const resolution = await this.options.workspaces.resolve(request.project, dispatchSignal);
      target = resolution.workspaces.find((workspace) => workspace.id === request.workspaceId);
    } catch (error) {
      if (dispatchSignal.aborted) throw abortError(dispatchSignal);
      throw backendError(
        "resolution-failed",
        502,
        `Server plugin ${pluginId} could not resolve workspace scope for operation ${operation}: ${boundedErrorMessage(error)}`,
        error,
      );
    }
    if (target === undefined) {
      throw backendError(
        "workspace-not-found",
        404,
        `Workspace ${request.workspaceId} is stale or unavailable for server plugin ${pluginId} operation ${operation}`,
      );
    }

    let workspace: PairedPluginWorkspace;
    try {
      workspace = snapshotWorkspace(target, project.id);
    } catch (error) {
      throw backendError(
        "invalid-scope",
        502,
        `Server plugin ${pluginId} received an invalid host workspace scope for operation ${operation}: ${boundedErrorMessage(error)}`,
        error,
      );
    }
    const context: PairedPluginRequestContext = Object.freeze({
      project,
      workspace,
      operation,
      input,
      signal: dispatchSignal,
    });
    let result: unknown;
    try {
      result = await runBoundedPluginBackendOperation(
        pluginId,
        operation,
        this.callbackTimeoutMs,
        (callbackSignal) => contribution.backend.request(Object.freeze({ ...context, signal: callbackSignal })),
        dispatchSignal,
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
    || admission.request.workspaceId !== expected.workspaceId) {
    throw channelError("admission-denied", 1013, `Server plugin ${expected.pluginId} channel admission reservation is invalid`);
  }
  if (admission.signal.aborted) {
    throw channelError("shutdown", 1012, `Server plugin ${expected.pluginId} channel admission was cancelled`);
  }
  return admission;
}

interface ManagedPluginBackendChannelOptions {
  pluginId: string;
  workspaceId: string;
  operation: string;
  channel: PairedPluginChannel;
  transport: PluginBackendChannelTransport;
  lifetimeController: AbortController;
  callbackTimeoutMs: number;
  lifetimeMs: number;
  onReleased: (channel: ManagedPluginBackendChannel) => void;
  onCleanupFailure: (error: unknown) => void;
}

class ManagedPluginBackendChannel implements PluginBackendChannelSession {
  readonly pluginId: string;
  readonly workspaceId: string;
  private readonly lifetimeTimer: ReturnType<typeof setTimeout>;
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
    try {
      const close = this.options.channel.close?.bind(this.options.channel);
      if (close !== undefined) {
        await runBoundedPluginBackendOperation(
          this.pluginId,
          `channel ${this.options.operation} close`,
          this.options.callbackTimeoutMs,
          (signal) => close(Object.freeze({ code, reason, signal })),
        );
      }
    } catch (error) {
      this.options.onCleanupFailure(error);
      throw channelError(
        "close-failed",
        1011,
        `Server plugin ${this.pluginId} channel ${this.options.operation} close failed: ${boundedErrorMessage(error)}`,
        error,
      );
    } finally {
      this.options.onReleased(this);
    }
  }
}

async function closeUnpublishedChannel(
  channel: PairedPluginChannel,
  pluginId: string,
  operation: string,
  callbackTimeoutMs: number,
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
  );
}

async function resolveDirectScope(
  workspaces: Pick<WorkspaceProviderRegistry, "resolve">,
  request: PluginBackendRequest,
  pluginId: string,
  operation: string,
  signal: AbortSignal,
): Promise<{ project: ProjectInput; workspace: PairedPluginWorkspace }> {
  if (request.workspaceId === "") {
    throw channelError("workspace-not-found", 1008, `Workspace not found for server plugin ${pluginId} channel ${operation}`);
  }
  let project: ProjectInput;
  try {
    project = snapshotProject(request.project);
  } catch (error) {
    throw channelError("invalid-scope", 1011, boundedErrorMessage(error), error);
  }
  let target: WorkspaceListing | undefined;
  try {
    const resolution = await workspaces.resolve(request.project, signal);
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
      `Workspace ${request.workspaceId} is stale or unavailable for server plugin ${pluginId} channel ${operation}`,
    );
  }
  try {
    return { project, workspace: snapshotWorkspace(target, project.id) };
  } catch (error) {
    throw channelError(
      "invalid-scope",
      1011,
      `Server plugin ${pluginId} received an invalid host workspace scope for channel ${operation}: ${boundedErrorMessage(error)}`,
      error,
    );
  }
}

function channelScopeKey(pluginId: string, projectId: string, workspaceId: string): string {
  return `${pluginId}\u0000${projectId}\u0000${workspaceId}`;
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

function snapshotWorkspace(workspace: WorkspaceListing, projectId: string): PairedPluginWorkspace {
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
