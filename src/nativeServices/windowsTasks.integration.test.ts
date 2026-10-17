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

// Opt-in only: registers temporary uniquely named tasks running harmless Node
// timers. It never targets PI WEB services, ports, configuration, or user data.
it.skipIf(process.platform !== "win32" || process.env["PI_WEB_TEST_WINDOWS_TASKS"] !== "1")(
  "Windows Task Scheduler owns and terminates the complete fixture process trees",
  { timeout: 240_000 },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-web-task-smoke-"));
    const prefix = `PI-WEB-TEST-${String(process.pid)}-${String(Date.now())}-`;
    function isolated(script: string): string {
      const source = "$prefix = 'PI-WEB-'";
      if (!script.includes(source)) throw new Error("Cannot isolate task script");
      return script.replace(source, `$prefix = '${prefix}'`);
    }
    const knownPids = new Set<number>();
    function fixturePids(): number[] {
      return ["sessiond", "web"].flatMap((id) => {
        const path = join(root, `${id}.pids`);
        if (!existsSync(path)) return [];
        return readFileSync(path, "utf8").split(",").map(Number).filter((pid) => Number.isInteger(pid) && pid > 0);
      });
    }
    function alive(pid: number): boolean {
      try { process.kill(pid, 0); return true; } catch { return false; }
    }
    const plan = windowsTaskPlan({
      node: process.execPath, packageRoot: root, home: root, configPath: join(root, "config.json"), dataDirectory: root,
      environment: { SystemRoot: process.env["SystemRoot"] },
    });
    for (const id of ["sessiond", "web"] as const) {
      plan.entrypoints[id] = join(root, `${id}.cjs`);
      writeFileSync(plan.entrypoints[id], `
const {spawn} = require('node:child_process');
const {writeFileSync, existsSync, readFileSync, unlinkSync} = require('node:fs');
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio:'ignore'});
writeFileSync(${JSON.stringify(join(root, `${id}.pids`))}, process.pid + ',' + child.pid);
writeFileSync(${JSON.stringify(join(root, `${id}.owner`))}, String(process.ppid));
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
      while (fixturePids().length !== 4 && Date.now() < deadline) await setTimeout(200);
      let originalPids = fixturePids();
      originalPids.forEach((pid) => knownPids.add(pid));
      expect(originalPids).toHaveLength(4);
      expect(originalPids.every(alive)).toBe(true);
      const tasks = parseWindowsTaskStatus(runWindowsTaskScript(isolated(windowsTaskQueryScript())));
      expect(tasks).toHaveLength(2);
      expect(tasks.every((task) => task.state === "Running")).toBe(true);

      // Both successful reload exits and failures replace the daemon generation,
      // clean its abandoned child, and leave the independent web process alone.
      for (const exitCode of [0, 17, "kill"] as const) {
        const before = fixturePids();
        const daemonPid = before[0];
        if (daemonPid === undefined) throw new Error("Fixture daemon PID is missing");
        if (exitCode === "kill") process.kill(daemonPid);
        else writeFileSync(join(root, "sessiond.exit"), String(exitCode));
        const recoveryDeadline = Date.now() + 30_000;
        while (Date.now() < recoveryDeadline) {
          const current = fixturePids();
          if (current.length === 4 && current[0] !== before[0] && current.every(alive)
            && !before.slice(0, 2).some(alive)) break;
          await setTimeout(100);
        }
        originalPids = fixturePids();
        originalPids.forEach((pid) => knownPids.add(pid));
        expect(originalPids[0]).not.toBe(before[0]);
        expect(originalPids.slice(2)).toEqual(before.slice(2));
        expect(before.slice(0, 2).filter(alive)).toEqual([]);
      }
      // Kill only this fixture's supervisor, found through its worker's ancestry.
      // The scheduler must recover the owner, not just its Node child.
      const workerPid = Number(readFileSync(join(root, "sessiond.owner"), "utf8"));
      expect(Number.isInteger(workerPid) && workerPid > 0).toBe(true);
      const supervisorPid = Number(runWindowsTaskScript(`(Get-CimInstance Win32_Process -Filter 'ProcessId = ${String(workerPid)}').ParentProcessId`));
      expect(Number.isInteger(supervisorPid) && supervisorPid > 0).toBe(true);
      const beforeOwnerCrash = fixturePids();
      process.kill(supervisorPid);
      const ownerRecoveryDeadline = Date.now() + 85_000;
      while (Date.now() < ownerRecoveryDeadline) {
        const current = fixturePids();
        if (current.length === 4 && current[0] !== beforeOwnerCrash[0] && current.every(alive)
          && !beforeOwnerCrash.slice(0, 2).some(alive)) break;
        await setTimeout(250);
      }
      originalPids = fixturePids();
      originalPids.forEach((pid) => knownPids.add(pid));
      expect(originalPids[0], JSON.stringify(parseWindowsTaskStatus(runWindowsTaskScript(isolated(windowsTaskQueryScript()))).map(({ id, state, lastResult }) => ({ id, state, lastResult })))).not.toBe(beforeOwnerCrash[0]);
      expect(originalPids.slice(2)).toEqual(beforeOwnerCrash.slice(2));
      expect(beforeOwnerCrash.slice(0, 2).filter(alive)).toEqual([]);

      runWindowsTaskScript(isolated(windowsTaskActionScript("start")));
      expect(fixturePids()).toEqual(originalPids);
      expect(() => runWindowsTaskScript(isolated(windowsTaskInstallScript(plan)))).toThrow("already exist");
      runWindowsTaskScript(isolated(windowsTaskActionScript("restart", "sessiond")));
      const daemonRestartDeadline = Date.now() + 30_000;
      while (Date.now() < daemonRestartDeadline) {
        const current = fixturePids();
        if (current[0] !== originalPids[0] && current.every(alive) && !originalPids.slice(0, 2).some(alive)) break;
        await setTimeout(100);
      }
      const daemonRestartedPids = fixturePids();
      daemonRestartedPids.forEach((pid) => knownPids.add(pid));
      expect(daemonRestartedPids[0]).not.toBe(originalPids[0]);
      expect(daemonRestartedPids.slice(2)).toEqual(originalPids.slice(2));
      expect(originalPids.slice(0, 2).filter(alive)).toEqual([]);
      originalPids = daemonRestartedPids;
      runWindowsTaskScript(isolated(windowsTaskActionScript("restart")));
      // Scheduler state changes precede process-tree teardown and runner startup.
      // Wait for both observable outcomes, not just the replacement PID files.
      const restartDeadline = Date.now() + 30_000;
      while (Date.now() < restartDeadline) {
        const currentPids = fixturePids();
        if (currentPids.length === 4 && currentPids.every(alive)
          && !currentPids.some((pid) => originalPids.includes(pid)) && !originalPids.some(alive)) break;
        await setTimeout(100);
      }
      const restartedPids = fixturePids();
      restartedPids.forEach((pid) => knownPids.add(pid));
      expect(restartedPids).toHaveLength(4);
      expect(restartedPids.some((pid) => originalPids.includes(pid))).toBe(false);
      expect(originalPids.filter(alive)).toEqual([]);
      originalPids = restartedPids;
      runWindowsTaskScript(isolated(windowsTaskActionScript("stop")));
      const stopDeadline = Date.now() + 5000;
      while (originalPids.some(alive) && Date.now() < stopDeadline) await setTimeout(100);
      expect(originalPids.filter(alive), "stopping tasks must also terminate Node and descendants").toEqual([]);
      const stopped = parseWindowsTaskStatus(runWindowsTaskScript(isolated(windowsTaskQueryScript())));
      expect(stopped.every((task) => task.state === "Disabled")).toBe(true);
      // Also outwait the scheduler's one-minute owner recovery interval.
      await setTimeout(65_000);
      expect(fixturePids()).toEqual(originalPids);
      expect(originalPids.filter(alive)).toEqual([]);
    } finally {
      // Both the task namespace and every process here belong solely to this fixture.
      try {
        runWindowsTaskScript(isolated(windowsTaskActionScript("uninstall")));
        expect(parseWindowsTaskStatus(runWindowsTaskScript(isolated(windowsTaskQueryScript())))).toEqual([]);
      } finally {
        fixturePids().forEach((pid) => knownPids.add(pid));
        for (const pid of knownPids) { if (alive(pid)) process.kill(pid); }
        await setTimeout(1500);
        rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      }
    }
  },
);
