// Run after build. All package-manager state, Pi hosts and application state are
// disposable; never install services or use the caller's agent configuration.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { request } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { WebSocket } from "ws";

const exec = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = await mkdtemp(join(tmpdir(), "pi-web-bun-install-"));
const children = [];
const marker = "pi-web-bun-pty-✓";
const webRuntime = process.env.PI_WEB_SMOKE_WEB_RUNTIME ?? "bun";
const daemonRuntime = process.env.PI_WEB_SMOKE_SESSIOND_RUNTIME ?? "bun";
const unixDaemon = process.env.PI_WEB_SMOKE_DAEMON_TRANSPORT !== "tcp";
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
  !/^(?:PI_|PI_WEB_|BUN_|npm_|XDG_|DBUS_|NODE_OPTIONS$|NODE_PATH$|PORT$)/iu.test(name)));
const env = {
  ...cleanEnv,
  HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "config"),
  XDG_DATA_HOME: join(root, "data"), XDG_RUNTIME_DIR: join(root, "run"),
  BUN_INSTALL: join(root, "bun"), BUN_INSTALL_GLOBAL_DIR: join(root, "global"),
  BUN_INSTALL_BIN: join(root, "bin"), BUN_INSTALL_CACHE_DIR: join(root, "cache"),
  PI_CODING_AGENT_DIR: join(root, "agent"), PI_WEB_DATA_DIR: join(root, "web-data"),
  PI_WEB_CONFIG: join(root, "config.json"), PI_WEB_OFFLINE: "1", PI_OFFLINE: "1",
  PI_WEB_RUNTIME: process.env.PI_WEB_SMOKE_PREFERENCE ?? "bun", SHELL: "/bin/bash", NODE_OPTIONS: "", NODE_PATH: "",
};

try {
  await Promise.all([env.HOME, env.XDG_RUNTIME_DIR, env.BUN_INSTALL_BIN, join(root, "tools"), join(root, "pack"), join(root, "workspace")]
    .map(path => mkdir(path, { recursive: true })));
  const bun = await realpath(process.env.BUN_EXECUTABLE ?? (process.versions.bun ? process.execPath
    : (await exec("bun", ["-p", "process.execPath"])).stdout.trim()));
  // Application children can find shell utilities, but not node or npm. The
  // explicit Bun preference also prevents the launcher's fixed-path Node probe.
  for (const name of ["bash", "sh", "env", "dirname", "readlink", "basename", "git", "sleep", "stty"]) {
    const source = (await exec("/bin/sh", ["-c", 'command -v "$1"', "sh", name])).stdout.trim();
    await symlink(source, join(root, "tools", name));
  }
  await symlink(bun, join(root, "tools", "bun"));
  env.PATH = `${env.BUN_INSTALL_BIN}:${join(root, "tools")}`;
  assert.notEqual((await exec(bun, ["--version"], { env })).stdout.trim(), "");
  await assert.rejects(exec("node", ["--version"], { env }), { code: "ENOENT" });

  let tarball = process.env.PI_WEB_SMOKE_TARBALL;
  if (tarball === undefined) {
    // Bun opens package.json writable while packing, even with scripts disabled.
    // Pack an allowlisted payload copy so read-only checkouts work unchanged.
    const payload = join(root, "payload");
    await mkdir(payload);
    const metadata = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));
    for (const path of new Set(["package.json", "README.md", "LICENSE", ...metadata.files.filter(path => !path.startsWith("!"))])) {
      await cp(join(repoRoot, path), join(payload, path), { recursive: true });
    }
    await run(bun, ["pm", "pack", "--ignore-scripts", "--destination", join(root, "pack")], payload);
    const archives = (await readdir(join(root, "pack"))).filter(name => name.endsWith(".tgz"));
    assert.equal(archives.length, 1);
    tarball = join(root, "pack", archives[0]);
  }
  await run(bun, ["add", "--global", "--ignore-scripts", resolve(tarball)], root);
  const packageRoot = join(env.BUN_INSTALL_GLOBAL_DIR, "node_modules", "@jmfederico", "pi-web");
  const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  assert.equal(manifest.dependencies["node-pty"], undefined);
  assert.ok(manifest.optionalDependencies["node-pty"]);
  const requireFromPackage = createRequire(join(packageRoot, "package.json"));
  for (const name of ["pi-agent-core", "pi-ai", "pi-coding-agent", "pi-tui"]) {
    const specifier = `@earendil-works/${name}`;
    assert.equal(manifest.dependencies[specifier], undefined);
    assert.throws(() => requireFromPackage.resolve(specifier), { code: "MODULE_NOT_FOUND" }, `PI WEB must reuse a separately provisioned ${specifier}`);
  }
  if (daemonRuntime === "node") {
    // A Bun install deliberately skipped native builds. This mixed-runtime
    // fixture explicitly builds only Node's PTY addon using the Node toolchain.
    await exec("npm", ["rebuild", "node-pty", "--prefix", env.BUN_INSTALL_GLOBAL_DIR], {
      cwd: env.BUN_INSTALL_GLOBAL_DIR,
      env: { ...env, PATH: cleanEnv.PATH, npm_config_cache: join(root, "npm-cache") },
      encoding: "utf8", timeout: 180_000,
    });
  }
  // Provision a separate fixture Pi, as a user would. PI WEB itself must not
  // acquire an SDK through its optional peers during installation.
  const host = join(root, "pi-host");
  await mkdir(host);
  await writeFile(join(host, "package.json"), '{"private":true}\n');
  await run(bun, ["add", "--ignore-scripts", "@earendil-works/pi-coding-agent@1.3.0"], host);
  env.PI_WEB_PI_PACKAGE_DIR = join(host, "node_modules", "@earendil-works", "pi-coding-agent");
  await symlink(join(host, "node_modules", ".bin", "pi"), join(root, "tools", "pi"));
  const cli = join(env.BUN_INSTALL_BIN, "pi-web");
  assert.equal((await run(cli, ["--print-runtime"])).trim(), "bun");
  if (process.env.PI_WEB_SMOKE_NODE_ABSENT === "1") {
    await assert.rejects(exec(cli, ["--print-runtime"], { env: { ...env, PI_WEB_RUNTIME: "node" } }));
  }
  assert.ok((await run(cli, ["--version"])).includes(manifest.version));
  await run(cli, ["--help"]);
  for (const name of ["pi-web", "pi-web-server", "pi-web-sessiond"]) {
    assert.equal((await run(join(env.BUN_INSTALL_BIN, name), ["--check-runtime"])).trim(), "bun");
  }

  if (daemonRuntime === "node") {
    // Prove that service preflight judges the selected interpreter's abilities,
    // not the CLI's engine, and that the web process does not require a PTY.
    const nodePtyRoot = dirname(createRequire(join(packageRoot, "package.json")).resolve("node-pty/package.json"));
    assert.ok(nodePtyRoot.startsWith(root + "/"), "Native fixture must stay inside the disposable install");
    await rename(nodePtyRoot, nodePtyRoot + "-disabled");
    try {
      const nodeEnv = { ...env, PI_WEB_RUNTIME: "node", PI_WEB_PI_PACKAGE_DIR: "/nonexistent-preflight-sdk" };
      await assert.rejects(exec(join(env.BUN_INSTALL_BIN, "pi-web-sessiond"), ["--check-runtime"], { env: nodeEnv }));
      assert.equal((await exec(join(env.BUN_INSTALL_BIN, "pi-web-server"), ["--check-runtime"], { env: nodeEnv })).stdout.trim(), "node");
      assert.equal((await run(join(env.BUN_INSTALL_BIN, "pi-web-sessiond"), ["--check-runtime"])).trim(), "bun");
    } finally { await rename(nodePtyRoot + "-disabled", nodePtyRoot); }
  }

  const sdkFixture = join(packageRoot, "bun-sdk-smoke.mjs");
  await writeFile(sdkFixture, `
    import assert from "node:assert/strict";
    import { loadPiSdk, loadPiAi, resolvePiRuntimeImport } from "./dist/piRuntime.js";
    const { checkTerminalPrerequisites } = await import("./dist/server/diagnostics/terminalPrerequisites.js");
    const readiness = await checkTerminalPrerequisites();
    assert.ok(readiness.ok, readiness.lines.join("\\n"));
    const sdk = await loadPiSdk();
    assert.equal(sdk.getPackageDir(), process.env.PI_WEB_PI_PACKAGE_DIR);
    assert.strictEqual(await loadPiAi(), await import(await resolvePiRuntimeImport("@earendil-works/pi-ai")));
    const settingsManager = sdk.SettingsManager.inMemory({ packages: [${JSON.stringify(packageRoot)}] });
    const resourceLoader = new sdk.DefaultResourceLoader({ cwd: ${JSON.stringify(join(root, "workspace"))},
      agentDir: process.env.PI_CODING_AGENT_DIR, settingsManager, noSkills: true, noThemes: true, noPromptTemplates: true });
    await resourceLoader.reload();
    const extensions = resourceLoader.getExtensions();
    assert.deepEqual(extensions.errors, []);
    assert.deepEqual(extensions.warnings ?? [], []);
    assert.ok(extensions.extensions.some(extension => extension.commands.has("pi-web")));
    const { session } = await sdk.createAgentSession({ cwd: ${JSON.stringify(join(root, "workspace"))},
      agentDir: process.env.PI_CODING_AGENT_DIR, sessionManager: sdk.SessionManager.inMemory(), settingsManager, resourceLoader });
    await session.dispose();
  `);
  await run(bun, [sdkFixture], packageRoot);
  await exec(bun, [sdkFixture], { cwd: packageRoot, env: { ...env, PI_WEB_PI_PACKAGE_DIR: undefined }, timeout: 60_000 });

  env.PI_WEB_SESSIOND_SOCKET = join(root, "sessiond.sock");
  if (!unixDaemon) env.PI_WEB_SESSIOND_PORT = String(await unusedPort());
  env.PI_WEB_SESSIOND_HOST = "127.0.0.1";
  env.PI_WEB_PORT = String(await unusedPort());
  env.PI_WEB_HOST = "127.0.0.1";
  const daemon = start(join(env.BUN_INSTALL_BIN, "pi-web-sessiond"), packageRoot, daemonRuntime);
  const daemonUrl = unixDaemon ? "http://sessiond.local" : `http://127.0.0.1:${env.PI_WEB_SESSIOND_PORT}`;
  if (!unixDaemon) env.PI_WEB_SESSIOND_URL = daemonUrl;
  await ready(`${daemonUrl}/runtime`, daemon);
  assert.equal((await json(`${daemonUrl}/runtime`)).runtime.name, daemonRuntime);
  assert.deepEqual(await json(`${daemonUrl}/terminal-status`), { state: "active", health: "healthy" });
  const web = start(join(env.BUN_INSTALL_BIN, "pi-web-server"), packageRoot, webRuntime);
  const webUrl = `http://127.0.0.1:${env.PI_WEB_PORT}`;
  await ready(`${webUrl}/api/pi-web/version`, web);
  const version = await json(`${webUrl}/api/pi-web/version`);
  assert.equal(version.components.web.runtime.name, webRuntime);
  assert.equal(version.components.sessiond.runtime.name, daemonRuntime);
  assert.equal((await fetch(`${webUrl}/`)).status, 200);
  assert.equal((await fetch(`${webUrl}/api/projects`)).status, 200);
  // Exercise actual session construction through the daemon, without a model
  // request or credentials. This also runs the installed resource loader.
  const session = await json(`${daemonUrl}/sessions`, { cwd: join(root, "workspace") });
  assert.ok(session.sessionId ?? session.id, JSON.stringify(session));
  const project = await json(`${daemonUrl}/projects`, { path: join(root, "workspace"), name: "Bun smoke" });
  const catalog = await json(`${webUrl}/api/projects/${encodeURIComponent(project.id)}/workspaces`);
  const workspace = catalog.workspaces[0];
  assert.ok(workspace);
  const plugins = await json(`${webUrl}/pi-web-plugins/manifest.json`);
  const terminalPlugin = plugins.plugins.find(plugin => plugin.id === "pi-web.terminal");
  assert.ok(terminalPlugin, JSON.stringify(plugins));
  const revision = terminalPlugin.backendRevision;
  assert.equal(typeof revision, "string", JSON.stringify(terminalPlugin));
  const basePath = `/api/paired-plugin-backends/pi-web.terminal/projects/${encodeURIComponent(project.id)}/workspaces/${encodeURIComponent(workspace.id)}`;
  const terminal = await json(`${webUrl}${basePath}/terminal.create`, { revision, input: {} });
  await terminalRoundTrip(`${webUrl.replace("http:", "ws:")}${basePath}/channels/terminal.attach`, revision, terminal.id);
  await json(`${webUrl}${basePath}/terminal.close`, { revision, input: { terminalId: terminal.id } });
  // Otherwise-valid oversized frames exercise both phases, through the proxy
  // and directly on sessiond. Malformed-JSON rejection cannot satisfy these tests.
  const boundedTerminal = await json(`${webUrl}${basePath}/terminal.create`, { revision, input: {} });
  const protocol = await import(pathToFileURL(join(packageRoot, "dist", "shared", "pluginBackendProtocol.js")).href);
  for (const url of [
    `${webUrl.replace("http:", "ws:")}${basePath}/channels/terminal.attach`,
    `${unixDaemon ? `ws+unix:${env.PI_WEB_SESSIOND_SOCKET}:` : daemonUrl.replace("http:", "ws:")}${basePath.slice(4)}/channels/terminal.attach`,
  ]) {
    await oversizedFrame(url, revision, boundedTerminal.id, "open", protocol.PLUGIN_BACKEND_CHANNEL_OPEN_FRAME_MAX_BYTES);
    await oversizedFrame(url, revision, boundedTerminal.id, "data", protocol.PLUGIN_BACKEND_CHANNEL_DATA_FRAME_MAX_BYTES);
  }
  await json(`${webUrl}${basePath}/terminal.close`, { revision, input: { terminalId: boundedTerminal.id } });
  // Keep a real shell alive while stopping sessiond. Snapshot descendants
  // before the signal so reparenting cannot conceal a leaked process.
  await json(`${webUrl}${basePath}/terminal.create`, { revision, input: {} });
  const descendants = await snapshotDescendants(daemon.process.pid);
  if (process.platform === "linux") assert.ok(descendants.size > 0, "Expected a live PTY shell before shutdown");
  await stop(web);
  assert.ok((await json(`${daemonUrl}/health`)).activeSessions >= 1, "Stopping web/API must preserve the daemon's active session");
  await stop(daemon);
  for (const [pid, start] of descendants) {
    const state = await processState(pid);
    assert.ok(state === undefined || state.start !== start || state.state === "Z", `Service leaked live descendant ${pid}`);
  }
  // The same provider prerequisites remain available, but recovery startup
  // deliberately does not activate Terminal. Status must reflect that choice.
  await writeFile(env.PI_WEB_CONFIG, JSON.stringify({ serverPlugins: { safeStart: "none" } }));
  const recoveryDaemon = start(join(env.BUN_INSTALL_BIN, "pi-web-sessiond"), packageRoot, daemonRuntime);
  await ready(`${daemonUrl}/runtime`, recoveryDaemon);
  assert.equal((await json(`${daemonUrl}/terminal-status`)).state, "disabled");
  await stop(recoveryDaemon);
  console.log(`Installed-package smoke passed (web=${webRuntime}, sessiond=${daemonRuntime}): prerequisites, active/disabled Terminal state, SDK session/extensions, HTTP, PTY channel, frame bounds and shutdown.`);
} catch (error) {
  for (const child of children) console.error(child.output);
  throw error;
} finally {
  // Do not replace a useful test failure with a secondary cleanup exception.
  await Promise.allSettled(children.reverse().map(child => stop(child)));
  await rm(root, { recursive: true, force: true });
}

async function run(file, args, cwd = root) {
  const result = await exec(file, args, { cwd, env, encoding: "utf8", timeout: 180_000, maxBuffer: 8 * 1024 * 1024 });
  return result.stdout;
}
function start(file, cwd, runtime) {
  const process = spawn(file, [], { cwd, env: { ...env, PI_WEB_RUNTIME: runtime }, stdio: ["ignore", "pipe", "pipe"] });
  const child = { process, output: "", done: false, code: undefined, signal: undefined, error: undefined };
  child.closed = new Promise(resolve => {
    process.once("error", error => { child.error = error; child.done = true; resolve(); });
    process.once("close", (code, signal) => { child.code = code; child.signal = signal; child.done = true; resolve(); });
  });
  for (const stream of [process.stdout, process.stderr]) stream.on("data", chunk => {
    child.output = (child.output + chunk.toString()).slice(-24_000);
  });
  children.push(child);
  return child;
}
async function stop(child) {
  if (child.done) {
    assert.equal(child.code, 0, child.output || String(child.error));
    return;
  }
  child.process.kill("SIGTERM");
  await Promise.race([child.closed, delay(10_000)]);
  if (!child.done) {
    child.process.kill("SIGKILL");
    await child.closed;
    throw new Error(`Bun service did not stop on SIGTERM: ${child.output}`);
  }
  assert.equal(child.code, 0, child.output || String(child.error));
}
async function ready(url, child) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.done) throw new Error(`Bun service exited: ${child.error ?? child.output}`);
    try { if ((await fixtureFetch(url, { signal: AbortSignal.timeout(1_000) })).ok) return; } catch { /* not listening yet */ }
    await delay(50);
  }
  throw new Error(`Bun service not ready at ${url}: ${child.output}`);
}
async function json(url, body) {
  const response = await fixtureFetch(url, body === undefined ? {} : {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const value = await response.json();
  assert.ok(response.ok, `${url}: ${response.status} ${JSON.stringify(value)}`);
  return value;
}
function fixtureFetch(url, init = {}) {
  if (!unixDaemon || !url.startsWith("http://sessiond.local")) return fetch(url, init);
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: env.PI_WEB_SESSIOND_SOCKET, path: new URL(url).pathname,
      method: init.method ?? "GET", headers: init.headers, signal: init.signal }, response => {
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("error", reject);
      response.on("end", () => resolve(new Response(Buffer.concat(chunks), { status: response.statusCode })));
    });
    req.on("error", reject);
    req.end(init.body);
  });
}
async function unusedPort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}
async function terminalRoundTrip(url, revision, terminalId) {
  const socket = new WebSocket(url);
  let output = "";
  const completed = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Native PTY channel timed out: ${JSON.stringify(output)}`)), 10_000);
    socket.on("error", reject);
    socket.on("close", (code, reason) => { clearTimeout(timer); reject(new Error(`PTY channel closed: ${code} ${reason}`)); });
    socket.on("message", bytes => {
      const frame = JSON.parse(bytes.toString());
      if (frame.kind === "error") { clearTimeout(timer); reject(new Error(JSON.stringify(frame))); }
      if (frame.kind === "ready") {
        socket.send(JSON.stringify({ version: 1, kind: "data", data: { type: "resize", cols: 93, rows: 27 } }));
        socket.send(JSON.stringify({ version: 1, kind: "data", data: { type: "input", data:
          `test -t 0 && test -t 1 && test "$(stty size)" = "27 93" && printf '%s\\n' '${marker}'; exit\n` } }));
      }
      if (frame.kind === "data" && frame.data.type === "output") output += frame.data.data;
      if (frame.kind === "data" && frame.data.type === "exit") {
        clearTimeout(timer);
        try { assert.equal(frame.data.exitCode, 0); assert.ok(output.includes(marker), output); resolve(); } catch (error) { reject(error); }
      }
    });
  });
  try {
    await once(socket, "open");
    socket.send(JSON.stringify({ version: 1, kind: "open", revision, input: { terminalId } }));
    await completed;
  } finally { socket.terminate(); }
}
async function processState(pid) {
  if (process.platform !== "linux") return undefined;
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return { state: fields[0], parent: Number(fields[1]), start: fields[19] };
  } catch (error) { if (error.code === "ENOENT" || error.code === "ESRCH") return undefined; throw error; }
}
async function snapshotDescendants(parent) {
  const descendants = new Map();
  if (process.platform !== "linux") return descendants;
  const states = await Promise.all((await readdir("/proc")).filter(name => /^\d+$/u.test(name))
    .map(async pid => [Number(pid), await processState(pid)]));
  let added;
  do {
    added = false;
    for (const [pid, state] of states) {
      if (state && !descendants.has(pid) && (state.parent === parent || descendants.has(state.parent))) {
        descendants.set(pid, state.start); added = true;
      }
    }
  } while (added);
  return descendants;
}
async function oversizedFrame(url, revision, terminalId, phase, limit) {
  const socket = new WebSocket(url);
  let timeout;
  let readyReceived = false;
  try {
    const ready = new Promise((resolve, reject) => socket.on("message", bytes => {
      const frame = JSON.parse(bytes.toString());
      if (frame.kind === "ready") { readyReceived = true; resolve(); }
      if (frame.kind === "error" && phase === "data") reject(new Error(`Channel admission failed at ${url}: ${JSON.stringify(frame)}`));
    }));
    const closed = once(socket, "close");
    const deadline = new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error(`Oversized ${phase} frame test timed out (${readyReceived ? "waiting for close" : "waiting for ready"}) at ${url}`)), 5_000); });
    await once(socket, "open");
    const open = { version: 1, kind: "open", revision, input: { terminalId } };
    if (phase === "open") {
      open.input.padding = "x".repeat(limit);
      socket.send(JSON.stringify(open));
    } else {
      socket.send(JSON.stringify(open));
      await Promise.race([ready, deadline]);
      socket.send(JSON.stringify({ version: 1, kind: "data", data: { type: "input", data: "x".repeat(limit) } }));
    }
    const [code] = await Promise.race([closed, deadline]);
    assert.equal(code, 1009, `Oversized ${phase} frame must receive size-specific rejection`);
  } finally { clearTimeout(timeout); socket.terminate(); }
}
