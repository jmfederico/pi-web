import { spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import {
  LaunchdNativeServiceProbe,
  SpawnProbeCommandRunner,
  SystemdNativeServiceProbe,
  launchdProbePlist,
  nativeServicePrerequisiteShellCheck,
  nodeVersionCheckScript,
  systemdRunArguments,
  type LaunchdProbeFileSystem,
  type ProbeCommandResult,
  type ProbeCommandRunner,
} from "./serviceProbe.js";
import type { NativeServiceProbeRequest } from "./servicePlan.js";

function request(kind: "systemd" | "launchd" = "systemd"): NativeServiceProbeRequest {
  return {
    purpose: "plan-validation",
    backend: { kind, label: kind },
    shell: {
      name: "zsh",
      executable: "/bin/zsh",
      source: "detected",
      detectedExecutable: "/bin/zsh",
    },
    environment: { PI_WEB_CONFIG: "/home/user/config with space.json" },
    workingDirectory: "/checkout with space",
    prerequisites: [{
      id: "sessiond.command.npm",
      kind: "command-available",
      command: "npm",
      description: "npm is available",
    }],
  };
}

function completed(status = 0, stdout = "", stderr = ""): ProbeCommandResult {
  return { kind: "completed", status, stdout, stderr };
}

function marker(id: string, status: "satisfied" | "unsatisfied"): string {
  return `PI_WEB_PROBE_fixed\t${Buffer.from(id).toString("base64")}\t${status}\n`;
}

function queuedRunner(results: ProbeCommandResult[]): ProbeCommandRunner & { calls: { command: string; args: readonly string[]; timeoutMs: number }[] } {
  const calls: { command: string; args: readonly string[]; timeoutMs: number }[] = [];
  return {
    calls,
    run: (command, args, timeoutMs) => {
      calls.push({ command, args, timeoutMs });
      const result = results.shift();
      if (result === undefined) throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
      return Promise.resolve(result);
    },
  };
}

describe("systemd authoritative native-service probe", () => {
  it("runs the exact shell, environment, and cwd in a transient user service", async () => {
    const runner = queuedRunner([completed(0, `login banner\n${marker("sessiond.command.npm", "satisfied")}`)]);
    const probe = new SystemdNativeServiceProbe({
      commandRunner: runner,
      createUniqueId: () => "fixed",
      commandTimeoutMs: 3210,
    });

    await expect(probe.run(request())).resolves.toEqual({
      kind: "completed",
      outcomes: [{ prerequisiteId: "sessiond.command.npm", status: "satisfied", detail: null }],
    });
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]).toMatchObject({ command: "systemd-run", timeoutMs: 3210 });
    expect(runner.calls[0]?.args).toEqual([
      "--user",
      "--wait",
      "--collect",
      "--pipe",
      "--quiet",
      "--unit=pi-web-authoritative-probe-fixed.service",
      "--property=RuntimeMaxSec=15s",
      "--property=TimeoutStopSec=5s",
      "--setenv=PI_WEB_CONFIG=/home/user/config with space.json",
      "--working-directory=/checkout with space",
      "/usr/bin/env",
      "/bin/zsh",
      "-lc",
      expect.stringContaining("command -v 'npm'"),
    ]);
  });

  it("reports requirement failures as completed and malformed output as infrastructure", async () => {
    const unsatisfiedRunner = queuedRunner([completed(0, marker("sessiond.command.npm", "unsatisfied"))]);
    const dependencies = { commandRunner: unsatisfiedRunner, createUniqueId: () => "fixed", commandTimeoutMs: 100 };
    await expect(new SystemdNativeServiceProbe(dependencies).run(request())).resolves.toEqual({
      kind: "completed",
      outcomes: [{
        prerequisiteId: "sessiond.command.npm",
        status: "unsatisfied",
        detail: "npm did not resolve to an external executable in the native service environment.",
      }],
    });

    const malformedRunner = queuedRunner([completed(0, "no marker here")]);
    await expect(new SystemdNativeServiceProbe({ ...dependencies, commandRunner: malformedRunner }).run(request())).resolves.toMatchObject({
      kind: "infrastructure-failure",
      reason: "malformed-output",
    });
  });

  it("bounds a hung unit, cleans it up, and reports the timeout", async () => {
    const runner = queuedRunner([
      { kind: "timeout", stdout: "", stderr: "" },
      completed(0),
      completed(0, "not-found\n"),
    ]);
    const probe = new SystemdNativeServiceProbe({
      commandRunner: runner,
      createUniqueId: () => "fixed",
      commandTimeoutMs: 100,
    });

    await expect(probe.run(request())).resolves.toMatchObject({
      kind: "infrastructure-failure",
      reason: "timeout",
    });
    expect(runner.calls.map(({ command }) => command)).toEqual(["systemd-run", "systemctl", "systemctl"]);
  });

  it("bounds a hung unit and distinguishes cleanup failure", async () => {
    const runner = queuedRunner([
      { kind: "timeout", stdout: "", stderr: "" },
      completed(0),
      completed(0, "loaded\n", "unit still loaded"),
    ]);
    const probe = new SystemdNativeServiceProbe({
      commandRunner: runner,
      createUniqueId: () => "fixed",
      commandTimeoutMs: 100,
    });

    const result = await probe.run(request());
    expect(result).toMatchObject({ kind: "infrastructure-failure", reason: "cleanup" });
    expect(result.kind === "infrastructure-failure" && result.message).toContain("unit still loaded");
    expect(runner.calls.map(({ command, args }) => [command, ...args.slice(0, 3)])).toEqual([
      ["systemd-run", "--user", "--wait", "--collect"],
      ["systemctl", "--user", "stop", "pi-web-authoritative-probe-fixed.service"],
      ["systemctl", "--user", "show", "pi-web-authoritative-probe-fixed.service"],
    ]);
  });
});

describe("spawn probe command runner", () => {
  it("bounds captured command output", async () => {
    const runner = new SpawnProbeCommandRunner();
    const result = await runner.run(
      process.execPath,
      ["-e", "process.stdout.write('x'.repeat(2 * 1024 * 1024))"],
      5_000,
    );

    expect(result).toMatchObject({ kind: "output-limit" });
    expect(result.stdout.length).toBeLessThanOrEqual(1024 * 1024);
  });

  it("settles a timeout without waiting for inherited pipes to close", async () => {
    const runner = new SpawnProbeCommandRunner();
    const childScript = [
      "const { spawn } = require('node:child_process');",
      "const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 1000)'], { stdio: ['ignore', 'inherit', 'inherit'] });",
      "child.unref();",
    ].join(" ");
    const startedAt = performance.now();

    await expect(runner.run(process.execPath, ["-e", childScript], 20)).resolves.toMatchObject({ kind: "timeout" });
    expect(performance.now() - startedAt).toBeLessThan(500);
  });
});

describe("launchd authoritative native-service probe", () => {
  it("bootstraps a uniquely labelled one-shot agent in gui/<uid> and always cleans it up", async () => {
    const runner = queuedRunner([completed(0), completed(0)]);
    const fileSystem = launchdFileSystem({
      "/tmp/probe/result.log": marker("sessiond.command.npm", "satisfied"),
    });
    let now = 0;
    const probe = new LaunchdNativeServiceProbe({
      commandRunner: runner,
      fileSystem,
      uid: 501,
      createUniqueId: () => "fixed",
      now: () => now,
      sleep: (milliseconds) => { now += milliseconds; return Promise.resolve(); },
      probeTimeoutMs: 500,
      pollIntervalMs: 10,
      commandTimeoutMs: 100,
    });

    await expect(probe.run(request("launchd"))).resolves.toMatchObject({ kind: "completed" });
    expect(runner.calls.map(({ command, args }) => [command, ...args])).toEqual([
      ["launchctl", "bootstrap", "gui/501", "/tmp/probe/probe.plist"],
      ["launchctl", "bootout", "gui/501/com.pi-web.authoritative-probe.501.fixed"],
    ]);
    expect(fileSystem.writeFile).toHaveBeenCalledWith(
      "/tmp/probe/probe.plist",
      expect.stringContaining("<string>/bin/zsh</string>"),
      0o600,
    );
    expect(fileSystem.writeFile).toHaveBeenCalledWith(
      "/tmp/probe/probe.plist",
      expect.stringContaining("<key>WorkingDirectory</key>\n  <string>/checkout with space</string>"),
      0o600,
    );
    expect(fileSystem.writeFile).toHaveBeenCalledWith(
      "/tmp/probe/probe.plist",
      expect.stringContaining("/bin/mv &apos;/tmp/probe/result.pending&apos; &apos;/tmp/probe/result.log&apos;"),
      0o600,
    );
    expect(fileSystem.removeDirectory).toHaveBeenCalledWith("/tmp/probe");
  });

  it("times out deterministically, boots out the agent, and removes temporary files", async () => {
    const runner = queuedRunner([completed(0), completed(0)]);
    const fileSystem = launchdFileSystem({});
    let now = 0;
    const probe = new LaunchdNativeServiceProbe({
      commandRunner: runner,
      fileSystem,
      uid: 502,
      createUniqueId: () => "fixed",
      now: () => now,
      sleep: (milliseconds) => { now += milliseconds; return Promise.resolve(); },
      probeTimeoutMs: 20,
      pollIntervalMs: 10,
      commandTimeoutMs: 100,
    });

    await expect(probe.run(request("launchd"))).resolves.toMatchObject({
      kind: "infrastructure-failure",
      reason: "timeout",
    });
    expect(runner.calls.at(-1)).toMatchObject({
      command: "launchctl",
      args: ["bootout", "gui/502/com.pi-web.authoritative-probe.502.fixed"],
    });
    expect(fileSystem.removeDirectory).toHaveBeenCalledWith("/tmp/probe");
  });

  it("bounds a stalled result-file read before cleaning up", async () => {
    const runner = queuedRunner([completed(0), completed(0)]);
    const fileSystem = launchdFileSystem({});
    fileSystem.readOptionalFile.mockReturnValueOnce(new Promise(() => undefined));
    const probe = new LaunchdNativeServiceProbe({
      commandRunner: runner,
      fileSystem,
      uid: 502,
      createUniqueId: () => "fixed",
      now: () => 0,
      sleep: () => Promise.resolve(),
      probeTimeoutMs: 10,
      pollIntervalMs: 1,
      commandTimeoutMs: 100,
    });

    await expect(probe.run(request("launchd"))).resolves.toMatchObject({
      kind: "infrastructure-failure",
      reason: "timeout",
    });
    expect(runner.calls.map(({ args }) => args[0])).toEqual(["bootstrap", "bootout"]);
    expect(fileSystem.removeDirectory).toHaveBeenCalledWith("/tmp/probe");
  });

  it("surfaces cleanup failure instead of returning an otherwise successful probe", async () => {
    const runner = queuedRunner([completed(0), completed(1, "", "bootout denied")]);
    const fileSystem = launchdFileSystem({
      "/tmp/probe/result.log": marker("sessiond.command.npm", "satisfied"),
    });
    const probe = new LaunchdNativeServiceProbe({
      commandRunner: runner,
      fileSystem,
      uid: 503,
      createUniqueId: () => "fixed",
      now: () => 0,
      sleep: () => Promise.resolve(),
      probeTimeoutMs: 20,
      pollIntervalMs: 10,
      commandTimeoutMs: 100,
    });

    const result = await probe.run(request("launchd"));
    expect(result).toMatchObject({ kind: "infrastructure-failure", reason: "cleanup" });
    expect(result.kind === "infrastructure-failure" && result.message).toContain("bootout denied");
    expect(fileSystem.removeDirectory).toHaveBeenCalledWith("/tmp/probe");
  });

  it("boots out a label when bootstrap itself times out", async () => {
    const runner = queuedRunner([
      { kind: "timeout", stdout: "", stderr: "" },
      completed(0),
    ]);
    const fileSystem = launchdFileSystem({});
    const probe = new LaunchdNativeServiceProbe({
      commandRunner: runner,
      fileSystem,
      uid: 504,
      createUniqueId: () => "fixed",
      now: () => 0,
      sleep: () => Promise.resolve(),
      probeTimeoutMs: 20,
      pollIntervalMs: 10,
      commandTimeoutMs: 100,
    });

    await expect(probe.run(request("launchd"))).resolves.toMatchObject({
      kind: "infrastructure-failure",
      reason: "timeout",
    });
    expect(runner.calls.map(({ args }) => args[0])).toEqual(["bootstrap", "bootout"]);
    expect(fileSystem.removeDirectory).toHaveBeenCalledWith("/tmp/probe");
  });

  it("treats an explicit not-loaded bootout response as successful cleanup after bootstrap fails", async () => {
    const runner = queuedRunner([
      completed(1, "", "bootstrap denied"),
      completed(3, "", "Could not find service in domain"),
    ]);
    const fileSystem = launchdFileSystem({});
    const probe = new LaunchdNativeServiceProbe({
      commandRunner: runner,
      fileSystem,
      uid: 504,
      createUniqueId: () => "fixed",
      now: () => 0,
      sleep: () => Promise.resolve(),
      probeTimeoutMs: 20,
      pollIntervalMs: 10,
      commandTimeoutMs: 100,
    });

    const result = await probe.run(request("launchd"));
    expect(result).toMatchObject({ kind: "infrastructure-failure", reason: "manager" });
    expect(result.kind === "infrastructure-failure" && result.message).toContain("bootstrap denied");
    expect(runner.calls.map(({ args }) => args[0])).toEqual(["bootstrap", "bootout"]);
    expect(fileSystem.removeDirectory).toHaveBeenCalledWith("/tmp/probe");
  });

  it("cleans a loaded label after malformed private result output", async () => {
    const runner = queuedRunner([completed(0), completed(0)]);
    const fileSystem = launchdFileSystem({ "/tmp/probe/result.log": "malformed result" });
    const probe = new LaunchdNativeServiceProbe({
      commandRunner: runner,
      fileSystem,
      uid: 505,
      createUniqueId: () => "fixed",
      now: () => 0,
      sleep: () => Promise.resolve(),
      probeTimeoutMs: 20,
      pollIntervalMs: 10,
      commandTimeoutMs: 100,
    });

    await expect(probe.run(request("launchd"))).resolves.toMatchObject({
      kind: "infrastructure-failure",
      reason: "malformed-output",
    });
    expect(runner.calls.at(-1)?.args[0]).toBe("bootout");
    expect(fileSystem.removeDirectory).toHaveBeenCalledWith("/tmp/probe");
  });

  it("cleans a loaded label when the private result cannot be read", async () => {
    const runner = queuedRunner([completed(0), completed(0)]);
    const fileSystem = launchdFileSystem({});
    fileSystem.readOptionalFile.mockRejectedValueOnce(new Error("read denied"));
    const probe = new LaunchdNativeServiceProbe({
      commandRunner: runner,
      fileSystem,
      uid: 506,
      createUniqueId: () => "fixed",
      now: () => 0,
      sleep: () => Promise.resolve(),
      probeTimeoutMs: 20,
      pollIntervalMs: 10,
      commandTimeoutMs: 100,
    });

    const result = await probe.run(request("launchd"));
    expect(result).toMatchObject({ kind: "infrastructure-failure", reason: "manager" });
    expect(result.kind === "infrastructure-failure" && result.message).toContain("Could not read launchd probe result");
    expect(runner.calls.at(-1)?.args[0]).toBe("bootout");
    expect(fileSystem.removeDirectory).toHaveBeenCalledWith("/tmp/probe");
  });

  it("reports temporary-file cleanup failures", async () => {
    const runner = queuedRunner([
      completed(1, "", "bootstrap denied"),
      completed(3, "", "Could not find service in domain"),
    ]);
    const fileSystem = launchdFileSystem({});
    fileSystem.removeDirectory.mockRejectedValueOnce(new Error("rm denied"));
    const probe = new LaunchdNativeServiceProbe({
      commandRunner: runner,
      fileSystem,
      uid: 506,
      createUniqueId: () => "fixed",
      now: () => 0,
      sleep: () => Promise.resolve(),
      probeTimeoutMs: 20,
      pollIntervalMs: 10,
      commandTimeoutMs: 100,
    });

    const result = await probe.run(request("launchd"));
    expect(result).toMatchObject({ kind: "infrastructure-failure", reason: "cleanup" });
    expect(result.kind === "infrastructure-failure" && result.message).toContain("rm denied");
  });
});

describe("probe service definitions", () => {
  it("requires external executables instead of accepting shell functions or aliases", () => {
    const commandRequirement = request().prerequisites[0];
    if (commandRequirement === undefined) throw new Error("Expected a command prerequisite");
    const bashCheck = nativeServicePrerequisiteShellCheck("bash", commandRequirement);
    expect(bashCheck).toContain("case \"$pi_web_probe_executable\" in */*)");
    expect(bashCheck).toContain("test -f \"$pi_web_probe_executable\"");
    expect(bashCheck).toContain("test -x \"$pi_web_probe_executable\"");

    const fishCheck = nativeServicePrerequisiteShellCheck("fish", commandRequirement);
    expect(fishCheck).toContain("string match -q '*/*'");
    expect(fishCheck).toContain("test -f $pi_web_probe_executable[1]");
    expect(fishCheck).toContain("test -x $pi_web_probe_executable[1]");
  });

  it("invokes the resolved external Node executable for version checks", () => {
    const check = nativeServicePrerequisiteShellCheck("zsh", {
      id: "sessiond.node",
      kind: "node-version",
      command: "node",
      minimumVersion: "22.19.0",
      description: "node >= 22.19.0",
    });
    expect(check).toContain("\"$pi_web_probe_executable\" '-e'");
    expect(check).toContain("22.19.0");
    expect(check).not.toContain("&& node -e");
  });

  it.each([
    { version: "21.99.99", accepted: false },
    { version: "22.18.99", accepted: false },
    { version: "22.19.0", accepted: true },
    { version: "22.19.1", accepted: true },
    { version: "23.0.0", accepted: true },
  ])("checks the complete Node version for $version", ({ version, accepted }) => {
    const result = spawnSync(process.execPath, ["-e", nodeVersionCheckScript("22.19.0"), version]);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(accepted ? 0 : 1);
  });

  it("requires bundled entrypoints to be readable regular files", () => {
    const check = nativeServicePrerequisiteShellCheck("bash", {
      id: "sessiond.entrypoint",
      kind: "readable-file",
      path: "/package/server.js",
      description: "entrypoint",
    });
    expect(check).toBe("test -f '/package/server.js' && test -r '/package/server.js'");
  });

  it("renders backend inputs without inheriting the caller PATH", () => {
    const probeRequest = request();
    const systemdArguments = systemdRunArguments(probeRequest, "probe.service", "echo ok");
    expect(systemdArguments.some((argument) => argument.includes("PATH="))).toBe(false);
    const plist = launchdProbePlist(probeRequest, "com.example.probe", "echo ok", "/tmp/out", "/tmp/err");
    expect(plist).not.toContain("<key>PATH</key>");
    expect(plist).toContain("<key>PI_WEB_CONFIG</key>");
    expect(plist).toContain("<key>HardResourceLimits</key>");
  });

  it("escapes manager-side substitutions in the systemd probe payload", () => {
    const args = systemdRunArguments(request(), "probe.service", "test -r '/tmp/$HOME/%h'");
    expect(args.at(-1)).toBe("test -r '/tmp/$$HOME/%h'");
  });
});

function launchdFileSystem(contents: Record<string, string>): LaunchdProbeFileSystem & {
  writeFile: ReturnType<typeof vi.fn<LaunchdProbeFileSystem["writeFile"]>>;
  readOptionalFile: ReturnType<typeof vi.fn<LaunchdProbeFileSystem["readOptionalFile"]>>;
  removeDirectory: ReturnType<typeof vi.fn<LaunchdProbeFileSystem["removeDirectory"]>>;
} {
  const writeFileMock = vi.fn<LaunchdProbeFileSystem["writeFile"]>(() => Promise.resolve());
  const readOptionalFileMock = vi.fn<LaunchdProbeFileSystem["readOptionalFile"]>((path) => Promise.resolve(contents[path] ?? null));
  const removeDirectoryMock = vi.fn<LaunchdProbeFileSystem["removeDirectory"]>(() => Promise.resolve());
  return {
    createTemporaryDirectory: () => Promise.resolve("/tmp/probe"),
    writeFile: writeFileMock,
    readOptionalFile: readOptionalFileMock,
    removeDirectory: removeDirectoryMock,
  };
}
