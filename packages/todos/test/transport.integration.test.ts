import { spawn, type ChildProcess } from "node:child_process";
import { copyFile, cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { buildDirectory, buildTerminalPackage } from "../../../scripts/build-plugins.mjs";
import { isRecord, resultTask, resultTasks } from "../src/browser/protocol.js";

interface FixtureProcess { child: ChildProcess; output: string; exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }> }
const processes = new Set<FixtureProcess>();
const roots: string[] = [];
afterEach(async () => {
  for (const process of processes) {
    if (process.child.exitCode === null && process.child.signalCode === null) process.child.kill("SIGKILL");
    await process.exited;
  }
  processes.clear();
  for (const root of roots) await rm(root, { recursive: true, force: true }); roots.length = 0;
});

// The package's connected central-authority journey is the invariant here. Store
// tests own validation/revisions; panel tests own DOM clicks and draft retention.
it.skipIf(process.platform === "win32")("serves one durable list to two isolated hosts and real discovered companion tools, including native reload", async () => {
  const root = await mkdtemp(join(tmpdir(), "pw-todos-")); roots.push(root);
  await cp(resolve("src"), join(root, "src"), { recursive: true });
  const metadata: unknown = JSON.parse(await readFile(resolve("package.json"), "utf8"));
  if (typeof metadata !== "object" || metadata === null) throw new Error("Invalid host manifest");
  // Ordinary integration tests use current source, never stale checkout dist.
  await writeFile(join(root, "package.json"), JSON.stringify({ ...metadata, exports: { "./server-plugin-api": "./src/server-plugin-api.ts" } }));
  await symlink(resolve("node_modules"), join(root, "node_modules"), "junction");
  await buildTerminalPackage(resolve("pi-web-plugins/terminal"), join(root, "dist/pi-web-plugins/terminal"));
  await writeFile(join(root, "web.mjs"), `
    import { buildApp } from "./src/server/app.ts";
    const app = await buildApp({ clientDist: false });
    console.log("FIXTURE_HTTP=" + await app.listen({ port: 0, host: "127.0.0.1" }));
    process.once("SIGTERM", () => { void app.close(); });
  `);
  const server = await machine(root, "server", { role: "server" });
  const serverDaemon = start(root, server, "src/server/sessiond.ts");
  await ready(serverDaemon, "Server listening at");
  const serverUrl = await httpUrl(start(root, server, "web.mjs"));
  const client = await machine(root, "client", { role: "client", targetMachineId: "central" });
  await writeFile(join(client, "data/machines.json"), JSON.stringify({ machines: [{ id: "central", name: "Server", kind: "remote", baseUrl: serverUrl,
    createdAt: "2026-10-04T00:00:00.000Z", updatedAt: "2026-10-04T00:00:00.000Z" }] }));
  const clientDaemon = start(root, client, "src/server/sessiond.ts");
  await ready(clientDaemon, "Server listening at");
  const clientUrl = await httpUrl(start(root, client, "web.mjs"));
  const first = resultTask(await backend(clientUrl, "mutate", { title: "Across machines", context: "One central SQLite authority" }));
  expect(resultTask(await backend(serverUrl, "read", { id: first.id }))).toEqual(first);
  expect(resultTasks(await backend(clientUrl, "list", { text: "SQLITE", project: null }))).toEqual([first]);
  const module = await fetch(`${clientUrl}/pi-web-plugins/manifest.json`);
  const manifest: unknown = await module.json();
  if (!isRecord(manifest) || !Array.isArray(manifest["plugins"])) throw new Error("Invalid browser manifest");
  expect(manifest["plugins"].some((entry: unknown) => isRecord(entry) && entry["id"] === "todos")).toBe(true);

  // Drive the shipped tool implementations in a real hosted session without
  // model credentials. The package manifest also discovers the native tools;
  // companion.test.ts separately owns native model tool admission/execution.
  const cwd = join(client, "project"); await mkdir(cwd);
  const session = await post(`${clientUrl}/api/sessions`, { cwd });
  if (typeof session !== "object" || session === null || !("id" in session) || typeof session.id !== "string") throw new Error("Missing hosted session");
  const commandUrl = `${clientUrl}/api/sessions/${encodeURIComponent(session.id)}/commands/run`;
  await post(commandUrl, { cwd, text: `/todos-probe ${first.id}` });
  const toolResult = await probe(client, clientDaemon);
  expect(toolResult).toMatchObject({ task: { id: first.id, revision: 2, status: "Doing" }, listed: [first.id], staleRejected: true });
  expect(resultTask(await backend(serverUrl, "read", { id: first.id }))).toMatchObject({ revision: 2, status: "Doing", context: first.context });
  await post(commandUrl, { cwd, text: "/reload" });
  await rm(join(client, "probe.json"));
  await post(commandUrl, { cwd, text: `/todos-probe ${first.id}` });
  expect(await probe(client, clientDaemon)).toMatchObject({ task: { id: first.id, revision: 3 }, staleRejected: true });
  expect(await readdir(join(client, "data/plugin-data/todos"))).toEqual([]);
  // Clean shutdown releases the database. Restart only our fixture's daemon,
  // preserving its data directory, and prove authority survives runtime replacement.
  serverDaemon.child.kill("SIGTERM");
  expect(await serverDaemon.exited).toEqual({ code: 0, signal: null });
  const restarted = start(root, server, "src/server/sessiond.ts");
  await ready(restarted, "Server listening at");
  await vi.waitFor(async () => {
    expect(resultTask(await backend(clientUrl, "read", { id: first.id }))).toMatchObject({ revision: 3, status: "Doing" });
  }, { timeout: 5_000 });
  for (const daemon of [clientDaemon, restarted]) { daemon.child.kill("SIGTERM"); expect(await daemon.exited).toEqual({ code: 0, signal: null }); }
}, 60_000);

async function machine(root: string, name: string, settings: Record<string, string>): Promise<string> {
  const path = join(root, name);
  const packageRoot = join(path, "package"); await mkdir(packageRoot, { recursive: true });
  await mkdir(join(packageRoot, "node_modules/@jmfederico"), { recursive: true });
  await symlink(root, join(packageRoot, "node_modules/@jmfederico/pi-web"), "junction");
  await mkdir(join(path, "data"));
  await copyFile(resolve("packages/todos/package.json"), join(packageRoot, "package.json"));
  await buildDirectory(resolve("packages/todos/src"), join(packageRoot, "dist"));
  await writeFile(join(path, "config.json"), JSON.stringify({ plugins: { todos: { enabled: true, settings } } }));
  await writeFile(join(path, "data/pi-package-dismissals.json"), JSON.stringify({ dismissals: [{ profileDir: join(path, "agent"), packageId: "@jmfederico/pi-relay", dismissedAt: "2026-10-04T00:00:00.000Z" }] }));
  const extensions = join(path, "agent/extensions"); await mkdir(extensions, { recursive: true });
  await writeFile(join(path, "agent/settings.json"), JSON.stringify({ packages: [packageRoot] }));
  await writeFile(join(extensions, "probe.js"), `
    import { writeFile } from "node:fs/promises";
    import companion from "../../package/dist/companion.js";
    export default function(pi) {
      const tools = new Map();
      companion({ ...pi, registerTool(tool) { tools.set(tool.name, tool); } });
      const execute = (name, args) => tools.get(name).execute("fixture", args, new AbortController().signal);
      pi.registerCommand("todos-probe", { description: "Drive shipped tools without a model", async handler(id) {
        try {
        const read = await execute("todos_read", { id });
        const task = read.structuredContent.task;
        const list = await execute("todos_list", { text: "Across", archived: "all", project: null });
        const update = await execute("todos_mutate", { id, revision: task.revision, status: "Doing" });
        let staleRejected = false;
        try { await execute("todos_mutate", { id, revision: task.revision, context: "stale overwrite" }); }
        catch (error) { staleRejected = String(error).includes("Task changed"); }
        await writeFile(${JSON.stringify(join(path, "probe.json"))}, JSON.stringify({
          task: update.structuredContent.task, listed: list.structuredContent.tasks.map(t => t.id), staleRejected
        }));
        } catch (error) { await writeFile(${JSON.stringify(join(path, "probe.json"))}, JSON.stringify({ error: String(error) })); }
      } });
    }
  `);
  return path;
}
async function probe(path: string, daemon: FixtureProcess): Promise<unknown> {
  return await vi.waitFor(async () => {
    try { const value: unknown = JSON.parse(await readFile(join(path, "probe.json"), "utf8")); return value; }
    catch (error) { throw new Error(`Companion probe not ready:\n${daemon.output}`, { cause: error }); }
  }, { timeout: 8_000 });
}
async function backend(url: string, operation: string, input: unknown): Promise<unknown> {
  return await post(`${url}/api/plugin-backends/todos/${operation}`, { version: 1, input });
}
async function post(url: string, body: unknown): Promise<unknown> {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
  const value: unknown = await response.json(); expect(response.status, JSON.stringify(value)).toBe(200); return value;
}
function start(root: string, machine: string, entry: string): FixtureProcess {
  // Scrub every live PI_WEB_* value, profile and credential. No inherited daemon socket.
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "TMPDIR", "TMP", "TEMP"]) if (process.env[key] !== undefined) env[key] = process.env[key];
  const child = spawn(process.execPath, ["--import", "tsx", entry], { cwd: root, stdio: ["ignore", "pipe", "pipe"], env: {
    ...env, HOME: join(machine, "home"), XDG_CONFIG_HOME: join(machine, "home/.config"), PI_WEB_CONFIG: join(machine, "config.json"),
    PI_WEB_DATA_DIR: join(machine, "data"), PI_CODING_AGENT_DIR: join(machine, "agent"), PI_CODING_AGENT_SESSION_DIR: join(machine, "agent/sessions"),
    PI_WEB_SESSIOND_SOCKET: join(machine, "sessiond.sock"), PI_WEB_OFFLINE: "1",
  } });
  const fixture: FixtureProcess = { child, output: "", exited: new Promise((finish) => { child.once("exit", (code, signal) => { finish({ code, signal }); }); }) };
  const collect = (data: Buffer) => { fixture.output += data.toString("utf8"); };
  child.stdout.on("data", collect); child.stderr.on("data", collect); processes.add(fixture); return fixture;
}
async function httpUrl(process: FixtureProcess): Promise<string> {
  const output = await ready(process, "FIXTURE_HTTP=");
  const match = /FIXTURE_HTTP=(http:\/\/[^\s]+)/u.exec(output);
  if (match?.[1] === undefined) throw new Error(`Missing fixture URL: ${output}`); return match[1];
}
function ready(process: FixtureProcess, marker: string): Promise<string> {
  return new Promise((resolveReady, reject) => {
    const timer = setTimeout(() => { finish(new Error(`Timed out waiting for ${marker}:\n${process.output}`)); }, 15_000);
    const data = () => { if (process.output.includes(marker)) finish(); };
    const exit = () => { finish(new Error(`Exited before ${marker}:\n${process.output}`)); };
    const finish = (error?: Error) => {
      clearTimeout(timer); process.child.stdout?.off("data", data); process.child.stderr?.off("data", data); process.child.off("exit", exit);
      if (error !== undefined) reject(error); else resolveReady(process.output);
    };
    process.child.stdout?.on("data", data); process.child.stderr?.on("data", data); process.child.once("exit", exit); data();
  });
}
