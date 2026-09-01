import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
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

// A packed copy of this checkout is reused by both modes; each mode installs it into its own
// throwaway prefix and runs it under its own runtime.
const tarballRoot = await mkdtemp(join(tmpdir(), "pi-web-package-tarball-"));
try {
  const tarballPath = await packWorkspace(tarballRoot);
  if (runMode() === "bun") await smokeBunGlobalInstall(tarballPath);
  else await smokeNpmGlobalInstall(tarballPath);
} finally {
  await rm(tarballRoot, { recursive: true, force: true });
}

function runMode() {
  const mode = process.argv[2] ?? "npm";
  if (mode !== "npm" && mode !== "bun") {
    throw new Error(`Unknown smoke mode ${mode}; expected \`npm\` or \`bun\` (run through npm scripts)`);
  }
  return mode;
}

async function packWorkspace(root) {
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
  const root = await mkdtemp(join(tmpdir(), "pi-web-package-install-"));
  try {
    const npmToolDir = join(root, "npm-tool");
    const globalPrefix = join(root, "global");
    await Promise.all([
      mkdir(join(globalPrefix, "lib"), { recursive: true }),
      mkdir(npmToolDir, { recursive: true }),
    ]);
    await writeFile(join(npmToolDir, "package.json"), '{"private":true}\n');

    const npmExecPath = process.env["npm_execpath"];
    if (npmExecPath === undefined || npmExecPath === "") {
      throw new Error("npm_execpath is required; run this check through `npm run smoke:package-install`");
    }
    const npmEnvironment = isolatedNpmEnvironment(root);
    await prepareNpmEnvironmentDirs(root);
    await runProcess(process.execPath, [npmExecPath,
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--no-package-lock",
      "--no-save",
      `npm@${NPM_VERSION}`,
    ], npmToolDir, npmEnvironment);
    const npm12ExecPath = join(npmToolDir, "node_modules", "npm", "bin", "npm-cli.js");

    await runProcess(process.execPath, [npm12ExecPath,
      "install",
      "--global",
      tarballPath,
      "--prefix",
      globalPrefix,
      "--allow-scripts=node-pty",
      "--no-audit",
      "--no-fund",
    ], root, npmEnvironment);

    const packageRoot = await installedPackageRoot(globalPrefix);
    await smokeInstalledPluginApi({ packageRoot, fixtureRoot: root, repoRoot });
    await smokeInstalledTerminalService(packageRoot);
    console.log(`Installed-package plugin API and PTY smoke tests passed with npm ${NPM_VERSION}.`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------ */
/*  bun global install (SPEC A2/A3): no node on PATH at all            */
/* ------------------------------------------------------------------ */

async function smokeBunGlobalInstall(tarballPath) {
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
    const environment = {
      HOME: home,
      PATH: pathValue,
      BUN_INSTALL: installRoot,
      SHELL: "/bin/sh",
      TMPDIR: root,
    };

    await runProcess(bunExecutable, ["add", "--global", tarballPath], root, environment);
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
    console.log(`✓ bun-installed pi-web ${version} runs on bun with node absent from PATH`);

    await smokeBunTerminalService(root, installRoot, environment);
    await smokeBunWebServer(root, installRoot, environment);
    console.log("Installed-package bun smoke tests passed (runtime, terminals over Bun.Terminal, web/API).");
  } finally {
    await rm(root, { recursive: true, force: true });
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

    const terminalsUrl = `${base}/terminals?cwd=${encodeURIComponent(dataDir)}`;
    const initial = await requestJson("GET", terminalsUrl, service);
    if (!Array.isArray(initial.body) || initial.body.length !== 0) {
      throw new Error(`GET /terminals returned ${JSON.stringify(initial.body)}; expected an empty list`);
    }

    const created = await requestJson("POST", `${base}/terminals`, service, { cwd: dataDir, cols: 40, rows: 10 });
    const terminal = created.body;
    if (created.status < 200 || created.status >= 300 || typeof terminal?.id !== "string") {
      throw new Error(`POST /terminals failed: ${String(created.status)} ${JSON.stringify(created.body)}`);
    }
    if (terminal.exited === true) throw new Error(`Created terminal already exited: ${JSON.stringify(terminal)}`);

    const listed = await requestJson("GET", terminalsUrl, service);
    if (!Array.isArray(listed.body) || listed.body.length !== 1) {
      throw new Error(`GET /terminals after create returned ${JSON.stringify(listed.body)}`);
    }

    // The attach stream is the observable proof that a real PTY is running under Bun: bytes that
    // only ever travelled through a pipe would look identical here. The quoted-split markers keep
    // the assertion unambiguous, because the PTY also echoes the typed command back.
    const echoed = await readTerminalEcho(`ws://127.0.0.1:${String(port)}/terminals/${terminal.id}/socket`, `printf 'b:${MARKER}\\n'`);
    if (!echoed.includes(`b:${MARKER}`)) {
      throw new Error(`Terminal attach stream did not carry the marker; saw ${JSON.stringify(echoed.slice(-400))}`);
    }
    // The marker alone would also travel through a pipe, so ask the shell what its own descriptors
    // are. `t""tyyes` prints `ttyyes` while the command the PTY echoes back keeps the quotes, which
    // is what makes the two branches distinguishable in this stream.
    const ttyState = await readTerminalEcho(
      `ws://127.0.0.1:${String(port)}/terminals/${terminal.id}/socket`,
      `if [ -t 0 ] && [ -t 1 ]; then echo t""tyyes; else echo t""tyno; fi`,
      "ttyyes",
    );
    if (!ttyState.includes("ttyyes")) {
      throw new Error(`Created terminal is not an interactive terminal device; saw ${JSON.stringify(ttyState.slice(-400))}`);
    }
    await requestJson("DELETE", `${base}/terminals/${terminal.id}`, service);
    // Deleting the terminal must take its shell with it, otherwise the smoke leaks PTY children.
    await waitFor(async () => (await countDescendants(service.pid)) === 0, 10_000,
      async () => new Error(`Terminal shell survived DELETE /terminals/:id — ${String(await countDescendants(service.pid))} descendants of pid ${String(service.pid)} remain`));
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
    // Readiness first: the version endpoint is also where each component's reported runtime lives.
    const version = await waitForJson(`${base}/api/pi-web/version`, web, 45_000);
    for (const component of ["web", "sessiond"]) {
      const reported = version.components?.[component]?.runtime;
      if (reported !== "bun") {
        throw new Error(`Installed ${component} component reported runtime ${JSON.stringify(reported)}; expected "bun"`);
      }
    }
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
async function readTerminalEcho(socketUrl, input, expectation = MARKER) {
  if (typeof globalThis.WebSocket !== "function") {
    throw new Error("The smoke needs a global WebSocket (Node 22+ and bun both provide one)");
  }
  return await new Promise((resolvePromise, reject) => {
    const socket = new globalThis.WebSocket(socketUrl);
    let seen = "";
    const timer = setTimeout(() => {
      try {
        socket.close();
      } catch {
        /* already closing */
      }
      reject(new Error(`Timed out waiting for terminal output; saw ${JSON.stringify(seen.slice(-400))}`));
    }, 20_000);
    socket.addEventListener?.("open", () => {
      socket.send(JSON.stringify({ type: "input", data: `${input}\n` }));
    });
    socket.addEventListener?.("message", (event) => {
      const raw = typeof event.data === "string" ? event.data : String(event.data);
      try {
        const frame = JSON.parse(raw);
        if (frame.type === "output") seen += frame.data;
        if (frame.type === "error") {
          clearTimeout(timer);
          socket.close();
          reject(new Error(`Terminal socket error: ${frame.message}`));
          return;
        }
      } catch {
        seen += raw;
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
    mkdir(join(root, "home"), { recursive: true }),
    mkdir(join(root, "npm-cache"), { recursive: true }),
  ]);
}

function isolatedNpmEnvironment(root) {
  const environment = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("npm_") || key.startsWith("NPM_") || key.startsWith("COREPACK_") || key === "NODE_OPTIONS") continue;
    environment[key] = value;
  }
  environment["HOME"] = join(root, "home");
  environment["npm_config_prefix"] = join(root, "global");
  environment["npm_config_cache"] = join(root, "npm-cache");
  return environment;
}

function packageTarballFilename(output) {
  // npm has shipped `pack --json` both as an array of manifests and, in newer versions, as an
  // object keyed by package name. Accept either; the field needed is the same. Lifecycle output
  // can precede the payload, so every JSON-looking offset is tried.
  for (const match of output.matchAll(/[[{]/gu)) {
    let parsed;
    try {
      parsed = JSON.parse(output.slice(match.index));
    } catch {
      continue;
    }
    const manifests = Array.isArray(parsed) ? parsed : Object.values(parsed ?? {});
    const filename = manifests.length === 1 ? manifests[0]?.filename : undefined;
    if (typeof filename === "string" && filename !== "") return filename;
  }
  throw new Error(`npm pack returned an unexpected result: ${JSON.stringify(output.slice(0, 400))}`);
}

async function smokeInstalledTerminalService(packageRoot) {
  const requireFromPackage = createRequire(join(packageRoot, "package.json"));
  const nodePtyPackageJsonPath = requireFromPackage.resolve("node-pty/package.json");
  const nodePtyPackage = JSON.parse(await readFile(nodePtyPackageJsonPath, "utf8"));
  if (typeof nodePtyPackage.version !== "string" || nodePtyPackage.version.includes("-")) {
    throw new Error(`Installed package resolved a non-stable node-pty version: ${String(nodePtyPackage.version)}`);
  }

  const terminalModuleUrl = pathToFileURL(join(packageRoot, "dist", "server", "terminals", "terminalService.js")).href;
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
        detach = service.attach(run.terminalId, {
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
