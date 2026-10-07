import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  assertWindowsTaskMutationAllowed,
  parseWindowsTaskStatus,
  performWindowsTaskAction,
  runWindowsTaskScript,
  windowsTaskActionScript,
  windowsTaskInstallScript,
  windowsTaskPlan,
  windowsTaskQueryScript,
  windowsTaskRunner,
  type WindowsTaskPlan,
  type WindowsTaskStatus,
} from "./windowsTasks.js";

function plan(environment: NodeJS.ProcessEnv = { Path: "C:\\my tools;C:\\Windows", PI_WEB_SESSIOND_PORT: "9505", PI_WEB_SESSION: "1", SECRET_TOKEN: "private" }): WindowsTaskPlan {
  return windowsTaskPlan({
    node: "C:\\Program Files\\nodejs\\node.exe",
    packageRoot: "C:\\Users\\O'Brien\\pi-web",
    home: "C:\\Users\\O'Brien",
    configPath: "C:\\Users\\O'Brien\\config.json",
    dataDirectory: "C:\\Users\\O'Brien\\.pi-web",
    environment,
  });
}

function status(state = "Running"): WindowsTaskStatus[] {
  return ["sessiond", "web"].map((id) => {
    if (id !== "sessiond" && id !== "web") throw new Error("Invalid fixture id");
    return { id, state, lastResult: 0, plan: plan() };
  });
}

function dependencies() {
  let now = 0;
  return {
    environment: {},
    readStatus: vi.fn(() => status()),
    runScript: vi.fn(() => ""),
    ready: vi.fn(() => Promise.resolve(true)),
    now: () => now,
    sleep: vi.fn(() => { now += 10_000; return Promise.resolve(); }),
  };
}

describe("Windows per-user autostart", () => {
  it("pins built entrypoints and config while capturing only the supported environment", () => {
    const result = plan();
    expect(result.entrypoints).toEqual({
      sessiond: "C:\\Users\\O'Brien\\pi-web\\dist\\server\\sessiond.js",
      web: "C:\\Users\\O'Brien\\pi-web\\dist\\server\\index.js",
    });
    expect(result.environment).toEqual({
      PI_WEB_CONFIG: "C:\\Users\\O'Brien\\config.json",
      PI_WEB_DATA_DIR: "C:\\Users\\O'Brien\\.pi-web",
      PI_WEB_SESSIOND_HOST: "127.0.0.1",
      PI_WEB_SESSIOND_PORT: "9505",
      PI_WEB_SESSIOND_URL: "http://127.0.0.1:9505",
      PATH: "C:\\my tools;C:\\Windows",
    });
    expect(JSON.stringify(result)).not.toContain("private");
  });

  it.each([
    { name: "alias only", alias: "C:\\legacy", canonical: undefined, expected: "C:\\legacy" },
    { name: "conflicting alias", alias: "C:\\legacy", canonical: "C:\\canonical", expected: "C:\\legacy" },
    { name: "canonical only", alias: undefined, canonical: "C:\\canonical", expected: "C:\\canonical" },
    { name: "empty alias", alias: "", canonical: "C:\\canonical", expected: "C:\\canonical" },
    { name: "empty canonical", alias: "C:\\legacy", canonical: "", expected: "C:\\legacy" },
    { name: "both empty", alias: "", canonical: "", expected: undefined },
    { name: "both absent", alias: undefined, canonical: undefined, expected: undefined },
  ])("normalizes Pi directory overrides with resolver precedence: $name", ({ alias, canonical, expected }) => {
    const result = plan({
      PI_WEB_AGENT_DIR: alias,
      PI_CODING_AGENT_DIR: canonical,
      PI_WEB_AGENT_SESSION_DIR: alias,
      PI_CODING_AGENT_SESSION_DIR: canonical,
    }).environment;
    expect(result["PI_CODING_AGENT_DIR"]).toBe(expected);
    expect(result["PI_CODING_AGENT_SESSION_DIR"]).toBe(expected);
    expect(result).not.toHaveProperty("PI_WEB_AGENT_DIR");
    expect(result).not.toHaveProperty("PI_WEB_AGENT_SESSION_DIR");
  });

  it("keeps profile and session overrides independent with Windows environment casing", () => {
    const result = plan({
      pi_web_agent_dir: "C:\\profile",
      Pi_Coding_Agent_Dir: "C:\\other-profile",
      Pi_Web_Agent_Session_Dir: "",
      pi_coding_agent_session_dir: "C:\\sessions",
    }).environment;
    expect(result["PI_CODING_AGENT_DIR"]).toBe("C:\\profile");
    expect(result["PI_CODING_AGENT_SESSION_DIR"]).toBe("C:\\sessions");
  });

  it.each(["0", "65536", "nan", "8505;exit", "1.5"])("rejects invalid daemon port %s", (port) => {
    expect(() => windowsTaskPlan({ node: "n", packageRoot: "p", home: "h", configPath: "c", dataDirectory: "d", environment: { PI_WEB_SESSIOND_PORT: port } })).toThrow("port between");
  });

  it("creates limited current-user logon tasks without time, battery, or duplicate-instance termination", () => {
    const script = windowsTaskInstallScript(plan());
    expect(script).toContain("-LogonType Interactive -RunLevel Limited");
    expect(script).toContain("-AtLogOn -User $identity.User.Value");
    expect(script).toContain("-MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero)");
    expect(script).toContain("-AllowStartIfOnBatteries -DontStopIfGoingOnBatteries");
    expect(script).not.toContain("RestartCount");
    expect(script.split("\n").filter((line) => line.includes("Register-ScheduledTask")).every((line) => !line.includes("-Force"))).toBe(true);
    expect(script).toContain("if ($tasks.Count -gt 0)");
    expect(script).toContain("foreach ($name in $created) { Unregister-ScheduledTask");
    expect(script).not.toContain("Start-ScheduledTask");
  });

  it("uses quoted foreground execution, clears nested identity, and preserves Node exit status", () => {
    const runner = windowsTaskRunner(plan(), "web");
    expect(runner).toContain("Remove-Item Env:PI_WEB_SESSION, Env:PI_WEB_SESSIOND_SOCKET");
    expect(runner).not.toContain("Get-ChildItem Env:PI_WEB_* | Remove-Item");
    expect(runner).toContain("Set-Location -LiteralPath 'C:\\Users\\O''Brien'");
    expect(runner).toContain("& 'C:\\Program Files\\nodejs\\node.exe' 'C:\\Users\\O''Brien\\pi-web\\dist\\server\\index.js'");
    expect(runner).toContain("*>> 'C:\\Users\\O''Brien\\.pi-web\\logs\\web.log'");
    expect(runner).toContain("exit $LASTEXITCODE");
    expect(runner).not.toContain("Start-Process");
  });

  it("removes inherited directory aliases only when install captured their canonical values", () => {
    const captured = windowsTaskRunner(plan({ PI_WEB_AGENT_DIR: "C:\\profile", PI_WEB_AGENT_SESSION_DIR: "C:\\sessions" }), "web");
    expect(captured).toContain("Remove-Item Env:PI_WEB_AGENT_DIR -ErrorAction SilentlyContinue");
    expect(captured).toContain("Remove-Item Env:PI_WEB_AGENT_SESSION_DIR -ErrorAction SilentlyContinue");
    const inherited = windowsTaskRunner(plan({}), "web");
    expect(inherited).not.toContain("Remove-Item Env:PI_WEB_AGENT_DIR");
    expect(inherited).not.toContain("Remove-Item Env:PI_WEB_AGENT_SESSION_DIR");
  });

  it("starts daemon first, but stops/restarts web before the daemon", () => {
    expect(windowsTaskActionScript("start")).toContain("@('sessiond', 'web')");
    for (const action of ["stop", "restart", "uninstall"] as const) {
      expect(windowsTaskActionScript(action)).toContain("@('web', 'sessiond')");
      expect(windowsTaskActionScript(action)).toContain("Timed out stopping");
    }
  });

  it("refuses mutation from hosted sessions before touching the manager", async () => {
    for (const action of ["start", "stop", "restart", "uninstall"] as const) {
      const deps = dependencies();
      deps.environment = { PI_WEB_SESSION: "1" };
      await expect(performWindowsTaskAction(action, deps)).rejects.toThrow("external Windows terminal");
      expect(deps.readStatus).not.toHaveBeenCalled();
      expect(deps.runScript).not.toHaveBeenCalled();
    }
    expect(() => { assertWindowsTaskMutationAllowed("install", { PI_WEB_SESSION: "1" }); }).toThrow("external Windows terminal");
  });

  it("requires both manager-running tasks and responsive endpoints", async () => {
    const deps = dependencies();
    deps.readStatus.mockReturnValueOnce(status("Ready")).mockReturnValueOnce(status("Ready"));
    deps.ready.mockResolvedValueOnce(false);
    await performWindowsTaskAction("start", deps);
    expect(deps.runScript).toHaveBeenCalledOnce();
    expect(deps.ready).toHaveBeenCalledTimes(2);
    expect(deps.sleep).toHaveBeenCalledTimes(2);
  });

  it("reports a readiness failure without uninstalling or claiming success", async () => {
    const deps = dependencies();
    deps.ready.mockResolvedValue(false);
    await expect(performWindowsTaskAction("restart", deps)).rejects.toThrow("did not become ready");
    expect(deps.runScript).toHaveBeenCalledExactlyOnceWith(windowsTaskActionScript("restart"));
  });

  it("fails closed on manager errors, missing tasks, and malformed installed metadata", async () => {
    const deps = dependencies();
    deps.readStatus.mockReturnValue([]);
    await expect(performWindowsTaskAction("start", deps)).rejects.toThrow("not fully installed");
    expect(deps.runScript).not.toHaveBeenCalled();
    deps.readStatus.mockImplementation(() => { throw new Error("access denied"); });
    await expect(performWindowsTaskAction("stop", deps)).rejects.toThrow("access denied");
    expect(deps.runScript).not.toHaveBeenCalled();
    expect(() => parseWindowsTaskStatus("{}")).toThrow("invalid task list");
    expect(() => parseWindowsTaskStatus('[{"id":"web","state":"Running","lastResult":0,"description":"foreign task"}]')).toThrow("unrecognized");
  });

  it("allows cleanup of partial or older installs without requiring the current runner format", async () => {
    const deps = dependencies();
    deps.readStatus.mockImplementation(() => { throw new Error("old runner format"); });
    await performWindowsTaskAction("uninstall", deps);
    expect(deps.runScript).toHaveBeenCalledExactlyOnceWith(windowsTaskActionScript("uninstall"));
    expect(deps.readStatus).not.toHaveBeenCalled();
    expect(deps.ready).not.toHaveBeenCalled();
  });
});

describe.skipIf(process.platform !== "win32")("Windows PowerShell boundary (no live tasks or servers)", () => {
  it("round-trips task settings and metadata through native cmdlets without registering a task", { timeout: 30_000 }, () => {
    // Only the manager mutation/listing boundary is replaced. The real Windows
    // cmdlets build triggers, principals, settings and actions (including quoting).
    const quoted = "C:\\O'Brien ‘left’ ‚low‛ $dollar `backtick";
    const fixture = { ...plan({ SHELL: quoted }), home: quoted, logDirectory: tmpdir() };
    const output = runWindowsTaskScript(`
Import-Module ScheduledTasks
$script:registered = @()
function Get-FixtureTask { $script:registered }
function Register-FixtureTask {
  param($TaskName, $TaskPath, $Action, $Trigger, $Principal, $Settings, $Description)
  $script:registered += [PSCustomObject]@{ TaskName=$TaskName; TaskPath=$TaskPath; Actions=@($Action); Description=$Description; State='Ready' }
}
function Get-FixtureTaskInfo { [CmdletBinding()] param([Parameter(ValueFromPipeline=$true)]$InputObject) process { [PSCustomObject]@{LastTaskResult=0} } }
# Aliases outrank auto-imported functions: these tests must never register real tasks.
Set-Alias Get-ScheduledTask Get-FixtureTask
Set-Alias Register-ScheduledTask Register-FixtureTask
Set-Alias Get-ScheduledTaskInfo Get-FixtureTaskInfo
function Remove-FixtureTask { throw 'Unexpected fixture rollback' }
Set-Alias Unregister-ScheduledTask Remove-FixtureTask
${windowsTaskInstallScript(fixture)}
${windowsTaskQueryScript()}
`);
    const tasks = parseWindowsTaskStatus(output);
    expect(tasks.map((task) => task.id)).toEqual(["sessiond", "web"]);
    expect(tasks[0]?.plan).toEqual(fixture);
    expect(tasks[1]?.state).toBe("Ready");
    expect(() => parseWindowsTaskStatus(output.replaceAll("-WindowStyle Hidden", "-WindowStyle Normal"))).toThrow("action was modified");
  });

  it("waits for a previous runner's log handle before launching Node exactly once", { timeout: 30_000 }, () => {
    const root = mkdtempSync(join(tmpdir(), "pi-web-log-lock-"));
    const quote = (value: string): string => `'${value.replaceAll("'", "''")}'`;
    try {
      const entrypoint = join(root, "fixture.cjs");
      const launches = join(root, "launches.txt");
      const retrySignal = join(root, "retry.txt");
      const script = join(root, "runner.ps1");
      const logDirectory = join(root, "logs");
      mkdirSync(logDirectory);
      const logPath = join(logDirectory, "web.log");
      writeFileSync(entrypoint, `require('node:fs').appendFileSync(${JSON.stringify(launches)}, 'launch\\n'); console.log('fixture output'); process.exit(17);\n`);
      const fixture: WindowsTaskPlan = {
        ...plan(), node: process.execPath, home: root, logDirectory,
        entrypoints: { sessiond: entrypoint, web: entrypoint },
      };
      // Signal from the generated runner's actual retry boundary lets the lock
      // owner release the handle deterministically, without a timing guess.
      const runner = windowsTaskRunner(fixture, "web").replace("Start-Sleep -Milliseconds 100", `Set-Content -LiteralPath ${quote(retrySignal)} -Value 'retry'\n  Start-Sleep -Milliseconds 100`);
      writeFileSync(script, `\uFEFF${runner}`);
      const output = runWindowsTaskScript(`
$ErrorActionPreference = 'Stop'
$handle = [IO.File]::Open(${quote(logPath)}, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::Write, [IO.FileShare]::Read)
$child = [Diagnostics.Process]::new()
try {
  $child.StartInfo.FileName = ${quote(fixture.powershell)}
  $child.StartInfo.Arguments = '-NoProfile -NonInteractive -File "' + ${quote(script)} + '"'
  $child.StartInfo.UseShellExecute = $false
  $child.StartInfo.CreateNoWindow = $true
  $child.StartInfo.RedirectStandardError = $true
  $child.Start() | Out-Null
  $deadline = (Get-Date).AddSeconds(10)
  while (-not (Test-Path -LiteralPath ${quote(retrySignal)}) -and -not $child.HasExited -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 50 }
  $retried = Test-Path -LiteralPath ${quote(retrySignal)}
  $handle.Dispose()
  if (-not $child.WaitForExit(10000)) { throw 'Fixture runner did not exit' }
  [PSCustomObject]@{ retried = $retried; exitCode = $child.ExitCode; stderr = $child.StandardError.ReadToEnd() } | ConvertTo-Json -Compress
} finally {
  $handle.Dispose()
  if ($child.Id -and -not $child.HasExited) { $child.Kill(); $child.WaitForExit() }
  $child.Dispose()
}
`);
      expect(JSON.parse(output)).toMatchObject({ retried: true, exitCode: 17, stderr: "" });
      expect(readFileSync(launches, "utf8")).toBe("launch\n");
      expect(readFileSync(logPath, "utf16le")).toContain("fixture output");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("executes a harmless Node fixture with spaces, Unicode, apostrophes, logs, and nonzero exit", { timeout: 30_000 }, () => {
    const root = mkdtempSync(join(tmpdir(), "pi-web O'Brien ‘left’ ‚low‛ ü-"));
    try {
      const entrypoint = join(root, "fixture.js");
      writeFileSync(entrypoint, "console.log(JSON.stringify({nested:process.env.PI_WEB_SESSION,socket:process.env.PI_WEB_SESSIOND_SOCKET,docker:process.env.PI_WEB_DOCKER_MODE,config:process.env.PI_WEB_CONFIG,cwd:process.cwd(),offline:process.env.PI_WEB_OFFLINE,hosts:process.env.PI_WEB_ALLOWED_HOSTS,spawn:process.env.PI_WEB_SPAWN_SESSIONS,subsessions:process.env.PI_WEB_SUBSESSIONS,ask:process.env.PI_WEB_ASK_USER,facts:process.env.PI_WEB_ENVIRONMENT_FACTS,profile:process.env.PI_WEB_AGENT_DIR})); console.error('fixture stderr'); process.exit(17);\n");
      mkdirSync(join(root, "logs"));
      const fixture: WindowsTaskPlan = {
        ...plan(), node: process.execPath, home: root, logDirectory: join(root, "logs"),
        environment: { ...plan().environment, PI_WEB_CONFIG: join(root, "config '$name`;.json") },
        entrypoints: { sessiond: entrypoint, web: entrypoint },
      };
      const script = join(root, "runner.ps1");
      writeFileSync(script, `\uFEFF${windowsTaskRunner(fixture, "web")}`);
      const result = spawnSync(fixture.powershell, ["-NoProfile", "-NonInteractive", "-File", script], {
        encoding: "utf8", windowsHide: true, timeout: 20_000,
        env: {
          ...process.env, PI_WEB_SESSION: "1", PI_WEB_SESSIOND_SOCKET: "foreign.sock", PI_WEB_DOCKER_MODE: "runtime",
          PI_WEB_OFFLINE: "1", PI_WEB_ALLOWED_HOSTS: "example.test", PI_WEB_SPAWN_SESSIONS: "false",
          PI_WEB_SUBSESSIONS: "false", PI_WEB_ASK_USER: "false", PI_WEB_ENVIRONMENT_FACTS: "false",
          PI_WEB_AGENT_DIR: join(root, "inherited-profile"),
        },
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(17);
      const log = readFileSync(join(root, "logs", "web.log"), "utf16le");
      expect(log).toContain(JSON.stringify(fixture.environment["PI_WEB_CONFIG"]));
      expect(log).toContain(JSON.stringify(root));
      expect(log).toContain("fixture stderr");
      expect(log).not.toContain('"nested"');
      expect(log).not.toContain('"socket"');
      expect(log).not.toContain('"docker"');
      expect(log).toContain('"offline":"1"');
      expect(log).toContain('"hosts":"example.test"');
      for (const key of ["spawn", "subsessions", "ask", "facts"]) expect(log).toContain(`"${key}":"false"`);
      expect(log).toContain(`"profile":${JSON.stringify(join(root, "inherited-profile"))}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
