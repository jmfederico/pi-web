import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const exec = promisify(execFile);
const npmCli = process.env.npm_execpath;
const groupLauncher = fileURLToPath(new URL("./dev-services.mjs", import.meta.url));

// npm supplies its own CLI path when running either npm test or npm exec vitest.
describe.skipIf(!npmCli)("development npm lifecycles (requires npm-provided CLI)", () => {
  it.each([
    { preExit: 0, mainExit: 0, expected: ["pre", "main", "post"], exit: 0 },
    { preExit: 9, mainExit: 0, expected: ["pre"], exit: 9 },
    { preExit: 0, mainExit: 7, expected: ["pre", "main"], exit: 7 },
  ])("orders prerequisites and propagates failures ($preExit, $mainExit)", async ({ preExit, mainExit, expected, exit }) => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-web-dev-lifecycle-"));
    try {
      await writeFile(join(cwd, "package.json"), JSON.stringify({
        private: true,
        scripts: {
          group: `node "${groupLauncher}" fixture:service`,
          "prefixture:service": `node record.cjs pre ${preExit}`,
          "fixture:service": `node record.cjs main ${mainExit}`,
          "postfixture:service": "node record.cjs post 0",
        },
      }));
      await writeFile(join(cwd, "record.cjs"), `
const fs = require('node:fs');
const phase = process.argv[2];
if (phase === 'main' && !fs.existsSync('prepared')) process.exit(99);
fs.appendFileSync('order', phase + '\\n');
if (phase === 'pre' && process.argv[3] === '0') fs.writeFileSync('prepared', 'ready');
process.exit(Number(process.argv[3]));
`);
      let result;
      try {
        await exec(process.execPath, [npmCli, "run", "group"], { cwd, timeout: 15_000 });
        result = 0;
      } catch (error) { result = error.code; }
      expect(result).toBe(exit);
      expect((await readFile(join(cwd, "order"), "utf8")).trim().split("\n")).toEqual(expected);
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  it.each(["stale", "missing", "not removable as a file"])("only enters the dev group after clearing readiness (%s)", async (marker) => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-web-dev-readiness-"));
    try {
      const { scripts } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
      // Use the repository's actual prerequisite and observe its effect at
      // group entry, before any child (including the builder) can run.
      await writeFile(join(cwd, "package.json"), JSON.stringify({
        private: true,
        scripts: { predev: scripts.predev, dev: "node enter.cjs" },
      }));
      await writeFile(join(cwd, "enter.cjs"), `
const fs = require('node:fs');
fs.writeFileSync('observed-readiness', String(fs.existsSync('dist/.plugins-ready')));
`);
      const readyPath = join(cwd, "dist", ".plugins-ready");
      if (marker === "stale") {
        await mkdir(join(cwd, "dist"));
        await writeFile(readyPath, "ready\n");
      } else if (marker === "not removable as a file") {
        await mkdir(readyPath, { recursive: true });
      }
      const running = exec(process.execPath, [npmCli, "run", "dev"], { cwd, timeout: 15_000 });
      const observed = () => readFile(join(cwd, "observed-readiness"), "utf8");
      if (marker === "not removable as a file") {
        await expect(running).rejects.toMatchObject({ stderr: expect.stringContaining(".plugins-ready") });
        await expect(observed()).rejects.toMatchObject({ code: "ENOENT" });
      } else {
        await running;
        expect(await observed()).toBe("false");
      }
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  it.skipIf(process.platform === "win32").each([
    { trigger: "failure", exit: 7 },
    { trigger: "shutdown", exit: 143 },
  ])("waits for nested runtime cleanup after its npm owner exits ($trigger)", async ({ trigger, exit }) => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-web-dev-group-"));
    try {
      await writeFile(join(cwd, "package.json"), JSON.stringify({
        private: true,
        scripts: {
          group: "node group.mjs",
          "fixture:long": "node owner.mjs",
          "fixture:fail": "node fail.cjs",
        },
      }));
      await writeFile(join(cwd, "group.mjs"), `
import { writeFileSync } from 'node:fs';
import { runDevelopmentServices } from ${JSON.stringify(new URL("./dev-services.mjs", import.meta.url).href)};
writeFileSync('group-pid', String(process.pid));
process.exitCode = await runDevelopmentServices(['fixture:long', 'fixture:fail']);
`);
      await writeFile(join(cwd, "owner.mjs"), `
import { startDevelopmentProcess, superviseDevelopmentProcesses } from ${JSON.stringify(new URL("./dev-processes.mjs", import.meta.url).href)};
process.exitCode = await superviseDevelopmentProcesses(add => {
  add(startDevelopmentProcess('long.cjs', [], process.env));
});
`);
      await writeFile(join(cwd, "long.cjs"), `
const fs = require('node:fs');
let cleaning = false;
process.on('SIGTERM', () => {
  if (cleaning) return;
  cleaning = true;
  // Model asynchronous terminal/session cleanup in a nested service runtime.
  setTimeout(() => { fs.writeFileSync('stopped', 'clean'); process.exit(0); }, 100);
});
setInterval(() => {}, 1000);
fs.writeFileSync('started', String(process.pid));
`);
      await writeFile(join(cwd, "fail.cjs"), `
const fs = require('node:fs');
let triggered = false;
function trigger() {
  if (triggered || !fs.existsSync('started')) return;
  triggered = true;
  if (${JSON.stringify(trigger)} === 'failure') process.exit(7);
  process.kill(Number(fs.readFileSync('group-pid', 'utf8')), 'SIGTERM');
}
const watcher = fs.watch('.', trigger);
trigger();
`);
      await expect(exec(process.execPath, [npmCli, "run", "group"], { cwd, timeout: 15_000 })).rejects.toMatchObject({ code: exit });
      expect(await readFile(join(cwd, "stopped"), "utf8")).toBe("clean");
      const pid = Number(await readFile(join(cwd, "started"), "utf8"));
      expect(() => process.kill(pid, 0)).toThrow();
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });
});
