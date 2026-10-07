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
  { timeout: 90_000 },
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
const {writeFileSync} = require('node:fs');
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio:'ignore'});
writeFileSync(${JSON.stringify(join(root, `${id}.pids`))}, process.pid + ',' + child.pid);
setInterval(() => {}, 1000);
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

      runWindowsTaskScript(isolated(windowsTaskActionScript("start")));
      expect(fixturePids()).toEqual(originalPids);
      expect(() => runWindowsTaskScript(isolated(windowsTaskInstallScript(plan)))).toThrow("already exist");
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
      expect(stopped.every((task) => task.state === "Ready")).toBe(true);
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
