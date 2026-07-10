import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  defaultSafeTunnelConnectorCommand,
  SafeTunnelConnectorManager,
  safeTunnelConnectorAutoInstallEnvVar,
  safeTunnelConnectorBinEnvVar,
  safeTunnelConnectorInstallDirEnvVar,
  safeTunnelConnectorNpmCommandEnvVar,
  safeTunnelConnectorPackageEnvVar,
  type SafeTunnelConnectorCommandInvocation,
  type SafeTunnelConnectorCommandRunner,
  type SafeTunnelConnectorCommandRunOptions,
  type SafeTunnelConnectorCommandRunResult,
} from "./safeTunnelConnectorManager.js";

let tempDir: string;
let runner: FakeConnectorRunner;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "pi-web-safe-tunnel-manager-test-"));
  runner = new FakeConnectorRunner();
});

afterEach(async () => {
  await rm(tempDir, { force: true, recursive: true });
});

describe("SafeTunnelConnectorManager", () => {
  it("reports an installable managed connector without installing during status", async () => {
    runner.missingCommands.add(defaultSafeTunnelConnectorCommand);
    const manager = createManager({ XDG_DATA_HOME: tempDir });

    const status = await manager.status();
    const managedCommand = join(tempDir, "pi-web", "safe-tunnel-connector", "node_modules", ".bin", "pi-web-tunnel");

    expect(status).toEqual({
      command: managedCommand,
      state: "installable",
      error: "spawn ENOENT",
      install: {
        binName: "pi-web-tunnel",
        command: managedCommand,
        enabled: true,
        installDirectory: join(tempDir, "pi-web", "safe-tunnel-connector"),
        installerCommand: "npm",
        packageSpec: "@jmfederico/pi-web-tunnel",
      },
    });
    expect(runner.runCalls).toEqual([{ command: "pi-web-tunnel", args: ["status", "--json"] }]);
  });

  it("installs the managed connector on first use after the PATH command is unavailable", async () => {
    runner.missingCommands.add(defaultSafeTunnelConnectorCommand);
    const manager = createManager({ XDG_DATA_HOME: tempDir });
    const managedCommand = join(tempDir, "pi-web", "safe-tunnel-connector", "node_modules", ".bin", "pi-web-tunnel");

    await expect(manager.ensureCommand()).resolves.toBe(managedCommand);

    expect(runner.runCalls).toEqual([
      { command: "pi-web-tunnel", args: ["status", "--json"] },
      { command: "npm", args: ["install", "--prefix", join(tempDir, "pi-web", "safe-tunnel-connector"), "--no-audit", "--no-fund", "@jmfederico/pi-web-tunnel"] },
      { command: managedCommand, args: ["status", "--json"] },
    ]);
  });

  it("uses env overrides for package, bin, install directory, and installer command", async () => {
    runner.missingCommands.add(defaultSafeTunnelConnectorCommand);
    const installDirectory = join(tempDir, "custom-install");
    const manager = createManager({
      [safeTunnelConnectorBinEnvVar]: "custom-tunnel",
      [safeTunnelConnectorInstallDirEnvVar]: installDirectory,
      [safeTunnelConnectorNpmCommandEnvVar]: "/opt/npm",
      [safeTunnelConnectorPackageEnvVar]: "@example/pi-web-tunnel@1.2.3",
    });
    const managedCommand = join(installDirectory, "node_modules", ".bin", "custom-tunnel");

    await expect(manager.ensureCommand()).resolves.toBe(managedCommand);

    expect(runner.runCalls).toEqual([
      { command: "pi-web-tunnel", args: ["status", "--json"] },
      { command: "/opt/npm", args: ["install", "--prefix", installDirectory, "--no-audit", "--no-fund", "@example/pi-web-tunnel@1.2.3"] },
      { command: managedCommand, args: ["status", "--json"] },
    ]);
  });

  it("respects disabled automatic installation", async () => {
    runner.missingCommands.add(defaultSafeTunnelConnectorCommand);
    const manager = createManager({ [safeTunnelConnectorAutoInstallEnvVar]: "false" });

    await expect(manager.status()).resolves.toEqual({ command: "pi-web-tunnel", state: "unavailable", error: "spawn ENOENT" });
    await expect(manager.ensureCommand()).rejects.toThrow("PI WEB Safe Tunnel connector command is unavailable: spawn ENOENT");
    expect(runner.runCalls).toEqual([
      { command: "pi-web-tunnel", args: ["status", "--json"] },
      { command: "pi-web-tunnel", args: ["status", "--json"] },
    ]);
  });
});

function createManager(env: Record<string, string | undefined>): SafeTunnelConnectorManager {
  return new SafeTunnelConnectorManager({
    commandRunner: runner,
    cwd: process.cwd(),
    env,
    fileExists: () => false,
    homeDirectory: tempDir,
    platform: "linux",
  });
}

class FakeConnectorRunner implements SafeTunnelConnectorCommandRunner {
  readonly missingCommands = new Set<string>();
  readonly runCalls: SafeTunnelConnectorCommandInvocation[] = [];

  run(invocation: SafeTunnelConnectorCommandInvocation, options: SafeTunnelConnectorCommandRunOptions): Promise<SafeTunnelConnectorCommandRunResult> {
    void options;
    this.runCalls.push(invocation);
    if (this.missingCommands.has(invocation.command)) return Promise.reject(new Error("spawn ENOENT"));
    return Promise.resolve(commandResult({}));
  }
}

function commandResult(overrides: Partial<SafeTunnelConnectorCommandRunResult>): SafeTunnelConnectorCommandRunResult {
  return {
    exitCode: 0,
    stdout: "",
    stderr: "",
    timedOut: false,
    ...overrides,
  };
}
