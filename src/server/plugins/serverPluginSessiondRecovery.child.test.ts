import { spawn, type ChildProcessByStdio } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, cp, lstat, mkdir, mkdtemp, readdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildTerminalPackage } from "../../../scripts/build-plugins.mjs";

type FixtureChild = ChildProcessByStdio<null, Readable, Readable>;

const tempRoots = new Set<string>();
const children = new Set<FixtureChild>();
const liveTerminalRoot = resolve("dist/pi-web-plugins/terminal");
let liveTerminalBefore: string;

beforeEach(async () => {
  liveTerminalBefore = await snapshotDirectory(liveTerminalRoot);
});

afterEach(async () => {
  for (const child of children) {
    child.kill("SIGKILL");
    await waitForExit(child, 10_000);
  }
  children.clear();
  for (const root of tempRoots) {
    assertOwnedRoot(root);
    if ((await lstat(root)).isSymbolicLink()) throw new Error(`Refusing to clean symlink: ${root}`);
    await rm(root, { recursive: true, force: true });
    tempRoots.delete(root);
  }
  // Check after cleanup too: the original regression deleted the live bundle here.
  expect(await snapshotDirectory(liveTerminalRoot)).toBe(liveTerminalBefore);
});

describe("sessiond persisted server plugin recovery", () => {
  it("rejects cleanup of the live Terminal bundle and unowned temporary directories", () => {
    expect(() => { assertOwnedRoot(liveTerminalRoot); }).toThrow("Refusing to clean unowned directory");
    expect(() => { assertOwnedRoot(join(tmpdir(), "pi-web-sessiond-plugin-unowned")); }).toThrow("Refusing to clean unowned directory");
  });
  it.each([
    {
      name: "starts from real config and catalog with no server module imports in emergency safe start",
      safeStart: "none",
      expectedDiagnostic: undefined,
    },
    {
      name: "fails closed and starts without server module imports when safe start is malformed",
      safeStart: "future-level",
      expectedDiagnostic: "No server plugins will be loaded until safe start is repaired",
    },
  ])("$name", async ({ safeStart, expectedDiagnostic }) => {
    const root = await createDaemonFixture();
    const configPath = join(root, "config.json");
    const dataDir = join(root, "data");
    const pluginRoot = join(dataDir, "plugins", "poison");
    const markerPath = join(root, "poison-imported");
    await mkdir(pluginRoot, { recursive: true });
    await writeFile(configPath, `${JSON.stringify({ serverPlugins: { safeStart } })}\n`, "utf8");
    await writeFile(join(pluginRoot, "package.json"), `${JSON.stringify({
      piWeb: { plugins: [{ id: "poison", serverModule: "server.mjs" }] },
    })}\n`, "utf8");
    await writeFile(join(pluginRoot, "server.mjs"), `
      import { writeFileSync } from "node:fs";
      writeFileSync(${JSON.stringify(markerPath)}, "imported");
      process.exit(97);
    `, "utf8");

    const child = spawnFixtureDaemon(root);

    const startupOutput = await waitForOutput(child, "Server listening at", 15_000);
    expect(startupOutput).toContain("Server listening at");
    if (expectedDiagnostic !== undefined) expect(startupOutput).toContain(expectedDiagnostic);
    expect(existsSync(markerPath)).toBe(false);

    child.kill("SIGTERM");
    const exit = await waitForExit(child, 10_000);
    children.delete(child);

    // Windows has no POSIX signal delivery: SIGTERM force-terminates the
    // child, so the graceful-shutdown exit code only holds on POSIX hosts.
    expect(exit).toEqual(
      process.platform === "win32" ? { code: null, signal: "SIGTERM" } : { code: 0, signal: null },
    );
    expect(existsSync(markerPath)).toBe(false);
  }, 30_000);

  // Plugin stop on SIGTERM requires POSIX signal delivery; Windows
  // force-terminates the child without running shutdown handlers.
  it.skipIf(process.platform === "win32")("stops activated plugins when SIGTERM arrives during sessiond startup", async () => {
    const root = await createDaemonFixture();
    // The copied catalog resolves bundled plugins relative to this temporary checkout.
    await buildTerminalPackage(resolve("pi-web-plugins/terminal"), join(root, "dist/pi-web-plugins/terminal"));
    const configPath = join(root, "config.json");
    const dataDir = join(root, "data");
    const pluginRoot = join(dataDir, "plugins", "startup-signal");
    const startedMarker = join(root, "plugin-started");
    const stoppedMarker = join(root, "plugin-stopped");
    await mkdir(pluginRoot, { recursive: true });
    await writeFile(configPath, "{}\n", "utf8");
    await writeFile(join(pluginRoot, "package.json"), `${JSON.stringify({
      piWeb: { plugins: [{ id: "startup-signal", serverModule: "server.mjs" }] },
    })}\n`, "utf8");
    await writeFile(join(pluginRoot, "server.mjs"), `
      import { writeFileSync } from "node:fs";
      export default {
        apiVersion: 1,
        name: "Startup signal fixture",
        activate() {
          return {
            async start() {
              writeFileSync(${JSON.stringify(startedMarker)}, "started");
              console.error("PLUGIN_STARTED");
              await new Promise((resolve) => setTimeout(resolve, 250));
            },
            stop() {
              writeFileSync(${JSON.stringify(stoppedMarker)}, "stopped");
            }
          };
        }
      };
    `, "utf8");

    const child = spawnFixtureDaemon(root);

    await waitForOutput(child, "PLUGIN_STARTED", 15_000);
    expect(existsSync(startedMarker)).toBe(true);
    child.kill("SIGTERM");
    const exit = await waitForExit(child, 15_000);
    children.delete(child);

    expect(exit).toEqual({ code: 0, signal: null });
    expect(existsSync(stoppedMarker)).toBe(true);
  }, 35_000);
});

function assertOwnedRoot(root: string): void {
  if (!tempRoots.has(root) || dirname(root) !== resolve(tmpdir()) || !basename(root).startsWith("pi-web-sessiond-plugin-")) {
    throw new Error(`Refusing to clean unowned directory: ${root}`);
  }
}

async function createDaemonFixture(): Promise<string> {
  const root = await mkdtemp(join(resolve(tmpdir()), "pi-web-sessiond-plugin-"));
  tempRoots.add(root);
  // Keep import.meta.url-based discovery in the fixture without adding a production
  // environment override. Only dependencies are linked; source and bundles are owned.
  await cp(resolve("src"), join(root, "src"), { recursive: true });
  await copyFile(resolve("package.json"), join(root, "package.json"));
  await symlink(resolve("node_modules"), join(root, "node_modules"), "junction");
  return root;
}

function spawnFixtureDaemon(root: string): FixtureChild {
  assertOwnedRoot(root);
  // Do not inherit the hosting daemon's PI_WEB_*, agent paths, config or credentials.
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "Path", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "TMP", "TEMP", "TMPDIR"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  const child = spawn(process.execPath, ["--import", "tsx", "src/server/sessiond.ts"], {
    cwd: root,
    env: {
      ...env,
      HOME: join(root, "home"),
      USERPROFILE: join(root, "home"),
      XDG_CONFIG_HOME: join(root, "home", ".config"),
      PI_WEB_CONFIG: join(root, "config.json"),
      PI_WEB_DATA_DIR: join(root, "data"),
      PI_CODING_AGENT_DIR: join(root, "agent"),
      PI_CODING_AGENT_SESSION_DIR: join(root, "agent", "sessions"),
      PI_WEB_OFFLINE: "1",
      PI_WEB_SESSIOND_SOCKET: join(root, "sessiond.sock"),
      PI_WEB_SESSIOND_HOST: "127.0.0.1",
      PI_WEB_SESSIOND_PORT: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  return child;
}

async function snapshotDirectory(root: string): Promise<string> {
  if (!existsSync(root)) return "missing";
  const hash = createHash("sha256");
  async function visit(path: string): Promise<void> {
    const stat = await lstat(path);
    hash.update(JSON.stringify([path, stat.mode, stat.mtimeMs]));
    if (stat.isSymbolicLink()) hash.update(await readlink(path));
    else if (stat.isDirectory()) {
      for (const name of (await readdir(path)).sort()) await visit(join(path, name));
    } else hash.update(await readFile(path));
  }
  await visit(root);
  return hash.digest("hex");
}

function waitForOutput(child: FixtureChild, expected: string, timeoutMs: number): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    let output = "";
    const timeout = setTimeout(() => {
      cleanup();
      rejectPromise(new Error(`Timed out waiting for child output ${JSON.stringify(expected)}:\n${output}`));
    }, timeoutMs);
    const onData = (chunk: unknown): void => {
      output += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      if (!output.includes(expected)) return;
      cleanup();
      resolvePromise(output);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      cleanup();
      rejectPromise(new Error(`Child exited before readiness (${String(code)}, ${String(signal)}):\n${output}`));
    };
    const cleanup = (): void => {
      clearTimeout(timeout);
      child.stdout.off("data", onData);
      child.stderr.off("data", onData);
      child.off("exit", onExit);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("exit", onExit);
  });
}

function waitForExit(
  child: FixtureChild,
  timeoutMs: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolvePromise, rejectPromise) => {
    const timeout = setTimeout(() => {
      cleanup();
      rejectPromise(new Error("Timed out waiting for sessiond shutdown"));
    }, timeoutMs);
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      cleanup();
      resolvePromise({ code, signal });
    };
    const cleanup = (): void => {
      clearTimeout(timeout);
      child.off("exit", onExit);
    };
    child.once("exit", onExit);
  });
}
