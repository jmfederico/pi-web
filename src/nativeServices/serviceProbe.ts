import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  NativeServiceAuthoritativeProbe,
  NativeServicePrerequisite,
  NativeServicePrerequisiteOutcome,
  NativeServiceProbeRequest,
  NativeServiceProbeResult,
  NativeServiceShellName,
} from "./servicePlan.js";

export type ProbeCommandResult =
  | { kind: "completed"; status: number; stdout: string; stderr: string }
  | { kind: "timeout"; stdout: string; stderr: string }
  | { kind: "spawn-failure"; message: string; stdout: string; stderr: string };

export interface ProbeCommandRunner {
  run(command: string, args: readonly string[], timeoutMs: number): Promise<ProbeCommandResult>;
}

export interface LaunchdProbeFileSystem {
  createTemporaryDirectory(prefix: string): Promise<string>;
  writeFile(path: string, contents: string): Promise<void>;
  readFile(path: string): Promise<string>;
  removeDirectory(path: string): Promise<void>;
}

interface CommonProbeDependencies {
  commandRunner: ProbeCommandRunner;
  createUniqueId(): string;
  commandTimeoutMs: number;
}

export type SystemdProbeDependencies = CommonProbeDependencies;

export interface LaunchdProbeDependencies extends CommonProbeDependencies {
  fileSystem: LaunchdProbeFileSystem;
  uid: number;
  now(): number;
  sleep(milliseconds: number): Promise<void>;
  probeTimeoutMs: number;
  pollIntervalMs: number;
}

const defaultCommandTimeoutMs = 15_000;
const defaultProbeTimeoutMs = 15_000;
const defaultPollIntervalMs = 50;

export class SystemdNativeServiceProbe implements NativeServiceAuthoritativeProbe {
  public constructor(private readonly dependencies: SystemdProbeDependencies) {}

  public async run(request: NativeServiceProbeRequest): Promise<NativeServiceProbeResult> {
    if (request.backend.kind !== "systemd") {
      return infrastructureFailure("manager", `Systemd probe cannot validate the ${request.backend.kind} backend.`);
    }

    const uniqueId = safeUniqueId(this.dependencies.createUniqueId());
    const unitName = `pi-web-authoritative-probe-${uniqueId}.service`;
    const outputPrefix = `PI_WEB_PROBE_${uniqueId}`;
    const command = prerequisiteProbeCommand(request.shell.name, request.prerequisites, outputPrefix);
    const args = systemdRunArguments(request, unitName, command);
    const result = await this.dependencies.commandRunner.run("systemd-run", args, this.dependencies.commandTimeoutMs);

    if (result.kind === "timeout") {
      const cleanupFailure = await this.cleanupTimedOutUnit(unitName);
      return cleanupFailure ?? infrastructureFailure(
        "timeout",
        `Timed out waiting for transient systemd unit ${unitName}.`,
      );
    }
    if (result.kind === "spawn-failure") {
      return infrastructureFailure("manager", `Could not start systemd-run: ${result.message}`);
    }
    if (result.status !== 0) {
      return infrastructureFailure(
        "manager",
        `Transient systemd probe ${unitName} failed: ${firstOutput(result.stderr, result.stdout, `exit status ${String(result.status)}`)}`,
      );
    }
    return parseProbeOutput(result.stdout, request.prerequisites, outputPrefix);
  }

  private async cleanupTimedOutUnit(unitName: string): Promise<NativeServiceProbeResult | null> {
    const stop = await this.dependencies.commandRunner.run(
      "systemctl",
      ["--user", "stop", unitName],
      this.dependencies.commandTimeoutMs,
    );
    if (stop.kind !== "completed" || stop.status !== 0) {
      return infrastructureFailure("cleanup", `Could not stop timed-out transient systemd unit ${unitName}: ${commandFailureDetail(stop)}`);
    }
    const reset = await this.dependencies.commandRunner.run(
      "systemctl",
      ["--user", "reset-failed", unitName],
      this.dependencies.commandTimeoutMs,
    );
    if (reset.kind !== "completed" || reset.status !== 0) {
      return infrastructureFailure("cleanup", `Could not collect timed-out transient systemd unit ${unitName}: ${commandFailureDetail(reset)}`);
    }
    return null;
  }
}

export class LaunchdNativeServiceProbe implements NativeServiceAuthoritativeProbe {
  public constructor(private readonly dependencies: LaunchdProbeDependencies) {}

  public async run(request: NativeServiceProbeRequest): Promise<NativeServiceProbeResult> {
    if (request.backend.kind !== "launchd") {
      return infrastructureFailure("manager", `Launchd probe cannot validate the ${request.backend.kind} backend.`);
    }

    const uniqueId = safeUniqueId(this.dependencies.createUniqueId());
    const label = `com.pi-web.authoritative-probe.${String(this.dependencies.uid)}.${uniqueId}`;
    const domain = `gui/${String(this.dependencies.uid)}`;
    const target = `${domain}/${label}`;
    const outputPrefix = `PI_WEB_PROBE_${uniqueId}`;
    let directory: string | null = null;
    let bootstrapState: "not-loaded" | "loaded" | "uncertain" = "not-loaded";
    let result: NativeServiceProbeResult;

    try {
      directory = await this.dependencies.fileSystem.createTemporaryDirectory(
        join(tmpdir(), "pi-web-launchd-probe-"),
      );
      const plistPath = join(directory, "probe.plist");
      const stdoutPath = join(directory, "stdout.log");
      const stderrPath = join(directory, "stderr.log");
      const command = prerequisiteProbeCommand(request.shell.name, request.prerequisites, outputPrefix);
      await this.dependencies.fileSystem.writeFile(
        plistPath,
        launchdProbePlist(request, label, command, stdoutPath, stderrPath),
      );

      const bootstrap = await this.dependencies.commandRunner.run(
        "launchctl",
        ["bootstrap", domain, plistPath],
        this.dependencies.commandTimeoutMs,
      );
      if (bootstrap.kind !== "completed" || bootstrap.status !== 0) {
        bootstrapState = bootstrap.kind === "timeout" ? "uncertain" : "not-loaded";
        result = commandInfrastructureFailure("bootstrap launchd probe", bootstrap);
      } else {
        bootstrapState = "loaded";
        result = await this.waitForResult(target, stdoutPath, stderrPath, request.prerequisites, outputPrefix);
      }
    } catch (error: unknown) {
      result = infrastructureFailure("manager", `Could not prepare launchd probe: ${errorMessage(error)}`);
    }

    const cleanupFailure = await this.cleanup(target, directory, bootstrapState);
    return cleanupFailure ?? result;
  }

  private async waitForResult(
    target: string,
    stdoutPath: string,
    stderrPath: string,
    prerequisites: readonly NativeServicePrerequisite[],
    outputPrefix: string,
  ): Promise<NativeServiceProbeResult> {
    const deadline = this.dependencies.now() + this.dependencies.probeTimeoutMs;
    while (this.dependencies.now() < deadline) {
      const printed = await this.dependencies.commandRunner.run(
        "launchctl",
        ["print", target],
        this.dependencies.commandTimeoutMs,
      );
      if (printed.kind !== "completed" || printed.status !== 0) {
        return commandInfrastructureFailure("inspect launchd probe", printed);
      }

      const state = launchdField(printed.stdout, "state");
      if (state === undefined) {
        return infrastructureFailure("malformed-output", `launchctl returned no state for ${target}.`);
      }
      const lastExitCode = launchdIntegerField(printed.stdout, "last exit code");
      if (state === "not running" && lastExitCode !== undefined) {
        let stdout: string;
        let stderr: string;
        try {
          [stdout, stderr] = await Promise.all([
            this.dependencies.fileSystem.readFile(stdoutPath),
            this.dependencies.fileSystem.readFile(stderrPath),
          ]);
        } catch (error: unknown) {
          return infrastructureFailure("manager", `Could not read launchd probe output: ${errorMessage(error)}`);
        }
        if (lastExitCode !== 0) {
          return infrastructureFailure(
            "manager",
            `Launchd probe service exited with status ${String(lastExitCode)}: ${firstOutput(stderr, stdout, "no output")}`,
          );
        }
        return parseProbeOutput(stdout, prerequisites, outputPrefix);
      }

      await this.dependencies.sleep(this.dependencies.pollIntervalMs);
    }
    return infrastructureFailure("timeout", `Timed out waiting for launchd probe ${target}.`);
  }

  private async cleanup(
    target: string,
    directory: string | null,
    bootstrapState: "not-loaded" | "loaded" | "uncertain",
  ): Promise<NativeServiceProbeResult | null> {
    const failures: string[] = [];
    let shouldBootout = bootstrapState === "loaded";
    if (bootstrapState === "uncertain") {
      const inspection = await this.dependencies.commandRunner.run(
        "launchctl",
        ["print", target],
        this.dependencies.commandTimeoutMs,
      );
      if (inspection.kind === "completed") {
        shouldBootout = inspection.status === 0;
      } else {
        // If launchctl cannot tell us whether a timed-out bootstrap loaded the
        // label, bootout is the only operation that can make cleanup certain.
        shouldBootout = true;
      }
    }
    if (shouldBootout) {
      const bootout = await this.dependencies.commandRunner.run(
        "launchctl",
        ["bootout", target],
        this.dependencies.commandTimeoutMs,
      );
      if (bootout.kind !== "completed" || bootout.status !== 0) {
        failures.push(`bootout failed: ${commandFailureDetail(bootout)}`);
      }
    }
    if (directory !== null) {
      try {
        await this.dependencies.fileSystem.removeDirectory(directory);
      } catch (error: unknown) {
        failures.push(`temporary-file removal failed: ${errorMessage(error)}`);
      }
    }
    return failures.length === 0
      ? null
      : infrastructureFailure("cleanup", `Launchd probe cleanup failed for ${target}: ${failures.join("; ")}`);
  }
}

export function createNativeServiceAuthoritativeProbe(): NativeServiceAuthoritativeProbe {
  const commandRunner = new SpawnProbeCommandRunner();
  const common: CommonProbeDependencies = {
    commandRunner,
    createUniqueId: randomUUID,
    commandTimeoutMs: defaultCommandTimeoutMs,
  };
  const systemd = new SystemdNativeServiceProbe(common);
  const launchd = new LaunchdNativeServiceProbe({
    ...common,
    fileSystem: nodeLaunchdProbeFileSystem,
    uid: userInfo().uid,
    now: Date.now,
    sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    probeTimeoutMs: defaultProbeTimeoutMs,
    pollIntervalMs: defaultPollIntervalMs,
  });
  return {
    run: (request) => request.backend.kind === "systemd" ? systemd.run(request) : launchd.run(request),
  };
}

export function systemdRunArguments(
  request: NativeServiceProbeRequest,
  unitName: string,
  shellCommand: string,
): readonly string[] {
  return [
    "--user",
    "--wait",
    "--collect",
    "--pipe",
    "--quiet",
    `--unit=${unitName}`,
    ...Object.entries(request.environment).map(([key, value]) => `--setenv=${key}=${value}`),
    ...(request.workingDirectory === null ? [] : [`--working-directory=${request.workingDirectory}`]),
    "/usr/bin/env",
    request.shell.executable,
    "-lc",
    shellCommand,
  ];
}

export function launchdProbePlist(
  request: NativeServiceProbeRequest,
  label: string,
  shellCommand: string,
  stdoutPath: string,
  stderrPath: string,
): string {
  const argumentsXml = ["/usr/bin/env", request.shell.executable, "-lc", shellCommand]
    .map((argument) => `    <string>${xmlEscape(argument)}</string>`)
    .join("\n");
  const environmentEntries = Object.entries(request.environment);
  const environmentXml = environmentEntries.length === 0
    ? ""
    : `  <key>EnvironmentVariables</key>\n  <dict>\n${environmentEntries.map(([key, value]) => plistString(key, value, "    ")).join("")}  </dict>\n`;
  const workingDirectoryXml = request.workingDirectory === null
    ? ""
    : plistString("WorkingDirectory", request.workingDirectory);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${plistString("Label", label)}  <key>ProgramArguments</key>
  <array>
${argumentsXml}
  </array>
${workingDirectoryXml}${environmentXml}  <key>RunAtLoad</key>
  <true/>
${plistString("StandardOutPath", stdoutPath)}${plistString("StandardErrorPath", stderrPath)}</dict>
</plist>
`;
}

class SpawnProbeCommandRunner implements ProbeCommandRunner {
  public run(command: string, args: readonly string[], timeoutMs: number): Promise<ProbeCommandResult> {
    return new Promise((resolve) => {
      const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      let spawnFailure: string | null = null;
      let timedOut = false;
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => { stdout += chunk; });
      child.stderr.on("data", (chunk: string) => { stderr += chunk; });
      child.on("error", (error) => { spawnFailure = error.message; });
      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeoutMs);
      child.on("close", (status) => {
        clearTimeout(timeout);
        if (timedOut) {
          resolve({ kind: "timeout", stdout, stderr });
        } else if (spawnFailure !== null) {
          resolve({ kind: "spawn-failure", message: spawnFailure, stdout, stderr });
        } else {
          resolve({ kind: "completed", status: status ?? 1, stdout, stderr });
        }
      });
    });
  }
}

const nodeLaunchdProbeFileSystem: LaunchdProbeFileSystem = {
  createTemporaryDirectory: (prefix) => mkdtemp(prefix),
  writeFile: (path, contents) => writeFile(path, contents, "utf8"),
  readFile: (path) => readFile(path, "utf8"),
  removeDirectory: (path) => rm(path, { recursive: true, force: true }),
};

function prerequisiteProbeCommand(
  shell: NativeServiceShellName,
  prerequisites: readonly NativeServicePrerequisite[],
  outputPrefix: string,
): string {
  return prerequisites.map((prerequisite) => {
    const check = nativeServicePrerequisiteShellCheck(shell, prerequisite);
    const encodedId = Buffer.from(prerequisite.id, "utf8").toString("base64");
    const satisfied = markerCommand(shell, outputPrefix, encodedId, "satisfied");
    const unsatisfied = markerCommand(shell, outputPrefix, encodedId, "unsatisfied");
    return `${check} >/dev/null 2>&1 && ${satisfied} || ${unsatisfied}`;
  }).join("; ") || ":";
}

export function nativeServicePrerequisiteShellCheck(shell: NativeServiceShellName, prerequisite: NativeServicePrerequisite): string {
  switch (prerequisite.kind) {
    case "command-available":
      return `command -v ${shellQuote(shell, prerequisite.command)}`;
    case "node-version": {
      const script = `const major=Number(process.versions.node.split('.')[0]);process.exit(major>=${String(prerequisite.minimumMajor)}?0:1)`;
      return `node -e ${shellQuote(shell, script)}`;
    }
    case "readable-file":
      return `test -r ${shellQuote(shell, prerequisite.path)}`;
    case "package-scripts": {
      const script = "const p=require(process.argv[1]);const names=process.argv.slice(2);process.exit(names.every((name)=>typeof p.scripts?.[name]==='string')?0:1)";
      return ["node", "-e", shellQuote(shell, script), shellQuote(shell, prerequisite.packageJsonPath), ...prerequisite.scripts.map((name) => shellQuote(shell, name))].join(" ");
    }
  }
}

function markerCommand(
  shell: NativeServiceShellName,
  outputPrefix: string,
  encodedId: string,
  status: "satisfied" | "unsatisfied",
): string {
  return `printf '%s\\t%s\\t%s\\n' ${shellQuote(shell, outputPrefix)} ${shellQuote(shell, encodedId)} ${shellQuote(shell, status)}`;
}

function parseProbeOutput(
  stdout: string,
  prerequisites: readonly NativeServicePrerequisite[],
  outputPrefix: string,
): NativeServiceProbeResult {
  const expected = new Map(prerequisites.map((prerequisite) => [
    Buffer.from(prerequisite.id, "utf8").toString("base64"),
    prerequisite,
  ]));
  const outcomes = new Map<string, NativeServicePrerequisiteOutcome>();
  for (const line of stdout.split(/\r?\n/u)) {
    if (!line.startsWith(`${outputPrefix}\t`)) continue;
    const fields = line.split("\t");
    if (fields.length !== 3) {
      return infrastructureFailure("malformed-output", "Authoritative probe returned a malformed result line.");
    }
    const encodedId = fields[1];
    const status = fields[2];
    const prerequisite = encodedId === undefined ? undefined : expected.get(encodedId);
    if (prerequisite === undefined || (status !== "satisfied" && status !== "unsatisfied")) {
      return infrastructureFailure("malformed-output", "Authoritative probe returned an unexpected result.");
    }
    if (outcomes.has(prerequisite.id)) {
      return infrastructureFailure("malformed-output", `Authoritative probe returned duplicate outcome ${prerequisite.id}.`);
    }
    outcomes.set(prerequisite.id, {
      prerequisiteId: prerequisite.id,
      status,
      detail: status === "satisfied" ? null : unsatisfiedDetail(prerequisite),
    });
  }
  const missing = prerequisites.find((prerequisite) => !outcomes.has(prerequisite.id));
  if (missing !== undefined) {
    return infrastructureFailure("malformed-output", `Authoritative probe returned no outcome for ${missing.id}.`);
  }
  return { kind: "completed", outcomes: [...outcomes.values()] };
}

function unsatisfiedDetail(prerequisite: NativeServicePrerequisite): string {
  switch (prerequisite.kind) {
    case "command-available":
      return `${prerequisite.command} was not found in the native service environment.`;
    case "node-version":
      return `node >= ${String(prerequisite.minimumMajor)} was not available in the native service environment.`;
    case "readable-file":
      return `${prerequisite.path} was not readable in the native service environment.`;
    case "package-scripts":
      return `${prerequisite.packageJsonPath} did not provide scripts ${prerequisite.scripts.join(", ")} in the native service environment.`;
  }
}

function shellQuote(shell: NativeServiceShellName, value: string): string {
  return shell === "fish"
    ? `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`
    : `'${value.replaceAll("'", "'\\''")}'`;
}

function safeUniqueId(value: string): string {
  const safe = value.toLowerCase().replaceAll(/[^a-z0-9-]/gu, "").slice(0, 48);
  return safe === "" ? "probe" : safe;
}

function launchdField(output: string, field: string): string | undefined {
  return new RegExp(`^\\s*${escapeRegExp(field)}\\s*=\\s*(.+)$`, "mu").exec(output)?.[1]?.trim();
}

function launchdIntegerField(output: string, field: string): number | undefined {
  const value = launchdField(output, field);
  if (value === undefined || !/^-?\d+$/u.test(value)) return undefined;
  return Number(value);
}

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function plistString(key: string, value: string, indent = "  "): string {
  return `${indent}<key>${xmlEscape(key)}</key>\n${indent}<string>${xmlEscape(value)}</string>\n`;
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function commandInfrastructureFailure(action: string, result: ProbeCommandResult): NativeServiceProbeResult {
  if (result.kind === "timeout") return infrastructureFailure("timeout", `Timed out while trying to ${action}.`);
  return infrastructureFailure("manager", `Could not ${action}: ${commandFailureDetail(result)}`);
}

function commandFailureDetail(result: ProbeCommandResult): string {
  if (result.kind === "timeout") return "command timed out";
  if (result.kind === "spawn-failure") return result.message;
  return firstOutput(result.stderr, result.stdout, `exit status ${String(result.status)}`);
}

function infrastructureFailure(
  reason: "manager" | "timeout" | "malformed-output" | "cleanup",
  message: string,
): NativeServiceProbeResult {
  return { kind: "infrastructure-failure", reason, message };
}

function firstOutput(...values: string[]): string {
  for (const value of values) {
    const line = value.trim().split(/\r?\n/u).find((candidate) => candidate.trim() !== "");
    if (line !== undefined) return line.trim();
  }
  return "no output";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
