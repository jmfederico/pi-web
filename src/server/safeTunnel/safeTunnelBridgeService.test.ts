import { describe, expect, it, vi } from "vitest";
import type { SafeTunnelRuntimeStatus } from "../../shared/apiTypes.js";
import { SafeTunnelAccountAccessError } from "./safeTunnelAccountAccess.js";
import {
  DefaultSafeTunnelBridgeService,
  type SafeTunnelApplicationService,
  type SafeTunnelBridgeDependencies,
} from "./safeTunnelBridgeService.js";
import {
  createNodeSafeTunnelEnableDefaultsProvider,
  defaultSafeTunnelControlApiBaseUrl,
  type SafeTunnelEnableDefaults,
} from "./safeTunnelEnableDefaults.js";
import type { SafeTunnelReconciledFrpcRuntime } from "./safeTunnelRuntimeReconciler.js";
import type {
  SafeTunnelEnableInput,
  SafeTunnelLoginInput,
  SafeTunnelLoginObserver,
  SafeTunnelLoginOptions,
  SafeTunnelLoginResult,
} from "./safeTunnelService.js";
import {
  createDefaultSafeTunnelState,
  type LoadedSafeTunnelState,
  type SafeTunnelPersistedState,
} from "./safeTunnelState.js";
import type {
  SafeTunnelFrpcStartResult,
} from "./safeTunnelFrpcSupervisor.js";

const machineToken = "piwt_mtok_v1_private_machine_token";
const publicUrl = "https://machine.example.test";
const defaults: SafeTunnelEnableDefaults = {
  controlApiBaseUrl: defaultSafeTunnelControlApiBaseUrl,
  localPiWebUrl: "http://127.0.0.1:8504",
  machineName: "Test machine",
  machineSlug: "test-machine",
};
const registeredState: SafeTunnelPersistedState = {
  ...createDefaultSafeTunnelState(),
  controlApiUrl: defaults.controlApiBaseUrl,
  machine: {
    controlApiBaseUrl: defaults.controlApiBaseUrl,
    credentialStatus: "active",
    machineId: "machine_123",
    machineToken,
    machineSlug: defaults.machineSlug,
    publicUrl,
  },
};

describe("DefaultSafeTunnelBridgeService", () => {
  it("returns only allowlisted PI WEB status when internal diagnostics contain credentials", async () => {
    const fixture = createFixture(registeredState);
    fixture.runtime.currentStatus = {
      state: "unknown",
      error: `raw child output included ${machineToken}`,
    };

    const status = await fixture.bridge.status();

    expect(status).toEqual({
      config: {
        exists: true,
        state: "registered",
        localPiWebUrl: defaults.localPiWebUrl,
        controlApiUrl: defaults.controlApiBaseUrl,
        machine: {
          controlApiBaseUrl: defaults.controlApiBaseUrl,
          machineId: "machine_123",
          machineSlug: defaults.machineSlug,
          publicHostname: "machine.example.test",
          publicUrl,
        },
      },
      desiredState: "disabled",
      runtime: {
        state: "unknown",
        diagnosticCode: "runtime_failed",
        error: "Safe Tunnel runtime is unavailable.",
      },
    });
    const serialized = JSON.stringify(status);
    expect(serialized).not.toContain(machineToken);
    expect(serialized).not.toContain("raw child output");
    expect(serialized).not.toContain("frpcConfig");
    expect(serialized).not.toContain("logTail");
  });

  it("reports approval metadata, then completes the ordinary enabled workflow", async () => {
    const fixture = createFixture(createDefaultSafeTunnelState());
    const login = deferred<undefined>();
    fixture.safeTunnel.loginGate = login;

    const response = await fixture.bridge.enable({});
    await waitFor(() => fixture.bridge.operation(response.operation.id)?.phase === "awaiting_approval");

    expect(fixture.bridge.operation(response.operation.id)).toMatchObject({
      id: response.operation.id,
      kind: "enable",
      phase: "awaiting_approval",
      status: "running",
      userCode: "ABCD-EFGH",
      verificationUriComplete: "https://control.example.test/device?user_code=ABCD-EFGH",
    });
    login.resolve(undefined);
    await waitFor(() => fixture.bridge.operation(response.operation.id)?.status === "succeeded");

    expect(fixture.bridge.operation(response.operation.id)).toEqual({
      id: response.operation.id,
      kind: "enable",
      phase: "enabled",
      status: "succeeded",
      publicUrl,
    });
    expect(fixture.safeTunnel.loginInputs).toEqual([expect.objectContaining({
      controlApiBaseUrl: defaults.controlApiBaseUrl,
      machineName: defaults.machineName,
      machineSlug: defaults.machineSlug,
    })]);
    expect(fixture.runtime.startCalls).toBe(1);
    expect(JSON.stringify(fixture.bridge.operation(response.operation.id))).not.toContain(
      machineToken,
    );
  });

  it("reuses a valid saved registration without starting device approval", async () => {
    const fixture = createFixture(registeredState);

    const response = await fixture.bridge.enable({});
    await waitFor(() => fixture.bridge.operation(response.operation.id)?.status === "succeeded");

    expect(fixture.safeTunnel.loginInputs).toEqual([]);
    expect(fixture.safeTunnel.enableInputs).toEqual([{
      localPiWebUrl: defaults.localPiWebUrl,
    }]);
  });

  it("preserves a registration when the normalized selected service matches saved state", async () => {
    const fixture = createFixture(registeredState);

    const response = await fixture.bridge.enable({
      controlApiUrl: `${defaults.controlApiBaseUrl}/`,
    });
    await waitFor(() => fixture.bridge.operation(response.operation.id)?.status === "succeeded");

    expect(fixture.safeTunnel.loginInputs).toEqual([]);
    expect(fixture.safeTunnel.enableInputs).toEqual([{
      localPiWebUrl: defaults.localPiWebUrl,
    }]);
  });

  it("still replaces registration for changed or rejected identity", async () => {
    const changed = createFixture(registeredState);
    const changedResponse = await changed.bridge.enable({
      controlApiUrl: "https://other-control.example.test",
    });
    await waitFor(() => changed.bridge.operation(changedResponse.operation.id)?.status === "succeeded");
    expect(changed.safeTunnel.loginInputs).toEqual([
      expect.objectContaining({ controlApiBaseUrl: "https://other-control.example.test" }),
    ]);

    const registeredMachine = registeredState.machine;
    if (registeredMachine === undefined) throw new Error("Expected registered fixture state");
    const rejected = createFixture({
      ...registeredState,
      machine: { ...registeredMachine, credentialStatus: "rejected" },
    });
    const rejectedResponse = await rejected.bridge.enable({
      controlApiUrl: defaults.controlApiBaseUrl,
    });
    await waitFor(() => rejected.bridge.operation(rejectedResponse.operation.id)?.status === "succeeded");
    expect(rejected.safeTunnel.loginInputs).toHaveLength(1);
  });

  it("omitting the service clears a development selection and re-registers in production", async () => {
    const machine = registeredState.machine;
    if (machine === undefined) throw new Error("Expected registered fixture state");
    const fixture = createFixture({
      ...registeredState,
      controlApiUrl: "https://dev.example.test",
      machine: { ...machine, controlApiBaseUrl: "https://dev.example.test" },
    });
    const response = await fixture.bridge.enable({});
    await waitFor(() => fixture.bridge.operation(response.operation.id)?.status === "succeeded");
    expect(fixture.safeTunnel.loginInputs).toEqual([expect.objectContaining({
      controlApiBaseUrl: defaultSafeTunnelControlApiBaseUrl,
    })]);
  });

  it("reports the saved selected service before registration", async () => {
    const fixture = createFixture({
      ...createDefaultSafeTunnelState(),
      controlApiUrl: "https://dev.example.test",
    });
    expect((await fixture.bridge.status()).config).toMatchObject({
      state: "unregistered",
      controlApiUrl: "https://dev.example.test",
    });
  });

  it("fails when the listener target cannot be inferred", async () => {
    const enableDefaults = createNodeSafeTunnelEnableDefaultsProvider({
      serverAddress: () => ({ address: "fe80::1%lo0", family: "IPv6", port: 8504 }),
    });
    const fixture = createFixture(createDefaultSafeTunnelState(), { enableDefaults });
    await expect(fixture.bridge.enable({})).rejects.toThrow("cannot infer");
    expect(fixture.safeTunnel.loginInputs).toEqual([]);
  });

  it("restores durable enabled intent once on web/API startup", async () => {
    const fixture = createFixture({
      ...registeredState,
      desiredState: "enabled",
    });

    await fixture.bridge.startup();

    expect(fixture.runtime.startupCalls).toBe(1);
    expect(fixture.safeTunnel.loginInputs).toEqual([]);
    expect(fixture.safeTunnel.enableInputs).toEqual([]);
  });

  it("passes only bounded provider-neutral account-access guidance to the browser", async () => {
    const fixture = createFixture(registeredState);
    const notice = {
      status: "account_access_deactivated" as const,
      message: "Account access is permanently deactivated. Open the hosted dashboard.",
      dashboardUrl: "https://control.example.test/dashboard",
    };
    fixture.runtime.currentStatus = { state: "stopped", accountAccess: notice };

    await expect(fixture.bridge.status()).resolves.toMatchObject({
      config: { state: "registered" },
      runtime: { state: "stopped", accountAccess: notice },
    });

    fixture.runtime.startError = new SafeTunnelAccountAccessError(notice);
    const response = await fixture.bridge.enable({});
    await waitFor(() => fixture.bridge.operation(response.operation.id)?.status === "failed");

    expect(fixture.bridge.operation(response.operation.id)).toEqual({
      id: response.operation.id,
      kind: "enable",
      phase: "starting",
      status: "failed",
      accountAccess: notice,
    });
    expect(fixture.safeTunnel.stateValue.machine?.credentialStatus).toBe("active");
  });

  it("publishes account denial while the owned runtime is still stopping", async () => {
    const fixture = createFixture({
      ...registeredState,
      desiredState: "enabled",
    });
    const notice = {
      status: "account_access_payment_required" as const,
      message: "Account access is not active. Open the hosted dashboard.",
      dashboardUrl: "https://control.example.test/dashboard",
    };
    fixture.runtime.currentStatus = {
      state: "running",
      accountAccess: notice,
    };

    const status = await fixture.bridge.status();

    expect(status.runtime).toEqual({
      state: "running",
      accountAccess: notice,
    });
    expect(status.desiredState).toBe("enabled");
    expect(status.config.state).toBe("registered");
  });

  it("keeps account denial visible when Disable cannot stop the running runtime", async () => {
    const fixture = createFixture({
      ...registeredState,
      desiredState: "enabled",
    });
    const notice = {
      status: "account_access_suspended" as const,
      message: "Account access is suspended pending administrator review.",
      dashboardUrl: "https://control.example.test/dashboard",
    };
    const stopError = new Error("private child stop failure");
    fixture.runtime.currentStatus = {
      state: "running",
      accountAccess: notice,
      diagnosticCode: "runtime_failed",
      error: "private child stop failure",
    };
    fixture.runtime.stopError = stopError;

    await expect(fixture.bridge.disable()).rejects.toBe(stopError);

    expect(fixture.safeTunnel.stateValue.desiredState).toBe("disabled");
    expect(fixture.safeTunnel.stateValue.machine?.credentialStatus).toBe("active");
    await expect(fixture.bridge.status()).resolves.toMatchObject({
      desiredState: "disabled",
      runtime: {
        state: "running",
        accountAccess: notice,
        diagnosticCode: "runtime_failed",
        error: "Safe Tunnel runtime is unavailable.",
      },
    });
  });

  it("exposes a fixed failure instead of an internal provider or child error", async () => {
    const fixture = createFixture(registeredState);
    fixture.runtime.startError = new Error(`provider body and ${machineToken}`);

    const response = await fixture.bridge.enable({});
    await waitFor(() => fixture.bridge.operation(response.operation.id)?.status === "failed");

    const operation = fixture.bridge.operation(response.operation.id);
    expect(operation).toMatchObject({
      phase: "starting",
      status: "failed",
      error: "Safe Tunnel enablement failed.",
    });
    expect(JSON.stringify(operation)).not.toContain(machineToken);
    expect(JSON.stringify(operation)).not.toContain("provider body");
  });

  it("blocks concurrent Enable and honors Disable while preparing the request", async () => {
    const fixture = createFixture(createDefaultSafeTunnelState());
    const preparingStatus = deferred<SafeTunnelRuntimeStatus>();
    vi.spyOn(fixture.runtime, "status").mockReturnValueOnce(preparingStatus.promise);
    const enabling = fixture.bridge.enable({});
    const rejectedEnable = expect(enabling).rejects.toThrow("cancelled");
    await expect(fixture.bridge.enable({})).rejects.toMatchObject({ code: "operation_in_progress" });
    await fixture.bridge.disable();
    preparingStatus.resolve({ state: "stopped" });
    await rejectedEnable;
    expect(fixture.safeTunnel.loginInputs).toEqual([]);
    expect(fixture.runtime.startCalls).toBe(0);

    const retry = await fixture.bridge.enable({});
    await waitFor(() => fixture.bridge.operation(retry.operation.id)?.status === "succeeded");
  });

  it("cancels active approval and stops the exact runtime on disable", async () => {
    const fixture = createFixture(createDefaultSafeTunnelState());
    fixture.safeTunnel.loginGate = deferred<undefined>();
    const response = await fixture.bridge.enable({});
    await waitFor(() => fixture.bridge.operation(response.operation.id)?.phase === "awaiting_approval");

    const disabled = await fixture.bridge.disable();

    expect(fixture.bridge.operation(response.operation.id)).toMatchObject({
      status: "cancelled",
      error: "Safe Tunnel enablement was cancelled.",
    });
    expect(disabled.status.desiredState).toBe("disabled");
    expect(fixture.runtime.stopCalls).toBe(1);
  });

  it("keeps Enable admission closed until a cancelled registration joins Disable", async () => {
    let identity = "a";
    const fixture = createFixture(createDefaultSafeTunnelState(), {
      enableDefaults: () => ({ ...defaults, machineSlug: `machine-${identity}` }),
    });
    const firstRegistration = deferred<undefined>();
    fixture.safeTunnel.registrationGates.set("machine-a", firstRegistration);
    const first = await fixture.bridge.enable({});
    identity = "b";
    await waitFor(() => fixture.bridge.operation(first.operation.id)?.phase === "registering");

    const disabling = fixture.bridge.disable();
    await expect(fixture.bridge.enable({
      controlApiUrl: "https://other.example.test",
    })).rejects.toMatchObject({ code: "operation_in_progress" });

    firstRegistration.resolve(undefined);
    await disabling;
    const second = await fixture.bridge.enable({
      controlApiUrl: "https://other.example.test",
    });
    await waitFor(() => fixture.bridge.operation(second.operation.id)?.status === "succeeded");

    expect(fixture.safeTunnel.loginInputs.map((input) => input.machineSlug)).toEqual([
      "machine-a",
      "machine-b",
    ]);
    expect(fixture.safeTunnel.stateValue.machine?.machineId).toBe("machine_machine-b");
    expect(fixture.runtime.runningMachineId).toBe("machine_machine-b");
  });

  it("keeps only the latest completed operation", async () => {
    const fixture = createFixture(registeredState);
    const first = await fixture.bridge.enable({});
    await waitFor(() => fixture.bridge.operation(first.operation.id)?.status === "succeeded");
    fixture.runtime.currentStatus = { state: "stopped" };
    fixture.safeTunnel.stateValue = { ...fixture.safeTunnel.stateValue, desiredState: "disabled" };

    const second = await fixture.bridge.enable({});
    await waitFor(() => fixture.bridge.operation(second.operation.id)?.status === "succeeded");

    expect(fixture.bridge.operation(first.operation.id)).toBeUndefined();
    expect(fixture.bridge.operation(second.operation.id)?.status).toBe("succeeded");
  });

  it("turns unreadable state into one fixed invalid-state category", async () => {
    const fixture = createFixture(createDefaultSafeTunnelState());
    fixture.safeTunnel.stateError = new Error(`private parse detail ${machineToken}`);

    await expect(fixture.bridge.status()).resolves.toEqual({
      config: {
        exists: true,
        state: "invalid",
        error: "Unable to read PI WEB Safe Tunnel state.",
      },
      desiredState: "disabled",
      runtime: { state: "stopped" },
    });
  });
});

function createFixture(
  initialState: SafeTunnelPersistedState,
  options: {
    readonly enableDefaults?: SafeTunnelBridgeDependencies["enableDefaults"];
  } = {},
): {
  readonly bridge: DefaultSafeTunnelBridgeService;
  readonly runtime: FakeRuntime;
  readonly safeTunnel: FakeSafeTunnelApplication;
} {
  const safeTunnel = new FakeSafeTunnelApplication(initialState);
  const runtime = new FakeRuntime(() => safeTunnel.stateValue.machine);
  let operationSequence = 0;
  const bridge = new DefaultSafeTunnelBridgeService({
    createOperationId: () => `operation-${(++operationSequence).toString()}`,
    enableDefaults: options.enableDefaults ?? (() => defaults),
    fileExists: () => true,
    runtime,
    safeTunnel,
  });
  return { bridge, runtime, safeTunnel };
}

class FakeSafeTunnelApplication implements SafeTunnelApplicationService {
  readonly statePath = "/private/safe-tunnel/config.json";
  readonly enableInputs: SafeTunnelEnableInput[] = [];
  readonly loginInputs: SafeTunnelLoginInput[] = [];
  readonly registrationGates = new Map<string, Deferred<undefined>>();
  loginGate: Deferred<undefined> | undefined;
  stateError: Error | undefined;

  constructor(public stateValue: SafeTunnelPersistedState) {}

  disable(): Promise<SafeTunnelPersistedState> {
    this.stateValue = { ...this.stateValue, desiredState: "disabled" };
    return Promise.resolve(this.stateValue);
  }

  enable(input: SafeTunnelEnableInput = {}): Promise<SafeTunnelPersistedState> {
    this.enableInputs.push(input);
    this.stateValue = {
      ...this.stateValue,
      desiredState: "enabled",
      ...(input.localPiWebUrl === undefined ? {} : { localPiWebUrl: input.localPiWebUrl }),
    };
    return Promise.resolve(this.stateValue);
  }

  async login(
    input: SafeTunnelLoginInput,
    observer: SafeTunnelLoginObserver = {},
    options: SafeTunnelLoginOptions = {},
  ): Promise<SafeTunnelLoginResult> {
    this.loginInputs.push(input);
    observer.onDeviceAuthorization?.({
      userCode: "ABCD-EFGH",
      verificationUri: "https://control.example.test/device",
      verificationUriComplete: "https://control.example.test/device?user_code=ABCD-EFGH",
      expiresAt: "2030-01-01T00:10:00.000Z",
      intervalSeconds: 5,
    });
    await waitForGateOrAbort(this.loginGate, options.signal);
    observer.onAuthorizationApproved?.();
    // Registration is intentionally a one-time unabortable credential write.
    await this.registrationGates.get(input.machineSlug)?.promise;
    const machineId = input.machineSlug === defaults.machineSlug
      ? "machine_123"
      : `machine_${input.machineSlug}`;
    const registeredPublicUrl = input.machineSlug === defaults.machineSlug
      ? publicUrl
      : `https://${input.machineSlug}.example.test`;
    const machineCredentials = {
      controlApiBaseUrl: input.controlApiBaseUrl,
      credentialStatus: "active" as const,
      machineId,
      machineToken,
      machineSlug: input.machineSlug,
      publicUrl: registeredPublicUrl,
    };
    this.stateValue = {
      ...this.stateValue,
      localPiWebUrl: input.localPiWebUrl ?? this.stateValue.localPiWebUrl,
      machine: machineCredentials,
    };
    observer.onMachineRegistered?.();
    return {
      machineCredentials,
      registeredMachine: {
        machine: {
          id: machineId,
          accountId: "account_123",
          name: input.machineName,
          slug: input.machineSlug,
        },
        machineToken,
        publicHostname: new URL(registeredPublicUrl).hostname,
        publicUrl: registeredPublicUrl,
      },
    };
  }

  state(): Promise<LoadedSafeTunnelState> {
    return this.stateError === undefined
      ? Promise.resolve({ exists: this.stateValue !== createDefaultSafeTunnelState(), state: this.stateValue })
      : Promise.reject(this.stateError);
  }
}

class FakeRuntime implements SafeTunnelReconciledFrpcRuntime {
  currentStatus: SafeTunnelRuntimeStatus = { state: "stopped" };
  runningMachineId: string | undefined;
  startError: Error | undefined;
  startCalls = 0;
  startupCalls = 0;
  stopCalls = 0;
  stopError: Error | undefined;

  constructor(
    private readonly currentMachine: () => SafeTunnelPersistedState["machine"],
  ) {}

  shutdown(): Promise<void> {
    this.currentStatus = { state: "stopped" };
    this.runningMachineId = undefined;
    return Promise.resolve();
  }

  start(): Promise<SafeTunnelFrpcStartResult> {
    this.startCalls += 1;
    if (this.startError !== undefined) return Promise.reject(this.startError);
    const machine = this.currentMachine();
    this.currentStatus = { state: "running" };
    this.runningMachineId = machine?.machineId;
    return Promise.resolve({ publicUrl: machine?.publicUrl ?? publicUrl });
  }

  startup(): Promise<void> {
    this.startupCalls += 1;
    return Promise.resolve();
  }

  status(): Promise<SafeTunnelRuntimeStatus> {
    return Promise.resolve(this.currentStatus);
  }

  stop(): Promise<void> {
    this.stopCalls += 1;
    if (this.stopError !== undefined) return Promise.reject(this.stopError);
    this.currentStatus = { state: "stopped" };
    this.runningMachineId = undefined;
    return Promise.resolve();
  }
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

async function waitForGateOrAbort(
  gate: Deferred<undefined> | undefined,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (gate === undefined) return;
  if (signal?.aborted === true) throw new Error("cancelled");
  await Promise.race([
    gate.promise,
    new Promise<never>((_resolve, reject) => {
      signal?.addEventListener("abort", () => { reject(new Error("cancelled")); }, { once: true });
    }),
  ]);
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error("Condition was not reached.");
}
