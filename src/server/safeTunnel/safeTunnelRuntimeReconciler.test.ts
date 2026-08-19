import { describe, expect, it } from "vitest";
import type { SafeTunnelRuntimeStatus } from "../../shared/apiTypes.js";
import {
  SafeTunnelControlPlaneError,
  type SafeTunnelHeartbeatTunnelStatus,
  type SafeTunnelMachineHeartbeat,
} from "./safeTunnelControlPlane.js";
import type {
  SafeTunnelFrpcRuntime,
  SafeTunnelFrpcStartInput,
  SafeTunnelFrpcStartResult,
  SafeTunnelScheduledTask,
  SafeTunnelSupervisorClock,
} from "./safeTunnelFrpcSupervisor.js";
import {
  SafeTunnelRuntimeReconciler,
  type SafeTunnelRuntimeReconciliationService,
} from "./safeTunnelRuntimeReconciler.js";
import { SafeTunnelServiceError } from "./safeTunnelService.js";
import {
  createDefaultSafeTunnelState,
  type LoadedSafeTunnelState,
} from "./safeTunnelState.js";

const policy = {
  maximumHeartbeatIntervalMs: 100_000,
  minimumHeartbeatIntervalMs: 20_000,
} as const;

describe("SafeTunnelRuntimeReconciler", () => {
  it("restores enabled intent and clamps hosted heartbeat intervals", async () => {
    const fixture = createFixture();
    fixture.safeTunnel.loaded = registeredEnabledState({ frpcPath: "/advanced/frpc" });
    fixture.safeTunnel.heartbeatResults = [
      () => Promise.resolve(heartbeatResult(1)),
      () => Promise.resolve(heartbeatResult(999)),
    ];

    await fixture.reconciler.startup();
    await waitForCondition(() => fixture.runtime.startCalls.length === 1);

    expect(fixture.runtime.startCalls).toEqual([{ advancedFrpcPath: "/advanced/frpc" }]);
    fixture.clock.advance(0);
    await waitForCondition(() => fixture.clock.scheduledDelays.at(-1) === 20_000);
    expect(fixture.safeTunnel.heartbeatCalls).toEqual([{ tunnelStatus: "running" }]);

    fixture.clock.advance(20_000);
    await waitForCondition(() => fixture.clock.scheduledDelays.at(-1) === 100_000);
    expect(fixture.safeTunnel.heartbeatCalls).toHaveLength(2);
    expect(fixture.runtime.stopCalls).toBe(0);
  });

  it("leaves disabled intent dormant without child or timer work", async () => {
    const fixture = createFixture();

    await fixture.reconciler.startup();
    await fixture.reconciler.startup();

    expect(fixture.runtime.startCalls).toEqual([]);
    expect(fixture.runtime.stopCalls).toBe(0);
    expect(fixture.safeTunnel.heartbeatCalls).toEqual([]);
    expect(fixture.clock.activeTaskCount()).toBe(0);
  });

  it("keeps missing or rejected registration stopped with a fixed category", async () => {
    const missing = createFixture();
    missing.safeTunnel.loaded = {
      exists: true,
      state: { ...createDefaultSafeTunnelState(), desiredState: "enabled" },
    };
    await missing.reconciler.startup();

    expect(missing.runtime.startCalls).toEqual([]);
    await expect(missing.reconciler.status()).resolves.toMatchObject({
      state: "stopped",
      diagnosticCode: "registration_required",
    });

    const rejected = createFixture();
    const loaded = registeredEnabledState();
    const machine = loaded.state.machine;
    if (machine === undefined) throw new Error("Expected registered fixture");
    rejected.safeTunnel.loaded = {
      ...loaded,
      state: {
        ...loaded.state,
        machine: { ...machine, credentialStatus: "rejected" },
      },
    };
    await rejected.reconciler.startup();

    expect(rejected.runtime.startCalls).toEqual([]);
    await expect(rejected.reconciler.status()).resolves.toMatchObject({
      state: "stopped",
      diagnosticCode: "credentials_rejected",
    });
  });

  it("uses one periodic interval after an ordinary heartbeat failure", async () => {
    const fixture = createFixture();
    fixture.safeTunnel.heartbeatResults = [
      () => Promise.reject(new Error("provider detail")),
      () => Promise.resolve(heartbeatResult(30)),
    ];

    await fixture.reconciler.start({});
    fixture.clock.advance(0);
    await waitForCondition(() => fixture.clock.scheduledDelays.at(-1) === 20_000);

    await expect(fixture.reconciler.status()).resolves.toEqual({
      state: "running",
      diagnosticCode: "heartbeat_failed",
      error: "Safe Tunnel heartbeat failed. PI WEB will try again at the next heartbeat interval.",
    });
    fixture.clock.advance(20_000);
    await waitForCondition(() => fixture.clock.scheduledDelays.at(-1) === 30_000);

    expect(fixture.safeTunnel.heartbeatCalls).toHaveLength(2);
    expect(fixture.runtime.stopCalls).toBe(0);
    await expect(fixture.reconciler.status()).resolves.toEqual({ state: "running" });
  });

  it.each([
    new SafeTunnelControlPlaneError("authentication_failed", "record_heartbeat"),
    new SafeTunnelServiceError("credentials_rejected"),
  ])("stops once when heartbeat credentials are rejected", async (rejection) => {
    const fixture = createFixture();
    fixture.safeTunnel.heartbeatResults = [() => Promise.reject(rejection)];

    await fixture.reconciler.start({});
    fixture.clock.advance(0);
    await waitForCondition(() => fixture.runtime.stopCalls === 1);
    fixture.clock.advance(100_000);

    expect(fixture.runtime.stopCalls).toBe(1);
    expect(fixture.clock.activeTaskCount()).toBe(0);
    await expect(fixture.reconciler.status()).resolves.toMatchObject({
      state: "stopped",
      diagnosticCode: "credentials_rejected",
    });
  });

  it("reports an unreadable state once without scheduling recovery", async () => {
    const fixture = createFixture();
    fixture.safeTunnel.stateError = new Error("private filesystem detail");

    await fixture.reconciler.startup();
    fixture.clock.advance(100_000);

    expect(fixture.runtime.startCalls).toEqual([]);
    expect(fixture.clock.activeTaskCount()).toBe(0);
    await expect(fixture.reconciler.status()).resolves.toEqual({
      state: "stopped",
      diagnosticCode: "state_invalid",
      error: "PI WEB could not read persisted Safe Tunnel intent.",
    });
  });

  it("reports a start failure without adding a child restart loop", async () => {
    const fixture = createFixture();
    fixture.runtime.startError = new Error("private launch detail");

    await expect(fixture.reconciler.start({})).rejects.toBe(fixture.runtime.startError);
    fixture.clock.advance(100_000);
    await flushAsyncWork();

    expect(fixture.runtime.startCalls).toEqual([{}]);
    await expect(fixture.reconciler.status()).resolves.toMatchObject({
      diagnosticCode: "runtime_failed",
    });
  });

  it("aborts heartbeat work before stopping the exact runtime", async () => {
    const order: string[] = [];
    const fixture = createFixture(order);
    fixture.safeTunnel.heartbeatResults = [pendingHeartbeatUntilAbort];

    await fixture.reconciler.start({});
    fixture.clock.advance(0);
    await waitForCondition(() => order.includes("heartbeat:start"));
    await fixture.reconciler.stop();

    expect(order).toEqual([
      "runtime:start",
      "heartbeat:start",
      "heartbeat:abort",
      "runtime:stop",
    ]);
    expect(fixture.clock.activeTaskCount()).toBe(0);
  });

  it("aborts heartbeat work before one idempotent runtime shutdown", async () => {
    const order: string[] = [];
    const fixture = createFixture(order);
    fixture.safeTunnel.heartbeatResults = [pendingHeartbeatUntilAbort];

    await fixture.reconciler.start({});
    fixture.clock.advance(0);
    await waitForCondition(() => order.includes("heartbeat:start"));

    const first = fixture.reconciler.shutdown();
    const second = fixture.reconciler.shutdown();
    expect(second).toBe(first);
    await first;

    expect(order).toEqual([
      "runtime:start",
      "heartbeat:start",
      "heartbeat:abort",
      "runtime:shutdown",
    ]);
    expect(fixture.runtime.shutdownCalls).toBe(1);
    expect(fixture.clock.activeTaskCount()).toBe(0);
  });
});

interface Fixture {
  readonly clock: ManualClock;
  readonly reconciler: SafeTunnelRuntimeReconciler;
  readonly runtime: FakeFrpcRuntime;
  readonly safeTunnel: FakeReconciliationService;
}

function createFixture(order: string[] = []): Fixture {
  const clock = new ManualClock();
  const runtime = new FakeFrpcRuntime(order);
  const safeTunnel = new FakeReconciliationService(order);
  return {
    clock,
    runtime,
    safeTunnel,
    reconciler: new SafeTunnelRuntimeReconciler({
      clock,
      policy,
      runtime,
      safeTunnel,
    }),
  };
}

class FakeReconciliationService implements SafeTunnelRuntimeReconciliationService {
  readonly heartbeatCalls: {
    readonly tunnelStatus: SafeTunnelHeartbeatTunnelStatus;
    readonly errorMessage?: string;
  }[] = [];
  heartbeatResults: (() => Promise<SafeTunnelMachineHeartbeat>)[] = [];
  loaded: LoadedSafeTunnelState = {
    exists: false,
    state: createDefaultSafeTunnelState(),
  };
  stateError: Error | undefined;

  constructor(private readonly order: string[]) {}

  recordHeartbeat(
    input: {
      readonly tunnelStatus: SafeTunnelHeartbeatTunnelStatus;
      readonly errorMessage?: string;
    },
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<SafeTunnelMachineHeartbeat> {
    this.heartbeatCalls.push(input);
    this.order.push("heartbeat:start");
    const result = (this.heartbeatResults.shift()
      ?? (() => Promise.resolve(heartbeatResult(30))))();
    if (options.signal === undefined) return result;
    const signal = options.signal;
    const onAbort = (): void => { this.order.push("heartbeat:abort"); };
    signal.addEventListener("abort", onAbort, { once: true });
    return abortableFake(result, signal).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  }

  state(): Promise<LoadedSafeTunnelState> {
    return this.stateError === undefined
      ? Promise.resolve(structuredClone(this.loaded))
      : Promise.reject(this.stateError);
  }
}

class FakeFrpcRuntime implements SafeTunnelFrpcRuntime {
  readonly startCalls: SafeTunnelFrpcStartInput[] = [];
  startError: Error | undefined;
  shutdownCalls = 0;
  statusValue: SafeTunnelRuntimeStatus = runtimeStatus();
  stopCalls = 0;

  constructor(private readonly order: string[]) {}

  shutdown(): Promise<void> {
    this.order.push("runtime:shutdown");
    this.shutdownCalls += 1;
    this.statusValue = runtimeStatus();
    return Promise.resolve();
  }

  start(input: SafeTunnelFrpcStartInput): Promise<SafeTunnelFrpcStartResult> {
    this.order.push("runtime:start");
    this.startCalls.push(input);
    if (this.startError !== undefined) return Promise.reject(this.startError);
    this.statusValue = runtimeStatus({ state: "running" });
    return Promise.resolve({
      publicUrl: "https://dev-box.ns.tunnels.pi-web.dev",
    });
  }

  status(): Promise<SafeTunnelRuntimeStatus> {
    return Promise.resolve(this.statusValue);
  }

  stop(): Promise<void> {
    this.order.push("runtime:stop");
    this.stopCalls += 1;
    this.statusValue = runtimeStatus();
    return Promise.resolve();
  }
}

class ManualClock implements SafeTunnelSupervisorClock {
  private currentMilliseconds = 0;
  private nextId = 1;
  readonly scheduledDelays: number[] = [];
  private readonly tasks = new Map<number, {
    readonly callback: () => void;
    readonly dueAt: number;
  }>();

  schedule(callback: () => void, delayMs: number): SafeTunnelScheduledTask {
    const id = this.nextId;
    this.nextId += 1;
    this.scheduledDelays.push(delayMs);
    this.tasks.set(id, { callback, dueAt: this.currentMilliseconds + delayMs });
    return { cancel: () => { this.tasks.delete(id); } };
  }

  advance(milliseconds: number): void {
    const target = this.currentMilliseconds + milliseconds;
    for (;;) {
      const next = [...this.tasks.entries()]
        .filter(([, task]) => task.dueAt <= target)
        .sort((left, right) => left[1].dueAt - right[1].dueAt || left[0] - right[0])[0];
      if (next === undefined) break;
      const [id, task] = next;
      this.tasks.delete(id);
      this.currentMilliseconds = task.dueAt;
      task.callback();
    }
    this.currentMilliseconds = target;
  }

  activeTaskCount(): number {
    return this.tasks.size;
  }
}

function registeredEnabledState(
  overrides: Partial<LoadedSafeTunnelState["state"]> = {},
): LoadedSafeTunnelState {
  return {
    exists: true,
    state: {
      ...createDefaultSafeTunnelState(),
      desiredState: "enabled",
      machine: {
        controlApiBaseUrl: "https://control.example.test",
        machineId: "machine_123",
        machineToken: "piwt_mtok_v1_private",
        machineSlug: "dev-box",
        publicUrl: "https://dev-box.ns.tunnels.pi-web.dev",
      },
      ...overrides,
    },
  };
}

function heartbeatResult(nextHeartbeatSeconds: number): SafeTunnelMachineHeartbeat {
  return {
    machineId: "machine_123",
    lastSeenAt: "2026-07-29T00:00:00.000Z",
    nextHeartbeatSeconds,
  };
}

function runtimeStatus(
  overrides: Partial<SafeTunnelRuntimeStatus> = {},
): SafeTunnelRuntimeStatus {
  return {
    state: "stopped",
    ...overrides,
  };
}

function pendingHeartbeatUntilAbort(): Promise<SafeTunnelMachineHeartbeat> {
  return new Promise(() => undefined);
}

function abortableFake<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error("aborted"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener("abort", onAbort);
      reject(new Error("aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error instanceof Error ? error : new Error("Unexpected fake failure."));
      },
    );
  });
}

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function waitForCondition(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (condition()) return;
    await flushAsyncWork();
  }
  throw new Error("Expected asynchronous Safe Tunnel condition was not reached.");
}
