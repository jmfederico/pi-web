import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { smokeInstalledPluginApi } from "./plugin-api-package-smoke.mjs";

const NPM_VERSION = "12.0.1";
const MARKER = "pi-web-package-pty-ok";
const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

if (process.platform === "win32") {
  throw new Error("The installed-package PTY smoke test requires a POSIX shell");
}

const npmExecPath = process.env["npm_execpath"];
if (npmExecPath === undefined || npmExecPath === "") {
  throw new Error("npm_execpath is required; run this check through `npm run smoke:package-install`");
}

const root = await mkdtemp(join(tmpdir(), "pi-web-package-install-"));
try {
  const packDir = join(root, "pack");
  await mkdir(packDir, { recursive: true });
  await prepareNpmEnvironmentDirs(packDir);
  const npmExecPath = process.env["npm_execpath"];
  if (npmExecPath === undefined || npmExecPath === "") {
    throw new Error("npm_execpath is required; run this check through `npm run smoke:package-install`");
  }
  const packOutput = await runProcess(process.execPath, [npmExecPath, "pack", "--ignore-scripts", "--json", "--pack-destination", packDir], repoRoot, isolatedNpmEnvironment(packDir));
  const tarballPath = join(packDir, packageTarballFilename(packOutput.stdout));
  return tarballPath;
}

/* ------------------------------------------------------------------ */
/*  npm + Node (regression guard for the F1 loader fix)                */
/* ------------------------------------------------------------------ */

async function smokeNpmGlobalInstall(tarballPath) {
  const root = await mkdtemp(join(tmpdir(), "pi-web-bun-package-install-"));
  try {
    const bunExecutable = await resolveBun();
    const installRoot = join(root, "bun");
    const home = join(root, "home");
    const binDir = join(root, "shim");
    await Promise.all([mkdir(installRoot, { recursive: true }), mkdir(home, { recursive: true }), mkdir(binDir, { recursive: true })]);
    // Only bun and the fixed system directories: Node must not be reachable anywhere, so the
    // launchers cannot silently fall back and the run proves the bun path.
    const pathValue = await nodelessPath(binDir, bunExecutable);
    // Node.js is the default runtime now, so the bun path is exercised explicitly via
    // PI_WEB_RUNTIME=bun. The nodeless PATH proves the launcher cannot silently fall back
    // to something else and that Bun alone can serve the whole stack.
    const environment = {
      HOME: home,
      PATH: pathValue,
      BUN_INSTALL: installRoot,
      PI_WEB_RUNTIME: "bun",
      SHELL: "/bin/sh",
      TMPDIR: root,
    };

    // Trust dependency postinstall scripts (node-pty needs them to build its native binding);
    // otherwise the daemon tries to rebuild node-pty via `bunx node-gyp` at startup, which
    // blocks the unix-socket listen path the web/API depends on.
    await runProcess(bunExecutable, ["add", "--global", "--trust", tarballPath], root, environment);
    const packageRoot = await installedBunPackage(installRoot);
    const launcherBin = join(installRoot, "bin", "pi-web");

    const version = (await runProcess(launcherBin, ["--version"], root, environment)).stdout.trim();
    const expectedVersion = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")).version;
    if (version !== expectedVersion) {
      throw new Error(`Installed \`pi-web --version\` reported ${JSON.stringify(version)}; expected ${expectedVersion}`);
    }
    const reportedRuntime = await runProcess(join(installRoot, "bin", "pi-web-sessiond"), ["--print-runtime"], root, environment);
    if (reportedRuntime.stdout.trim() !== "bun") {
      throw new Error(`Installed launcher reported runtime ${JSON.stringify(reportedRuntime.stdout)}; expected "bun"`);
    }
    console.log(`✓ bun-installed pi-web ${version} runs on bun via PI_WEB_RUNTIME=bun with node absent from PATH`);

    await smokeBunTerminalService(root, installRoot, environment);
    await smokeBunWebServer(root, installRoot, environment);
    console.log("Installed-package bun smoke tests passed (runtime, terminals over Bun.Terminal, web/API).");
  } finally {
    if (process.env["PI_WEB_SMOKE_KEEP"] === undefined) await rm(root, { recursive: true, force: true });
    else console.log(`KEEP root: ${root}`);
  }
}

async function resolveBun() {
  const configured = process.env["PI_WEB_SMOKE_BUN"];
  const candidate = configured === undefined || configured === ""
    ? await which("bun")
    : configured;
  if (candidate === null) {
    throw new Error("bun is required for the bun smoke; install it or set PI_WEB_SMOKE_BUN to the bun executable");
  }
  // Capability, not version — the same gate the launchers use.
  const capability = await runProcess(candidate, ["-e", 'process.exit(typeof Bun.Terminal === "function" ? 0 : 1)'], process.cwd());
  if (capability.code !== 0) {
    throw new Error(`${candidate} has no Bun.Terminal; the bun smoke needs a bun build with the native PTY API`);
  }
  return candidate;
}

async function which(command) {
  const result = await runProcess("/bin/sh", ["-c", `command -v ${command}`], process.cwd());
  const path = result.stdout.trim();
  return result.code === 0 && path !== "" ? path : null;
}

async function nodelessPath(binDir, bunExecutable) {
  await symlinkSafe(bunExecutable, join(binDir, "bun"));
  const system = "/usr/bin:/bin";
  const probe = await runProcess("/usr/bin/env", ["-i", `PATH=${system}`, "/bin/sh", "-c", "command -v node || command -v npm"], process.cwd());
  if (`${probe.stdout}${probe.stderr}`.trim() !== "") {
    // A distro node in /usr/bin would let the launchers fall back; shim only what a launcher needs.
    for (const tool of ["sh", "bash", "env", "readlink", "dirname", "cat", "uname"]) {
      const path = await which(tool);
      if (path !== null) await symlinkSafe(path, join(binDir, tool));
    }
    return binDir;
  }
  return `${binDir}:${system}`;
}

async function symlinkSafe(target, linkPath) {
  await rm(linkPath, { force: true });
  await symlink(target, linkPath);
}

/**
 * `<prefix>/lib/node_modules` for npm and `<BUN_INSTALL>/install/global/node_modules` for bun;
 * neither is derived from the other, so look for the manifest instead of trusting one layout.
 */
async function installedPackageRoot(prefix) {
  for (const candidate of [
    join(prefix, "lib", "node_modules", "@jmfederico", "pi-web"),
    join(prefix, "install", "global", "node_modules", "@jmfederico", "pi-web"),
  ]) {
    try {
      await readFile(join(candidate, "package.json"), "utf8");
      return candidate;
    } catch {
      // try the next layout
    }
  }
  throw new Error(`The package was not installed under ${prefix} (checked lib/ and install/global/ node_modules)`);
}

async function installedBunPackage(installRoot) {
  const packageJsonPath = join(installRoot, "install", "global", "node_modules", "@jmfederico", "pi-web", "package.json");
  try {
    await readFile(packageJsonPath, "utf8");
    return dirname(packageJsonPath);
  } catch {
    throw new Error(`bun did not install the package where expected: ${packageJsonPath}`);
  }
}

async function smokeBunTerminalService(dataRoot, installRoot, environment) {
  const dataDir = join(dataRoot, "sessiond-data");
  await mkdir(dataDir, { recursive: true });
  const port = await freePort();
  const service = await startService(join(installRoot, "bin", "pi-web-sessiond"), {
    ...environment,
    PI_WEB_DATA_DIR: dataDir,
    PI_WEB_SESSIOND_HOST: "127.0.0.1",
    PI_WEB_SESSIOND_PORT: String(port),
  });
  try {
    const base = `http://127.0.0.1:${String(port)}`;
    const runtime = await waitForJson(`${base}/runtime`, service, 30_000);
    // The daemon answers for itself — this is the runtime the launcher chose, not an assumption.
    if (runtime.runtime !== "bun") {
      throw new Error(`Session daemon reported runtime ${JSON.stringify(runtime.runtime)}; expected "bun"`);
    }
    if (runtime.available !== true) throw new Error(`Session daemon runtime component unavailable: ${JSON.stringify(runtime)}`);

    // After the rebase, terminals live inside the bundled Terminal plugin (pi-web.terminal),
    // so the old REST endpoints (/terminals/*) no longer exist. The plugin backend protocol
    // requires a project and workspace; create them here so the plugin routes resolve.
    const project = await requestJson("POST", `${base}/projects`, service, {
      path: dataDir,
      name: "smoke",
      create: true,
    });
    if (project.status !== 200) throw new Error(`POST /projects returned ${project.status}: ${JSON.stringify(project.body)}`);
    const projectId = project.body.id;

    const catalog = await waitForJson(`${base}/workspace-catalog/projects/${encodeURIComponent(projectId)}/workspaces`, service, 30_000);
    const mainWorkspace = catalog.workspaces?.find((w) => w.isMain) ?? catalog.workspaces?.[0];
    if (!mainWorkspace) throw new Error(`No workspace found for project ${projectId}: ${JSON.stringify(catalog)}`);
    const workspaceId = mainWorkspace.id;

    // Fetch the current plugin backend revisions so the smoke test can use them
    // in all plugin backend requests and WebSocket frames.
    const providerRuntime = await waitForJson(`${base}/workspace-catalog/provider-runtime`, service, 30_000);
    const terminalRecord = providerRuntime.records?.find((r) => r.pluginId === "pi-web.terminal");
    if (terminalRecord === undefined) throw new Error(`No plugin backend record for pi-web.terminal in provider-runtime`);
    const terminalRevision = terminalRecord.moduleRevision;
    if (typeof terminalRevision !== "string" || terminalRevision === "") throw new Error(`pi-web.terminal moduleRevision is not a non-empty string`);

    // List terminals (should be empty initially)
    const listResult = await pluginBackendRequest(base, "pi-web.terminal", projectId, workspaceId, "terminal.list", null, terminalRevision);
    if (listResult.status < 200 || listResult.status >= 300 || !Array.isArray(listResult.body) || listResult.body.length !== 0) {
      throw new Error(`terminal.list returned ${JSON.stringify(listResult)}; expected an empty list`);
    }

    // Create a terminal
    const created = await pluginBackendRequest(base, "pi-web.terminal", projectId, workspaceId, "terminal.create", {
      cols: 40,
      rows: 10,
    }, terminalRevision);
    if (created.status < 200 || created.status >= 300 || typeof created.body?.id !== "string") {
      throw new Error(`terminal.create failed: ${String(created.status)} ${JSON.stringify(created.body)}`);
    }
    const terminal = created.body;
    if (terminal.exited === true) throw new Error(`Created terminal already exited: ${JSON.stringify(terminal)}`);

    // List again — should show one terminal
    const listed = await pluginBackendRequest(base, "pi-web.terminal", projectId, workspaceId, "terminal.list", null, terminalRevision);
    if (listed.status < 200 || listed.status >= 300 || !Array.isArray(listed.body) || listed.body.length !== 1) {
      throw new Error(`terminal.list after create returned ${JSON.stringify(listed)}`);
    }

    // The attach stream is the observable proof that a real PTY is running under Bun: bytes that
    // only ever travelled through a pipe would look identical here. The quoted-split markers keep
    // the assertion unambiguous, because the PTY also echoes the typed command back.
    const echoed = await readTerminalEcho(
      `${base}/paired-plugin-backends/pi-web.terminal/projects/${encodeURIComponent(projectId)}/workspaces/${encodeURIComponent(workspaceId)}/channels/terminal.attach`,
      terminal.id,
      `printf 'b:${MARKER}\\n'`,
      MARKER,
      terminalRevision,
    );
    if (!echoed.includes(`b:${MARKER}`)) {
      throw new Error(`Terminal attach stream did not carry the marker; saw ${JSON.stringify(echoed.slice(-400))}`);
    }
    // The marker alone would also travel through a pipe, so ask the shell what its own descriptors
    // are. `t""tyyes` prints `ttyyes` while the command the PTY echoes back keeps the quotes, which
    // is what makes the two branches distinguishable in this stream.
    const ttyState = await readTerminalEcho(
      `${base}/paired-plugin-backends/pi-web.terminal/projects/${encodeURIComponent(projectId)}/workspaces/${encodeURIComponent(workspaceId)}/channels/terminal.attach`,
      terminal.id,
      `if [ -t 0 ] && [ -t 1 ]; then echo t""tyyes; else echo t""tyno; fi`,
      "ttyyes",
      terminalRevision,
    );
    if (!ttyState.includes("ttyyes")) {
      throw new Error(`Created terminal is not an interactive terminal device; saw ${JSON.stringify(ttyState.slice(-400))}`);
    }

    // Close the terminal (plugin backend protocol uses POST, not DELETE)
    const closeResult = await pluginBackendRequest(base, "pi-web.terminal", projectId, workspaceId, "terminal.close", { terminalId: terminal.id }, terminalRevision);
    if (closeResult.status !== 200 || !closeResult.body?.closed) {
      throw new Error(`terminal.close failed: ${JSON.stringify(closeResult.body)}`);
    }
    // Deleting the terminal must take its shell with it, otherwise the smoke leaks PTY children.
    await waitFor(async () => (await countDescendants(service.pid)) === 0, 10_000,
      async () => new Error(`Terminal shell survived terminal.close — ${String(await countDescendants(service.pid))} descendants of pid ${String(service.pid)} remain`));
    console.log(`✓ bun session daemon (pid ${String(service.pid)}) served a terminal through Bun.Terminal`);
  } finally {
    await stopService(service);
  }
}

async function smokeBunWebServer(dataRoot, installRoot, environment) {
  const dataDir = join(dataRoot, "web-data");
  await mkdir(dataDir, { recursive: true });
  // The web/API reaches the session daemon over its unix socket, which lives in the data dir.
  const sessiond = await startService(join(installRoot, "bin", "pi-web-sessiond"), { ...environment, PI_WEB_DATA_DIR: dataDir });
  const port = await freePort();
  const web = await startService(join(installRoot, "bin", "pi-web-server"), {
    ...environment,
    PI_WEB_DATA_DIR: dataDir,
    PI_WEB_HOST: "127.0.0.1",
    PI_WEB_PORT: String(port),
  });
  const base = `http://127.0.0.1:${String(port)}`;
  try {
    // Readiness first, then the status endpoint, which is where each component's
    // reported runtime lives (the version endpoint omits the session daemon's
    // runtime when it predates runtime reporting).
    await waitForJson(`${base}/api/pi-web/version`, web, 45_000);
    // The web/API may come up before the session daemon has created its unix
    // socket, so poll the status endpoint until the daemon is reachable and
    // both components report the runtime.
    await waitFor(
      async () => {
        const response = await fetch(`${base}/api/pi-web/status`);
        if (!response.ok) return false;
        const status = await response.json();
        return ["web", "sessiond"].every((component) => status.components?.[component]?.runtime === "bun");
      },
      45_000,
      () => new Error(`Timed out waiting for both components to report runtime bun:\nWEB:\n${logTail(web)}\nSESSIOND:\n${logTail(sessiond)}`),
    );
    const index = await requestText("GET", `${base}/`, web);
    if (index.status !== 200 || !index.body.includes("<html")) {
      throw new Error(`GET / returned ${String(index.status)} with ${index.body.slice(0, 120)} body`);
    }
    const projects = await requestJson("GET", `${base}/api/projects`, web);
    if (projects.status !== 200 || !Array.isArray(projects.body)) {
      throw new Error(`GET /api/projects returned ${String(projects.status)} ${JSON.stringify(projects.body)}`);
    }
    console.log(`✓ bun web/API and session daemon both reported runtime=bun and served / + /api/projects on port ${String(port)}`);
  } finally {
    // Stop both even when a check failed, and never let a shutdown error hide the real one.
    const shutdownErrors = [];
    for (const service of [web, sessiond]) {
      try {
        await stopService(service);
      } catch (error) {
        shutdownErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (shutdownErrors.length > 0) throw new Error(`Installed services did not shut down cleanly:\n${shutdownErrors.join("\n")}`);
  }
}

/* ------------------------------------------------------------------ */
/*  Shared process/HTTP plumbing                                       */
/* ------------------------------------------------------------------ */

async function startService(command, environment) {
  const logs = [];
  const child = spawn(command, [], { env: environment, stdio: ["ignore", "pipe", "pipe"], detached: false });
  const collect = (stream) => {
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      logs.push(String(chunk));
      if (logs.length > 400) logs.shift();
    });
  };
  if (child.stdout !== null) collect(child.stdout);
  if (child.stderr !== null) collect(child.stderr);
  if (typeof child.pid !== "number") throw new Error(`Could not start ${command}`);
  const service = { command, pid: child.pid, child, logs, exited: false };
  child.once("exit", () => { service.exited = true; });
  return service;
}

function logTail(service) {
  const tail = service.logs.join("").split("\n").slice(-25).join("\n");
  return tail === "" ? "(no output)" : tail;
}

/**
 * Stops a service and proves it actually went away.
 *
 * `exitCode` stays null for a process killed by a signal — which is how the web/API ends on
 * SIGTERM, since it has no signal handler of its own — so the check has to watch `spawn`/`exit`
 * rather than poll `exitCode`, or a clean shutdown looks like a hang.
 */
async function stopService(service) {
  if (service.exited) return;
  // Snapshot the tree before signalling: once the leader exits, /proc no longer says who its
  // children were, and an orphaned PTY shell is precisely what this smoke must not leave behind.
  const spawned = await descendantPids(service.pid);
  service.child.kill("SIGTERM");
  const deadline = Date.now() + 15_000;
  while (!service.exited && Date.now() < deadline) {
    await delay(100);
  }
  if (!service.exited) {
    service.child.kill("SIGKILL");
    throw new Error(`${service.command} (pid ${String(service.pid)}) did not exit on SIGTERM\n${logTail(service)}`);
  }
  // Reparented children get a moment to notice their leader is gone before this counts as a leak.
  let survivors = [];
  const leakDeadline = Date.now() + 5_000;
  for (;;) {
    const stillRunning = [];
    for (const pid of spawned) {
      if (processIsAlive(pid)) stillRunning.push(pid);
    }
    survivors = stillRunning;
    if (stillRunning.length === 0 || Date.now() >= leakDeadline) break;
    await delay(100);
  }
  if (survivors.length > 0) {
    throw new Error(`${service.command} (pid ${String(service.pid)}) left ${String(survivors.length)} descendant process(es) behind: ${survivors.join(", ")}\n${logTail(service)}`);
  }
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return error.code === "EPERM";
  }
}

/** Polls a condition until it holds or the budget runs out; used for teardown assertions. */
async function waitFor(condition, timeoutMs, onFailure) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await condition()) return;
    if (Date.now() >= deadline) throw await onFailure();
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
}

/**
 * Direct and indirect children of `pid`, read from /proc. A stop that only reaps the process it
 * spawned would still leak the session daemon's PTY shells and children they started.
 */
async function descendantPids(pid) {
  const children = new Map();
  for (const entry of await readdir("/proc", { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    const statPath = join("/proc", entry.name, "stat");
    let stat;
    try {
      stat = await readFile(statPath, "utf8");
    } catch {
      continue; // the process exited while we were scanning
    }
    // comm is parenthesised and may contain spaces, so the parent pid is field 4 after the ')'.
    const fields = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/u);
    const ppid = Number(fields[1]);
    if (Number.isFinite(ppid) && ppid > 0) children.set(ppid, [...(children.get(ppid) ?? []), Number(entry.name)]);
  }
  const found = [];
  const queue = [pid];
  while (queue.length > 0) {
    for (const child of children.get(queue.shift()) ?? []) {
      found.push(child);
      queue.push(child);
    }
  }
  return found;
}

async function countDescendants(pid) {
  return (await descendantPids(pid)).length;
}

async function waitForJson(url, service, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "no attempt";
  while (Date.now() < deadline) {
    if (service.exited) throw new Error(`${service.command} exited during startup:\n${logTail(service)}`);
    try {
      const response = await fetch(url);
      if (response.ok) return await response.json();
      lastError = `HTTP ${String(response.status)}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await delay(250);
  }
  throw new Error(`Timed out waiting for ${url} (${lastError})\n${logTail(service)}`);
}

async function pluginBackendRequest(base, pluginId, projectId, workspaceId, operation, input, revision) {
  const url = `${base}/paired-plugin-backends/${encodeURIComponent(pluginId)}/projects/${encodeURIComponent(projectId)}/workspaces/${encodeURIComponent(workspaceId)}/${operation}`;
  return requestJson("POST", url, undefined, { revision, input });
}

async function requestJson(method, url, service, body) {
  const init = body === undefined ? { method } : { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
  const response = await fetch(url, init).catch((error) => {
    throw new Error(`${method} ${url} failed: ${error instanceof Error ? error.message : String(error)}\n${logTail(service)}`);
  });
  const text = await response.text();
  let parsed = text;
  try {
    parsed = text === "" ? undefined : JSON.parse(text);
  } catch {
    /* Non-JSON error bodies stay verbatim so failures are readable. */
  }
  return { status: response.status, body: parsed };
}

async function requestText(method, url, service) {
  const response = await fetch(url, { method }).catch((error) => {
    throw new Error(`${method} ${url} failed: ${error instanceof Error ? error.message : String(error)}\n${logTail(service)}`);
  });
  return { status: response.status, body: await response.text() };
}

/**
 * Writes a command into a live terminal and collects what the PTY streams back.
 * Uses bun when it is available (this file may run under either runtime) and falls back to the
 * Node global WebSocket, so the smoke itself is runtime-agnostic while the service is bun.
 */
async function readTerminalEcho(socketUrl, terminalId, input, expectation = MARKER, revision) {
  if (typeof globalThis.WebSocket !== "function") {
    throw new Error("The smoke needs a global WebSocket (Node 22+ and bun both provide one)");
  }
  return await new Promise((resolvePromise, reject) => {
    const socket = new globalThis.WebSocket(socketUrl);
    let seen = "";
    let inputSent = false;
    const timer = setTimeout(() => {
      try { socket.close(); } catch { /* already closing */ }
      reject(new Error(`Timed out waiting for terminal output; saw ${JSON.stringify(seen.slice(-400))}`));
    }, 20_000);
    socket.addEventListener?.("open", () => {
      // Open the plugin backend channel first
      socket.send(JSON.stringify({ version: 1, kind: "open", revision: revision ?? "local", input: { terminalId } }));
    });
    socket.addEventListener?.("message", (event) => {
      const raw = typeof event.data === "string" ? event.data : String(event.data);
      try {
        const frame = JSON.parse(raw);
        if (frame.kind === "ready") {
          // Channel is ready — send the input command
          socket.send(JSON.stringify({ version: 1, kind: "data", data: { type: "input", data: `${input}\n` } }));
          return;
        }
        if (frame.kind === "data" && frame.data?.type === "output") {
          seen += frame.data.data;
        }
        if (frame.kind === "data" && frame.data?.type === "error") {
          clearTimeout(timer);
          socket.close();
          reject(new Error(`Terminal channel error: ${frame.data.message}`));
          return;
        }
        if (frame.kind === "error") {
          clearTimeout(timer);
          socket.close();
          reject(new Error(`Terminal channel error: ${frame.message}`));
          return;
        }
        if (frame.kind === "data" && frame.data?.type === "exit") {
          // Terminal exited — check if we already saw the expectation
          if (seen.includes(expectation)) {
            clearTimeout(timer);
            socket.close();
            resolvePromise(seen);
          }
          return;
        }
      } catch {
        // Non-JSON frames are ignored
      }
      if (seen.includes(expectation)) {
        clearTimeout(timer);
        socket.close();
        resolvePromise(seen);
      }
    });
    socket.addEventListener?.("error", () => {
      clearTimeout(timer);
      reject(new Error(`Terminal socket failed before producing output; saw ${JSON.stringify(seen.slice(-400))}`));
    });
  });
}

async function freePort() {
  const net = await import("node:net");
  return await new Promise((resolvePromise, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => resolvePromise(port));
    });
  });
}

function delay(milliseconds) {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, milliseconds);
  });
}

function runProcess(file, args, cwd, environment = process.env) {
  return new Promise((resolvePromise, reject) => {
    execFile(file, args, { cwd, encoding: "utf8", maxBuffer: 20 * 1024 * 1024, timeout: 300_000, env: environment }, (error, stdout, stderr) => {
      if (error !== null && typeof error.code !== "number") {
        reject(new Error(`Could not run ${file} ${args.join(" ")}: ${error.message}\n${stderr}`));
        return;
      }
      resolvePromise({ code: error?.code ?? 0, stdout, stderr });
    });
  });
}

/**
 * npm's own environment must not leak into the npm it shells out to.
 *
 * Running through `npm run` exports `npm_config_*` for the outer npm, including
 * `npm_config_prefix` when the caller uses a version manager's prefix. An inner
 * `npm install --global --prefix <temp>` then resolves against that **real** prefix instead of
 * the throwaway one, so the check either silently no-ops (same version already installed) or
 * overwrites the user's global PI WEB. Force the config, the cache, and HOME into the temp root.
 */
async function prepareNpmEnvironmentDirs(root) {
  await Promise.all([
    mkdir(packDir, { recursive: true }),
    mkdir(join(globalPrefix, "lib"), { recursive: true }),
    mkdir(npmToolDir, { recursive: true }),
  ]);
  await writeFile(join(npmToolDir, "package.json"), '{"private":true}\n');

  await runNpm(npmExecPath, [
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--no-package-lock",
    "--no-save",
    `npm@${NPM_VERSION}`,
  ], npmToolDir);
  const npm12ExecPath = join(npmToolDir, "node_modules", "npm", "bin", "npm-cli.js");
  // Use npm 12 for packing too: npm 10 can run prepare despite --ignore-scripts.
  const packOutput = await runNpm(npm12ExecPath, ["pack", "--ignore-scripts", "--json", "--pack-destination", packDir], repoRoot);
  const tarballPath = join(packDir, packageTarballFilename(packOutput));

  await runNpm(npm12ExecPath, [
    "install",
    "--global",
    tarballPath,
    "--prefix",
    globalPrefix,
    "--allow-scripts=node-pty",
    "--no-audit",
    "--no-fund",
  ], root);

  const packageRoot = join(globalPrefix, "lib", "node_modules", "@jmfederico", "pi-web");
  await smokeInstalledPiSdk(packageRoot);
  await smokeInstalledTypebox(packageRoot, true);
  await smokePiPackageExtension(packageRoot);
  await smokeInstalledPluginApi({ packageRoot, fixtureRoot: root, repoRoot });
  await smokeInstalledTerminalService(packageRoot);

  // Match Pi's npm install policy without using its live settings or package store.
  const managedRoot = join(root, "managed");
  await mkdir(managedRoot);
  await writeFile(join(managedRoot, "package.json"), '{"name":"pi-extensions","private":true}\n');
  await runNpm(npm12ExecPath, [
    "install", tarballPath, "--prefix", managedRoot, "--legacy-peer-deps",
    "--ignore-scripts", "--no-audit", "--no-fund",
  ], managedRoot);
  const managedPackageRoot = join(managedRoot, "node_modules", "@jmfederico", "pi-web");
  assert.throws(() => createRequire(join(managedPackageRoot, "package.json")).resolve("@earendil-works/pi-coding-agent"),
    { code: "MODULE_NOT_FOUND" }, "Managed fixture must not auto-install the Pi SDK peer");
  // Only TypeBox resolution is under test here, not provisioning the server's Pi SDK peers.
  await smokeInstalledTypebox(managedPackageRoot, false);
  await smokePiPackageExtension(managedPackageRoot);
  console.log(`Installed-package Pi 1.x, server TypeBox (global/managed), extension, plugin API, and PTY smoke tests passed with npm ${NPM_VERSION}.`);
} finally {
  await rm(root, { recursive: true, force: true });
}

async function runNpm(npmCliPath, args, cwd) {
  const result = await execFileAsync(process.execPath, [npmCliPath, ...args], {
    cwd,
    // npm run exports prefix/config variables that can redirect nested installations.
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^npm_/iu.test(name))),
      HOME: join(root, "home"),
      npm_config_cache: join(root, "npm-cache"),
    },
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    timeout: 180_000,
  });
  return result.stdout;
}

function packageTarballFilename(output) {
  const parsed = JSON.parse(output);
  // npm 12 keys pack results by package name; older npm returns an array.
  const packages = Array.isArray(parsed) ? parsed : Object.values(parsed);
  assert.equal(packages.length, 1, "npm pack must return exactly one package");
  assert.equal(typeof packages[0]?.filename, "string", "npm pack must return a tarball filename");
  return packages[0].filename;
}

async function smokeInstalledPiSdk(packageRoot) {
  const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  for (const name of ["pi-agent-core", "pi-ai", "pi-coding-agent"]) {
    const specifier = `@earendil-works/${name}`;
    if (manifest.peerDependencies?.[specifier] !== "^1.0.0") {
      throw new Error(`Installed package must require ${specifier} ^1.0.0`);
    }
    const dependency = JSON.parse(await readFile(join(packageRoot, "node_modules", specifier, "package.json"), "utf8"));
    if (!/^1\./.test(dependency.version)) {
      throw new Error(`Installed package resolved unsupported ${specifier} ${dependency.version}`);
    }
  }
  // Pi's barrels are import-only; resolve them through an ESM fixture inside the
  // temporary installation rather than createRequire's CommonJS condition.
  const runtimePath = join(packageRoot, "pi-sdk-smoke.mjs");
  await writeFile(runtimePath, ["pi-agent-core", "pi-ai", "pi-coding-agent"]
    .map((name) => `import "@earendil-works/${name}";`).join("\n"));
  await import(pathToFileURL(runtimePath).href);
  const factoriesUrl = pathToFileURL(join(packageRoot, "dist", "server", "sessions", "builtinExtensionFactories.js")).href;
  const { getBuiltinExtensionFactories } = await import(factoriesUrl);
  if ((await getBuiltinExtensionFactories()).length !== 3) {
    throw new Error("Installed package did not resolve all three Pi built-in extension factories");
  }
}

async function smokeInstalledTypebox(packageRoot, importServerTools) {
  const runtimePath = join(packageRoot, "server-typebox-smoke.mjs");
  const toolModules = ["spawnSessionTool", "spawnSubsessionTool", "askUserTool"];
  await writeFile(runtimePath, [
    'import assert from "node:assert/strict";',
    'import { Type } from "pi-web-typebox";',
    'import { Check } from "pi-web-typebox/value";',
    'const schema = Type.Object({ value: Type.String() });',
    'assert.equal(Check(schema, { value: "standalone" }), true);',
    'assert.equal(Check(schema, { value: 42 }), false);',
    ...(importServerTools ? toolModules.map((name) => `import "./dist/server/sessions/${name}.js";`) : []),
  ].join("\n"));
  // A fresh native Node process has neither Pi's extension aliases nor test-runner transforms.
  await execFileAsync(process.execPath, [runtimePath], {
    cwd: packageRoot, encoding: "utf8", timeout: 30_000,
    env: { ...process.env, NODE_OPTIONS: "", NODE_PATH: "" },
  });
}

async function smokePiPackageExtension(packageRoot) {
  const { DefaultResourceLoader, SettingsManager } = await import("@earendil-works/pi-coding-agent");
  const agentDir = await mkdtemp(join(root, "extension-"));
  const loader = new DefaultResourceLoader({
    cwd: agentDir, agentDir,
    settingsManager: SettingsManager.inMemory({ packages: [packageRoot] }),
    noSkills: true, noPromptTemplates: true, noThemes: true,
  });
  await loader.reload();
  const result = loader.getExtensions();
  assert.deepEqual(result.errors, [], "PI WEB extension must load through Pi");
  assert.deepEqual(result.warnings ?? [], [], "PI WEB must not trigger a host-provided dependency warning");
  assert.ok(result.extensions.some((extension) => extension.commands.has("pi-web")), "Pi must register /pi-web");
}

async function smokeInstalledTerminalService(packageRoot) {
  const requireFromPackage = createRequire(join(packageRoot, "package.json"));
  const nodePtyPackageJsonPath = requireFromPackage.resolve("node-pty/package.json");
  const nodePtyPackage = JSON.parse(await readFile(nodePtyPackageJsonPath, "utf8"));
  if (typeof nodePtyPackage.version !== "string" || nodePtyPackage.version.includes("-")) {
    throw new Error(`Installed package resolved a non-stable node-pty version: ${String(nodePtyPackage.version)}`);
  }

  const terminalModuleUrl = pathToFileURL(join(packageRoot, "dist", "pi-web-plugins", "terminal", "terminalService.js")).href;
  const { TerminalService } = await import(terminalModuleUrl);
  const previousShell = process.env["SHELL"];
  process.env["SHELL"] = "/bin/sh";
  const service = new TerminalService();
  try {
    const run = service.runCommand({
      origin: "package-smoke",
      projectId: "package-smoke",
      workspaceId: "package-smoke",
      cwd: packageRoot,
      title: "Installed package PTY smoke test",
      command: `printf '%s' '${MARKER}'`,
    });
    let output = "";
    let detach = () => undefined;
    const exitCode = await new Promise((resolvePromise, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Timed out waiting for installed node-pty output: ${JSON.stringify(output)}`)), 10_000);
      try {
        detach = service.attach({ projectId: "package-smoke", workspaceId: "package-smoke", cwd: packageRoot }, run.terminalId, {
          output: (data) => { output += data; },
          exit: (code) => {
            clearTimeout(timeout);
            resolvePromise(code);
          },
        });
      } catch (error) {
        clearTimeout(timeout);
        reject(error);
      }
    });
    detach();
    if (exitCode !== 0) throw new Error(`Installed PTY command exited with ${String(exitCode)}`);
    if (!output.includes(MARKER)) throw new Error(`Installed PTY output did not contain ${MARKER}: ${JSON.stringify(output)}`);
  } finally {
    service.dispose();
    if (previousShell === undefined) delete process.env["SHELL"];
    else process.env["SHELL"] = previousShell;
  }
}
