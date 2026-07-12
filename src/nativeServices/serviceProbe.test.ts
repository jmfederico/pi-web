import { describe, expect, it, vi } from "vitest";
import {
  LaunchdNativeServiceProbe,
  SystemdNativeServiceProbe,
  launchdProbePlist,
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
        detail: "npm was not found in the native service environment.",
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
      completed(0),
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
      completed(1, "", "unit still loaded"),
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
      ["systemctl", "--user", "reset-failed", "pi-web-authoritative-probe-fixed.service"],
    ]);
  });
});

describe("launchd authoritative native-service probe", () => {
  it("bootstraps a uniquely labelled one-shot agent in gui/<uid> and always cleans it up", async () => {
    const runner = queuedRunner([
      completed(0),
      completed(0, "state = running\n"),
      completed(0, "state = not running\nlast exit code = 0\n"),
      completed(0),
    ]);
    const fileSystem = launchdFileSystem({
      "/tmp/probe/stdout.log": marker("sessiond.command.npm", "satisfied"),
      "/tmp/probe/stderr.log": "",
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
      ["launchctl", "print", "gui/501/com.pi-web.authoritative-probe.501.fixed"],
      ["launchctl", "print", "gui/501/com.pi-web.authoritative-probe.501.fixed"],
      ["launchctl", "bootout", "gui/501/com.pi-web.authoritative-probe.501.fixed"],
    ]);
    expect(fileSystem.writeFile).toHaveBeenCalledWith(
      "/tmp/probe/probe.plist",
      expect.stringContaining("<string>/bin/zsh</string>"),
    );
    expect(fileSystem.writeFile).toHaveBeenCalledWith(
      "/tmp/probe/probe.plist",
      expect.stringContaining("<key>WorkingDirectory</key>\n  <string>/checkout with space</string>"),
    );
    expect(fileSystem.removeDirectory).toHaveBeenCalledWith("/tmp/probe");
  });

  it("times out deterministically, boots out the agent, and removes temporary files", async () => {
    const runner = queuedRunner([
      completed(0),
      completed(0, "state = running\n"),
      completed(0, "state = running\n"),
      completed(0),
    ]);
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

  it("surfaces cleanup failure instead of returning an otherwise successful probe", async () => {
    const runner = queuedRunner([
      completed(0),
      completed(0, "state = not running\nlast exit code = 0\n"),
      completed(1, "", "bootout denied"),
    ]);
    const fileSystem = launchdFileSystem({
      "/tmp/probe/stdout.log": marker("sessiond.command.npm", "satisfied"),
      "/tmp/probe/stderr.log": "",
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

  it("checks and boots out a label when bootstrap itself times out", async () => {
    const runner = queuedRunner([
      { kind: "timeout", stdout: "", stderr: "" },
      completed(0, "state = running\n"),
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
    expect(runner.calls.map(({ args }) => args[0])).toEqual(["bootstrap", "print", "bootout"]);
    expect(fileSystem.removeDirectory).toHaveBeenCalledWith("/tmp/probe");
  });

  it("removes temporary files when bootstrap fails without booting out an unloaded label", async () => {
    const runner = queuedRunner([completed(1, "", "bootstrap denied")]);
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
    expect(runner.calls).toHaveLength(1);
    expect(fileSystem.removeDirectory).toHaveBeenCalledWith("/tmp/probe");
  });

  it("cleans a loaded label after malformed launchctl output", async () => {
    const runner = queuedRunner([
      completed(0),
      completed(0, "pid = 123\n"),
      completed(0),
    ]);
    const fileSystem = launchdFileSystem({});
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

  it("cleans a loaded label when probe output cannot be read", async () => {
    const runner = queuedRunner([
      completed(0),
      completed(0, "state = not running\nlast exit code = 0\n"),
      completed(0),
    ]);
    const fileSystem = launchdFileSystem({});
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
    expect(result.kind === "infrastructure-failure" && result.message).toContain("Could not read launchd probe output");
    expect(runner.calls.at(-1)?.args[0]).toBe("bootout");
    expect(fileSystem.removeDirectory).toHaveBeenCalledWith("/tmp/probe");
  });

  it("reports temporary-file cleanup failures", async () => {
    const runner = queuedRunner([completed(1, "", "bootstrap denied")]);
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
  it("renders backend inputs without inheriting the caller PATH", () => {
    const probeRequest = request();
    expect(systemdRunArguments(probeRequest, "probe.service", "echo ok")).not.toContain(expect.stringContaining("PATH="));
    const plist = launchdProbePlist(probeRequest, "com.example.probe", "echo ok", "/tmp/out", "/tmp/err");
    expect(plist).not.toContain("<key>PATH</key>");
    expect(plist).toContain("<key>PI_WEB_CONFIG</key>");
  });
});

function launchdFileSystem(contents: Record<string, string>): LaunchdProbeFileSystem & {
  writeFile: ReturnType<typeof vi.fn<LaunchdProbeFileSystem["writeFile"]>>;
  removeDirectory: ReturnType<typeof vi.fn<LaunchdProbeFileSystem["removeDirectory"]>>;
} {
  const writeFileMock = vi.fn<LaunchdProbeFileSystem["writeFile"]>(() => Promise.resolve());
  const removeDirectoryMock = vi.fn<LaunchdProbeFileSystem["removeDirectory"]>(() => Promise.resolve());
  return {
    createTemporaryDirectory: () => Promise.resolve("/tmp/probe"),
    writeFile: writeFileMock,
    readFile: (path) => {
      const content = contents[path];
      return content === undefined ? Promise.reject(new Error(`missing ${path}`)) : Promise.resolve(content);
    },
    removeDirectory: removeDirectoryMock,
  };
}
