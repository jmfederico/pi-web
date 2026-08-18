import { spawn, type ChildProcessByStdio } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";

type FixtureChild = ChildProcessByStdio<null, Readable, Readable>;

const tempRoots: string[] = [];
const children = new Set<FixtureChild>();

afterEach(async () => {
  for (const child of children) child.kill("SIGKILL");
  children.clear();
  await Promise.all(tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("sessiond persisted server plugin recovery", () => {
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
    const root = await mkdtemp(join(tmpdir(), "pi-web-sessiond-plugin-recovery-"));
    tempRoots.push(root);
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

    const child = spawn(process.execPath, ["--import", "tsx", "src/server/sessiond.ts"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: join(root, "home"),
        PI_WEB_CONFIG: configPath,
        PI_WEB_DATA_DIR: dataDir,
        PI_WEB_AGENT_DIR: join(root, "agent"),
        PI_WEB_OFFLINE: "1",
        PI_WEB_SESSIOND_PORT: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.add(child);

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
    const root = await mkdtemp(join(tmpdir(), "pi-web-sessiond-plugin-startup-signal-"));
    tempRoots.push(root);
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

    const child = spawn(process.execPath, ["--import", "tsx", "src/server/sessiond.ts"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: join(root, "home"),
        PI_WEB_CONFIG: configPath,
        PI_WEB_DATA_DIR: dataDir,
        PI_WEB_AGENT_DIR: join(root, "agent"),
        PI_WEB_OFFLINE: "1",
        PI_WEB_SESSIOND_PORT: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.add(child);

    await waitForOutput(child, "PLUGIN_STARTED", 15_000);
    expect(existsSync(startedMarker)).toBe(true);
    child.kill("SIGTERM");
    const exit = await waitForExit(child, 15_000);
    children.delete(child);

    expect(exit).toEqual({ code: 0, signal: null });
    expect(existsSync(stoppedMarker)).toBe(true);
  }, 35_000);
});

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
