import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { agentSessionDirEnvOverride, PI_CODING_AGENT_DIR_ENV, PI_CODING_AGENT_SESSION_DIR_ENV, PI_WEB_AGENT_DIR_ENV, PI_WEB_AGENT_SESSION_DIR_ENV } from "../config.js";

export type WindowsServiceId = "sessiond" | "web";
export type WindowsTaskAction = "start" | "stop" | "restart" | "uninstall";

export interface WindowsTaskPlan {
  node: string;
  powershell: string;
  home: string;
  logDirectory: string;
  environment: Record<string, string>;
  entrypoints: Record<WindowsServiceId, string>;
}

export interface WindowsTaskStatus {
  id: WindowsServiceId;
  state: string;
  lastResult: number;
  plan: WindowsTaskPlan;
}

const ids: readonly WindowsServiceId[] = ["sessiond", "web"];
const marker = "PI WEB Windows tasks v1\n";

/** Windows tasks are a separate adapter: no POSIX login shell or service wrapper. */
export function windowsTaskPlan(input: {
  node: string;
  packageRoot: string;
  home: string;
  configPath: string;
  dataDirectory: string;
  environment: NodeJS.ProcessEnv;
}): WindowsTaskPlan {
  const env = input.environment;
  const port = nonemptyEnvironment(env, "PI_WEB_SESSIOND_PORT") ?? "8505";
  if (!/^\d+$/u.test(port) || Number(port) < 1 || Number(port) > 65535) {
    throw new Error("PI_WEB_SESSIOND_PORT must be a port between 1 and 65535.");
  }
  const environment: Record<string, string> = {
    PI_WEB_CONFIG: input.configPath,
    PI_WEB_DATA_DIR: input.dataDirectory,
    PI_WEB_SESSIOND_HOST: "127.0.0.1",
    PI_WEB_SESSIOND_PORT: port,
    PI_WEB_SESSIOND_URL: `http://127.0.0.1:${port}`,
  };
  // Deliberately do not persist the whole caller environment (tokens, nested
  // session identity, etc.). Task Scheduler supplies the user's normal environment.
  for (const key of ["PATH", "SHELL"]) {
    const value = Object.entries(env).find(([name]) => name.toUpperCase() === key)?.[1];
    if (value !== undefined && value !== "") environment[key] = value;
  }
  // Match config.ts precedence before the runner clears captured directory aliases.
  // Normalize Windows' case-insensitive environment names for plain-object callers.
  const directoryEnvironment = Object.fromEntries(Object.entries(env).map(([key, value]) => [key.toUpperCase(), value]));
  const agentDirectory = nonemptyEnvironment(directoryEnvironment, PI_WEB_AGENT_DIR_ENV)
    ?? nonemptyEnvironment(directoryEnvironment, PI_CODING_AGENT_DIR_ENV);
  const sessionDirectory = agentSessionDirEnvOverride(directoryEnvironment);
  if (agentDirectory !== undefined) environment[PI_CODING_AGENT_DIR_ENV] = agentDirectory;
  if (sessionDirectory !== undefined) environment[PI_CODING_AGENT_SESSION_DIR_ENV] = sessionDirectory;
  return {
    node: input.node,
    powershell: win32.join(nonemptyEnvironment(env, "SystemRoot") ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    home: input.home,
    logDirectory: win32.join(input.dataDirectory, "logs"),
    environment,
    entrypoints: {
      sessiond: win32.join(input.packageRoot, "dist", "server", "sessiond.js"),
      web: win32.join(input.packageRoot, "dist", "server", "index.js"),
    },
  };
}

function literal(value: string): string {
  // PowerShell recognizes these typographic apostrophes as single-quote delimiters too.
  return `'${value.replace(/['\u2018\u2019\u201a\u201b]/gu, "$&$&")}'`;
}

// Task Scheduler terminates its action, not the action's descendants. Put the
// PowerShell owner in a kill-on-close job before starting Node; only this owner
// holds the non-inheritable handle, so crashes, sign-out, and End Task clean up
// the entire tree. No PID files, process-name matching, or wrapper binary.
const taskJobScript = `Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class PiWebTaskJob {
  [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
    public long ProcessTime, JobTime;
    public uint Flags;
    public UIntPtr MinWorkingSet, MaxWorkingSet;
    public uint ActiveProcesses;
    public UIntPtr Affinity;
    public uint Priority, Scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct IoCounters {
    public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes;
  }
  [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
    public BasicLimits Basic;
    public IoCounters Io;
    public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits limits, uint size);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  public static void Attach() {
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
    var limits = new ExtendedLimits();
    limits.Basic.Flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimits))) ||
        !AssignProcessToJobObject(job, GetCurrentProcess())) {
      int error = Marshal.GetLastWin32Error();
      CloseHandle(job);
      throw new Win32Exception(error);
    }
    // Keep the raw handle open until process exit; it must not be finalized by GC.
  }
}
'@
[PiWebTaskJob]::Attach()
`;

export function windowsTaskRunner(plan: WindowsTaskPlan, id: WindowsServiceId): string {
  // Scheduler can report Ready while the terminated process tree still owns
  // the log handle. Retry only a sharing/lock violation before the body starts;
  // never relaunch Node or conceal a different runner failure.
  return `$ErrorActionPreference = 'Stop'
$logDeadline = (Get-Date).AddSeconds(10)
$script:runnerStarted = $false
while ($true) {
try {
& {
$script:runnerStarted = $true
${taskJobScript}
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
# Keep runtime configuration inherited from Windows; remove only nested
# identity, foreign deployment wiring, and aliases superseded at install.
Remove-Item Env:PI_WEB_SESSION, Env:PI_WEB_SESSIOND_SOCKET -ErrorAction SilentlyContinue
Get-ChildItem Env:PI_WEB_DOCKER_* | Remove-Item
${([[PI_WEB_AGENT_DIR_ENV, PI_CODING_AGENT_DIR_ENV], [PI_WEB_AGENT_SESSION_DIR_ENV, PI_CODING_AGENT_SESSION_DIR_ENV]] as const).filter(([, canonical]) => plan.environment[canonical] !== undefined).map(([alias]) => `Remove-Item Env:${alias} -ErrorAction SilentlyContinue`).join("\n")}
Remove-Item Env:PORT -ErrorAction SilentlyContinue
${Object.entries(plan.environment).map(([key, value]) => `[Environment]::SetEnvironmentVariable(${literal(key)}, ${literal(value)}, 'Process')`).join("\n")}
Set-Location -LiteralPath ${literal(plan.home)} -ErrorAction Stop
$global:LASTEXITCODE = 1
& ${literal(plan.node)} ${literal(plan.entrypoints[id])}
exit $LASTEXITCODE
} *>> ${literal(win32.join(plan.logDirectory, `${id}.log`))}
break
} catch [IO.IOException] {
  if ($script:runnerStarted -or ($_.Exception.HResult -band 0xFFFF) -notin @(32, 33) -or (Get-Date) -ge $logDeadline) { throw }
  Start-Sleep -Milliseconds 100
}
}
`;
}

function runnerArguments(plan: WindowsTaskPlan, id: WindowsServiceId): string {
  const encoded = Buffer.from(windowsTaskRunner(plan, id), "utf16le").toString("base64");
  const args = `-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -EncodedCommand ${encoded}`;
  if (args.length > 30_000) throw new Error("Windows task command is too long. Shorten PATH before installing.");
  return args;
}

const taskContext = `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$prefix = 'PI-WEB-' + $identity.User.Value + '-'
$tasks = @(Get-ScheduledTask | Where-Object { $_.TaskPath -eq '\\' -and $_.TaskName -in @(($prefix + 'sessiond'), ($prefix + 'web')) })
foreach ($task in $tasks) {
  if (-not $task.Description.StartsWith(${literal(marker)})) { throw ('Refusing to change an unrecognized task: ' + $task.TaskName) }
}
`;

export function windowsTaskInstallScript(plan: WindowsTaskPlan): string {
  return `${taskContext}
if ($tasks.Count -gt 0) { throw 'PI WEB tasks already exist. Run pi-web uninstall before reinstalling; this interrupts active sessions.' }
$principal = New-ScheduledTaskPrincipal -UserId $identity.User.Value -LogonType Interactive -RunLevel Limited
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity.User.Value
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
New-Item -ItemType Directory -Force -Path ${literal(plan.logDirectory)} | Out-Null
$created = @()
try {
${ids.map((id) => `  $action = New-ScheduledTaskAction -Execute ${literal(plan.powershell)} -Argument ${literal(runnerArguments(plan, id))} -WorkingDirectory ${literal(plan.home)}
  Register-ScheduledTask -TaskName ($prefix + '${id}') -TaskPath '\\' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description ${literal(marker + JSON.stringify(plan))} | Out-Null
  $created += ($prefix + '${id}')`).join("\n")}
} catch {
  $failure = $_
  foreach ($name in $created) { Unregister-ScheduledTask -TaskName $name -TaskPath '\\' -Confirm:$false }
  throw $failure
}
`;
}

export function windowsTaskQueryScript(): string {
  return `${taskContext}
$result = @($tasks | ForEach-Object {
  $info = $_ | Get-ScheduledTaskInfo
  [PSCustomObject]@{ id = $_.TaskName.Substring($prefix.Length); state = [string]$_.State; lastResult = $info.LastTaskResult; description = $_.Description; actions = @($_.Actions | Select-Object Execute, Arguments) }
})
ConvertTo-Json -InputObject $result -Depth 5 -Compress
`;
}

export function parseWindowsTaskStatus(output: string): WindowsTaskStatus[] {
  const value: unknown = JSON.parse(output.trim());
  if (!Array.isArray(value)) throw new Error("Task Scheduler returned an invalid task list.");
  const result: WindowsTaskStatus[] = [];
  const rows: unknown[] = value;
  for (const row of rows) {
    if (!isRecord(row) || (row["id"] !== "sessiond" && row["id"] !== "web")
      || typeof row["state"] !== "string" || typeof row["lastResult"] !== "number"
      || typeof row["description"] !== "string" || !row["description"].startsWith(marker)) {
      throw new Error("Task Scheduler returned an unrecognized PI WEB task.");
    }
    const plan: unknown = JSON.parse(row["description"].slice(marker.length));
    if (!isPlan(plan)) throw new Error("Installed Windows task metadata is invalid. Reinstall PI WEB tasks.");
    const actions: unknown = row["actions"];
    if (!Array.isArray(actions) || actions.length !== 1 || !isRecord(actions[0])
      || actions[0]["Execute"] !== plan.powershell || actions[0]["Arguments"] !== runnerArguments(plan, row["id"])) {
      throw new Error("Installed Windows task action was modified. Reinstall PI WEB tasks before managing them.");
    }
    result.push({ id: row["id"], state: row["state"], lastResult: row["lastResult"], plan });
  }
  if (new Set(result.map((task) => task.id)).size !== result.length
    || result.some((task) => JSON.stringify(task.plan) !== JSON.stringify(result[0]?.plan))) {
    throw new Error("Installed Windows tasks have inconsistent definitions. Reinstall PI WEB tasks.");
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPlan(value: unknown): value is WindowsTaskPlan {
  if (!isRecord(value)) return false;
  const environment = value["environment"];
  const entrypoints = value["entrypoints"];
  return ["node", "powershell", "home", "logDirectory"].every((key) => typeof value[key] === "string" && win32.isAbsolute(value[key]))
    && isRecord(environment) && Object.values(environment).every((item) => typeof item === "string")
    && typeof environment["PI_WEB_CONFIG"] === "string"
    && isRecord(entrypoints) && ids.every((id) => typeof entrypoints[id] === "string");
}

function nonemptyEnvironment(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name];
  return value === "" ? undefined : value;
}

export function windowsTaskActionScript(action: WindowsTaskAction): string {
  const order = action === "start" ? ids : (["web", "sessiond"] as const);
  return `${taskContext}
${action === "uninstall" ? "" : "if ($tasks.Count -ne 2) { throw 'PI WEB tasks are not fully installed. Run pi-web install (uninstall partial tasks first).' }"}
foreach ($id in @(${order.map(literal).join(", ")})) {
  $task = $tasks | Where-Object { $_.TaskName -eq ($prefix + $id) }
  if ($null -eq $task) { continue }
${action !== "start" ? `  $task | Stop-ScheduledTask
  $deadline = (Get-Date).AddSeconds(30)
  do {
    $current = Get-ScheduledTask -TaskName $task.TaskName -TaskPath '\\'
    if ($current.State -notin @('Running', 'Queued')) { break }
    if ((Get-Date) -ge $deadline) { throw ('Timed out stopping ' + $task.TaskName) }
    Start-Sleep -Milliseconds 200
  } while ($true)` : ""}
${action === "start" || action === "restart" ? "  $task | Start-ScheduledTask" : ""}
${action === "uninstall" ? "  $task | Unregister-ScheduledTask -Confirm:$false" : ""}
}
`;
}

export async function performWindowsTaskAction(action: WindowsTaskAction, deps: {
  environment: NodeJS.ProcessEnv;
  readStatus: () => WindowsTaskStatus[];
  runScript: (script: string) => string;
  ready: (plan: WindowsTaskPlan) => Promise<boolean>;
  now: () => number;
  sleep: () => Promise<void>;
}): Promise<void> {
  assertWindowsTaskMutationAllowed(action, deps.environment);
  // Removal must also work after a package upgrade changes the canonical
  // runner. The manager script still checks the per-user names and ownership marker.
  if (action === "uninstall") {
    deps.runScript(windowsTaskActionScript(action));
    return;
  }
  const installed = deps.readStatus();
  if (installed.length !== 2) throw new Error("PI WEB tasks are not fully installed. Run pi-web install (uninstall partial tasks first).");
  deps.runScript(windowsTaskActionScript(action));
  if (action === "stop") return;
  const deadline = deps.now() + 30_000;
  do {
    const tasks = deps.readStatus();
    const plan = tasks[0]?.plan;
    if (tasks.length === 2 && tasks.every((task) => task.state === "Running") && plan !== undefined && await deps.ready(plan)) return;
    await deps.sleep();
  } while (deps.now() < deadline);
  throw new Error("PI WEB tasks did not become ready within 30 seconds. Check pi-web status and pi-web logs; tasks were left installed for diagnosis.");
}

export function assertWindowsTaskMutationAllowed(action: string, environment: NodeJS.ProcessEnv): void {
  if (environment["PI_WEB_SESSION"] === "1") {
    throw new Error(`Run pi-web ${action} from an external Windows terminal, not a hosted PI WEB session. Service changes can interrupt the session running this command.`);
  }
}

/** Script files avoid nested command-line quoting and Windows' command length limit. */
export function runWindowsTaskScript(script: string): string {
  const directory = mkdtempSync(join(tmpdir(), "pi-web-tasks-"));
  try {
    const path = join(directory, "command.ps1");
    writeFileSync(path, `\uFEFF${script}`, "utf8");
    const executable = win32.join(nonemptyEnvironment(process.env, "SystemRoot") ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const result = spawnSync(executable, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path], {
      encoding: "utf8", windowsHide: true, timeout: 90_000, maxBuffer: 4 * 1024 * 1024,
    });
    if (result.error !== undefined || result.status !== 0) {
      throw new Error(`Windows Task Scheduler command failed: ${result.error?.message ?? (result.stderr.trim() || result.stdout.trim() || `exit ${String(result.status)}`)}`);
    }
    return result.stdout;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export function readWindowsTaskStatus(): WindowsTaskStatus[] {
  return parseWindowsTaskStatus(runWindowsTaskScript(windowsTaskQueryScript()));
}

export function windowsTaskLogsScript(plan: WindowsTaskPlan): string {
  return `$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Get-Content -LiteralPath @(${ids.map((id) => literal(win32.join(plan.logDirectory, `${id}.log`))).join(", ")}) -Tail 100
`;
}
