import type { SafeTunnelRuntimeStatus } from "../../shared/apiTypes.js";
import { validateSafeTunnelFrpcConfig } from "./safeTunnelFrpcConfig.js";
import {
  SafeTunnelFrpcAcquisitionError,
  type SafeTunnelManagedFrpcProvider,
} from "./safeTunnelFrpcManager.js";
import type {
  SafeTunnelFrpcProcessExit,
  SafeTunnelFrpcProcessHandle,
  SafeTunnelFrpcProcessLauncher,
} from "./safeTunnelFrpcProcess.js";
import type { SafeTunnelFrpcRuntimeFiles } from "./safeTunnelFrpcRuntimeFiles.js";
import type { SafeTunnelPreparedTunnelConfig } from "./safeTunnelService.js";

const defaultStopGracePeriodMs = 5_000;
const defaultKillGracePeriodMs = 2_000;

export type SafeTunnelFrpcSupervisorErrorCode =
  | "already_running"
  | "config_write_failed"
  | "frpc_acquisition_failed"
  | "process_launch_failed"
  | "process_stop_failed"
  | "start_cancelled"
  | "supervisor_shutdown"
  | "tunnel_config_failed";

export class SafeTunnelFrpcSupervisorError extends Error {
  constructor(
    readonly code: SafeTunnelFrpcSupervisorErrorCode,
    readonly detailCode?: string,
  ) {
    super(safeTunnelFrpcSupervisorErrorMessage(code, detailCode));
    this.name = "SafeTunnelFrpcSupervisorError";
  }
}

export interface SafeTunnelScheduledTask {
  cancel(): void;
}

export interface SafeTunnelSupervisorClock {
  schedule(callback: () => void, delayMs: number): SafeTunnelScheduledTask;
}

export class NodeSafeTunnelSupervisorClock implements SafeTunnelSupervisorClock {
  schedule(callback: () => void, delayMs: number): SafeTunnelScheduledTask {
    let active = true;
    const timeout = setTimeout(() => {
      if (!active) return;
      active = false;
      callback();
    }, delayMs);
    return {
      cancel(): void {
        if (!active) return;
        active = false;
        clearTimeout(timeout);
      },
    };
  }
}

export interface SafeTunnelFrpcSupervisorPolicy {
  readonly killGracePeriodMs?: number;
  readonly stopGracePeriodMs?: number;
}

export interface SafeTunnelFrpcConfigProvider {
  getTunnelConfig(options?: {
    readonly signal?: AbortSignal;
  }): Promise<SafeTunnelPreparedTunnelConfig>;
}

export interface SafeTunnelFrpcStartInput {
  readonly advancedFrpcPath?: string;
}

export interface SafeTunnelFrpcStartResult {
  readonly publicUrl: string;
}

export interface SafeTunnelFrpcRuntime {
  shutdown(): Promise<void>;
  start(input: SafeTunnelFrpcStartInput): Promise<SafeTunnelFrpcStartResult>;
  status(): Promise<SafeTunnelRuntimeStatus>;
  stop(): Promise<void>;
}

export interface SafeTunnelFrpcSupervisorDependencies {
  readonly clock?: SafeTunnelSupervisorClock;
  readonly configProvider: SafeTunnelFrpcConfigProvider;
  readonly files: SafeTunnelFrpcRuntimeFiles;
  readonly launcher: SafeTunnelFrpcProcessLauncher;
  readonly managedFrpc: SafeTunnelManagedFrpcProvider;
  readonly policy?: SafeTunnelFrpcSupervisorPolicy;
}

type SupervisorPhase =
  | "running"
  | "shutdown"
  | "starting"
  | "stopped"
  | "stopping";

interface NormalizedSupervisorPolicy {
  readonly killGracePeriodMs: number;
  readonly stopGracePeriodMs: number;
}

interface OwnedFrpcProcess {
  readonly completion: Promise<void>;
  readonly handle: SafeTunnelFrpcProcessHandle;
  resolveCompletion: () => void;
  exit?: SafeTunnelFrpcProcessExit;
  closed: boolean;
  stopRequested: boolean;
}

/** Owns only the exact frpc child launched by this PI WEB process. */
export class SafeTunnelFrpcSupervisor implements SafeTunnelFrpcRuntime {
  private activeAttempt: Promise<SafeTunnelFrpcStartResult> | undefined;
  private activeAttemptAbortController: AbortController | undefined;
  private activeProcess: OwnedFrpcProcess | undefined;
  private readonly clock: SafeTunnelSupervisorClock;
  private disposed = false;
  private lastError: string | undefined;
  private phase: SupervisorPhase = "stopped";
  private readonly policy: NormalizedSupervisorPolicy;
  private shutdownInFlight: Promise<void> | undefined;
  private stopInFlight: Promise<void> | undefined;

  constructor(private readonly dependencies: SafeTunnelFrpcSupervisorDependencies) {
    this.clock = dependencies.clock ?? new NodeSafeTunnelSupervisorClock();
    this.policy = normalizePolicy(dependencies.policy);
  }

  start(input: SafeTunnelFrpcStartInput): Promise<SafeTunnelFrpcStartResult> {
    if (this.disposed) {
      return Promise.reject(new SafeTunnelFrpcSupervisorError("supervisor_shutdown"));
    }
    if (this.stopInFlight !== undefined
      || this.activeAttempt !== undefined
      || this.activeProcess !== undefined) {
      return Promise.reject(new SafeTunnelFrpcSupervisorError("already_running"));
    }

    this.lastError = undefined;
    this.phase = "starting";
    const controller = new AbortController();
    const attempt = this.performStart(input, controller);
    this.activeAttempt = attempt;
    this.activeAttemptAbortController = controller;
    const clear = (): void => {
      if (this.activeAttempt === attempt) this.activeAttempt = undefined;
      if (this.activeAttemptAbortController === controller) {
        this.activeAttemptAbortController = undefined;
      }
    };
    void attempt.then(clear, clear);
    return attempt;
  }

  stop(): Promise<void> {
    return this.stopRuntime();
  }

  shutdown(): Promise<void> {
    if (this.shutdownInFlight !== undefined) return this.shutdownInFlight;
    this.disposed = true;
    const shutdown = this.stopRuntime().then(() => {
      this.phase = "shutdown";
    });
    this.shutdownInFlight = shutdown;
    return shutdown;
  }

  status(): Promise<SafeTunnelRuntimeStatus> {
    return Promise.resolve({
      state: runtimeStateFor(this.phase, this.activeProcess !== undefined),
      ...(this.lastError === undefined ? {} : { error: this.lastError }),
    });
  }

  private async performStart(
    input: SafeTunnelFrpcStartInput,
    controller: AbortController,
  ): Promise<SafeTunnelFrpcStartResult> {
    let tunnelConfig: SafeTunnelPreparedTunnelConfig;
    try {
      tunnelConfig = await abortable(
        this.dependencies.configProvider.getTunnelConfig({ signal: controller.signal }),
        controller.signal,
      );
    } catch {
      if (controller.signal.aborted) throw new SafeTunnelFrpcSupervisorError("start_cancelled");
      throw this.failStart(new SafeTunnelFrpcSupervisorError("tunnel_config_failed"));
    }
    this.assertStartActive(controller);

    try {
      validateSafeTunnelFrpcConfig(
        tunnelConfig.frpcConfigToml,
        {
          trustedCaFile: this.dependencies.files.trustedCaPath,
          machineToken: tunnelConfig.machineToken,
        },
      );
    } catch {
      throw this.failStart(new SafeTunnelFrpcSupervisorError("tunnel_config_failed"));
    }

    let frpcPath = input.advancedFrpcPath;
    if (frpcPath === undefined) {
      try {
        const managedFrpc = await this.dependencies.managedFrpc.ensureManagedFrpc({
          signal: controller.signal,
        });
        frpcPath = managedFrpc.path;
      } catch (error: unknown) {
        if (controller.signal.aborted) {
          throw new SafeTunnelFrpcSupervisorError("start_cancelled");
        }
        const detailCode = error instanceof SafeTunnelFrpcAcquisitionError
          ? error.code
          : undefined;
        throw this.failStart(
          new SafeTunnelFrpcSupervisorError("frpc_acquisition_failed", detailCode),
        );
      }
    }
    this.assertStartActive(controller);

    try {
      await this.dependencies.files.writeConfig(tunnelConfig.frpcConfigToml);
    } catch {
      throw this.failStart(new SafeTunnelFrpcSupervisorError("config_write_failed"));
    }
    this.assertStartActive(controller);

    let earlyExit: SafeTunnelFrpcProcessExit | undefined;
    const ownership: { current?: OwnedFrpcProcess } = {};
    let handle: SafeTunnelFrpcProcessHandle;
    try {
      handle = this.dependencies.launcher.launch({
        configPath: this.dependencies.files.configPath,
        frpcPath,
      }, {
        onExit: (exit) => {
          if (ownership.current === undefined) earlyExit = exit;
          else this.handleProcessExit(ownership.current, exit);
        },
      });
    } catch {
      throw this.failStart(new SafeTunnelFrpcSupervisorError("process_launch_failed"));
    }

    const owned = createOwnedProcess(handle);
    ownership.current = owned;
    this.activeProcess = owned;

    if (earlyExit !== undefined) {
      this.handleProcessExit(owned, earlyExit);
      throw this.failStart(new SafeTunnelFrpcSupervisorError("process_launch_failed"));
    }

    try {
      await handle.started;
    } catch {
      if (controller.signal.aborted) {
        throw new SafeTunnelFrpcSupervisorError("start_cancelled");
      }
      throw this.failStart(new SafeTunnelFrpcSupervisorError("process_launch_failed"));
    }
    this.assertStartActive(controller);

    if (owned.closed || this.activeProcess !== owned) {
      throw this.failStart(new SafeTunnelFrpcSupervisorError("process_launch_failed"));
    }

    this.phase = "running";
    this.lastError = undefined;
    return { publicUrl: tunnelConfig.publicUrl };
  }

  private failStart(error: SafeTunnelFrpcSupervisorError): SafeTunnelFrpcSupervisorError {
    if (!this.disposed) this.phase = "stopped";
    this.lastError = error.message;
    return error;
  }

  private handleProcessExit(
    owned: OwnedFrpcProcess,
    exit: SafeTunnelFrpcProcessExit,
  ): void {
    if (this.activeProcess !== owned || owned.closed) return;
    owned.exit = exit;
    this.releaseClosedProcess(owned);

    if (owned.stopRequested) {
      this.phase = this.disposed ? "shutdown" : "stopped";
      this.lastError = undefined;
      return;
    }

    this.phase = this.disposed ? "shutdown" : "stopped";
    this.lastError = unexpectedExitError(exit).message;
  }

  private stopRuntime(): Promise<void> {
    if (this.stopInFlight !== undefined) return this.stopInFlight;

    this.activeAttemptAbortController?.abort();
    if (this.activeAttempt !== undefined || this.activeProcess !== undefined) {
      this.phase = "stopping";
    }
    const stopping = this.performStop();
    this.stopInFlight = stopping;
    void stopping.then(
      () => { if (this.stopInFlight === stopping) this.stopInFlight = undefined; },
      () => { if (this.stopInFlight === stopping) this.stopInFlight = undefined; },
    );
    return stopping;
  }

  private async performStop(): Promise<void> {
    await this.activeAttempt?.catch(() => undefined);

    const owned = this.activeProcess;
    let stopError: SafeTunnelFrpcSupervisorError | undefined;
    if (owned !== undefined) {
      owned.stopRequested = true;
      const terminateRequested = this.trySignalOwnedProcess(owned, "SIGTERM");

      let stopped = owned.closed;
      if (!stopped && terminateRequested) {
        stopped = await this.waitForOwnedProcess(owned, this.policy.stopGracePeriodMs);
      }
      if (!stopped) {
        this.trySignalOwnedProcess(owned, "SIGKILL");
        stopped = owned.closed;
        if (!stopped) {
          stopped = await this.waitForOwnedProcess(owned, this.policy.killGracePeriodMs);
        }
      }
      if (!stopped) {
        // Keep the exact handle owned so a replacement cannot be launched while
        // termination remains unconfirmed.
        stopError = new SafeTunnelFrpcSupervisorError("process_stop_failed");
      }
    }

    try {
      await this.dependencies.files.removeConfig();
    } catch {
      stopError ??= new SafeTunnelFrpcSupervisorError("config_write_failed");
    }

    if (this.activeProcess !== undefined) this.phase = "stopping";
    else this.phase = this.disposed ? "shutdown" : "stopped";
    this.lastError = stopError?.message;
    if (stopError !== undefined) throw stopError;
  }

  private trySignalOwnedProcess(
    owned: OwnedFrpcProcess,
    signal: NodeJS.Signals,
  ): boolean {
    try {
      return owned.handle.terminate(signal);
    } catch {
      return false;
    }
  }

  private waitForOwnedProcess(
    owned: OwnedFrpcProcess,
    timeoutMs: number,
  ): Promise<boolean> {
    if (owned.closed) return Promise.resolve(true);
    return new Promise((resolve) => {
      let settled = false;
      const timeout = this.clock.schedule(() => {
        if (settled) return;
        settled = true;
        resolve(false);
      }, timeoutMs);
      void owned.completion.then(() => {
        if (settled) return;
        settled = true;
        timeout.cancel();
        resolve(true);
      });
    });
  }

  private releaseClosedProcess(owned: OwnedFrpcProcess): void {
    if (owned.closed) return;
    owned.closed = true;
    owned.handle.dispose();
    if (this.activeProcess === owned) this.activeProcess = undefined;
    owned.resolveCompletion();
  }

  private assertStartActive(controller: AbortController): void {
    if (controller.signal.aborted
      || this.disposed
      || this.activeAttemptAbortController !== controller) {
      throw new SafeTunnelFrpcSupervisorError("start_cancelled");
    }
  }
}

function createOwnedProcess(handle: SafeTunnelFrpcProcessHandle): OwnedFrpcProcess {
  let resolveCompletion = (): void => undefined;
  const completion = new Promise<void>((resolve) => { resolveCompletion = resolve; });
  return {
    completion,
    handle,
    resolveCompletion,
    closed: false,
    stopRequested: false,
  };
}

function normalizePolicy(
  policy: SafeTunnelFrpcSupervisorPolicy = {},
): NormalizedSupervisorPolicy {
  return {
    killGracePeriodMs: positiveInteger(
      policy.killGracePeriodMs ?? defaultKillGracePeriodMs,
      "killGracePeriodMs",
    ),
    stopGracePeriodMs: positiveInteger(
      policy.stopGracePeriodMs ?? defaultStopGracePeriodMs,
      "stopGracePeriodMs",
    ),
  };
}

function runtimeStateFor(
  phase: SupervisorPhase,
  hasActiveProcess: boolean,
): SafeTunnelRuntimeStatus["state"] {
  if (phase === "running" || (phase === "stopping" && hasActiveProcess)) return "running";
  if (phase === "starting") return "unknown";
  return "stopped";
}

function unexpectedExitError(exit: SafeTunnelFrpcProcessExit): Error {
  if (exit.kind === "error") return new Error("The owned frpc process failed.");
  if (exit.signal !== null) {
    return new Error(`The owned frpc process exited unexpectedly after ${exit.signal}.`);
  }
  return new Error(
    `The owned frpc process exited unexpectedly with code ${exit.exitCode?.toString() ?? "unknown"}.`,
  );
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(new SafeTunnelFrpcSupervisorError("start_cancelled"));
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (complete: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      complete();
    };
    const onAbort = (): void => {
      finish(() => { reject(new SafeTunnelFrpcSupervisorError("start_cancelled")); });
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void operation.then(
      (value) => { finish(() => { resolve(value); }); },
      (error: unknown) => {
        finish(() => {
          reject(error instanceof Error ? error : new Error("Unexpected asynchronous failure."));
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

function safeTunnelFrpcSupervisorErrorMessage(
  code: SafeTunnelFrpcSupervisorErrorCode,
  detailCode: string | undefined,
): string {
  switch (code) {
    case "already_running":
      return "Safe Tunnel frpc supervision is already active.";
    case "config_write_failed":
      return "PI WEB could not write the private Safe Tunnel frpc configuration.";
    case "frpc_acquisition_failed":
      return detailCode === undefined
        ? "PI WEB could not prepare a verified Safe Tunnel frpc executable."
        : `PI WEB could not prepare a verified Safe Tunnel frpc executable (${detailCode}).`;
    case "process_launch_failed":
      return "PI WEB could not launch the Safe Tunnel frpc process.";
    case "process_stop_failed":
      return "PI WEB could not confirm that its owned Safe Tunnel frpc process stopped.";
    case "start_cancelled":
      return "Safe Tunnel frpc start was cancelled.";
    case "supervisor_shutdown":
      return "Safe Tunnel frpc supervision has shut down.";
    case "tunnel_config_failed":
      return "PI WEB could not prepare Safe Tunnel configuration.";
  }
}
