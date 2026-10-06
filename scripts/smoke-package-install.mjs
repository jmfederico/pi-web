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
