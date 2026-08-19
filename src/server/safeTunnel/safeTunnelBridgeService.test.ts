import { describe, expect, it, vi } from "vitest";
import type { SafeTunnelRuntimeStatus } from "../../shared/apiTypes.js";
import {
  DefaultSafeTunnelBridgeService,
  type SafeTunnelApplicationService,
  type SafeTunnelBridgeDependencies,
} from "./safeTunnelBridgeService.js";
import {
  createNodeSafeTunnelEnableDefaultsProvider,
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
  SafeTunnelFrpcStartInput,
  SafeTunnelFrpcStartResult,
} from "./safeTunnelFrpcSupervisor.js";

const machineToken = "piwt_mtok_v1_private_machine_token";
const publicUrl = "https://machine.example.test";
const defaults: SafeTunnelEnableDefaults = {
  controlApiBaseUrl: "https://control.example.test",
  localPiWebUrl: "http://127.0.0.1:8504",
  machineName: "Test machine",
  machineSlug: "test-machine",
};
const registeredState: SafeTunnelPersistedState = {
  ...createDefaultSafeTunnelState(),
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
        frpcPathConfigured: false,
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
    expect(fixture.runtime.startInputs).toEqual([{}]);
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

  it("lets an advanced local target bypass unavailable listener inference", async () => {
    const enableDefaults = vi.fn(createNodeSafeTunnelEnableDefaultsProvider({
      serverAddress: () => ({ address: "fe80::1%lo0", family: "IPv6", port: 8504 }),
      hostname: () => defaults.machineName,
      uniqueId: () => "12345678-abcd",
    }));
    const fixture = createFixture(createDefaultSafeTunnelState(), { enableDefaults });
    const localPiWebUrl = "http://[::1]:80";

    const response = await fixture.bridge.enable({ advanced: { localPiWebUrl } });
    await waitFor(() => fixture.bridge.operation(response.operation.id)?.status === "succeeded");

    expect(enableDefaults).toHaveBeenCalledWith({ localPiWebUrl });
    expect(fixture.safeTunnel.loginInputs).toEqual([
      expect.objectContaining({ localPiWebUrl }),
    ]);
    expect(fixture.safeTunnel.enableInputs).toEqual([{ localPiWebUrl }]);
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
    const fixture = createFixture(createDefaultSafeTunnelState());
    const firstRegistration = deferred<undefined>();
    fixture.safeTunnel.registrationGates.set("machine-a", firstRegistration);
    const first = await fixture.bridge.enable({
      advanced: { machineName: "Machine A", machineSlug: "machine-a" },
    });
    await waitFor(() => fixture.bridge.operation(first.operation.id)?.phase === "registering");

    const disabling = fixture.bridge.disable();
    await expect(fixture.bridge.enable({
      advanced: { machineName: "Machine B", machineSlug: "machine-b" },
    })).rejects.toMatchObject({ code: "operation_in_progress" });

    firstRegistration.resolve(undefined);
    await disabling;
    const second = await fixture.bridge.enable({
      advanced: { machineName: "Machine B", machineSlug: "machine-b" },
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
      ...(input.frpcPath === undefined ? {} : { frpcPath: input.frpcPath }),
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
  readonly startInputs: SafeTunnelFrpcStartInput[] = [];
  startupCalls = 0;
  stopCalls = 0;

  constructor(
    private readonly currentMachine: () => SafeTunnelPersistedState["machine"],
  ) {}

  shutdown(): Promise<void> {
    this.currentStatus = { state: "stopped" };
    this.runningMachineId = undefined;
    return Promise.resolve();
  }

  start(input: SafeTunnelFrpcStartInput): Promise<SafeTunnelFrpcStartResult> {
    this.startInputs.push(input);
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
