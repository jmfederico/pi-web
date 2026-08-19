import { describe, expect, it } from "vitest";
import type { SafeTunnelManagedFrpcProvider } from "./safeTunnelFrpcManager.js";
import type {
  SafeTunnelFrpcProcessExit,
  SafeTunnelFrpcProcessHandle,
  SafeTunnelFrpcProcessLauncher,
  SafeTunnelFrpcProcessObserver,
  SafeTunnelFrpcProcessRequest,
} from "./safeTunnelFrpcProcess.js";
import type { SafeTunnelFrpcRuntimeFiles } from "./safeTunnelFrpcRuntimeFiles.js";
import { applySafeTunnelLocalTarget } from "./safeTunnelService.js";
import {
  hostedFrpcConfigToml,
  hostedLocalPiWebUrl,
  hostedMachineId,
  hostedMachineToken,
  hostedProxyName,
  hostedPublicHostname,
  hostedPublicUrl,
} from "./safeTunnelHostedFixtures.testSupport.js";
import {
  SafeTunnelFrpcSupervisor,
  SafeTunnelFrpcSupervisorError,
  type SafeTunnelFrpcConfigProvider,
  type SafeTunnelScheduledTask,
  type SafeTunnelSupervisorClock,
} from "./safeTunnelFrpcSupervisor.js";

const configPath = "/private/safe-tunnel/frpc.toml";
const trustedCaPath = "/private/safe-tunnel/frps-roots.pem";
const managedPath = "/private/safe-tunnel/bin/frpc";
const publicUrl = hostedPublicUrl;
const machineToken = hostedMachineToken;

describe("SafeTunnelFrpcSupervisor", () => {
  it("writes one constrained config and launches one owned child", async () => {
    const fixture = createFixture();

    const result = await fixture.supervisor.start({});

    expect(result).toEqual({ publicUrl });
    expect(fixture.files.writes).toEqual([fixture.configProvider.config.frpcConfigToml]);
    expect(fixture.launcher.requests).toEqual([{ configPath, frpcPath: managedPath }]);
    expect(await fixture.supervisor.status()).toEqual({ state: "running" });
  });

  it("uses an explicit advanced executable without acquiring managed frpc", async () => {
    const fixture = createFixture();

    await fixture.supervisor.start({ advancedFrpcPath: "/opt/frpc" });

    expect(fixture.managed.calls).toBe(0);
    expect(fixture.launcher.requests).toEqual([{ configPath, frpcPath: "/opt/frpc" }]);
  });

  it("rejects a pre-spawn advanced executable failure before reporting running", async () => {
    const fixture = createFixture();
    fixture.launcher.startError = new Error("missing executable");

    await expect(fixture.supervisor.start({ advancedFrpcPath: "/missing/frpc" }))
      .rejects.toEqual(new SafeTunnelFrpcSupervisorError("process_launch_failed"));

    expect(await fixture.supervisor.status()).toEqual({
      state: "stopped",
      error: "PI WEB could not launch the Safe Tunnel frpc process.",
    });
    const child = fixture.launcher.processes[0];
    expect(child?.disposed).toBe(false);

    child?.exit({ kind: "error" });
    expect(child?.disposed).toBe(true);
  });

  it("reports an ordinary unexpected child exit without starting a retry loop", async () => {
    const fixture = createFixture();
    await fixture.supervisor.start({});

    fixture.launcher.processes[0]?.exit({ exitCode: 1, kind: "exited", signal: null });
    fixture.clock.advance(60_000);
    await settle();

    expect(fixture.launcher.requests).toHaveLength(1);
    expect(await fixture.supervisor.status()).toEqual({
      state: "stopped",
      error: "The owned frpc process exited unexpectedly with code 1.",
    });
  });

  it("stops only its exact child and removes generated credentials", async () => {
    const fixture = createFixture();
    await fixture.supervisor.start({});
    const child = fixture.launcher.processes[0];

    await fixture.supervisor.stop();

    expect(child?.signals).toEqual(["SIGTERM"]);
    expect(child?.disposed).toBe(true);
    expect(fixture.files.removeCalls).toBe(1);
    expect(await fixture.supervisor.status()).toEqual({ state: "stopped" });
  });

  it("escalates one unresponsive owned child from SIGTERM to SIGKILL", async () => {
    const fixture = createFixture();
    await fixture.supervisor.start({});
    const child = fixture.launcher.processes[0];
    if (child === undefined) throw new Error("Expected a launched child");
    child.exitOnSignal = "SIGKILL";

    const stopping = fixture.supervisor.stop();
    await settle();
    fixture.clock.advance(5);
    await settle();
    await stopping;

    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(child.disposed).toBe(true);
  });

  it("reports one stable category when tunnel preparation fails", async () => {
    const fixture = createFixture();
    fixture.configProvider.error = new Error("raw provider response");

    await expect(fixture.supervisor.start({})).rejects.toMatchObject({
      code: "tunnel_config_failed",
    });
    fixture.clock.advance(60_000);

    expect(fixture.launcher.requests).toEqual([]);
    expect(await fixture.supervisor.status()).toEqual({
      state: "stopped",
      error: "PI WEB could not prepare Safe Tunnel configuration.",
    });
  });

  it("rejects a prepared config that lost its machine identity before launch", async () => {
    const fixture = createFixture();
    fixture.configProvider.config = {
      ...fixture.configProvider.config,
      frpcConfigToml: fixture.configProvider.config.frpcConfigToml.replace(
        `pi_web_machine_token = "${machineToken}"\n`,
        "",
      ),
    };

    await expect(fixture.supervisor.start({})).rejects.toMatchObject({
      code: "tunnel_config_failed",
    });

    expect(fixture.files.writes).toEqual([]);
    expect(fixture.launcher.requests).toEqual([]);
  });

  it("cancels an in-progress configuration request before stopping", async () => {
    const fixture = createFixture();
    fixture.configProvider.waitForAbort = true;

    const starting = fixture.supervisor.start({});
    const stopping = fixture.supervisor.stop();

    await expect(starting).rejects.toEqual(
      new SafeTunnelFrpcSupervisorError("start_cancelled"),
    );
    await stopping;
    expect(fixture.configProvider.observedSignal?.aborted).toBe(true);
    expect(fixture.launcher.requests).toEqual([]);
    expect(fixture.files.removeCalls).toBe(1);
  });

  it("cancels an in-progress managed frpc acquisition before stopping", async () => {
    const fixture = createFixture();
    fixture.managed.waitForAbort = true;

    const starting = fixture.supervisor.start({});
    await fixture.managed.started;
    const stopping = fixture.supervisor.stop();

    await expect(starting).rejects.toEqual(
      new SafeTunnelFrpcSupervisorError("start_cancelled"),
    );
    await stopping;
    expect(fixture.managed.observedSignal?.aborted).toBe(true);
    expect(fixture.launcher.requests).toEqual([]);
    expect(fixture.files.removeCalls).toBe(1);
  });

  it("shuts down idempotently and rejects later starts", async () => {
    const fixture = createFixture();
    await fixture.supervisor.start({});

    const first = fixture.supervisor.shutdown();
    const second = fixture.supervisor.shutdown();
    expect(second).toBe(first);
    await first;

    expect(fixture.files.removeCalls).toBe(1);
    await expect(fixture.supervisor.start({})).rejects.toEqual(
      new SafeTunnelFrpcSupervisorError("supervisor_shutdown"),
    );
  });
});

function createFixture(): {
  readonly clock: ManualClock;
  readonly configProvider: FakeConfigProvider;
  readonly files: FakeRuntimeFiles;
  readonly launcher: FakeLauncher;
  readonly managed: FakeManagedFrpc;
  readonly supervisor: SafeTunnelFrpcSupervisor;
} {
  const clock = new ManualClock();
  const configProvider = new FakeConfigProvider();
  const files = new FakeRuntimeFiles();
  const launcher = new FakeLauncher();
  const managed = new FakeManagedFrpc();
  const supervisor = new SafeTunnelFrpcSupervisor({
    clock,
    configProvider,
    files,
    launcher,
    managedFrpc: managed,
    policy: {
      killGracePeriodMs: 5,
      stopGracePeriodMs: 5,
    },
  });
  return { clock, configProvider, files, launcher, managed, supervisor };
}

class FakeConfigProvider implements SafeTunnelFrpcConfigProvider {
  config = applySafeTunnelLocalTarget({
    machineId: hostedMachineId,
    publicHostname: hostedPublicHostname,
    publicUrl,
    localPiWebUrl: hostedLocalPiWebUrl,
    proxyName: hostedProxyName,
    frpcConfigToml: hostedFrpcConfigToml,
  }, hostedLocalPiWebUrl, trustedCaPath, machineToken);
  error: Error | undefined;
  observedSignal: AbortSignal | undefined;
  waitForAbort = false;

  getTunnelConfig(options: { readonly signal?: AbortSignal } = {}): Promise<typeof this.config> {
    this.observedSignal = options.signal;
    if (this.error !== undefined) return Promise.reject(this.error);
    if (!this.waitForAbort) return Promise.resolve(this.config);
    return new Promise((_resolve, reject) => {
      options.signal?.addEventListener("abort", () => { reject(new Error("aborted")); }, {
        once: true,
      });
    });
  }
}

class FakeRuntimeFiles implements SafeTunnelFrpcRuntimeFiles {
  readonly configPath = configPath;
  readonly trustedCaPath = trustedCaPath;
  removeCalls = 0;
  readonly writes: string[] = [];

  removeConfig(): Promise<void> {
    this.removeCalls += 1;
    return Promise.resolve();
  }

  writeConfig(contents: string): Promise<void> {
    this.writes.push(contents);
    return Promise.resolve();
  }
}

class FakeManagedFrpc implements SafeTunnelManagedFrpcProvider {
  calls = 0;
  observedSignal: AbortSignal | undefined;
  private resolveStarted = (): void => undefined;
  readonly started = new Promise<void>((resolve) => { this.resolveStarted = resolve; });
  waitForAbort = false;

  ensureManagedFrpc(options: { readonly signal?: AbortSignal } = {}) {
    this.calls += 1;
    this.observedSignal = options.signal;
    this.resolveStarted();
    if (!this.waitForAbort) return Promise.resolve({ path: managedPath });
    return new Promise<{ readonly path: string }>((_resolve, reject) => {
      if (options.signal?.aborted === true) {
        reject(new Error("cancelled acquisition"));
        return;
      }
      options.signal?.addEventListener(
        "abort",
        () => { reject(new Error("cancelled acquisition")); },
        { once: true },
      );
    });
  }
}

class FakeLauncher implements SafeTunnelFrpcProcessLauncher {
  readonly processes: FakeProcess[] = [];
  readonly requests: SafeTunnelFrpcProcessRequest[] = [];
  startError: Error | undefined;

  launch(
    request: SafeTunnelFrpcProcessRequest,
    observer: SafeTunnelFrpcProcessObserver,
  ): SafeTunnelFrpcProcessHandle {
    this.requests.push(request);
    const process = new FakeProcess(
      observer,
      4_000 + this.processes.length,
      this.startError,
    );
    this.processes.push(process);
    return process;
  }
}

class FakeProcess implements SafeTunnelFrpcProcessHandle {
  disposed = false;
  exitOnSignal: NodeJS.Signals | undefined = "SIGTERM";
  readonly signals: NodeJS.Signals[] = [];
  readonly started: Promise<void>;

  constructor(
    private readonly observer: SafeTunnelFrpcProcessObserver,
    readonly pid: number,
    startError: Error | undefined,
  ) {
    this.started = startError === undefined
      ? Promise.resolve()
      : Promise.reject(startError);
  }

  dispose(): void {
    this.disposed = true;
  }

  terminate(signal: NodeJS.Signals): boolean {
    this.signals.push(signal);
    if (signal === this.exitOnSignal) {
      queueMicrotask(() => {
        this.exit({ exitCode: 0, kind: "exited", signal });
      });
    }
    return true;
  }

  exit(exit: SafeTunnelFrpcProcessExit): void {
    this.observer.onExit(exit);
  }
}

interface Scheduled {
  readonly callback: () => void;
  readonly dueAt: number;
  cancelled: boolean;
}

class ManualClock implements SafeTunnelSupervisorClock {
  private current = 0;
  private readonly scheduled: Scheduled[] = [];

  schedule(callback: () => void, delayMs: number): SafeTunnelScheduledTask {
    const task = { callback, dueAt: this.current + delayMs, cancelled: false };
    this.scheduled.push(task);
    return { cancel: () => { task.cancelled = true; } };
  }

  advance(milliseconds: number): void {
    this.current += milliseconds;
    for (const task of this.scheduled) {
      if (!task.cancelled && task.dueAt <= this.current) {
        task.cancelled = true;
        task.callback();
      }
    }
  }
}

async function settle(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}
