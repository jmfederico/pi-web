import type {
  SafeTunnelConfigStatus,
  SafeTunnelDisableResponse,
  SafeTunnelEnableRequest,
  SafeTunnelEnableResponse,
  SafeTunnelOperationResponse,
  SafeTunnelRuntimeDiagnosticCode,
  SafeTunnelRuntimeStatus,
  SafeTunnelStatusResponse,
} from "../../shared/apiTypes.js";
import type {
  SafeTunnelEnableDefaults,
  SafeTunnelEnableDefaultsProvider,
} from "./safeTunnelEnableDefaults.js";
import {
  SafeTunnelOperationConflictError,
  type SafeTunnelRouteService,
} from "./safeTunnelRoutes.js";
import type { SafeTunnelReconciledFrpcRuntime } from "./safeTunnelRuntimeReconciler.js";
import type {
  SafeTunnelEnableInput,
  SafeTunnelLoginInput,
  SafeTunnelLoginObserver,
  SafeTunnelLoginOptions,
  SafeTunnelLoginResult,
} from "./safeTunnelService.js";
import type {
  LoadedSafeTunnelState,
  SafeTunnelPersistedState,
} from "./safeTunnelState.js";
import type { SafeTunnelFrpcStartResult } from "./safeTunnelFrpcSupervisor.js";

const maxBrowserIdentifierCharacters = 256;
const enableCancelledMessage = "Safe Tunnel enablement was cancelled.";
const enableFailedMessage = "Safe Tunnel enablement failed.";
const invalidStateMessage = "Unable to read PI WEB Safe Tunnel state.";

export interface SafeTunnelBridgeService extends SafeTunnelRouteService {
  shutdown(): Promise<void>;
  startup(): Promise<void>;
}

/** The narrow application-service surface used by the browser adapter. */
export interface SafeTunnelApplicationService {
  readonly statePath: string;
  disable(): Promise<SafeTunnelPersistedState>;
  enable(input?: SafeTunnelEnableInput): Promise<SafeTunnelPersistedState>;
  login(
    request: SafeTunnelLoginInput,
    observer?: SafeTunnelLoginObserver,
    options?: SafeTunnelLoginOptions,
  ): Promise<SafeTunnelLoginResult>;
  state(): Promise<LoadedSafeTunnelState>;
}

export interface SafeTunnelBridgeDependencies {
  readonly createOperationId: () => string;
  readonly enableDefaults: SafeTunnelEnableDefaultsProvider;
  readonly fileExists: (path: string) => boolean;
  readonly runtime: SafeTunnelReconciledFrpcRuntime;
  readonly safeTunnel: SafeTunnelApplicationService;
}

interface SafeTunnelOperationState {
  readonly id: string;
  readonly kind: "enable";
  phase: SafeTunnelOperationResponse["phase"];
  status: SafeTunnelOperationResponse["status"];
  error?: string;
  publicUrl?: string;
  userCode?: string;
  verificationUriComplete?: string;
}

interface ActiveEnableWorkflow {
  readonly controller: AbortController;
  readonly operation: SafeTunnelOperationState;
  readonly promise: Promise<void>;
}

/**
 * Orchestrates browser requests around durable state and reconciled frpc
 * supervision. Browser responses are assembled from this small allowlist;
 * provider bodies, generated configuration, and child output stay internal.
 */
export class DefaultSafeTunnelBridgeService implements SafeTunnelBridgeService {
  private activeOperation: SafeTunnelOperationState | undefined;
  private activeWorkflow: ActiveEnableWorkflow | undefined;
  private enableRequestController: AbortController | undefined;
  private operationStartInFlight = false;
  private lastOperation: SafeTunnelOperationState | undefined;

  constructor(private readonly dependencies: SafeTunnelBridgeDependencies) {}

  async registeredPublicOrigin(): Promise<string | undefined> {
    const loaded = await this.dependencies.safeTunnel.state();
    return loaded.state.machine?.publicUrl;
  }

  async status(): Promise<SafeTunnelStatusResponse> {
    const [runtime, ownedState] = await Promise.all([
      this.dependencies.runtime.status(),
      this.readOwnedStateStatus(),
    ]);
    const activeOperation = this.activeOperation === undefined
      ? undefined
      : snapshotOperation(this.activeOperation);
    return {
      config: ownedState.config,
      desiredState: ownedState.desiredState,
      runtime: browserRuntimeStatus(runtime),
      ...(activeOperation === undefined ? {} : { activeOperation }),
    };
  }

  async enable(request: SafeTunnelEnableRequest): Promise<SafeTunnelEnableResponse> {
    this.assertNoActiveOperation();
    this.operationStartInFlight = true;
    const controller = new AbortController();
    this.enableRequestController = controller;

    try {
      const [runtime, loadedState] = await Promise.all([
        this.dependencies.runtime.status(),
        this.dependencies.safeTunnel.state(),
      ]);
      throwIfEnableCancelled(controller.signal);
      if (runtime.state === "running") {
        throw new SafeTunnelOperationConflictError("already_enabled");
      }

      const advancedLocalPiWebUrl = request.advanced?.localPiWebUrl;
      const defaults = this.dependencies.enableDefaults(
        advancedLocalPiWebUrl === undefined
          ? undefined
          : { localPiWebUrl: advancedLocalPiWebUrl },
      );
      throwIfEnableCancelled(controller.signal);
      const initialStatus = statusFromLoadedState(runtime, loadedState);
      const operation = this.createOperation();
      const promise = Promise.resolve()
        .then(() => this.runEnableWorkflow(
          request,
          loadedState,
          runtime,
          defaults,
          operation,
          controller.signal,
        ))
        .then((result) => { finishEnableOperation(operation, result); })
        .catch(() => { this.failOperation(operation, controller.signal); })
        .finally(() => {
          const active = this.activeWorkflow;
          if (active?.operation.id === operation.id) this.activeWorkflow = undefined;
          this.clearActiveOperation(operation);
        });
      this.activeWorkflow = { controller, operation, promise };

      return {
        accepted: true,
        operation: snapshotOperation(operation),
        status: {
          ...initialStatus,
          activeOperation: snapshotOperation(operation),
        },
      };
    } finally {
      if (this.enableRequestController === controller) {
        this.enableRequestController = undefined;
      }
      this.operationStartInFlight = false;
    }
  }

  async disable(): Promise<SafeTunnelDisableResponse> {
    const workflow = this.cancelActiveEnablement();
    let disableError: Error | undefined;
    let stopError: Error | undefined;

    try {
      await this.dependencies.safeTunnel.disable();
    } catch (error: unknown) {
      disableError = asError(error);
    }

    try {
      await this.dependencies.runtime.stop();
    } catch (error: unknown) {
      stopError = asError(error);
    }

    await workflow?.promise.catch(() => undefined);
    if (disableError !== undefined) throw disableError;
    if (stopError !== undefined) throw stopError;
    return { status: await this.status() };
  }

  operation(operationId: string): SafeTunnelOperationResponse | undefined {
    const operation = this.lastOperation;
    return operation?.id === operationId ? snapshotOperation(operation) : undefined;
  }

  async shutdown(): Promise<void> {
    const workflow = this.cancelActiveEnablement();
    let shutdownError: Error | undefined;
    try {
      await this.dependencies.runtime.shutdown();
    } catch (error: unknown) {
      shutdownError = asError(error);
    }
    await workflow?.promise.catch(() => undefined);
    if (shutdownError !== undefined) throw shutdownError;
  }

  startup(): Promise<void> {
    return this.dependencies.runtime.startup();
  }

  private async runEnableWorkflow(
    request: SafeTunnelEnableRequest,
    loadedState: LoadedSafeTunnelState,
    runtime: SafeTunnelRuntimeStatus,
    defaults: SafeTunnelEnableDefaults,
    operation: SafeTunnelOperationState,
    signal: AbortSignal,
  ): Promise<SafeTunnelFrpcStartResult> {
    const advanced = request.advanced;
    const localPiWebUrl = defaults.localPiWebUrl;
    const registrationRequired = shouldRegisterMachine(
      loadedState,
      runtime,
      request,
    );

    if (registrationRequired) {
      const controlApiBaseUrl = advanced?.controlApiUrl
        ?? loadedState.state.machine?.controlApiBaseUrl
        ?? defaults.controlApiBaseUrl;
      await this.dependencies.safeTunnel.login({
        controlApiBaseUrl,
        machineName: advanced?.machineName ?? defaults.machineName,
        machineSlug: advanced?.machineSlug ?? defaults.machineSlug,
        localPiWebUrl,
        ...(advanced?.frpcPath === undefined ? {} : { frpcPath: advanced.frpcPath }),
      }, enableLoginObserver(operation), { signal });
      throwIfEnableCancelled(signal);
    }

    operation.phase = "starting";
    await this.dependencies.safeTunnel.enable({
      localPiWebUrl,
      ...(advanced?.frpcPath === undefined ? {} : { frpcPath: advanced.frpcPath }),
    });
    throwIfEnableCancelled(signal);

    const enabledState = await this.dependencies.safeTunnel.state();
    throwIfEnableCancelled(signal);
    const advancedFrpcPath = enabledState.state.frpcPath;
    return this.dependencies.runtime.start({
      ...(advancedFrpcPath === undefined ? {} : { advancedFrpcPath }),
    });
  }

  private assertNoActiveOperation(): void {
    // A cancelled workflow can still be joining its unabortable registration write.
    if (this.operationStartInFlight
      || this.activeWorkflow?.operation.status === "cancelled"
      || this.activeOperation?.status === "running") {
      throw new SafeTunnelOperationConflictError("operation_in_progress");
    }
  }

  private createOperation(): SafeTunnelOperationState {
    const operationId = this.dependencies.createOperationId();
    if (operationId.trim() === ""
      || operationId.length > maxBrowserIdentifierCharacters) {
      throw new Error("Safe Tunnel operation IDs must be non-empty.");
    }
    const operation: SafeTunnelOperationState = {
      id: operationId,
      kind: "enable",
      phase: "preparing",
      status: "running",
    };
    this.activeOperation = operation;
    this.lastOperation = operation;
    return operation;
  }

  private cancelActiveEnablement(): ActiveEnableWorkflow | undefined {
    this.enableRequestController?.abort();
    const workflow = this.activeWorkflow;
    if (workflow === undefined) return undefined;
    workflow.controller.abort();
    if (workflow.operation.status === "running") {
      workflow.operation.status = "cancelled";
      workflow.operation.error = enableCancelledMessage;
    }
    this.clearActiveOperation(workflow.operation);
    return workflow;
  }

  private failOperation(
    operation: SafeTunnelOperationState,
    signal: AbortSignal,
  ): void {
    if (operation.status === "cancelled") return;
    operation.status = signal.aborted ? "cancelled" : "failed";
    operation.error = signal.aborted ? enableCancelledMessage : enableFailedMessage;
    delete operation.userCode;
    delete operation.verificationUriComplete;
  }

  private clearActiveOperation(operation: SafeTunnelOperationState): void {
    if (this.activeOperation?.id === operation.id) this.activeOperation = undefined;
  }

  private async readOwnedStateStatus(): Promise<{
    readonly config: SafeTunnelConfigStatus;
    readonly desiredState: SafeTunnelStatusResponse["desiredState"];
  }> {
    try {
      return ownedStateStatus(await this.dependencies.safeTunnel.state());
    } catch {
      return {
        config: {
          exists: this.fileExistsSafely(this.dependencies.safeTunnel.statePath),
          state: "invalid",
          error: invalidStateMessage,
        },
        desiredState: "disabled",
      };
    }
  }

  private fileExistsSafely(path: string): boolean {
    try {
      return this.dependencies.fileExists(path);
    } catch {
      return false;
    }
  }
}

function shouldRegisterMachine(
  loaded: LoadedSafeTunnelState,
  runtime: SafeTunnelRuntimeStatus,
  request: SafeTunnelEnableRequest,
): boolean {
  const machine = loaded.state.machine;
  if (machine === undefined
    || machine.credentialStatus === "rejected"
    || machine.publicUrl === undefined) return true;
  if (runtime.diagnosticCode === "credentials_rejected") return true;
  const advanced = request.advanced;
  return advanced?.controlApiUrl !== undefined
    || advanced?.machineName !== undefined
    || advanced?.machineSlug !== undefined;
}

function enableLoginObserver(operation: SafeTunnelOperationState): SafeTunnelLoginObserver {
  return {
    onDeviceAuthorization(authorization) {
      if (operation.status !== "running") return;
      operation.phase = "awaiting_approval";
      operation.verificationUriComplete = authorization.verificationUriComplete;
      operation.userCode = authorization.userCode;
    },
    onAuthorizationApproved() {
      if (operation.status !== "running") return;
      operation.phase = "registering";
      delete operation.userCode;
      delete operation.verificationUriComplete;
    },
    onMachineRegistered() {
      if (operation.status === "running") operation.phase = "starting";
    },
  };
}

function finishEnableOperation(
  operation: SafeTunnelOperationState,
  result: SafeTunnelFrpcStartResult,
): void {
  if (operation.status === "cancelled") return;
  operation.phase = "enabled";
  operation.publicUrl = result.publicUrl;
  operation.status = "succeeded";
  delete operation.userCode;
  delete operation.verificationUriComplete;
}

function statusFromLoadedState(
  runtime: SafeTunnelRuntimeStatus,
  loaded: LoadedSafeTunnelState,
): SafeTunnelStatusResponse {
  const ownedState = ownedStateStatus(loaded);
  return {
    config: ownedState.config,
    desiredState: ownedState.desiredState,
    runtime: browserRuntimeStatus(runtime),
  };
}

function ownedStateStatus(
  loaded: LoadedSafeTunnelState,
): {
  readonly config: SafeTunnelConfigStatus;
  readonly desiredState: SafeTunnelStatusResponse["desiredState"];
} {
  const state = loaded.state;
  const machine = state.machine;
  return {
    config: {
      exists: loaded.exists,
      state: machine === undefined
        ? (loaded.exists ? "unregistered" : "missing")
        : machine.credentialStatus === "rejected"
          ? "rejected"
          : "registered",
      localPiWebUrl: state.localPiWebUrl,
      frpcPathConfigured: state.frpcPath !== undefined,
      ...(machine === undefined
        ? {}
        : {
            machine: {
              controlApiBaseUrl: machine.controlApiBaseUrl,
              machineId: machine.machineId,
              ...(machine.machineSlug === undefined ? {} : { machineSlug: machine.machineSlug }),
              ...(machine.publicUrl === undefined
                ? {}
                : {
                    publicHostname: new URL(machine.publicUrl).hostname,
                    publicUrl: machine.publicUrl,
                  }),
            },
          }),
    },
    desiredState: state.desiredState,
  };
}

function browserRuntimeStatus(runtime: SafeTunnelRuntimeStatus): SafeTunnelRuntimeStatus {
  const diagnosticCode = runtime.diagnosticCode
    ?? (runtime.error === undefined ? undefined : "runtime_failed");
  return {
    state: runtime.state,
    ...(diagnosticCode === undefined
      ? {}
      : {
          diagnosticCode,
          error: runtimeDiagnosticMessage(diagnosticCode),
        }),
  };
}

function runtimeDiagnosticMessage(code: SafeTunnelRuntimeDiagnosticCode): string {
  switch (code) {
    case "credentials_rejected":
      return "Safe Tunnel approval was rejected or revoked.";
    case "heartbeat_failed":
      return "Safe Tunnel heartbeat failed. PI WEB will try again at the next interval.";
    case "registration_required":
      return "Safe Tunnel needs approval before PI WEB can reconnect.";
    case "runtime_failed":
      return "Safe Tunnel runtime is unavailable.";
    case "state_invalid":
      return "PI WEB could not read Safe Tunnel state.";
  }
}

function snapshotOperation(operation: SafeTunnelOperationState): SafeTunnelOperationResponse {
  return {
    id: operation.id,
    kind: operation.kind,
    phase: operation.phase,
    status: operation.status,
    ...(operation.error === undefined ? {} : { error: operation.error }),
    ...(operation.publicUrl === undefined ? {} : { publicUrl: operation.publicUrl }),
    ...(operation.userCode === undefined ? {} : { userCode: operation.userCode }),
    ...(operation.verificationUriComplete === undefined
      ? {}
      : { verificationUriComplete: operation.verificationUriComplete }),
  };
}

function throwIfEnableCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new Error(enableCancelledMessage);
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error("Safe Tunnel operation failed.");
}
