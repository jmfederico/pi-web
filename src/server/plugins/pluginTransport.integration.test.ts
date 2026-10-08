import { spawn, type ChildProcess } from "node:child_process";
import { copyFile, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initialAppState } from "../../client/src/appState.js";
import { loadExternalPlugins } from "../../client/src/plugins/external.js";
import { PluginRegistry } from "../../client/src/plugins/registry.js";
import type { PluginBackend } from "../../plugin-api.js";
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
  vi.unstubAllGlobals();
  Reflect.deleteProperty(globalThis, "transportPanelBackend");
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
    const responseBody: unknown = await response.json();
    expect(response.status, `${JSON.stringify(responseBody)}\n${clientDaemon.output}\n${serverDaemon.output}`).toBe(200);
    expect(responseBody).toEqual({
      role: "server", operation: "echo", input: { text: "cross-machine" },
      scopeKeys: ["input", "operation", "signal"], frozen: true,
    });
    // Load the real published browser module and invoke its application-panel
    // callback without any project/workspace selection. The DOM test owns clicks.
    vi.stubGlobal("document", { baseURI: `${clientUrl}/` });
    const browser = new PluginRegistry();
    try {
      const loaded = await loadExternalPlugins(undefined, {
        shouldLoadPlugin: (entry) => entry.id === "fixture.transport",
        moduleLoader: async (url) => {
          const module = await fetch(url);
          expect(module.status).toBe(200);
          const imported: unknown = await import(`data:text/javascript;base64,${Buffer.from(await module.text()).toString("base64")}`);
          return imported;
        },
      });
      expect(loaded.failures).toEqual([]);
      expect((await browser.registerBatch(loaded.registrations, { declarations: loaded.declarations })).failures).toEqual([]);
      const panel = browser.getApplicationPanels()[0];
      expect(panel).toBeDefined();
      panel?.render({ machine: { id: "local", name: "Client", kind: "local" }, state: initialAppState(),
        navigate: () => Promise.resolve(), prompt: { getText: () => "", getSelection: () => null, insertText: () => undefined },
        host: { requestRender: () => undefined } });
      const backend = requiredPanelBackend();
      expect(await backend.request("forward", { text: "application panel" })).toMatchObject({ role: "server", input: { text: "application panel" } });
      await browser.dispose();
      await expect(backend.request("echo", null)).rejects.toThrow();
    } finally { await browser.dispose(); }

    // A normal discovered companion tool uses the same client backend. Drive
    // its execute implementation via a fixture command, without model/network credentials.
    const cwd = join(client, "project");
    await mkdir(cwd, { recursive: true });
    const sessionResponse = await postJson(`${clientUrl}/api/sessions`, { cwd });
    expect(sessionResponse).toHaveProperty("id");
    if (typeof sessionResponse !== "object" || sessionResponse === null || !("id" in sessionResponse) || typeof sessionResponse.id !== "string") {
      throw new Error("Missing fixture hosted session id");
    }
    const commandUrl = `${clientUrl}/api/sessions/${encodeURIComponent(sessionResponse.id)}/commands/run`;
    expect(await postJson(commandUrl, { cwd, text: "/transport-probe" })).toMatchObject({ type: "done" });
    const toolResult = await waitForToolResult(client, clientDaemon);
    expect(toolResult).toMatchObject({ role: "server", input: { text: "companion tool" } });
    // Native extension reload keeps host ingress available, without backend reconnect setup.
    expect(await postJson(commandUrl, { cwd, text: "/reload" })).toMatchObject({ type: "done" });
    await rm(join(client, "tool-result.json"));
    expect(await postJson(commandUrl, { cwd, text: "/transport-probe" })).toMatchObject({ type: "done" });
    expect(await waitForToolResult(client, clientDaemon)).toEqual(toolResult);

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
    name: "transport-fixture", piWeb: { plugins: [{ id: "fixture.transport", serverModule: "server.mjs", module: "browser/index.mjs", browserRoot: "browser", machineSpecific: true }] },
  }));
  await mkdir(join(plugin, "browser"), { recursive: true });
  await writeFile(join(plugin, "browser", "index.mjs"), `
    export default { apiVersion: 4, name: "Generic transport panel", activate: ({ html }) => ({ contributions: {
      applicationPanels: [{ id: "probe", title: "Probe", render(context) {
        if (context.workspace || context.state.selectedProject) throw new Error("Unexpected panel scope");
        globalThis.transportPanelBackend = context.backend;
        return html\`Transport probe\`;
      } }]
    } }) };
  `);
  const extensions = join(machine, "agent", "extensions");
  await mkdir(extensions, { recursive: true });
  await writeFile(join(extensions, "transport.js"), `
    import { defineTool } from "@earendil-works/pi-coding-agent";
    import { Type } from "typebox";
    import { writeFile } from "node:fs/promises";
    import { createCompanionBackend } from "../../../src/server-plugin-api.ts";
    export default function(pi) {
      const execute = async () => {
        const backend = createCompanionBackend(pi.events, "fixture.transport");
        const result = await backend.request("forward", { text: "companion tool" });
        await writeFile(${JSON.stringify(join(machine, "tool-result.json"))}, JSON.stringify(result));
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
      };
      pi.registerTool(defineTool({ name: "transport_probe", label: "Transport probe",
        description: "Generic backend verification", parameters: Type.Object({}), execute }));
      pi.registerCommand("transport-probe", { description: "Drive the fixture tool without a model", handler: execute });
    }
  `);
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

async function waitForToolResult(machine: string, daemon: FixtureProcess): Promise<unknown> {
  return await vi.waitFor(async () => {
    try {
      const result: unknown = JSON.parse(await readFile(join(machine, "tool-result.json"), "utf8"));
      return result;
    } catch (error) { throw new Error(`Fixture tool result not ready:\n${daemon.output}`, { cause: error }); }
  }, { timeout: 5_000 });
}

function requiredPanelBackend(): PluginBackend {
  const value: unknown = Reflect.get(globalThis, "transportPanelBackend");
  Reflect.deleteProperty(globalThis, "transportPanelBackend");
  if (!isPanelBackend(value)) throw new Error("Missing published application-panel backend");
  return value;
}

function isPanelBackend(value: unknown): value is PluginBackend {
  return typeof value === "object" && value !== null && "version" in value && value.version === 1
    && "request" in value && typeof value.request === "function";
}

async function postJson(url: string, body: unknown): Promise<unknown> {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
  const result: unknown = await response.json();
  expect(response.status, JSON.stringify(result)).toBe(200);
  return result;
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
