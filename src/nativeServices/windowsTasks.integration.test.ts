import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { expect, it } from "vitest";
import {
  parseWindowsTaskStatus,
  runWindowsTaskScript,
  windowsTaskActionScript,
  windowsTaskInstallScript,
  windowsTaskPlan,
  windowsTaskQueryScript,
} from "./windowsTasks.js";

interface FixtureProcess { pid: number; startTicks: string }

// Opt-in: uniquely named tasks and harmless processes, never live PI WEB data.
it.skipIf(process.platform !== "win32" || process.env["PI_WEB_TEST_WINDOWS_TASKS"] !== "1")(
  "Windows Task Scheduler owns and terminates the complete fixture process trees",
  { timeout: 300_000 },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-web-task-smoke-"));
    const prefix = `PI-WEB-TEST-${String(process.pid)}-${String(Date.now())}-`;
    function isolated(script: string): string {
      const source = "$prefix = 'PI-WEB-'";
      if (!script.includes(source)) throw new Error("Cannot isolate task script");
      return script.replace(source, `$prefix = '${prefix}'`);
    }
    function startTicks(pid: number): string {
      if (!Number.isInteger(pid) || pid <= 0) throw new Error("Invalid fixture PID");
      return runWindowsTaskScript(`$p = Get-Process -Id ${String(pid)} -ErrorAction SilentlyContinue
if ($null -ne $p) { $p.StartTime.ToUniversalTime().Ticks.ToString() }`).trim();
    }
    function identify(pid: number): FixtureProcess {
      const ticks = startTicks(pid);
      if (!/^\d+$/u.test(ticks)) throw new Error(`Fixture process ${String(pid)} disappeared before identification`);
      return { pid, startTicks: ticks };
    }
    function alive(target: FixtureProcess): boolean {
      try { process.kill(target.pid, 0); } catch { return false; }
      return startTicks(target.pid) === target.startTicks;
    }
    function kill(target: FixtureProcess): void {
      // Hold an OS process handle and check its creation time before killing.
      // PID reuse must never let fixture cleanup terminate an unrelated process.
      runWindowsTaskScript(`$p = Get-Process -Id ${String(target.pid)} -ErrorAction SilentlyContinue
if ($null -ne $p) {
  try {
    $null = $p.Handle
    if ($p.StartTime.ToUniversalTime().Ticks.ToString() -eq '${target.startTicks}') { $p.Kill() }
  } finally { $p.Dispose() }
}`);
    }
    const known = new Set<FixtureProcess>();
    const generations = new Map<string, FixtureProcess[]>();
    function fixtureProcesses(): FixtureProcess[] {
      return ["sessiond", "web"].flatMap((id) => {
        const path = join(root, `${id}.pids`);
        if (!existsSync(path)) return [];
        const generation = readFileSync(path, "utf8");
        let entries = generations.get(generation);
        if (entries === undefined) {
          entries = generation.split(",").slice(0, 2).map((pid) => identify(Number(pid)));
          entries.forEach((entry) => known.add(entry));
          generations.set(generation, entries);
        }
        return entries;
      });
    }
    async function waitForReplacement(before: FixtureProcess[], daemonOnly: boolean, timeoutMs = 30_000): Promise<FixtureProcess[]> {
      const deadline = Date.now() + timeoutMs;
      const replaced = daemonOnly ? before.slice(0, 2) : before;
      while (Date.now() < deadline) {
        const current = fixtureProcesses();
        if (current.length === 4 && current[0] !== before[0] && current.every(alive) && !replaced.some(alive)) {
          if (daemonOnly) expect(current.slice(2)).toEqual(before.slice(2));
          else expect(current.some((entry) => before.includes(entry))).toBe(false);
          return current;
        }
        await setTimeout(250);
      }
      throw new Error(`Fixture replacement timed out: ${JSON.stringify({ before, current: fixtureProcesses(), surviving: replaced.filter(alive) })}`);
    }
    const plan = windowsTaskPlan({
      node: process.execPath, packageRoot: root, home: root, configPath: join(root, "config.json"), dataDirectory: root,
      environment: { SystemRoot: process.env["SystemRoot"] },
    });
    for (const id of ["sessiond", "web"] as const) {
      plan.entrypoints[id] = join(root, `${id}.cjs`);
      writeFileSync(plan.entrypoints[id], `
const {spawn} = require('node:child_process');
const {writeFileSync, existsSync, readFileSync, unlinkSync, renameSync} = require('node:fs');
const {randomUUID} = require('node:crypto');
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio:'ignore'});
const marker = ${JSON.stringify(join(root, `${id}.pids`))};
writeFileSync(${JSON.stringify(join(root, `${id}.owner`))}, String(process.ppid));
writeFileSync(marker + '.tmp', process.pid + ',' + child.pid + ',' + randomUUID());
renameSync(marker + '.tmp', marker);
const exitRequest = ${JSON.stringify(join(root, `${id}.exit`))};
setInterval(() => {
  if (existsSync(exitRequest)) {
    const code = Number(readFileSync(exitRequest, 'utf8'));
    unlinkSync(exitRequest);
    process.exit(code);
  }
}, 100);
`);
    }
    try {
      runWindowsTaskScript(isolated(windowsTaskInstallScript(plan)));
      runWindowsTaskScript(isolated(windowsTaskActionScript("start")));
      const deadline = Date.now() + 30_000;
      while (fixtureProcesses().length !== 4 && Date.now() < deadline) await setTimeout(200);
      let current = fixtureProcesses();
      expect(current).toHaveLength(4);
      expect(current.every(alive)).toBe(true);
      const tasks = parseWindowsTaskStatus(runWindowsTaskScript(isolated(windowsTaskQueryScript())));
      expect(tasks).toHaveLength(2);
      expect(tasks.every((task) => task.state === "Running")).toBe(true);

      // Reload, failure, and forced death must replace only the daemon's tree.
      for (const exitCode of [0, 17, "kill"] as const) {
        const daemon = current[0];
        if (daemon === undefined) throw new Error("Missing fixture daemon");
        if (exitCode === "kill") kill(daemon);
        else writeFileSync(join(root, "sessiond.exit"), String(exitCode));
        current = await waitForReplacement(current, true);
      }
      // Resolve the supervisor through the fixture worker's live ancestry.
      const worker = identify(Number(readFileSync(join(root, "sessiond.owner"), "utf8")));
      const supervisor = identify(Number(runWindowsTaskScript(`(Get-CimInstance Win32_Process -Filter 'ProcessId = ${String(worker.pid)}').ParentProcessId`)));
      expect(alive(worker)).toBe(true);
      kill(supervisor);
      current = await waitForReplacement(current, true, 85_000);

      runWindowsTaskScript(isolated(windowsTaskActionScript("start")));
      expect(fixtureProcesses()).toEqual(current);
      expect(() => runWindowsTaskScript(isolated(windowsTaskInstallScript(plan)))).toThrow("already exist");
      runWindowsTaskScript(isolated(windowsTaskActionScript("restart", "sessiond")));
      current = await waitForReplacement(current, true);
      runWindowsTaskScript(isolated(windowsTaskActionScript("restart")));
      current = await waitForReplacement(current, false);
      runWindowsTaskScript(isolated(windowsTaskActionScript("stop")));
      const stopDeadline = Date.now() + 5000;
      while (current.some(alive) && Date.now() < stopDeadline) await setTimeout(100);
      expect(current.filter(alive), "stop must terminate the owned tree").toEqual([]);
      const stopped = parseWindowsTaskStatus(runWindowsTaskScript(isolated(windowsTaskQueryScript())));
      expect(stopped.every((task) => task.state === "Disabled")).toBe(true);
      await setTimeout(65_000); // Outwait the scheduler's recovery interval.
      expect(fixtureProcesses()).toEqual(current);
      expect(current.filter(alive)).toEqual([]);
    } finally {
      try {
        runWindowsTaskScript(isolated(windowsTaskActionScript("uninstall")));
        expect(parseWindowsTaskStatus(runWindowsTaskScript(isolated(windowsTaskQueryScript())))).toEqual([]);
      } finally {
        for (const target of known) { if (alive(target)) kill(target); }
        await setTimeout(1500);
        rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      }
    }
  },
);
