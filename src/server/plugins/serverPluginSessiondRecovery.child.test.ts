import { spawn, type ChildProcessByStdio } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, cp, lstat, mkdir, mkdtemp, readdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
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
    expect(existsSync(join(dataDir, "plugin-data"))).toBe(false);
  }, 30_000);

  it.skipIf(process.platform === "win32")("starts a plugin with its persistent directory in the early sessiond phase and permits I/O during disposal", async () => {
    const root = await createDaemonFixture();
    await buildTerminalPackage(resolve("pi-web-plugins/terminal"), join(root, "dist/pi-web-plugins/terminal"));

    const configPath = join(root, "config.json");
    const dataDir = join(root, "data");
    const pluginRoot = join(dataDir, "plugins", "state-only");
    const startedMarker = join(root, "state-plugin-started.json");
    const disposedMarker = join(root, "state-plugin-disposed.txt");
    await mkdir(pluginRoot, { recursive: true });
    await writeFile(configPath, "{}\n", "utf8");
    await writeFile(join(pluginRoot, "package.json"), `${JSON.stringify({
      piWeb: { plugins: [{ id: "state-only", serverModule: "server.mjs" }] },
    })}\n`, "utf8");
    await writeFile(join(pluginRoot, "server.mjs"), `
      import { readFile, writeFile } from "node:fs/promises";
      import { join } from "node:path";
      export default {
        apiVersion: 3,
        name: "State-only fixture",
        activate(context) {
          const filePath = join(context.dataDirectory, "state.json");
          return {
            async start() {
              await writeFile(filePath, JSON.stringify({ starts: 1 }));
              await writeFile(${JSON.stringify(startedMarker)}, JSON.stringify({ packageRoot: context.packageRoot }));
              console.error("STATE_PLUGIN_STARTED");
            },
            async dispose() {
              await writeFile(${JSON.stringify(disposedMarker)}, await readFile(filePath, "utf8"));
            }
          };
        }
      };
    `, "utf8");

    const child = spawnFixtureDaemon(root);

    const startupOutput = await waitForOutput(child, "Server listening at", 15_000);
    expect(startupOutput).toContain("STATE_PLUGIN_STARTED");
    expect(JSON.parse(await readFile(startedMarker, "utf8"))).toEqual({ packageRoot: pluginRoot });
    expect(JSON.parse(await readFile(join(dataDir, "plugin-data", "state-only", "state.json"), "utf8")))
      .toEqual({ starts: 1 });
    expect((await readdir(pluginRoot)).sort()).toEqual(["package.json", "server.mjs"]);

    child.kill("SIGTERM");
    const exit = await waitForExit(child, 10_000);
    children.delete(child);

    expect(exit).toEqual({ code: 0, signal: null });
    expect(JSON.parse(await readFile(disposedMarker, "utf8"))).toEqual({ starts: 1 });
  }, 35_000);

  it.skipIf(process.platform === "win32")("assembles early workspace providers and sessions before one late consumer resume", async () => {
    const root = await createDaemonFixture();
    await buildTerminalPackage(resolve("pi-web-plugins/terminal"), join(root, "dist/pi-web-plugins/terminal"));

    const configPath = join(root, "config.json");
    const dataDir = join(root, "data");
    const projectPath = join(root, "project");
    const projectId = "project-live-authority";
    const workspaceId = createHash("sha1").update(`${projectId}:main`).digest("hex").slice(0, 12);
    const eventsPath = join(root, "events.log");
    const authorityMarker = join(root, "workspace-authority.json");
    const runMarker = join(root, "pi-session-run.json");
    const disposedMarker = join(root, "workspace-consumer-disposed.json");
    const serverApiUrl = pathToFileURL(join(root, "src/server-plugin-api.ts")).href;
    await Promise.all([
      mkdir(projectPath, { recursive: true }),
      mkdir(join(dataDir, "plugins"), { recursive: true }),
    ]);
    await writeFile(configPath, "{}\n", "utf8");
    await writeFile(join(dataDir, "projects.json"), `${JSON.stringify({
      projects: [{
        id: projectId,
        name: "Live project",
        path: projectPath,
        createdAt: "2026-09-10T00:00:00.000Z",
      }],
    })}\n`, "utf8");

    const providerRoot = join(dataDir, "plugins", "provider");
    await mkdir(providerRoot, { recursive: true });
    await writeFile(join(providerRoot, "package.json"), `${JSON.stringify({
      piWeb: { plugins: [{ id: "a-workspace-provider", serverModule: "server.mjs" }] },
    })}\n`, "utf8");
    await writeFile(join(providerRoot, "server.mjs"), `
      import { appendFile } from "node:fs/promises";
      export default {
        apiVersion: 3,
        name: "Workspace provider fixture",
        activate() {
          return {
            workspaceProvider: {
              async probe(project) { return project.id === ${JSON.stringify(projectId)} ? "claim" : "pass"; },
              async list(project) {
                return [{
                  key: "main",
                  path: project.path,
                  label: "Provider main",
                  isMain: true,
                  data: { privateToken: "not-public" },
                  publicMetadata: { topology: "live" }
                }];
              }
            },
            async start() { await appendFile(${JSON.stringify(eventsPath)}, "provider:start\\n"); },
            async dispose() { await appendFile(${JSON.stringify(eventsPath)}, "provider:dispose\\n"); }
          };
        }
      };
    `, "utf8");

    const stateRoot = join(dataDir, "plugins", "state-early");
    await mkdir(stateRoot, { recursive: true });
    await writeFile(join(stateRoot, "package.json"), `${JSON.stringify({
      piWeb: { plugins: [{ id: "b-state-early", serverModule: "server.mjs" }] },
    })}\n`, "utf8");
    await writeFile(join(stateRoot, "server.mjs"), `
      import { appendFile, writeFile } from "node:fs/promises";
      import { join } from "node:path";
      export default {
        apiVersion: 3,
        name: "Early state fixture",
        activate(context) {
          return {
            async start() {
              await writeFile(join(context.dataDirectory, "state.json"), JSON.stringify({ phase: "early" }));
              await appendFile(${JSON.stringify(eventsPath)}, "state:start\\n");
            }
          };
        }
      };
    `, "utf8");

    const consumerRoot = join(dataDir, "plugins", "workspace-consumer");
    await mkdir(consumerRoot, { recursive: true });
    await writeFile(join(consumerRoot, "package.json"), `${JSON.stringify({
      piWeb: { plugins: [{ id: "z-workspace-consumer", serverModule: "server.mjs" }] },
    })}\n`, "utf8");
    await writeFile(join(consumerRoot, "server.mjs"), `
      import { appendFile, writeFile } from "node:fs/promises";
      import {
        PI_WEB_HOST_PI_SESSIONS_CAPABILITY,
        PI_WEB_HOST_PI_SESSION_EVENTS_CAPABILITY,
        PI_WEB_HOST_WORKSPACES_CAPABILITY
      } from ${JSON.stringify(serverApiUrl)};
      let workspaces;
      let piSessions;
      let sessionEvents;
      let connection;
      let createdConnection;
      let run;
      const selection = ${JSON.stringify({ projectId, workspaceId })};
      export default {
        apiVersion: 3,
        name: "Workspace consumer fixture",
        requires: [PI_WEB_HOST_WORKSPACES_CAPABILITY, PI_WEB_HOST_PI_SESSIONS_CAPABILITY, PI_WEB_HOST_PI_SESSION_EVENTS_CAPABILITY],
        activate() {
          return {
            async start({ capabilities }) {
              workspaces = capabilities.resolve(PI_WEB_HOST_WORKSPACES_CAPABILITY);
              piSessions = capabilities.resolve(PI_WEB_HOST_PI_SESSIONS_CAPABILITY);
              sessionEvents = capabilities.resolve(PI_WEB_HOST_PI_SESSION_EVENTS_CAPABILITY);
              const authority = await workspaces.resolve(selection);
              run = await piSessions.run({ ...selection, prompt: "Report the current workspace name." });
              await writeFile(${JSON.stringify(authorityMarker)}, JSON.stringify(authority));
              connection = await sessionEvents.connect({ ...selection, sessionId: run.sessionId });
              let echoed;
              connection.on("fixture:echo", data => { echoed = data; });
              connection.emit("fixture:echo", "connected");
              const created = await piSessions.create(selection);
              createdConnection = await sessionEvents.connect({ ...selection, sessionId: created.sessionId });
              let createdEcho;
              createdConnection.on("fixture:echo", data => { createdEcho = data; });
              createdConnection.emit("fixture:echo", "created and connected");
              await writeFile(${JSON.stringify(runMarker)}, JSON.stringify({ sessionId: run.sessionId, echoed, createdId: created.sessionId, createdEcho }));
              await appendFile(${JSON.stringify(eventsPath)}, "consumer:start\\n");
              console.error("WORKSPACE_CONSUMER_STARTED");
            },
            async dispose() {
              const result = { completion: await run.completion, connectionClosed: connection.signal.aborted, createdConnectionClosed: createdConnection.signal.aborted };
              try {
                await workspaces.resolve(selection);
                result.workspaceError = "workspace authority remained active";
              } catch (error) {
                result.workspaceError = error instanceof Error ? error.message : String(error);
              }
              try {
                await piSessions.run({ ...selection, prompt: "must not start" });
                result.piSessionsError = "PI sessions remained active";
              } catch (error) {
                result.piSessionsError = error instanceof Error ? error.message : String(error);
              }
              await writeFile(${JSON.stringify(disposedMarker)}, JSON.stringify(result));
            }
          };
        }
      };
    `, "utf8");

    const child = spawnFixtureDaemon(root);

    const startupOutput = await waitForOutput(child, "Server listening at", 20_000);
    expect(startupOutput).toContain("WORKSPACE_CONSUMER_STARTED");
    expect((await readFile(eventsPath, "utf8")).trim().split("\n")).toEqual([
      "provider:start",
      "state:start",
      "consumer:start",
    ]);
    expect(JSON.parse(await readFile(authorityMarker, "utf8"))).toEqual({
      project: { id: projectId, name: "Live project", path: projectPath },
      workspace: {
        id: workspaceId,
        projectId,
        path: projectPath,
        label: "Provider main",
        isMain: true,
        provider: {
          pluginId: "a-workspace-provider",
          capabilities: { remove: false },
          metadata: { topology: "live" },
        },
      },
    });
    const admittedRun = await readJsonObject(runMarker);
    expect(typeof admittedRun["sessionId"]).toBe("string");
    expect(admittedRun["sessionId"]).not.toBe("");
    expect(admittedRun["echoed"]).toBe("connected");
    expect(typeof admittedRun["createdId"]).toBe("string");
    expect(admittedRun["createdId"]).not.toBe(admittedRun["sessionId"]);
    expect(admittedRun["createdEcho"]).toBe("created and connected");
    expect(JSON.parse(await readFile(join(dataDir, "plugin-data", "b-state-early", "state.json"), "utf8")))
      .toEqual({ phase: "early" });

    child.kill("SIGTERM");
    const exit = await waitForExit(child, 10_000);
    children.delete(child);

    expect(exit).toEqual({ code: 0, signal: null });
    const disposed = await readJsonObject(disposedMarker);
    expect(disposed["connectionClosed"]).toBe(true);
    expect(disposed["createdConnectionClosed"]).toBe(true);
    const completion = disposed["completion"];
    expect(["completed", "failed", "cancelled"])
      .toContain(isRecord(completion) ? completion["status"] : undefined);
    expect(disposed["workspaceError"])
      .toContain("workspace authority for server plugin z-workspace-consumer is no longer active");
    expect(disposed["piSessionsError"])
      .toContain("PI session authority for server plugin z-workspace-consumer is no longer active");
    expect((await readFile(eventsPath, "utf8")).trim().split("\n")).toEqual([
      "provider:start",
      "state:start",
      "consumer:start",
      "provider:dispose",
    ]);
  }, 40_000);

  // Plugin stop on SIGTERM requires POSIX signal delivery; Windows
  // force-terminates the child without running shutdown handlers.
  it.skipIf(process.platform === "win32")("disposes activated plugins when SIGTERM arrives during sessiond startup", async () => {
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
        apiVersion: 3,
        name: "Startup signal fixture",
        activate() {
          return {
            async start() {
              writeFileSync(${JSON.stringify(startedMarker)}, "started");
              console.error("PLUGIN_STARTED");
              await new Promise((resolve) => setTimeout(resolve, 250));
            },
            dispose() {
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

async function readJsonObject(path: string): Promise<Record<string, unknown>> {
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!isRecord(value)) throw new Error(`Expected ${path} to contain a JSON object`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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
