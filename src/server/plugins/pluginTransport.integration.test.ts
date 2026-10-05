import { spawn, type ChildProcess } from "node:child_process";
import { copyFile, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildTerminalPackage } from "../../../scripts/build-plugins.mjs";

interface FixtureProcess {
  child: ChildProcess;
  output: string;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

const processes = new Set<FixtureProcess>();
const roots = new Set<string>();

afterEach(async () => {
  for (const process of processes) {
    if (process.child.exitCode === null && process.child.signalCode === null) process.child.kill("SIGKILL");
    await process.exited;
  }
  processes.clear();
  for (const root of roots) await rm(root, { recursive: true, force: true });
  roots.clear();
});

describe("host-managed plugin transport over isolated PI WEB instances", () => {
  // Real sessiond assembly + the production web app are the invariant here.
  // Narrow tests own JSON validation, bounds, errors, and cancellation.
  it.skipIf(process.platform === "win32")("routes from one package backend to the same package on a registered machine without project ids", async () => {
    const root = await mkdtemp(join(tmpdir(), "pw-transport-"));
    roots.add(root);
    await cp(resolve("src"), join(root, "src"), { recursive: true });
    await copyFile(resolve("package.json"), join(root, "package.json"));
    await symlink(resolve("node_modules"), join(root, "node_modules"), "junction");
    await buildTerminalPackage(resolve("pi-web-plugins/terminal"), join(root, "dist/pi-web-plugins/terminal"));
    // Port 0 is test-owned listener setup, not a configuration/runtime policy change.
    await writeFile(join(root, "web.mjs"), `
      import { buildApp } from "./src/server/app.ts";
      const app = await buildApp({ clientDist: false });
      const url = await app.listen({ port: 0, host: "127.0.0.1" });
      console.log("FIXTURE_HTTP=" + url);
      process.once("SIGTERM", () => { void app.close(); });
    `);

    const server = await createMachine(root, "server", { role: "server" });
    const serverDaemon = start(root, server, "src/server/sessiond.ts");
    await waitForOutput(serverDaemon, "Server listening at");
    const serverWeb = start(root, server, "web.mjs");
    const serverUrl = await httpUrl(serverWeb);

    const client = await createMachine(root, "client", { role: "client", target: "registered-server" });
    await writeFile(join(client, "data", "machines.json"), JSON.stringify({ machines: [{
      id: "registered-server", name: "Server", kind: "remote", baseUrl: serverUrl,
      createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z",
    }] }));
    const clientDaemon = start(root, client, "src/server/sessiond.ts");
    await waitForOutput(clientDaemon, "Server listening at");
    const clientWeb = start(root, client, "web.mjs");
    const clientUrl = await httpUrl(clientWeb);

    const response = await fetch(`${clientUrl}/api/plugin-backends/fixture.transport/forward`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: 1, input: { text: "cross-machine" } }),
      signal: AbortSignal.timeout(5_000),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      role: "server", operation: "echo", input: { text: "cross-machine" },
      scopeKeys: ["input", "operation", "signal"], frozen: true,
    });
    // Prove the generic allowlisted gateway path as well, not just direct remote access.
    const federated = await fetch(`${clientUrl}/api/machines/registered-server/plugin-backends/fixture.transport/echo`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: 1, input: null }), signal: AbortSignal.timeout(5_000),
    });
    expect(federated.status).toBe(200);
    expect(await federated.json()).toMatchObject({ role: "server", input: null });

    // Both isolated daemons dispose with lifetime cancellation, never touching the host daemon.
    for (const child of [clientDaemon, serverDaemon]) {
      child.child.kill("SIGTERM");
      expect(await child.exited).toEqual({ code: 0, signal: null });
    }
    for (const machine of [client, server]) {
      const disposed: unknown = JSON.parse(await readFile(join(machine, "data", "plugin-data", "fixture.transport", "disposed.json"), "utf8"));
      expect(disposed).toEqual({ lifetimeAborted: true, transportRevoked: true });
    }
  }, 40_000);
});

async function createMachine(root: string, name: string, settings: Record<string, string>): Promise<string> {
  const machine = join(root, name);
  const plugin = join(machine, "data", "plugins", "fixture");
  await mkdir(plugin, { recursive: true });
  await writeFile(join(machine, "config.json"), JSON.stringify({ plugins: { "fixture.transport": { settings } } }));
  // Keep the fixture offline: no automatic package installation into its fresh profile.
  await writeFile(join(machine, "data", "pi-package-dismissals.json"), JSON.stringify({ dismissals: [{
    profileDir: join(machine, "agent"), packageId: "@jmfederico/pi-relay", dismissedAt: "2026-10-01T00:00:00.000Z",
  }] }));
  await writeFile(join(plugin, "package.json"), JSON.stringify({
    name: "transport-fixture", piWeb: { plugins: [{ id: "fixture.transport", serverModule: "server.mjs" }] },
  }));
  await writeFile(join(plugin, "server.mjs"), `
    import { writeFile } from "node:fs/promises";
    import { join } from "node:path";
    export default {
      apiVersion: 3, name: "Generic transport verification",
      activate(context) {
        if (context.transport?.version !== 1) throw new Error("Host transport missing");
        return {
          backend: {
            async request(request) {
              if (context.settings.role === "client" && request.operation === "forward") {
                return await context.transport.request({
                  machineId: context.settings.target, operation: "echo", input: request.input, signal: request.signal,
                });
              }
              return { role: context.settings.role, operation: request.operation, input: request.input,
                scopeKeys: Object.keys(request).sort(), frozen: Object.isFrozen(request) };
            }
          },
          async dispose() {
            let transportRevoked = false;
            try {
              await context.transport.request({ machineId: "registered-server", operation: "echo", input: null, signal: new AbortController().signal });
            } catch { transportRevoked = true; }
            await writeFile(join(context.dataDirectory, "disposed.json"), JSON.stringify({
              lifetimeAborted: context.lifetimeSignal.aborted, transportRevoked,
            }));
          }
        };
      }
    };
  `);
  return machine;
}

function start(root: string, machine: string, entry: string): FixtureProcess {
  // Never inherit the live instance's config, data, sockets, agent state, or credentials.
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "TMPDIR", "TMP", "TEMP"]) if (process.env[key] !== undefined) env[key] = process.env[key];
  const child = spawn(process.execPath, ["--import", "tsx", entry], {
    cwd: root, stdio: ["ignore", "pipe", "pipe"],
    env: { ...env, HOME: join(machine, "home"), XDG_CONFIG_HOME: join(machine, "home", ".config"),
      PI_WEB_CONFIG: join(machine, "config.json"), PI_WEB_DATA_DIR: join(machine, "data"),
      PI_CODING_AGENT_DIR: join(machine, "agent"), PI_CODING_AGENT_SESSION_DIR: join(machine, "agent", "sessions"),
      PI_WEB_SESSIOND_SOCKET: join(machine, "sessiond.sock"), PI_WEB_OFFLINE: "1" },
  });
  const fixture: FixtureProcess = {
    child, output: "",
    exited: new Promise((resolveExit) => { child.once("exit", (code, signal) => { resolveExit({ code, signal }); }); }),
  };
  const collect = (data: Buffer): void => { fixture.output += data.toString("utf8"); };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  processes.add(fixture);
  return fixture;
}

async function httpUrl(fixture: FixtureProcess): Promise<string> {
  const output = await waitForOutput(fixture, "FIXTURE_HTTP=");
  const match = /FIXTURE_HTTP=(http:\/\/[^\s]+)/u.exec(output);
  if (match?.[1] === undefined) throw new Error(`Missing fixture HTTP URL: ${output}`);
  return match[1];
}

function waitForOutput(fixture: FixtureProcess, marker: string): Promise<string> {
  return new Promise((resolveReady, reject) => {
    const timer = setTimeout(() => { finish(new Error(`Timed out waiting for ${marker}:\n${fixture.output}`)); }, 15_000);
    const onData = (): void => { if (fixture.output.includes(marker)) finish(); };
    const onExit = (): void => { finish(new Error(`Fixture exited before ${marker}:\n${fixture.output}`)); };
    const finish = (error?: Error): void => {
      clearTimeout(timer);
      fixture.child.stdout?.off("data", onData);
      fixture.child.stderr?.off("data", onData);
      fixture.child.off("exit", onExit);
      if (error !== undefined) reject(error);
      else resolveReady(fixture.output);
    };
    fixture.child.stdout?.on("data", onData);
    fixture.child.stderr?.on("data", onData);
    fixture.child.once("exit", onExit);
    if (fixture.child.exitCode !== null || fixture.child.signalCode !== null) onExit();
    else onData();
  });
}
