import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SafeTunnelControlPlaneError,
  type SafeTunnelApprovedDeviceAuthorization,
  type SafeTunnelControlPlane,
  type SafeTunnelDeviceAuthorization,
  type SafeTunnelDeviceAuthorizationCompletion,
  type SafeTunnelMachineHeartbeat,
  type SafeTunnelMachineTunnelConfig,
  type SafeTunnelRegisteredMachine,
} from "./safeTunnelControlPlane.js";
import {
  hostedFrpcConfigToml,
  hostedLocalPiWebUrl,
  hostedMachineId,
  hostedMachineSlug,
  hostedMachineToken,
  hostedProxyName,
  hostedPublicHostname,
  hostedPublicUrl,
} from "./safeTunnelHostedFixtures.testSupport.js";
import {
  SafeTunnelService,
  SafeTunnelServiceError,
  applySafeTunnelLocalTarget,
} from "./safeTunnelService.js";
import {
  FileSafeTunnelStateStorage,
  createDefaultSafeTunnelState,
  type LoadedSafeTunnelState,
  type SafeTunnelPersistedState,
  type SafeTunnelStateStorage,
} from "./safeTunnelState.js";

const machineToken = hostedMachineToken;
const connectorToken = "piwt_ctok_v1_connector_private";
const machineSlug = hostedMachineSlug;
const publicUrl = hostedPublicUrl;
const localPiWebUrl = hostedLocalPiWebUrl;
const trustedCaPath = "/private/safe-tunnel/frps-roots.pem";
const machine = {
  controlApiBaseUrl: "https://control.example.test",
  credentialStatus: "active" as const,
  machineId: hostedMachineId,
  machineToken,
  machineSlug,
  publicUrl,
};

const tempDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirectories.splice(0).map(
    (directory) => rm(directory, { recursive: true, force: true }),
  ));
});

describe("SafeTunnelService", () => {
  it("completes ordinary approval and persists only current intent and credentials", async () => {
    const controlPlane = new FakeControlPlane();
    const storage = new MemoryStateStorage();
    const service = createService(controlPlane, storage);
    const observed: string[] = [];

    const result = await service.login({
      controlApiBaseUrl: "https://control.example.test/",
      localPiWebUrl,
      machineName: "Test machine",
      machineSlug,
    }, {
      onDeviceAuthorization: (authorization) => {
        observed.push(`approval:${authorization.userCode}`);
        expect(JSON.stringify(authorization)).not.toContain(controlPlane.device.deviceCode);
      },
      onAuthorizationApproved: () => { observed.push("approved"); },
      onMachineRegistered: () => { observed.push("registered"); },
    });

    expect(observed).toEqual(["approval:ABCD-EFGH", "approved", "registered"]);
    expect(result.machineCredentials).toEqual(machine);
    expect(storage.state).toEqual({
      ...createDefaultSafeTunnelState(),
      localPiWebUrl,
      machine,
    });
    expect(JSON.stringify(storage.state)).not.toContain("credentialBoundary");
    expect(controlPlane.registerInputs).toEqual([expect.objectContaining({
      connectorAccessToken: connectorToken,
      machineSlug,
    })]);
  });

  it("waits one provider interval before the first poll and between pending polls", async () => {
    const controlPlane = new FakeControlPlane();
    controlPlane.completions = [{ kind: "pending" }, { kind: "pending" }];
    const service = createService(controlPlane, new MemoryStateStorage(), {
      sleep: (milliseconds) => {
        controlPlane.events.push(`sleep:${milliseconds.toString()}`);
        return Promise.resolve();
      },
    });

    await service.login({
      controlApiBaseUrl: "https://control.example.test",
      localPiWebUrl,
      machineName: "Test machine",
      machineSlug,
    });

    expect(controlPlane.events).toEqual([
      "sleep:1000",
      "complete",
      "sleep:1000",
      "complete",
      "sleep:1000",
      "complete",
    ]);
  });

  it("honors slow_down Retry-After as polling control flow", async () => {
    const controlPlane = new FakeControlPlane();
    controlPlane.completions = [
      { kind: "slow_down", retryAfterSeconds: 9 },
      { kind: "pending" },
    ];
    const service = createService(controlPlane, new MemoryStateStorage(), {
      sleep: (milliseconds) => {
        controlPlane.events.push(`sleep:${milliseconds.toString()}`);
        return Promise.resolve();
      },
    });

    await service.login({
      controlApiBaseUrl: "https://control.example.test",
      localPiWebUrl,
      machineName: "Test machine",
      machineSlug,
    });

    expect(controlPlane.events).toEqual([
      "sleep:1000",
      "complete",
      "sleep:9000",
      "complete",
      "sleep:1000",
      "complete",
    ]);
  });

  it("retries a bounded rate limit after its Retry-After delay", async () => {
    const controlPlane = new FakeControlPlane();
    controlPlane.completions = [new SafeTunnelControlPlaneError(
      "rate_limited",
      "complete_device_authorization",
      4,
    )];
    const service = createService(controlPlane, new MemoryStateStorage(), {
      sleep: (milliseconds) => {
        controlPlane.events.push(`sleep:${milliseconds.toString()}`);
        return Promise.resolve();
      },
    });

    await service.login({
      controlApiBaseUrl: "https://control.example.test",
      localPiWebUrl,
      machineName: "Test machine",
      machineSlug,
    });

    expect(controlPlane.events).toEqual([
      "sleep:1000",
      "complete",
      "sleep:4000",
      "complete",
    ]);
  });

  it("fails a rate limit without Retry-After instead of busy-looping", async () => {
    const controlPlane = new FakeControlPlane();
    controlPlane.completions = [new SafeTunnelControlPlaneError(
      "rate_limited",
      "complete_device_authorization",
    )];
    const service = createService(controlPlane, new MemoryStateStorage(), {
      sleep: (milliseconds) => {
        controlPlane.events.push(`sleep:${milliseconds.toString()}`);
        return Promise.resolve();
      },
    });

    await expect(service.login({
      controlApiBaseUrl: "https://control.example.test",
      localPiWebUrl,
      machineName: "Test machine",
      machineSlug,
    })).rejects.toMatchObject({ code: "rate_limited" });
    expect(controlPlane.events).toEqual(["sleep:1000", "complete"]);
  });

  it("expires without polling when the authorization already expired", async () => {
    const controlPlane = new FakeControlPlane();
    const service = createService(controlPlane, new MemoryStateStorage(), {
      now: () => new Date("2030-01-01T00:10:00.000Z"),
      sleep: (milliseconds) => {
        controlPlane.events.push(`sleep:${milliseconds.toString()}`);
        return Promise.resolve();
      },
    });

    await expect(service.login({
      controlApiBaseUrl: "https://control.example.test",
      localPiWebUrl,
      machineName: "Test machine",
      machineSlug,
    })).rejects.toMatchObject({ code: "authorization_expired" });
    expect(controlPlane.events).toEqual([]);
  });

  it("stops at expiry and never polls an expired device code", async () => {
    const controlPlane = new FakeControlPlane();
    controlPlane.completions = [{ kind: "pending" }];
    let nowMilliseconds = Date.parse("2030-01-01T00:09:58.000Z");
    const service = createService(controlPlane, new MemoryStateStorage(), {
      now: () => new Date(nowMilliseconds),
      sleep: (milliseconds) => {
        nowMilliseconds += milliseconds;
        controlPlane.events.push(`sleep:${milliseconds.toString()}`);
        return Promise.resolve();
      },
    });

    await expect(service.login({
      controlApiBaseUrl: "https://control.example.test",
      localPiWebUrl,
      machineName: "Test machine",
      machineSlug,
    })).rejects.toMatchObject({ code: "authorization_expired" });
    expect(controlPlane.events).toEqual(["sleep:1000", "complete", "sleep:1000"]);
  });

  it("cancels an in-progress polling sleep", async () => {
    const controlPlane = new FakeControlPlane();
    const service = new SafeTunnelService({
      controlPlane,
      stateStorage: new MemoryStateStorage(),
      frpcTrustedCaPath: trustedCaPath,
      now: () => new Date("2030-01-01T00:00:00.000Z"),
    });
    const controller = new AbortController();

    const login = service.login({
      controlApiBaseUrl: "https://control.example.test",
      localPiWebUrl,
      machineName: "Test machine",
      machineSlug,
    }, {}, { signal: controller.signal });
    // Let the flow reach the real initial pre-poll sleep, then cancel it.
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    expect(controlPlane.events).toEqual([]);
    controller.abort();

    await expect(login).rejects.toThrow("Safe Tunnel enablement was cancelled.");
    expect(controlPlane.events).toEqual([]);
  });

  it("rejects a registration bound to a different account before persisting", async () => {
    const controlPlane = new FakeControlPlane();
    controlPlane.registered = {
      ...controlPlane.registered,
      machine: { ...controlPlane.registered.machine, accountId: "account_other" },
    };
    const storage = new MemoryStateStorage();
    const service = createService(controlPlane, storage);
    const observed: string[] = [];

    await expect(service.login({
      controlApiBaseUrl: "https://control.example.test",
      localPiWebUrl,
      machineName: "Test machine",
      machineSlug,
    }, {
      onMachineRegistered: () => { observed.push("registered"); },
    })).rejects.toMatchObject({ code: "invalid_login" });

    // Registration was dispatched, but nothing is persisted or observed for a
    // machine bound to an account other than the approving one.
    expect(controlPlane.registerInputs).toHaveLength(1);
    expect(observed).toEqual([]);
    expect(storage.saves).toEqual([]);
    expect(storage.state.machine).toBeUndefined();
  });

  it("rejects relative advanced frpc paths before Control API or durable effects", async () => {
    const loginControlPlane = new FakeControlPlane();
    const loginStorage = new MemoryStateStorage();
    const startAuthorization = vi.spyOn(loginControlPlane, "startDeviceAuthorization");
    const loginService = createService(loginControlPlane, loginStorage);

    await expect(loginService.login({
      controlApiBaseUrl: "https://control.example.test",
      frpcPath: "relative/frpc",
      localPiWebUrl,
      machineName: "Test machine",
      machineSlug,
    })).rejects.toMatchObject({ code: "invalid_login" });
    expect(startAuthorization).not.toHaveBeenCalled();
    expect(loginControlPlane.registerInputs).toEqual([]);
    expect(loginStorage.saves).toEqual([]);

    const enableControlPlane = new FakeControlPlane();
    const enableStorage = new MemoryStateStorage({
      ...createDefaultSafeTunnelState(),
      machine,
    });
    const enableService = createService(enableControlPlane, enableStorage);

    await expect(enableService.enable({ frpcPath: "relative/frpc" }))
      .rejects.toMatchObject({ code: "invalid_login" });
    expect(enableStorage.state.desiredState).toBe("disabled");
    expect(enableStorage.saves).toEqual([]);
  });

  it("enables, prepares one constrained tunnel, and records a normalized heartbeat", async () => {
    const controlPlane = new FakeControlPlane();
    const storage = new MemoryStateStorage({
      ...createDefaultSafeTunnelState(),
      machine,
    });
    const service = createService(controlPlane, storage);

    await expect(service.enable({ localPiWebUrl })).resolves.toMatchObject({
      desiredState: "enabled",
    });
    const config = await service.getTunnelConfig();
    expect(config).toMatchObject({
      machineId: machine.machineId,
      localPiWebUrl,
      publicUrl,
    });
    expect(config.frpcConfigToml).toContain(`trustedCaFile = "${trustedCaPath}"`);
    expect(config.frpcConfigToml).toContain("localIP = \"127.0.0.1\"");
    expect(config.frpcConfigToml).toContain("localPort = 8504");
    expect(config.frpcConfigToml).toContain("user = \"\"");
    expect(config.frpcConfigToml).toContain(`pi_web_machine_token = "${machineToken}"`);

    await expect(service.recordHeartbeat({ tunnelStatus: "running" })).resolves.toEqual(
      controlPlane.heartbeat,
    );
    expect(controlPlane.heartbeatInputs).toEqual([{
      clientVersion: "pi-web-safe-tunnel/1",
      tunnelStatus: "running",
    }]);
    expect(storage.saves).toHaveLength(1);
  });

  it("rejects a tunnel or heartbeat returned for another machine", async () => {
    const controlPlane = new FakeControlPlane();
    const service = createService(
      controlPlane,
      new MemoryStateStorage({ ...createDefaultSafeTunnelState(), machine }),
    );

    controlPlane.tunnelConfig = { ...controlPlane.tunnelConfig, machineId: "other" };
    await expect(service.getTunnelConfig()).rejects.toMatchObject({
      code: "invalid_tunnel_config",
    });

    controlPlane.heartbeat = { ...controlPlane.heartbeat, machineId: "other" };
    await expect(service.recordHeartbeat({ tunnelStatus: "running" })).rejects.toMatchObject({
      code: "invalid_heartbeat",
    });
  });

  it("durably marks a registration rejected when the Control API rejects its credential", async () => {
    const controlPlane = new FakeControlPlane();
    const storage = new MemoryStateStorage({ ...createDefaultSafeTunnelState(), machine });
    const service = createService(controlPlane, storage);
    controlPlane.heartbeatError = new SafeTunnelControlPlaneError(
      "authentication_failed",
      "record_heartbeat",
    );

    await expect(service.recordHeartbeat({ tunnelStatus: "running" })).rejects.toBe(
      controlPlane.heartbeatError,
    );
    expect(storage.state.machine?.credentialStatus).toBe("rejected");
    await expect(service.enable()).rejects.toMatchObject({ code: "credentials_rejected" });
  });

  it("keeps sustained heartbeat work and state size constant with real file storage", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-web-safe-tunnel-heartbeat-"));
    tempDirectories.push(directory);
    const filePath = join(directory, "safe-tunnel", "config.json");
    const storage = new FileSafeTunnelStateStorage({
      filePath,
      platform: "linux",
    });
    await storage.save({
      ...createDefaultSafeTunnelState(),
      desiredState: "enabled",
      machine,
    });
    const before = await readFile(filePath, "utf8");
    const beforeSize = (await stat(filePath)).size;
    const save = vi.spyOn(storage, "save");
    const controlPlane = new FakeControlPlane();
    const service = createService(controlPlane, storage);

    for (let index = 0; index < 300; index += 1) {
      await service.recordHeartbeat({ tunnelStatus: "running" });
    }

    expect(controlPlane.heartbeatInputs).toHaveLength(300);
    expect(save).not.toHaveBeenCalled();
    expect(await readFile(filePath, "utf8")).toBe(before);
    expect((await stat(filePath)).size).toBe(beforeSize);
    expect(before).not.toContain("credentialBoundary");
  });
});

describe("applySafeTunnelLocalTarget", () => {
  it("rewrites only the local target and binds PI WEB-owned relay trust", () => {
    const prepared = applySafeTunnelLocalTarget(
      new FakeControlPlane().tunnelConfig,
      "http://127.0.0.1:8600",
      trustedCaPath,
      machineToken,
    );

    expect(prepared.frpcConfigToml).toContain("localPort = 8600");
    expect(prepared.frpcConfigToml).toContain(`trustedCaFile = "${trustedCaPath}"`);
    expect(prepared.frpcConfigToml).not.toContain("localPort = 8504");
  });

  it("rejects provider configuration outside the one-proxy contract", () => {
    const config = new FakeControlPlane().tunnelConfig;
    expect(() => applySafeTunnelLocalTarget({
      ...config,
      frpcConfigToml: `${config.frpcConfigToml}\n[[proxies]]\nname = "extra"\n`,
    }, localPiWebUrl, trustedCaPath, machineToken)).toThrow(SafeTunnelServiceError);
  });
});

function createService(
  controlPlane: SafeTunnelControlPlane,
  stateStorage: SafeTunnelStateStorage,
  options: {
    readonly now?: () => Date;
    readonly sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  } = {},
): SafeTunnelService {
  return new SafeTunnelService({
    controlPlane,
    stateStorage,
    frpcTrustedCaPath: trustedCaPath,
    now: options.now ?? (() => new Date("2030-01-01T00:00:00.000Z")),
    ...(options.sleep === undefined ? { sleep: () => Promise.resolve() } : { sleep: options.sleep }),
  });
}

class MemoryStateStorage implements SafeTunnelStateStorage {
  readonly filePath = "/private/safe-tunnel/config.json";
  readonly saves: SafeTunnelPersistedState[] = [];

  constructor(public state: SafeTunnelPersistedState = createDefaultSafeTunnelState()) {}

  load(): Promise<LoadedSafeTunnelState> {
    return Promise.resolve({ exists: this.saves.length > 0 || this.state.machine !== undefined, state: this.state });
  }

  save(state: SafeTunnelPersistedState): Promise<void> {
    this.state = state;
    this.saves.push(state);
    return Promise.resolve();
  }
}

class FakeControlPlane implements SafeTunnelControlPlane {
  readonly device: SafeTunnelDeviceAuthorization = {
    deviceCode: "device-code-private",
    userCode: "ABCD-EFGH",
    verificationUri: "https://control.example.test/device",
    verificationUriComplete: "https://control.example.test/device?user_code=ABCD-EFGH",
    expiresAt: "2030-01-01T00:10:00.000Z",
    intervalSeconds: 1,
  };
  readonly authorization: SafeTunnelApprovedDeviceAuthorization = {
    accessToken: connectorToken,
    expiresAt: "2030-01-01T01:00:00.000Z",
    account: { id: "account_123", publicNamespace: "account" },
  };
  registered: SafeTunnelRegisteredMachine = {
    machine: {
      id: machine.machineId,
      accountId: "account_123",
      name: "Test machine",
      slug: hostedMachineSlug,
    },
    publicHostname: hostedPublicHostname,
    publicUrl,
    machineToken,
  };
  tunnelConfig: SafeTunnelMachineTunnelConfig = {
    machineId: machine.machineId,
    publicHostname: hostedPublicHostname,
    publicUrl,
    localPiWebUrl,
    proxyName: hostedProxyName,
    frpcConfigToml: hostedFrpcConfigToml,
  };
  heartbeat: SafeTunnelMachineHeartbeat = {
    machineId: machine.machineId,
    lastSeenAt: "2030-01-01T00:00:00.000Z",
    nextHeartbeatSeconds: 30,
  };
  completions: (SafeTunnelDeviceAuthorizationCompletion | Error)[] = [];
  readonly events: string[] = [];
  heartbeatError: Error | undefined;
  readonly heartbeatInputs: {
    readonly clientVersion: string;
    readonly tunnelStatus: string;
    readonly errorMessage?: string;
  }[] = [];
  readonly registerInputs: {
    readonly connectorAccessToken: string;
    readonly machineSlug: string;
  }[] = [];

  startDeviceAuthorization(): Promise<SafeTunnelDeviceAuthorization> {
    return Promise.resolve(this.device);
  }

  completeDeviceAuthorization(): Promise<SafeTunnelDeviceAuthorizationCompletion> {
    this.events.push("complete");
    const next = this.completions.shift();
    if (next === undefined) {
      return Promise.resolve({ kind: "approved", authorization: this.authorization });
    }
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  }

  registerMachine(input: {
    readonly connectorAccessToken: string;
    readonly machineSlug: string;
  }): Promise<SafeTunnelRegisteredMachine> {
    this.registerInputs.push(input);
    return Promise.resolve(this.registered);
  }

  getMachineTunnelConfig(): Promise<SafeTunnelMachineTunnelConfig> {
    return Promise.resolve(this.tunnelConfig);
  }

  recordMachineHeartbeat(
    _credentials: unknown,
    input: {
      readonly clientVersion: string;
      readonly tunnelStatus: string;
      readonly errorMessage?: string;
    },
  ): Promise<SafeTunnelMachineHeartbeat> {
    this.heartbeatInputs.push(input);
    return this.heartbeatError === undefined
      ? Promise.resolve(this.heartbeat)
      : Promise.reject(this.heartbeatError);
  }
}
