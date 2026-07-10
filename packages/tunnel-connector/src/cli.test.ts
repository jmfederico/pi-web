import { describe, expect, it } from "vitest";

import { FrpcProcessManager } from "@jmfederico/pi-web-tunnel-frp-engine";

import {
  type CliDependencies,
  type OutputSink,
  discoverConnectorConfigPath,
  parseLoginArgs,
  parseRegisterMachineArgs,
  parseStartArgs,
  parseStatusArgs,
  runCli,
} from "./cli.js";
import { type ConnectorConfig, createDefaultConnectorConfig } from "./config-storage.js";
import {
  createNodeConnectorRuntimeDependencies,
  type FetchLikeRequestInit,
  type FetchLikeResponse,
} from "./connector-runtime.js";

interface CapturedSink {
  readonly output: () => string;
  readonly sink: OutputSink;
}

function createCapturedSink(): CapturedSink {
  let output = "";

  return {
    output: () => output,
    sink: {
      write(chunk: string): void {
        output = `${output}${chunk}`;
      },
    },
  };
}

function createJsonResponse(status: number, body: unknown): FetchLikeResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  };
}

function createCliDependencies(argv: readonly string[]): CliDependencies {
  const stdout = createCapturedSink();
  const stderr = createCapturedSink();

  return {
    argv,
    createProcessManager: () => new FrpcProcessManager(),
    env: {},
    fetch: () => Promise.reject(new Error("fetch not configured in test")),
    fileExists: () => false,
    homeDirectory: "/home/pi",
    now: () => new Date("2026-07-03T12:00:00.000Z"),
    pid: 4321,
    platform: "linux",
    processExists: () => false,
    readConfig: () => createDefaultConnectorConfig(),
    registerSignalHandler: () => undefined,
    runtime: createNodeConnectorRuntimeDependencies("linux"),
    signalProcess: () => undefined,
    sleep: () => Promise.resolve(),
    writeConfig: () => undefined,
    stderr: stderr.sink,
    stdout: stdout.sink,
  };
}

describe("connector config-path discovery", () => {
  it("uses the XDG config root when it is available", () => {
    expect(discoverConnectorConfigPath({
      env: { XDG_CONFIG_HOME: "/tmp/pi-config" },
      homeDirectory: "/home/pi",
      platform: "linux",
    })).toBe("/tmp/pi-config/pi-web-tunnel/config.json");
  });

  it("falls back to the user's home config directory on POSIX platforms", () => {
    expect(discoverConnectorConfigPath({
      env: {},
      homeDirectory: "/home/pi",
      platform: "darwin",
    })).toBe("/home/pi/.config/pi-web-tunnel/config.json");
  });

  it("uses APPDATA on Windows", () => {
    expect(discoverConnectorConfigPath({
      env: { APPDATA: "C:\\Users\\pi\\AppData\\Roaming" },
      homeDirectory: "C:\\Users\\pi",
      platform: "win32",
    })).toBe("C:\\Users\\pi\\AppData\\Roaming\\pi-web-tunnel\\config.json");
  });
});

describe("pi-web-tunnel CLI", () => {
  it("prints help with the connector command shapes", async () => {
    const stdout = createCapturedSink();

    const exitCode = await runCli({
      ...createCliDependencies(["--help"]),
      stdout: stdout.sink,
    });

    expect(exitCode).toBe(0);
    expect(stdout.output()).toContain("  login             Authenticate and register this machine with the hosted service.\n");
    expect(stdout.output()).toContain("  register-machine  Persist bootstrap-issued machine credentials locally.\n");
    expect(stdout.output()).toContain("  start             Start the PI WEB Safe Tunnel connector.\n");
    expect(stdout.output()).toContain("  status [--json]   Show connector status and the discovered config path.\n");
    expect(stdout.output()).toContain("  stop              Stop the PI WEB Safe Tunnel connector.\n");
  });

  it("prints the discovered config path", async () => {
    const stdout = createCapturedSink();
    const stderr = createCapturedSink();

    const exitCode = await runCli({
      ...createCliDependencies(["config-path"]),
      stderr: stderr.sink,
      stdout: stdout.sink,
    });

    expect(exitCode).toBe(0);
    expect(stdout.output()).toBe("/home/pi/.config/pi-web-tunnel/config.json\n");
    expect(stderr.output()).toBe("");
  });

  it("reports not configured status when no config file exists", async () => {
    const stdout = createCapturedSink();

    const exitCode = await runCli({
      ...createCliDependencies(["status"]),
      stdout: stdout.sink,
    });

    expect(exitCode).toBe(0);
    expect(stdout.output()).toContain("Status: not configured\n");
    expect(stdout.output()).toContain("Config path: /home/pi/.config/pi-web-tunnel/config.json\n");
    expect(stdout.output()).toContain("Runtime: stopped\n");
  });

  it("prints structured JSON status without exposing the machine token", async () => {
    const stdout = createCapturedSink();
    const stderr = createCapturedSink();
    const configPath = "/home/pi/.config/pi-web-tunnel/config.json";
    const pidFilePath = "/home/pi/.config/pi-web-tunnel/connector.pid";
    const frpcConfigPath = "/home/pi/.config/pi-web-tunnel/frpc.toml";
    const logPath = "/home/pi/.config/pi-web-tunnel/connector.log";
    const existingFiles = new Set([configPath, pidFilePath, frpcConfigPath, logPath]);
    const runtimeFiles = new Map([
      [pidFilePath, "9988\n"],
      [logPath, "\u001B[31mfrpc failed\u001B[0m\n"],
    ]);

    const exitCode = await runCli({
      ...createCliDependencies(["status", "--json"]),
      fileExists: (path) => existingFiles.has(path),
      processExists: (pid) => pid === 9988,
      readConfig: () => ({
        localPiWebUrl: "http://127.0.0.1:9000",
        schemaVersion: 2,
        frpcPath: "/usr/local/bin/frpc",
        machine: {
          controlApiBaseUrl: "https://control.example.test",
          machineId: "machine_abc",
          machineToken: "piwt_mtok_v1_secret",
          machineSlug: "dev-box",
          publicUrl: "https://dev-box.ns.tunnels.pi-web.dev",
        },
      }),
      runtime: {
        ...createNodeConnectorRuntimeDependencies("linux"),
        readFile: (path) => {
          const contents = runtimeFiles.get(path);
          if (contents === undefined) throw new Error(`ENOENT: ${path}`);
          return contents;
        },
      },
      stderr: stderr.sink,
      stdout: stdout.sink,
    });

    expect(exitCode).toBe(0);
    expect(stderr.output()).toBe("");
    expect(stdout.output()).not.toContain("piwt_mtok_v1_secret");
    const parsed: unknown = JSON.parse(stdout.output());
    expect(parsed).toEqual({
      statusVersion: 1,
      config: {
        path: configPath,
        exists: true,
        state: "registered",
        localPiWebUrl: "http://127.0.0.1:9000",
        frpcPathConfigured: true,
        machine: {
          controlApiBaseUrl: "https://control.example.test",
          machineId: "machine_abc",
          machineSlug: "dev-box",
          publicUrl: "https://dev-box.ns.tunnels.pi-web.dev",
        },
      },
      runtime: {
        pidFilePath,
        frpcConfigPath,
        frpcConfigExists: true,
        state: "running",
        pid: 9988,
      },
      log: {
        path: logPath,
        exists: true,
        tailMaxCharacters: 12_000,
        tail: "frpc failed\n",
      },
    });
    expect(parsed).not.toHaveProperty(["config", "machine", "machineToken"]);
  });

  it("reports no running connector on stop when no PID file exists", async () => {
    const stdout = createCapturedSink();
    const signals: { pid: number; signal: NodeJS.Signals }[] = [];

    const exitCode = await runCli({
      ...createCliDependencies(["stop"]),
      runtime: {
        ...createNodeConnectorRuntimeDependencies("linux"),
        readFile: () => {
          throw new Error("ENOENT");
        },
      },
      signalProcess: (pid, signal) => {
        signals.push({ pid, signal });
      },
      stdout: stdout.sink,
    });

    expect(exitCode).toBe(0);
    expect(signals).toEqual([]);
    expect(stdout.output()).toContain("No running PI WEB Safe Tunnel connector was found.\n");
  });

  it("signals the recorded connector PID on stop", async () => {
    const stdout = createCapturedSink();
    const signals: { pid: number; signal: NodeJS.Signals }[] = [];

    const exitCode = await runCli({
      ...createCliDependencies(["stop"]),
      runtime: {
        ...createNodeConnectorRuntimeDependencies("linux"),
        readFile: () => "9988\n",
      },
      signalProcess: (pid, signal) => {
        signals.push({ pid, signal });
      },
      stdout: stdout.sink,
    });

    expect(exitCode).toBe(0);
    expect(signals).toEqual([{ pid: 9988, signal: "SIGTERM" }]);
    expect(stdout.output()).toContain("Signalled connector process 9988 to stop.\n");
  });

  it("fails start when no connector config exists", async () => {
    const stderr = createCapturedSink();

    const exitCode = await runCli({
      ...createCliDependencies(["start"]),
      fileExists: () => false,
      stderr: stderr.sink,
    });

    expect(exitCode).toBe(1);
    expect(stderr.output()).toContain("No connector config found.");
  });

  it("runs device login and persists the registered machine credentials", async () => {
    const stdout = createCapturedSink();
    const stderr = createCapturedSink();
    const writes: { configPath: string; config: ConnectorConfig }[] = [];
    const requests: { body?: string; input: string; init?: FetchLikeRequestInit }[] = [];
    const responses: FetchLikeResponse[] = [
      createJsonResponse(202, {
        deviceCode: "piwt_dcode_v1_device",
        userCode: "ABCD-EFGH",
        verificationUri: "https://control.local/device",
        verificationUriComplete: "https://control.local/device?user_code=ABCD-EFGH",
        expiresAt: "2026-07-03T12:10:00.000Z",
        intervalSeconds: 5,
      }),
      createJsonResponse(200, {
        accessToken: "piwt_cat_v1_access",
        tokenType: "Bearer",
        expiresAt: "2026-07-03T12:15:00.000Z",
        account: { id: "acct_123", publicNamespace: "ns-abc123" },
      }),
      createJsonResponse(201, {
        machine: {
          id: "machine_123",
          accountId: "acct_123",
          name: "My Dev Box",
          slug: "my-dev-box",
        },
        publicHostname: "my-dev-box.ns-abc123.tunnels.pi-web.dev",
        publicUrl: "https://my-dev-box.ns-abc123.tunnels.pi-web.dev",
        machineToken: "piwt_mtok_v1_machine",
        tunnelConfigUrl: "/v1/machines/machine_123/tunnel-config",
      }),
    ];
    let responseIndex = 0;

    const exitCode = await runCli({
      ...createCliDependencies([
        "login",
        "--control-api-url",
        "https://control.local/",
        "--machine-name",
        "My Dev Box",
        "--machine-slug",
        "my-dev-box",
        "--local-pi-web-url",
        "http://127.0.0.1:9000",
        "--frpc-path",
        "/usr/local/bin/frpc",
      ]),
      fetch: (input, init) => {
        requests.push({
          input,
          ...(init === undefined ? {} : { init }),
          ...(init?.body === undefined ? {} : { body: init.body }),
        });
        const response = responses[responseIndex];
        responseIndex += 1;

        if (response === undefined) {
          return Promise.reject(new Error(`unexpected fetch call: ${input}`));
        }

        return Promise.resolve(response);
      },
      writeConfig: (configPath, config) => {
        writes.push({ configPath, config });
      },
      stderr: stderr.sink,
      stdout: stdout.sink,
    });

    expect(exitCode).toBe(0);
    expect(stderr.output()).toBe("");
    expect(requests.map((request) => request.input)).toEqual([
      "https://control.local/v1/device/start",
      "https://control.local/v1/device/complete",
      "https://control.local/v1/machines",
    ]);
    expect(requests[2]?.init?.headers?.["authorization"]).toBe("Bearer piwt_cat_v1_access");
    expect(requests[2]?.body).toBe(
      "{\"name\":\"My Dev Box\",\"slug\":\"my-dev-box\",\"localPiWebUrl\":\"http://127.0.0.1:9000\",\"connectorVersion\":\"pi-web-tunnel/0.0.0\"}",
    );
    expect(writes).toEqual([
      {
        configPath: "/home/pi/.config/pi-web-tunnel/config.json",
        config: {
          localPiWebUrl: "http://127.0.0.1:9000",
          schemaVersion: 2,
          frpcPath: "/usr/local/bin/frpc",
          machine: {
            controlApiBaseUrl: "https://control.local/",
            machineId: "machine_123",
            machineToken: "piwt_mtok_v1_machine",
            machineSlug: "my-dev-box",
            publicUrl: "https://my-dev-box.ns-abc123.tunnels.pi-web.dev",
          },
        },
      },
    ]);
    expect(stdout.output()).toContain("User code: ABCD-EFGH\n");
    expect(stdout.output()).toContain("Public URL: https://my-dev-box.ns-abc123.tunnels.pi-web.dev\n");
  });

  it("persists bootstrap-issued machine credentials on register-machine", async () => {
    const stdout = createCapturedSink();
    const stderr = createCapturedSink();
    const writes: { configPath: string; config: ConnectorConfig }[] = [];

    const exitCode = await runCli({
      ...createCliDependencies([
        "register-machine",
        "--control-api-url",
        "http://127.0.0.1:8787",
        "--machine-id",
        "machine_abc",
        "--machine-token",
        "piwt_mtok_v1_secret",
        "--frpc-path",
        "/usr/local/bin/frpc",
      ]),
      writeConfig: (configPath, config) => {
        writes.push({ configPath, config });
      },
      stderr: stderr.sink,
      stdout: stdout.sink,
    });

    expect(exitCode).toBe(0);
    expect(stderr.output()).toBe("");
    expect(writes).toEqual([
      {
        configPath: "/home/pi/.config/pi-web-tunnel/config.json",
        config: {
          localPiWebUrl: "http://127.0.0.1:8504",
          schemaVersion: 2,
          frpcPath: "/usr/local/bin/frpc",
          machine: {
            controlApiBaseUrl: "http://127.0.0.1:8787",
            machineId: "machine_abc",
            machineToken: "piwt_mtok_v1_secret",
          },
        },
      },
    ]);
    expect(stdout.output()).toContain("Registered machine credentials for PI WEB Safe Tunnels.\n");
    expect(stdout.output()).toContain("Machine id: machine_abc\n");
  });

  it("fails register-machine when required flags are missing", async () => {
    const stderr = createCapturedSink();

    const exitCode = await runCli({
      ...createCliDependencies(["register-machine", "--machine-id", "machine_abc"]),
      stderr: stderr.sink,
    });

    expect(exitCode).toBe(1);
    expect(stderr.output()).toContain("register-machine requires --control-api-url <url>.");
  });

  it("parses login args", () => {
    expect(parseLoginArgs([
      "--control-api-url",
      "https://control.local",
      "--machine-name",
      "My Dev Box",
      "--machine-slug",
      "my-dev-box",
      "--local-pi-web-url",
      "http://127.0.0.1:9000",
      "--frpc-path",
      "/usr/local/bin/frpc",
    ])).toEqual({
      controlApiBaseUrl: "https://control.local",
      machineName: "My Dev Box",
      machineSlug: "my-dev-box",
      localPiWebUrl: "http://127.0.0.1:9000",
      frpcPath: "/usr/local/bin/frpc",
    });
  });

  it("parses status args", () => {
    expect(parseStatusArgs(["--json"])).toEqual({ json: true });
    expect(parseStatusArgs([])).toEqual({ json: false });
    expect(() => parseStatusArgs(["--verbose"])).toThrow("Unknown status option");
  });

  it("parses start args", () => {
    expect(parseStartArgs(["--frpc-path", "/usr/local/bin/frpc"])).toEqual({
      frpcPath: "/usr/local/bin/frpc",
    });
    expect(parseStartArgs([])).toEqual({});
  });

  it("parses register-machine args", () => {
    expect(parseRegisterMachineArgs([
      "--control-api-url",
      "http://127.0.0.1:8787",
      "--machine-id",
      "machine_abc",
      "--machine-token",
      "piwt_mtok_v1_secret",
      "--local-pi-web-url",
      "http://127.0.0.1:9000",
    ])).toEqual({
      controlApiBaseUrl: "http://127.0.0.1:8787",
      machineId: "machine_abc",
      machineToken: "piwt_mtok_v1_secret",
      localPiWebUrl: "http://127.0.0.1:9000",
    });
  });

  it("rejects unknown commands", async () => {
    const stderr = createCapturedSink();

    const exitCode = await runCli({
      ...createCliDependencies(["frobnicate"]),
      stderr: stderr.sink,
    });

    expect(exitCode).toBe(2);
    expect(stderr.output()).toContain("Unknown command: frobnicate\n");
  });
});
