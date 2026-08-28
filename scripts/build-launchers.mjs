#!/usr/bin/env node
// Generates the POSIX runtime launchers that package.json `bin` entries point at
// (SPEC D1). npm and bun install bins as symlinks to these files, so the runtime is
// chosen by scripts/pi-web-launcher.sh at start instead of by a shebang.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const templatePath = join(repoRoot, "scripts", "pi-web-launcher.sh");
const launcherMode = 0o755;

/** bin name -> entrypoint path relative to dist/bin/. */
export const launcherTargets = {
  "pi-web": "../cli.js",
  "pi-web-server": "../server/index.js",
  "pi-web-sessiond": "../server/sessiond.js",
};

if (isDirectExecution()) {
  const outDir = process.argv[2] === undefined ? join(repoRoot, "dist", "bin") : resolve(process.argv[2]);
  const written = await buildLaunchers({ outDir, minimumNodeVersion: await minimumSupportedNodeVersion() });
  console.log(`[launchers] built ${String(written.length)} runtime launchers into ${relative(repoRoot, outDir)}`);
}

/** Reads the Node floor from package.json engines so the launcher cannot drift from it. */
export async function minimumSupportedNodeVersion() {
  const manifest = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));
  const range = String(manifest["engines"]?.["node"] ?? "");
  const version = range.match(/\d+\.\d+\.\d+/u)?.[0];
  if (version === undefined) throw new Error("package.json engines.node must state an exact minimum version");
  return version;
}

export async function renderLauncher(target, minimumNodeVersion) {
  const template = await readFile(templatePath, "utf8");
  return template.replaceAll("__TARGET__", target).replaceAll("__MIN_NODE_VERSION__", minimumNodeVersion);
}

export async function buildLaunchers({ outDir, minimumNodeVersion }) {
  await mkdir(outDir, { recursive: true });
  const written = [];
  for (const [name, target] of Object.entries(launcherTargets)) {
    const path = join(outDir, `${name}.sh`);
    await writeFile(path, await renderLauncher(target, minimumNodeVersion), { encoding: "utf8", mode: launcherMode });
    written.push(path);
  }
  return written;
}

function isDirectExecution() {
  const entryPath = process.argv[1];
  if (entryPath === undefined) return false;
  return pathToFileURL(resolve(entryPath)).href === import.meta.url;
}
