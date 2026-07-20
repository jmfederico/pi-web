import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

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
    writeFile(join(npmToolDir, "package.json"), '{"private":true}\n'),
  ]);

  const packOutput = await runNpm(npmExecPath, ["pack", "--ignore-scripts", "--json", "--pack-destination", packDir], repoRoot);
  const tarballPath = join(packDir, packageTarballFilename(packOutput));

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
  await smokeInstalledTerminalService(packageRoot);
  console.log(`Installed-package PTY smoke test passed with npm ${NPM_VERSION}.`);
} finally {
  await rm(root, { recursive: true, force: true });
}

async function runNpm(npmCliPath, args, cwd) {
  const result = await execFileAsync(process.execPath, [npmCliPath, ...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    timeout: 180_000,
  });
  return result.stdout;
}

function packageTarballFilename(output) {
  const parsed = JSON.parse(output);
  if (!Array.isArray(parsed) || parsed.length !== 1 || typeof parsed[0]?.filename !== "string") {
    throw new Error("npm pack returned an unexpected result");
  }
  return parsed[0].filename;
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
