import type { SafeTunnelRuntimeStatus } from "../../shared/apiTypes.js";
import {
  SafeTunnelControlPlaneError,
  type SafeTunnelHeartbeatTunnelStatus,
  type SafeTunnelMachineHeartbeat,
} from "./safeTunnelControlPlane.js";
import {
  SafeTunnelFrpcSupervisorError,
  type SafeTunnelFrpcRuntime,
  type SafeTunnelFrpcStartInput,
  type SafeTunnelFrpcStartResult,
  type SafeTunnelScheduledTask,
  type SafeTunnelSupervisorClock,
} from "./safeTunnelFrpcSupervisor.js";
import { SafeTunnelServiceError } from "./safeTunnelService.js";
import type { LoadedSafeTunnelState } from "./safeTunnelState.js";

const defaultMinimumHeartbeatIntervalMs = 5_000;
const defaultMaximumHeartbeatIntervalMs = 300_000;
const runtimeUnavailableMessage = "PI WEB Safe Tunnel runtime is unavailable.";
const registrationRequiredMessage = "Safe Tunnel is enabled but its machine registration is missing. Enable Safe Tunnel to approve this PI WEB.";
const credentialsRejectedMessage = "Safe Tunnel access for this PI WEB was rejected or revoked. Enable Safe Tunnel to approve it again.";
const heartbeatFailedMessage = "Safe Tunnel heartbeat failed. PI WEB will try again at the next heartbeat interval.";
const runtimeFailedMessage = "PI WEB could not start or stop the Safe Tunnel runtime.";
const stateInvalidMessage = "PI WEB could not read persisted Safe Tunnel intent.";

export interface SafeTunnelRuntimeReconciliationService {
  recordHeartbeat(
    input: {
      readonly tunnelStatus: SafeTunnelHeartbeatTunnelStatus;
      readonly errorMessage?: string;
    },
    options?: { readonly signal?: AbortSignal },
  ): Promise<SafeTunnelMachineHeartbeat>;
  state(): Promise<LoadedSafeTunnelState>;
}

export interface SafeTunnelReconciledFrpcRuntime extends SafeTunnelFrpcRuntime {
  startup(): Promise<void>;
}

export interface SafeTunnelRuntimeReconcilerPolicy {
  readonly maximumHeartbeatIntervalMs?: number;
  readonly minimumHeartbeatIntervalMs?: number;
}

export interface SafeTunnelRuntimeReconcilerDependencies {
  readonly clock: SafeTunnelSupervisorClock;
  readonly runtime: SafeTunnelFrpcRuntime;
  readonly safeTunnel: SafeTunnelRuntimeReconciliationService;
  readonly policy?: SafeTunnelRuntimeReconcilerPolicy;
}

interface NormalizedSafeTunnelRuntimeReconcilerPolicy {
  readonly maximumHeartbeatIntervalMs: number;
  readonly minimumHeartbeatIntervalMs: number;
}

interface SafeTunnelLifecycleDiagnostic {
  readonly code: NonNullable<SafeTunnelRuntimeStatus["diagnosticCode"]>;
  readonly message: string;
}

/** Restores durable intent and owns the single periodic heartbeat schedule. */
export class SafeTunnelRuntimeReconciler implements SafeTunnelReconciledFrpcRuntime {
  private active = false;
  private disposed = false;
  private generation = 0;
  private heartbeatAbortController: AbortController | undefined;
  private heartbeatInFlight: Promise<void> | undefined;
  private heartbeatTask: SafeTunnelScheduledTask | undefined;
  private lifecycleDiagnostic: SafeTunnelLifecycleDiagnostic | undefined;
  private readonly policy: NormalizedSafeTunnelRuntimeReconcilerPolicy;
  private shutdownInFlight: Promise<void> | undefined;
  private startupInFlight: Promise<void> | undefined;

  constructor(private readonly dependencies: SafeTunnelRuntimeReconcilerDependencies) {
    this.policy = normalizePolicy(dependencies.policy);
  }

  startup(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    this.startupInFlight ??= this.restoreIntent();
    return this.startupInFlight;
  }

  async start(input: SafeTunnelFrpcStartInput): Promise<SafeTunnelFrpcStartResult> {
    if (this.disposed) throw new SafeTunnelFrpcSupervisorError("supervisor_shutdown");
    const generation = this.beginHeartbeatSession(true);
    await this.waitForHeartbeat();
    if (!this.isHeartbeatCurrent(generation)) {
      throw new SafeTunnelFrpcSupervisorError("start_cancelled");
    }

    this.lifecycleDiagnostic = undefined;
    const starting = this.dependencies.runtime.start(input);
    this.scheduleHeartbeat(generation, 0);
    try {
      return await starting;
    } catch (error: unknown) {
      if (this.isHeartbeatCurrent(generation)) {
        this.setLifecycleDiagnostic("runtime_failed", runtimeFailedMessage);
      }
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.beginHeartbeatSession(false);
    await this.waitForHeartbeat();
    this.lifecycleDiagnostic = undefined;
    await this.dependencies.runtime.stop();
  }

  shutdown(): Promise<void> {
    if (this.shutdownInFlight !== undefined) return this.shutdownInFlight;
    this.disposed = true;
    this.beginHeartbeatSession(false);
    const shutdown = this.waitForHeartbeat().then(() => this.dependencies.runtime.shutdown());
    this.shutdownInFlight = shutdown;
    return shutdown;
  }

  async status(): Promise<SafeTunnelRuntimeStatus> {
    const status = await this.dependencies.runtime.status();
    const diagnostic = this.lifecycleDiagnostic;
    if (diagnostic === undefined) return status;
    return {
      state: status.state,
      diagnosticCode: diagnostic.code,
      error: diagnostic.message,
    };
  }

  private async restoreIntent(): Promise<void> {
    let loaded: LoadedSafeTunnelState;
    try {
      loaded = await this.dependencies.safeTunnel.state();
    } catch {
      if (!this.disposed) this.setLifecycleDiagnostic("state_invalid", stateInvalidMessage);
      return;
    }
    if (this.disposed || loaded.state.desiredState === "disabled") return;

    const machine = loaded.state.machine;
    if (machine === undefined) {
      this.setLifecycleDiagnostic("registration_required", registrationRequiredMessage);
      return;
    }
    if (machine.credentialStatus === "rejected") {
      this.setLifecycleDiagnostic("credentials_rejected", credentialsRejectedMessage);
      return;
    }

    const input: SafeTunnelFrpcStartInput = {
      ...(loaded.state.frpcPath === undefined
        ? {}
        : { advancedFrpcPath: loaded.state.frpcPath }),
    };
    void this.start(input).catch(() => undefined);
  }

  private scheduleHeartbeat(generation: number, delayMs: number): void {
    if (!this.isHeartbeatCurrent(generation)) return;
    this.cancelHeartbeatTask();
    this.heartbeatTask = this.dependencies.clock.schedule(() => {
      this.heartbeatTask = undefined;
      if (!this.isHeartbeatCurrent(generation)) return;
      this.beginHeartbeat(generation);
    }, delayMs);
  }

  private beginHeartbeat(generation: number): void {
    const controller = new AbortController();
    this.heartbeatAbortController = controller;
    const heartbeat = this.runHeartbeat(generation, controller);
    this.heartbeatInFlight = heartbeat;
    void heartbeat.finally(() => {
      if (this.heartbeatInFlight === heartbeat) this.heartbeatInFlight = undefined;
      if (this.heartbeatAbortController === controller) {
        this.heartbeatAbortController = undefined;
      }
    });
  }

  private async runHeartbeat(
    generation: number,
    controller: AbortController,
  ): Promise<void> {
    try {
      const heartbeat = await this.sendHeartbeat(controller.signal);
      if (!this.isHeartbeatCurrent(generation)) return;
      if (this.lifecycleDiagnostic?.code === "heartbeat_failed") {
        this.lifecycleDiagnostic = undefined;
      }
      this.scheduleHeartbeat(
        generation,
        normalizeHeartbeatInterval(heartbeat.nextHeartbeatSeconds, this.policy),
      );
    } catch (error: unknown) {
      if (!this.isHeartbeatCurrent(generation)) return;
      if (isAuthenticationFailure(error)) {
        this.active = false;
        this.cancelHeartbeatTask();
        this.setLifecycleDiagnostic("credentials_rejected", credentialsRejectedMessage);
        try {
          await this.dependencies.runtime.stop();
        } catch {
          this.setLifecycleDiagnostic("runtime_failed", runtimeFailedMessage);
        }
        return;
      }
      this.setLifecycleDiagnostic("heartbeat_failed", heartbeatFailedMessage);
      this.scheduleHeartbeat(generation, this.policy.minimumHeartbeatIntervalMs);
    }
  }

  private async sendHeartbeat(signal: AbortSignal): Promise<SafeTunnelMachineHeartbeat> {
    const runtime = await abortable(this.dependencies.runtime.status(), signal);
    return abortable(
      this.dependencies.safeTunnel.recordHeartbeat(heartbeatInput(runtime), { signal }),
      signal,
    );
  }

  private beginHeartbeatSession(active: boolean): number {
    this.generation += 1;
    this.active = active;
    this.cancelHeartbeatTask();
    this.heartbeatAbortController?.abort();
    this.heartbeatAbortController = undefined;
    return this.generation;
  }

  private cancelHeartbeatTask(): void {
    this.heartbeatTask?.cancel();
    this.heartbeatTask = undefined;
  }

  private waitForHeartbeat(): Promise<void> {
    return this.heartbeatInFlight ?? Promise.resolve();
  }

  private isHeartbeatCurrent(generation: number): boolean {
    return this.active && !this.disposed && this.generation === generation;
  }

  private setLifecycleDiagnostic(
    code: NonNullable<SafeTunnelRuntimeStatus["diagnosticCode"]>,
    message: string,
  ): void {
    this.lifecycleDiagnostic = { code, message };
  }
}

function heartbeatInput(runtime: SafeTunnelRuntimeStatus): {
  readonly tunnelStatus: SafeTunnelHeartbeatTunnelStatus;
  readonly errorMessage?: string;
} {
  switch (runtime.state) {
    case "running":
      return { tunnelStatus: "running" };
    case "unknown":
      return runtime.error === undefined
        ? { tunnelStatus: "starting" }
        : { tunnelStatus: "error", errorMessage: runtimeUnavailableMessage };
    case "stopped":
      return { tunnelStatus: "error", errorMessage: runtimeUnavailableMessage };
  }
}

function normalizePolicy(
  policy: SafeTunnelRuntimeReconcilerPolicy = {},
): NormalizedSafeTunnelRuntimeReconcilerPolicy {
  const normalized = {
    maximumHeartbeatIntervalMs: positiveInteger(
      policy.maximumHeartbeatIntervalMs ?? defaultMaximumHeartbeatIntervalMs,
      "maximumHeartbeatIntervalMs",
    ),
    minimumHeartbeatIntervalMs: positiveInteger(
      policy.minimumHeartbeatIntervalMs ?? defaultMinimumHeartbeatIntervalMs,
      "minimumHeartbeatIntervalMs",
    ),
  };
  if (normalized.maximumHeartbeatIntervalMs < normalized.minimumHeartbeatIntervalMs) {
    throw new Error("maximumHeartbeatIntervalMs must not be shorter than minimumHeartbeatIntervalMs.");
  }
  return normalized;
}

function normalizeHeartbeatInterval(
  seconds: number,
  policy: NormalizedSafeTunnelRuntimeReconcilerPolicy,
): number {
  const maximumSeconds = Math.floor(policy.maximumHeartbeatIntervalMs / 1_000);
  const boundedSeconds = Math.min(seconds, Math.max(1, maximumSeconds));
  return Math.min(
    policy.maximumHeartbeatIntervalMs,
    Math.max(policy.minimumHeartbeatIntervalMs, boundedSeconds * 1_000),
  );
}

function isAuthenticationFailure(error: unknown): boolean {
  if (error instanceof SafeTunnelControlPlaneError) {
    return error.code === "authentication_failed";
  }
  return error instanceof SafeTunnelServiceError
    && error.code === "credentials_rejected";
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error("Safe Tunnel operation cancelled."));
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (complete: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      complete();
    };
    const onAbort = (): void => {
      finish(() => { reject(new Error("Safe Tunnel operation cancelled.")); });
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void operation.then(
      (value) => { finish(() => { resolve(value); }); },
      (error: unknown) => {
        finish(() => {
          reject(error instanceof Error ? error : new Error("Unexpected Safe Tunnel failure."));
        });
      },
    );
  });
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}
