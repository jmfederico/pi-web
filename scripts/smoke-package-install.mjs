import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { request } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { smokeInstalledPluginApi } from "./plugin-api-package-smoke.mjs";

const NPM_VERSION = "12.0.1";
// These are independently provisioned fixture hosts, never PI WEB dependencies.
const HOST_PI_VERSIONS = ["1.3.0", "1.2.0"];
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
const originalEnv = { ...process.env };
const fixtureEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(?:PI_|PI_WEB_|npm_|XDG_|DBUS_|NODE_OPTIONS$|NODE_PATH$|PORT$)/iu.test(name))),
  HOME: join(root, "home"),
  XDG_CONFIG_HOME: join(root, "config"),
  XDG_DATA_HOME: join(root, "data"),
  XDG_RUNTIME_DIR: join(root, "run"),
  PI_CODING_AGENT_DIR: join(root, "agent"),
  PI_WEB_DATA_DIR: join(root, "web-data"),
  PI_WEB_CONFIG: join(root, "web-config.json"),
  PI_WEB_SESSIOND_SOCKET: join(root, "sessiond.sock"),
  PI_WEB_OFFLINE: "1",
  PI_OFFLINE: "1",
  NODE_OPTIONS: "",
  NODE_PATH: "",
};
// In-process plugin consumers must be just as isolated as fresh CLI processes.
for (const name of Object.keys(process.env)) delete process.env[name];
Object.assign(process.env, fixtureEnv);
try {
  await Promise.all([fixtureEnv.HOME, fixtureEnv.XDG_CONFIG_HOME, fixtureEnv.XDG_RUNTIME_DIR]
    .map((path) => mkdir(path, { recursive: true })));
  const packDir = join(root, "pack");
  const npmToolDir = join(root, "npm-tool");
  const globalPrefix = join(root, "global");
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

  const hosts = [];
  for (const version of HOST_PI_VERSIONS) {
    const prefix = join(root, `pi-host-${version}`);
    await runNpm(npm12ExecPath, [
      "install", "--global", `@earendil-works/pi-coding-agent@${version}`,
      "--prefix", prefix, "--no-audit", "--no-fund",
    ], root);
    const hostRoot = join(prefix, "lib", "node_modules", "@earendil-works", "pi-coding-agent");
    hosts.push({ hostRoot, prefix, version });
  }

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
  await assertHostPeersOnly(packageRoot);
  for (const host of hosts) await smokeInstalledPiSdk(packageRoot, host);
  const host = hosts[0];
  process.env["PI_WEB_PI_PACKAGE_DIR"] = host.hostRoot;
  for (const preference of ["auto", "node"]) {
    const launcherEnv = { ...process.env, PI_WEB_RUNTIME: preference };
    const cli = join(globalPrefix, "bin", "pi-web");
    const selected = await execFileAsync(cli, ["--print-runtime"], { env: launcherEnv, encoding: "utf8", timeout: 30_000 });
    assert.equal(selected.stdout.trim(), "node");
    const prerequisites = await execFileAsync(join(globalPrefix, "bin", "pi-web-sessiond"), ["--check-runtime"], { env: launcherEnv, encoding: "utf8", timeout: 30_000 });
    assert.equal(prerequisites.stdout.trim(), "node");
    const version = await execFileAsync(cli, ["--version"], { env: launcherEnv, encoding: "utf8", timeout: 30_000 });
    assert.ok(version.stdout.includes(JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")).version));
  }
  await smokeInstalledTypebox(packageRoot, host);
  await smokePiPackageExtension(packageRoot, host);
  await smokeInstalledPluginApi({ packageRoot, fixtureRoot: root, repoRoot });
  await smokeInstalledTerminalService(packageRoot);
  await smokeInstalledSessionDaemon(packageRoot, host, "global");

  // Match Pi's npm install policy without using its live settings or package store.
  const managedRoot = join(root, "managed");
  await mkdir(managedRoot);
  await writeFile(join(managedRoot, "package.json"), '{"name":"pi-extensions","private":true,"allowScripts":{"node-pty":true}}\n');
  await runNpm(npm12ExecPath, [
    "install", tarballPath, "--prefix", managedRoot, "--legacy-peer-deps",
    "--no-audit", "--no-fund",
  ], managedRoot);
  const managedPackageRoot = join(managedRoot, "node_modules", "@jmfederico", "pi-web");
  await assertHostPeersOnly(managedPackageRoot);
  await smokeInstalledPiSdk(managedPackageRoot, host);
  await smokeInstalledTypebox(managedPackageRoot, host);
  await smokePiPackageExtension(managedPackageRoot, host);
  await smokeInstalledSessionDaemon(managedPackageRoot, host, "managed-legacy", {
    entrypoint: join(managedPackageRoot, "dist", "server", "sessiond.js"), discoverOnPath: true,
  });
  // Ordinary npm peers win over PATH, while an explicit host still wins over peers.
  const localRoot = join(root, "local-peers");
  await mkdir(localRoot);
  await writeFile(join(localRoot, "package.json"), '{"private":true,"allowScripts":{"node-pty":true}}\n');
  await runNpm(npm12ExecPath, [
    "install", `@earendil-works/pi-coding-agent@${hosts[1].version}`,
    "--no-audit", "--no-fund",
  ], localRoot);
  await runNpm(npm12ExecPath, [
    "install", tarballPath, "--no-audit", "--no-fund",
  ], localRoot);
  const localPackageRoot = join(localRoot, "node_modules", "@jmfederico", "pi-web");
  const localHost = {
    hostRoot: join(localRoot, "node_modules", "@earendil-works", "pi-coding-agent"),
    prefix: localRoot, version: hosts[1].version,
  };
  await assertHostPeersOnly(localPackageRoot, { localPeers: true });
  await smokeInstalledPiSdk(localPackageRoot, localHost, { localPeers: true, pathHost: host });
  await smokeInstalledPiSdk(localPackageRoot, host, { explicitOnly: true });
  await smokeInstalledSessionDaemon(localPackageRoot, localHost, "local-peers", {
    localPeers: true, pathHost: host,
  });
  await smokeInstalledSessionDaemon(packageRoot, hosts[1], "development-source", {
    entrypoint: join(repoRoot, "src", "server", "sessiond.ts"),
    nodeOptions: ["--import", import.meta.resolve("tsx")],
  });
  // Replace the same host installation only after all 1.3 checks have finished.
  // Fresh processes must see the replacement, not the earlier process's SDK cache.
  await runNpm(npm12ExecPath, [
    "install", "--global", `@earendil-works/pi-coding-agent@${hosts[1].version}`,
    "--prefix", host.prefix, "--no-audit", "--no-fund",
  ], root);
  const updatedHost = { ...host, version: hosts[1].version };
  await smokeInstalledPiSdk(packageRoot, updatedHost);
  await smokeInstalledSessionDaemon(packageRoot, updatedHost, "host-updated");
  await smokeInstalledSessionDaemon(packageRoot, updatedHost, "host-updated-path", { discoverOnPath: true });
  console.log(`Installed-package host-selected Pi SDKs, local npm peers, in-place host update/restart, CLI/session daemon (global/managed), server TypeBox, extension command, plugin API, and PTY smoke tests passed with npm ${NPM_VERSION}.`);
} finally {
  for (const name of Object.keys(process.env)) delete process.env[name];
  Object.assign(process.env, originalEnv);
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

async function assertHostPeersOnly(packageRoot, { localPeers = false } = {}) {
  const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  for (const name of ["pi-agent-core", "pi-ai", "pi-coding-agent", "pi-tui"]) {
    const specifier = `@earendil-works/${name}`;
    if (name !== "pi-tui") {
      assert.equal(manifest.peerDependencies?.[specifier], "*", `${specifier} must accept the host version`);
      assert.equal(manifest.peerDependenciesMeta?.[specifier]?.optional, true);
    }
    assert.equal(manifest.dependencies?.[specifier], undefined, `${specifier} must not be a runtime dependency`);
    if (!localPeers) {
      assert.throws(() => createRequire(join(packageRoot, "package.json")).resolve(specifier),
        { code: "MODULE_NOT_FOUND" }, `Fixture must not install its own ${specifier}`);
    }
  }
}

function runtimeImportSource(packageRoot) {
  return `import { loadPiSdk, loadPiAi, resolvePiRuntimeImport, piRuntimeCliPath } from ${JSON.stringify(pathToFileURL(join(packageRoot, "dist", "piRuntime.js")).href)};`;
}

async function runFixture(runtimePath, packageRoot, host, extraEnv = {}) {
  return execFileAsync(process.execPath, [runtimePath], {
    cwd: packageRoot, encoding: "utf8", timeout: 60_000,
    env: { ...process.env, PI_WEB_PI_PACKAGE_DIR: host.hostRoot, ...extraEnv },
  });
}

async function smokeInstalledPiSdk(packageRoot, host, options = {}) {
  const runtimePath = join(packageRoot, "pi-sdk-smoke.mjs");
  await writeFile(runtimePath, `
    import assert from "node:assert/strict";
    ${runtimeImportSource(packageRoot)}
    const sdk = await loadPiSdk();
    assert.equal(sdk.VERSION, ${JSON.stringify(host.version)});
    assert.equal(sdk.getPackageDir(), ${JSON.stringify(host.hostRoot)});
    assert.strictEqual(sdk, await import(await resolvePiRuntimeImport("@earendil-works/pi-coding-agent")));
    assert.strictEqual(await loadPiAi(), await import(await resolvePiRuntimeImport("@earendil-works/pi-ai")));
    const sharedSdk = await import("./dist/piSdk.js");
    assert.strictEqual(sharedSdk.SessionManager, sdk.SessionManager);
    await Promise.all(["pi-agent-core", "pi-tui"].map(async name => import(await resolvePiRuntimeImport("@earendil-works/" + name))));
    const { readFile } = await import("node:fs/promises");
    const { resolve } = await import("node:path");
    const hostManifest = JSON.parse(await readFile(${JSON.stringify(join(host.hostRoot, "package.json"))}, "utf8"));
    assert.equal(await piRuntimeCliPath(), resolve(${JSON.stringify(host.hostRoot)}, typeof hostManifest.bin === "string" ? hostManifest.bin : hostManifest.bin.pi));
    const { getPiWebRuntimeComponent } = await import("./dist/server/piWebStatus.js");
    for (const component of ["web", "sessiond"]) {
      assert.equal(getPiWebRuntimeComponent(component).piVersion, sdk.VERSION);
    }
    const { getBuiltinExtensionFactories } = await import("./dist/server/sessions/builtinExtensionFactories.js");
    assert.equal((await getBuiltinExtensionFactories()).length, 3);
  `);
  const selectionEnv = options.localPeers ? {
    PI_WEB_PI_PACKAGE_DIR: undefined, PATH: join(options.pathHost.prefix, "bin"),
  } : {};
  await runFixture(runtimePath, packageRoot, host, selectionEnv);
  const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  // Explicit interpreter tests use the JS entry; launcher policy has its own
  // installed-package smoke so these restricted-PATH SDK fixtures stay focused.
  const cliPath = join(packageRoot, "dist", "cli.js");
  for (const args of [["--version"], ["--help"]]) {
    const { stdout } = await execFileAsync(process.execPath, [cliPath, ...args], {
      cwd: root, env: { ...process.env, PI_WEB_PI_PACKAGE_DIR: host.hostRoot, ...selectionEnv },
      encoding: "utf8", timeout: 30_000,
    });
    assert.ok(stdout.includes(args[0] === "--version" ? manifest.version : "pi-web"));
  }
  if (!options.localPeers && !options.explicitOnly) {
    // No override or local peers: discover the existing npm Pi on PATH.
    await runFixture(runtimePath, packageRoot, host, {
      PI_WEB_PI_PACKAGE_DIR: undefined, PATH: join(host.prefix, "bin"),
    });
  }
}

async function smokeInstalledTypebox(packageRoot, host) {
  const runtimePath = join(packageRoot, "server-typebox-smoke.mjs");
  await writeFile(runtimePath, [
    'import assert from "node:assert/strict";',
    runtimeImportSource(packageRoot),
    'const { Type } = await import("pi-web-typebox");',
    'const { Check } = await import("pi-web-typebox/value");',
    'const schema = Type.Object({ value: Type.String() });',
    'assert.equal(Check(schema, { value: "standalone" }), true);',
    'assert.equal(Check(schema, { value: 42 }), false);',
    ...["spawnSessionTool", "spawnSubsessionTool", "askUserTool"]
      .map((name) => `await import("./dist/server/sessions/${name}.js");`),
  ].join("\n"));
  await runFixture(runtimePath, packageRoot, host);
}

async function smokePiPackageExtension(packageRoot, host) {
  const agentDir = await mkdtemp(join(root, "extension-"));
  const runtimePath = join(packageRoot, "extension-smoke.mjs");
  await writeFile(runtimePath, `
    import assert from "node:assert/strict";
    ${runtimeImportSource(packageRoot)}
    const { DefaultResourceLoader, SettingsManager } = await loadPiSdk();
    const loader = new DefaultResourceLoader({
      cwd: ${JSON.stringify(agentDir)}, agentDir: ${JSON.stringify(agentDir)},
      settingsManager: SettingsManager.inMemory({ packages: [${JSON.stringify(packageRoot)}] }),
      noSkills: true, noPromptTemplates: true, noThemes: true,
    });
    await loader.reload();
    const result = loader.getExtensions();
    assert.deepEqual(result.errors, [], "PI WEB extension must load through Pi");
    assert.deepEqual(result.warnings ?? [], [], "No host dependency warnings");
    const command = result.extensions.find(extension => extension.commands.has("pi-web"))?.commands.get("pi-web");
    assert.ok(command, "Pi must register /pi-web");
    const notifications = [];
    await command.handler("version", { ui: { notify: (message, type) => notifications.push({ message, type }) } });
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].type, "info", notifications[0].message);
    assert.ok(notifications[0].message.includes("PI WEB version"), notifications[0].message);
  `);
  // No systemctl/launchctl on PATH, no live D-Bus, socket or HTTP endpoint.
  // Invalid port makes version reporting explain unavailable config, not probe localhost.
  await runFixture(runtimePath, packageRoot, host, {
    PATH: join(host.prefix, "bin"), DBUS_SESSION_BUS_ADDRESS: "unix:path=" + join(root, "no-bus"),
    PI_WEB_PORT: "not-a-port",
  });
}

async function smokeInstalledSessionDaemon(packageRoot, host, layout, options = {}) {
  const stateDir = join(root, `daemon-${layout}`);
  const socketPath = join(stateDir, "sessiond.sock");
  const entrypoint = options.entrypoint ?? join(packageRoot, "dist", "server", "sessiond.js");
  const child = spawn(process.execPath, [...(options.nodeOptions ?? []), entrypoint], {
    cwd: packageRoot,
    env: {
      ...process.env,
      PI_WEB_PI_PACKAGE_DIR: options.discoverOnPath || options.localPeers ? undefined : host.hostRoot,
      PATH: options.localPeers ? join(options.pathHost.prefix, "bin")
        : options.discoverOnPath ? join(host.prefix, "bin") : process.env["PATH"],
      PI_WEB_DATA_DIR: stateDir, PI_WEB_SESSIOND_SOCKET: socketPath,
      PI_CODING_AGENT_DIR: join(stateDir, "agent"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (chunk) => { output = (output + chunk.toString()).slice(-16_000); });
  }
  let exited = false;
  let exitCode;
  let startupError;
  const closed = new Promise((resolve) => {
    child.once("error", (error) => { startupError = error; exited = true; resolve(); });
    child.once("close", (code) => { exitCode = code; exited = true; resolve(); });
  });
  try {
    const deadline = Date.now() + 15_000;
    let runtime;
    while (Date.now() < deadline) {
      if (exited) throw new Error(`Installed ${layout} daemon exited before readiness: ${startupError ?? output}`);
      try {
        runtime = await new Promise((resolve, reject) => {
          const req = request({ socketPath, path: "/runtime" }, (response) => {
            let body = "";
            response.setEncoding("utf8");
            response.on("data", (chunk) => { body += chunk; });
            response.on("end", () => resolve({ status: response.statusCode, body }));
            response.on("error", reject);
          });
          req.on("error", reject);
          req.setTimeout(1_000, () => req.destroy(new Error("Daemon runtime request timed out")));
          req.end();
        });
        break;
      } catch (error) {
        if (error.code !== "ENOENT" && error.code !== "ECONNREFUSED") throw error;
        await delay(50);
      }
    }
    assert.ok(runtime, `Installed ${layout} daemon never became ready: ${output}`);
    assert.equal(runtime.status, 200, runtime.body);
    assert.equal(JSON.parse(runtime.body).piVersion, host.version);
  } finally {
    if (!exited) child.kill("SIGTERM");
    await Promise.race([closed, delay(5_000)]);
    if (!exited) {
      child.kill("SIGKILL");
      await closed;
    }
  }
  assert.equal(exitCode, 0, `Installed ${layout} daemon did not shut down cleanly: ${output}`);
}

async function smokeInstalledTerminalService(packageRoot) {
  const { checkTerminalPrerequisites } = await import(pathToFileURL(join(packageRoot, "dist", "server", "diagnostics", "terminalPrerequisites.js")).href);
  const readiness = await checkTerminalPrerequisites();
  assert.ok(readiness.ok, readiness.lines.join("\n"));
  const requireFromPackage = createRequire(join(packageRoot, "package.json"));
  const nodePtyPackageJsonPath = requireFromPackage.resolve("node-pty/package.json");
  const nodePtyPackage = JSON.parse(await readFile(nodePtyPackageJsonPath, "utf8"));
  if (typeof nodePtyPackage.version !== "string" || nodePtyPackage.version.includes("-")) {
    throw new Error(`Installed package resolved a non-stable node-pty version: ${String(nodePtyPackage.version)}`);
  }

  const terminalModuleUrl = pathToFileURL(join(packageRoot, "dist", "pi-web-plugins", "terminal", "terminalService.js")).href;
  const { TerminalService } = await import(terminalModuleUrl);
  const { createDefaultPtyProvider } = await import(new URL("./ptyComposition.js", terminalModuleUrl).href);
  const previousShell = process.env["SHELL"];
  process.env["SHELL"] = "/bin/sh";
  const service = new TerminalService(createDefaultPtyProvider());
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
