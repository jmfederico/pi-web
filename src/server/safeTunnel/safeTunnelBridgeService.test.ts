import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createNodeSafeTunnelCommandRunner,
  DefaultSafeTunnelBridgeService,
  type SafeTunnelCommandRunner,
  type SafeTunnelCommandRunResult,
} from "./safeTunnelBridgeService.js";

let tempDir: string;
let runner: FakeCommandRunner;
let service: DefaultSafeTunnelBridgeService;
let nowIndex: number;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "pi-web-safe-tunnel-test-"));
  runner = new FakeCommandRunner();
  runner.statusJson = connectorStatusJson({ configDirectory: join(tempDir, "pi-web-tunnel") });
  nowIndex = 0;
  service = new DefaultSafeTunnelBridgeService({
    commandRunner: runner,
    cwd: process.cwd(),
    env: { XDG_CONFIG_HOME: tempDir, PI_WEB_SAFE_TUNNEL_CONNECTOR_COMMAND: "/usr/local/bin/pi-web-tunnel" },
    fileExists: (path) => runner.fileExists(path),
    homeDirectory: tempDir,
    now: () => new Date(`2026-07-03T00:00:0${(nowIndex += 1).toString()}.000Z`),
    platform: "linux",
  });
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("DefaultSafeTunnelBridgeService", () => {
  it("reports connector availability, missing config, and stopped runtime without failing the status endpoint", async () => {
    runner.nextRunError = new Error("spawn ENOENT");

    const status = await service.status();

    expect(status.connector).toEqual({ command: "/usr/local/bin/pi-web-tunnel", state: "unavailable", error: "spawn ENOENT" });
    expect(status.config).toEqual({ exists: false, path: join(tempDir, "pi-web-tunnel", "config.json"), state: "missing" });
    expect(status.runtime).toEqual({
      pidFilePath: join(tempDir, "pi-web-tunnel", "connector.pid"),
      state: "stopped",
      logPath: join(tempDir, "pi-web-tunnel", "connector.log"),
    });
    expect(runner.runCalls).toEqual([{ command: "/usr/local/bin/pi-web-tunnel", args: ["status", "--json"] }]);
  });

  it("surfaces invalid connector status JSON without returning private config data", async () => {
    runner.statusJson = "not-json";

    const status = await service.status();

    expect(status.connector).toEqual({ command: "/usr/local/bin/pi-web-tunnel", state: "available" });
    expect(status.config.exists).toBe(false);
    expect(status.config.path).toBe(join(tempDir, "pi-web-tunnel", "config.json"));
    expect(status.config.state).toBe("invalid");
    expect(status.config.error).toContain("Unable to parse pi-web-tunnel status --json");
    expect(status.runtime.pidFilePath).toBe(join(tempDir, "pi-web-tunnel", "connector.pid"));
    expect(status.runtime.state).toBe("unknown");
    expect(status.runtime.error).toContain("Unable to parse pi-web-tunnel status --json");
  });

  it("uses the first-party source-tree connector wrapper when no command override is configured", async () => {
    const defaultedService = new DefaultSafeTunnelBridgeService({
      commandRunner: runner,
      cwd: process.cwd(),
      env: { XDG_CONFIG_HOME: tempDir },
      fileExists: (path) => runner.fileExists(path),
      homeDirectory: tempDir,
      now: () => new Date("2026-07-03T00:00:01.000Z"),
      platform: "linux",
    });

    const status = await defaultedService.status();
    const expectedCommand = join(process.cwd(), "scripts", "pi-web-tunnel-dev.sh");

    expect(status.connector).toEqual({ command: expectedCommand, state: "available" });
    expect(runner.runCalls).toEqual([{ command: expectedCommand, args: ["status", "--json"] }]);
  });

  it("reports registered connector status without exposing the machine token", async () => {
    const configDirectory = join(tempDir, "pi-web-tunnel");
    runner.statusJson = connectorStatusJson({
      configDirectory,
      config: {
        exists: true,
        state: "registered",
        localPiWebUrl: "http://127.0.0.1:8504",
        frpcPathConfigured: true,
        machine: {
          controlApiBaseUrl: "https://control.example.test",
          machineId: "mach_123",
          machineToken: "piwt_mtok_v1_secret",
        },
      },
      runtime: { frpcConfigExists: true, pid: 4242, state: "running" },
    });

    const status = await service.status();

    expect(status.connector).toEqual({ command: "/usr/local/bin/pi-web-tunnel", state: "available" });
    expect(status.config).toEqual({
      exists: true,
      path: join(configDirectory, "config.json"),
      state: "registered",
      localPiWebUrl: "http://127.0.0.1:8504",
      frpcPathConfigured: true,
      machine: { controlApiBaseUrl: "https://control.example.test", machineId: "mach_123" },
    });
    expect(status.runtime).toEqual({
      pid: 4242,
      pidFilePath: join(configDirectory, "connector.pid"),
      frpcConfigPath: join(configDirectory, "frpc.toml"),
      frpcConfigExists: true,
      state: "running",
      logPath: join(configDirectory, "connector.log"),
      logExists: false,
      logTailMaxCharacters: 12_000,
    });
    expect(JSON.stringify(status)).not.toContain("piwt_mtok_v1_secret");
  });

  it("reports current tunnel slug and URL from connector structured status without parsing frpc.toml", async () => {
    const configDirectory = join(tempDir, "pi-web-tunnel");
    await mkdir(configDirectory, { recursive: true });
    await writeFile(join(configDirectory, "frpc.toml"), 'customDomains = ["wrong.ns-0e17b6ed7d8cbf18.tunnels.pi-web.dev"]\n');
    runner.statusJson = connectorStatusJson({
      configDirectory,
      config: {
        exists: true,
        state: "registered",
        localPiWebUrl: "http://127.0.0.1:8504",
        frpcPathConfigured: true,
        machine: {
          controlApiBaseUrl: "https://control.example.test",
          machineId: "mach_123",
          machineSlug: "ipad5",
          publicUrl: "https://ipad5.ns-0e17b6ed7d8cbf18.tunnels.pi-web.dev",
        },
      },
      runtime: { frpcConfigExists: true, pid: 4242, state: "running" },
    });

    const status = await service.status();

    expect(status.config.machine).toEqual({
      controlApiBaseUrl: "https://control.example.test",
      machineId: "mach_123",
      machineSlug: "ipad5",
      publicHostname: "ipad5.ns-0e17b6ed7d8cbf18.tunnels.pi-web.dev",
      publicUrl: "https://ipad5.ns-0e17b6ed7d8cbf18.tunnels.pi-web.dev",
    });
  });

  it("starts login as a tracked operation and extracts browser approval details from command output", async () => {
    const loginDeferred = createDeferred<SafeTunnelCommandRunResult>();
    runner.loginDeferred = loginDeferred;

    const response = await service.login({
      controlApiUrl: "https://control.example.test",
      machineName: "My Dev Box",
      machineSlug: "my-dev-box",
      localPiWebUrl: "http://127.0.0.1:8504",
      frpcPath: "/opt/frpc",
    });

    expect(runner.runCalls[1]).toEqual({
      command: "/usr/local/bin/pi-web-tunnel",
      args: [
        "login",
        "--control-api-url",
        "https://control.example.test",
        "--machine-name",
        "My Dev Box",
        "--machine-slug",
        "my-dev-box",
        "--local-pi-web-url",
        "http://127.0.0.1:8504",
        "--frpc-path",
        "/opt/frpc",
      ],
    });
    expect(response.operation.status).toBe("running");
    expect(response.status.activeOperation?.id).toBe(response.operation.id);

    const loginOptions = runner.loginOptions;
    if (loginOptions === undefined) throw new Error("Expected login command options");
    loginOptions.onStdout?.("Starting PI WEB Safe Tunnel login.\nOpen this URL to authorize the connector:\nhttps://control.example.test/device?user_code=ABCD-EFGH\nUser code: ABCD-EFGH\n");

    expect(service.operation(response.operation.id)).toMatchObject({
      status: "running",
      verificationUriComplete: "https://control.example.test/device?user_code=ABCD-EFGH",
      userCode: "ABCD-EFGH",
    });

    loginDeferred.resolve(commandResult({
      stdout: "Starting PI WEB Safe Tunnel login.\nPublic URL: https://my-dev-box.ns.tunnels.example.test\n",
    }));
    await Promise.resolve();

    expect(service.operation(response.operation.id)).toMatchObject({
      status: "succeeded",
      exitCode: 0,
      publicUrl: "https://my-dev-box.ns.tunnels.example.test",
    });
  });

  it("rejects starting the connector before a registered config exists", async () => {
    await expect(service.start({ frpcPath: "/opt/frpc" })).rejects.toMatchObject({
      message: "Register or log in to PI WEB Safe Tunnels before starting the connector.",
      statusCode: 409,
    });
  });

  it("starts the connector as a tracked operation with log capture", async () => {
    const configDirectory = join(tempDir, "pi-web-tunnel");
    const startDeferred = createDeferred<SafeTunnelCommandRunResult>();
    runner.startDeferred = startDeferred;
    runner.statusJson = connectorStatusJson({
      configDirectory,
      config: {
        exists: true,
        state: "registered",
        localPiWebUrl: "http://127.0.0.1:8504",
        frpcPathConfigured: true,
        machine: { controlApiBaseUrl: "https://control.example.test", machineId: "mach_123" },
      },
    });
    runner.startProcessId = 1234;

    const response = await service.start({});

    expect(runner.runCalls[2]).toEqual({ command: "/usr/local/bin/pi-web-tunnel", args: ["start"] });
    expect(runner.startOptions).toMatchObject({
      detached: true,
      logHeader: "\n=== 2026-07-03T00:00:01.000Z /usr/local/bin/pi-web-tunnel start ===\n",
      logPath: join(configDirectory, "connector.log"),
      timeoutMs: 0,
    });
    expect(response.accepted).toBe(true);
    expect(response.connectorProcessId).toBe(1234);
    expect(response.operation).toMatchObject({
      connectorProcessId: 1234,
      kind: "start",
      logPath: join(configDirectory, "connector.log"),
      status: "running",
    });
    expect(response.status.activeOperation?.id).toBe(response.operation.id);

    if (runner.startOptions === undefined) throw new Error("Expected start command options");
    runner.startOptions.onStdout?.("Starting PI WEB Safe Tunnel connector.\nPublic URL: https://dev-box.ns.tunnels.example.test\n");
    runner.startOptions.onStderr?.("frpc failed to connect\n");

    const runningOperation = service.operation(response.operation.id);
    expect(runningOperation).toMatchObject({
      publicUrl: "https://dev-box.ns.tunnels.example.test",
      stderr: "frpc failed to connect\n",
      stdout: "Starting PI WEB Safe Tunnel connector.\nPublic URL: https://dev-box.ns.tunnels.example.test\n",
    });
    expect(runningOperation?.logTail).toContain("frpc failed to connect");

    startDeferred.resolve(commandResult({
      exitCode: 1,
      stdout: "Starting PI WEB Safe Tunnel connector.\nPublic URL: https://dev-box.ns.tunnels.example.test\n",
      stderr: "frpc failed to connect\n",
    }));
    await Promise.resolve();

    expect(service.operation(response.operation.id)).toMatchObject({
      error: "Safe Tunnel start exited with code 1.",
      exitCode: 1,
      status: "failed",
    });
  });

  it("reports the sanitized connector log tail from connector structured status", async () => {
    const configDirectory = join(tempDir, "pi-web-tunnel");
    runner.statusJson = connectorStatusJson({
      configDirectory,
      log: {
        exists: true,
        tail: `${"x".repeat(12_050)}\n\u001B[1;33mfrpc failed\u001B[0m\n`,
      },
    });

    const status = await service.status();

    expect(status.runtime.pidFilePath).toBe(join(configDirectory, "connector.pid"));
    expect(status.runtime.state).toBe("stopped");
    expect(status.runtime.logPath).toBe(join(configDirectory, "connector.log"));
    expect(status.runtime.logExists).toBe(true);
    expect(status.runtime.logTail).toContain("frpc failed");
    expect(status.runtime.logTail?.length).toBeLessThanOrEqual(12_000);
    expect(status.runtime.logTail).not.toContain("\u001B");
  });

  it("truncates previous tracked connector logs while capturing current process output", async () => {
    const nodeRunner = createNodeSafeTunnelCommandRunner();
    const logPath = join(tempDir, "pi-web-tunnel", "connector.log");
    await mkdir(join(tempDir, "pi-web-tunnel"), { recursive: true });
    await writeFile(logPath, "old connector output that should be replaced\n");

    const result = await nodeRunner.run({
      command: process.execPath,
      args: ["-e", "console.log('frpc stdout'); console.error('frpc stderr');"],
    }, {
      logHeader: "header\n",
      logPath,
      maxOutputCharacters: 24_000,
      timeoutMs: 15_000,
    });

    const logContents = await readFileWhen(logPath, (contents) => contents.includes("frpc stdout") && contents.includes("frpc stderr"));

    expect(result.stdout).toContain("frpc stdout");
    expect(result.stderr).toContain("frpc stderr");
    expect(logContents).toContain("header\n");
    expect(logContents).toContain("frpc stdout");
    expect(logContents).toContain("frpc stderr");
    expect(logContents).not.toContain("old connector output");
  });

  it("runs stop through the connector command and returns redacted command output", async () => {
    runner.stopResult = commandResult({ stdout: "No running PI WEB Safe Tunnel connector was found.\n" });

    const response = await service.stop();

    expect(runner.runCalls[1]).toEqual({ command: "/usr/local/bin/pi-web-tunnel", args: ["stop"] });
    expect(response.command).toEqual({ exitCode: 0, stdout: "No running PI WEB Safe Tunnel connector was found.\n", stderr: "" });
  });
});

type CommandInvocation = Parameters<SafeTunnelCommandRunner["run"]>[0];
type CommandRunOptions = Parameters<SafeTunnelCommandRunner["run"]>[1];
interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly reject: (error: unknown) => void;
  readonly resolve: (value: T) => void;
}

class FakeCommandRunner implements SafeTunnelCommandRunner {
  loginDeferred: Deferred<SafeTunnelCommandRunResult> | undefined;
  loginOptions: CommandRunOptions | undefined;
  nextRunError: Error | undefined;
  runCalls: CommandInvocation[] = [];
  startDeferred: Deferred<SafeTunnelCommandRunResult> | undefined;
  startOptions: CommandRunOptions | undefined;
  startProcessId: number | undefined;
  statusJson = "";
  stopResult: SafeTunnelCommandRunResult = commandResult({});

  run(invocation: CommandInvocation, options: CommandRunOptions): Promise<SafeTunnelCommandRunResult> {
    this.runCalls.push(invocation);
    if (this.nextRunError !== undefined) {
      const error = this.nextRunError;
      this.nextRunError = undefined;
      return Promise.reject(error);
    }

    const command = invocation.args[0];
    if (command === "status" && invocation.args[1] === "--json") return Promise.resolve(commandResult({ stdout: this.statusJson }));
    if (command === "login") {
      this.loginOptions = options;
      return this.loginDeferred?.promise ?? Promise.resolve(commandResult({}));
    }

    if (command === "start") {
      this.startOptions = options;
      if (this.startProcessId !== undefined) options.onProcessId?.(this.startProcessId);
      return this.startDeferred?.promise ?? Promise.resolve(commandResult({}));
    }

    if (command === "stop") return Promise.resolve(this.stopResult);
    return Promise.resolve(commandResult({}));
  }

  fileExists(path: string): boolean {
    return existsSync(path);
  }
}

function commandResult(overrides: Partial<SafeTunnelCommandRunResult>): SafeTunnelCommandRunResult {
  return {
    exitCode: 0,
    stdout: "",
    stderr: "",
    timedOut: false,
    ...overrides,
  };
}

function connectorStatusJson(options: {
  readonly configDirectory: string;
  readonly config?: Record<string, unknown>;
  readonly log?: Record<string, unknown>;
  readonly runtime?: Record<string, unknown>;
}): string {
  const configPath = join(options.configDirectory, "config.json");
  const frpcConfigPath = join(options.configDirectory, "frpc.toml");
  const logPath = join(options.configDirectory, "connector.log");
  const pidFilePath = join(options.configDirectory, "connector.pid");

  return JSON.stringify({
    statusVersion: 1,
    config: {
      path: configPath,
      exists: false,
      state: "missing",
      ...options.config,
    },
    runtime: {
      pidFilePath,
      frpcConfigPath,
      frpcConfigExists: false,
      state: "stopped",
      ...options.runtime,
    },
    log: {
      path: logPath,
      exists: false,
      tailMaxCharacters: 12_000,
      ...options.log,
    },
  });
}

async function readFileWhen(path: string, predicate: (contents: string) => boolean): Promise<string> {
  let contents = "";

  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (existsSync(path)) {
      contents = readFileSync(path, "utf8");
      if (predicate(contents)) return contents;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  return contents;
}

function createDeferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {
    throw new Error("Deferred resolver was not initialized");
  };
  let reject: (error: unknown) => void = () => {
    throw new Error("Deferred rejecter was not initialized");
  };
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}
