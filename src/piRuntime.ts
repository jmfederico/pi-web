import { constants, statSync } from "node:fs";
import { access, readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve as resolveImport } from "import-meta-resolve";

export const PI_WEB_PI_PACKAGE_DIR_ENV = "PI_WEB_PI_PACKAGE_DIR";
const SDK_PACKAGE = "@earendil-works/pi-coding-agent";

export interface PiRuntimeSelectionOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  resolveLocalSdk?: () => string;
}

async function isSdkPackage(directory: string): Promise<boolean> {
  try {
    const manifest: unknown = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
    return typeof manifest === "object" && manifest !== null
      && "name" in manifest && manifest.name === SDK_PACKAGE;
  } catch (error) {
    if (error instanceof SyntaxError || (error instanceof Error && "code" in error
      && (error.code === "ENOENT" || error.code === "ENOTDIR"))) return false;
    throw error;
  }
}

async function findSdkAncestor(file: string): Promise<string | undefined> {
  let directory = dirname(file);
  for (;;) {
    if (await isSdkPackage(directory)) return directory;
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

/**
 * Pi's managed installer keeps each release under
 * `<install root>/releases/<version>/node_modules/<SDK>` and names the active
 * one in `<install root>/current-version`; its `pi` launcher reads the same
 * file on every run. PI WEB follows that file the same way, with only the
 * checks needed to build a safe path from it.
 */
const MANAGED_CURRENT_VERSION = "current-version";

function managedReleaseSdkDir(installRoot: string, version: string): string {
  return join(installRoot, "releases", version, "node_modules", SDK_PACKAGE);
}

/** The managed install root owning a release SDK path, judged by path shape only. */
function managedInstallRootFromPath(packageDir: string): string | undefined {
  const sdk = resolve(packageDir);
  const sdkSegments = SDK_PACKAGE.split("/");
  let directory = sdk;
  for (const segment of [...sdkSegments].reverse()) {
    if (basename(directory) !== segment) return undefined;
    directory = dirname(directory);
  }
  if (basename(directory) !== "node_modules") return undefined;
  const releaseDir = dirname(directory);
  const releasesDir = dirname(releaseDir);
  if (basename(releasesDir) !== "releases") return undefined;
  const installRoot = dirname(releasesDir);
  return managedReleaseSdkDir(installRoot, basename(releaseDir)) === sdk ? installRoot : undefined;
}

/**
 * Resolve the SDK named by a managed install's `current-version`. Returns
 * undefined when the directory has no `current-version` file, so callers can
 * treat it as not being a managed install. A present but unusable file is an
 * error that names the file and the expected SDK path.
 */
async function managedInstallSdk(installRoot: string): Promise<string | undefined> {
  const versionFile = join(installRoot, MANAGED_CURRENT_VERSION);
  let version: string;
  try {
    version = (await readFile(versionFile, "utf8")).trim();
  } catch (error) {
    if (error instanceof Error && "code" in error
      && (error.code === "ENOENT" || error.code === "ENOTDIR")) return undefined;
    throw error;
  }
  // The version becomes one path segment; reject anything that could leave releases/.
  if (version === "" || version === "." || version === ".." || /[/\\\0]/u.test(version)) {
    throw new Error(`Managed Pi version file ${versionFile} contains ${JSON.stringify(version)}, which is not a release directory name.`);
  }
  const candidate = managedReleaseSdkDir(installRoot, version);
  if (!await isSdkPackage(candidate)) {
    throw new Error(`Managed Pi version file ${versionFile} selects ${JSON.stringify(version)}, but ${candidate} has no package.json named ${SDK_PACKAGE}.`);
  }
  return candidate;
}

/**
 * The value native services should keep for a selected Pi package directory.
 * A managed Pi release path is replaced by its install root, so each service
 * start follows `current-version` instead of a release that `pi update` may
 * delete. Any other value is kept unchanged.
 */
export function stablePiPackageSelection(packageDir: string): string {
  const installRoot = managedInstallRootFromPath(packageDir);
  if (installRoot === undefined) return packageDir;
  try {
    statSync(join(installRoot, MANAGED_CURRENT_VERSION));
    return installRoot;
  } catch (error) {
    if (error instanceof Error && "code" in error
      && (error.code === "ENOENT" || error.code === "ENOTDIR")) return packageDir;
    throw error;
  }
}

async function explicitPiPackageDir(explicit: string): Promise<string> {
  if (explicit.trim() === "") throw new Error("The value is empty.");
  // Preserve a supplied symlink: a package manager may retarget it on upgrade.
  const directory = resolve(explicit);
  if (await isSdkPackage(directory)) return directory;
  const managed = await managedInstallSdk(directory);
  if (managed !== undefined) return managed;
  const installRoot = managedInstallRootFromPath(directory);
  if (installRoot !== undefined) {
    throw new Error(`Managed Pi release ${JSON.stringify(basename(dirname(dirname(dirname(directory)))))} is missing; \`pi update\` removes old releases. Re-run \`/pi-web install\` from Pi, or use the managed install root ${installRoot}.`);
  }
  throw new Error(`Expected a Pi npm SDK package root (package.json named ${SDK_PACKAGE}) or a managed Pi install root (containing ${MANAGED_CURRENT_VERSION}), not a standalone binary.`);
}

/** Prefer an explicit Pi host, then ordinary npm resolution, then the Pi command. */
export async function selectPiRuntimePackageDir(options: PiRuntimeSelectionOptions = {}): Promise<string> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const explicit = env[PI_WEB_PI_PACKAGE_DIR_ENV];
  if (explicit !== undefined) {
    try {
      return await explicitPiPackageDir(explicit);
    } catch (cause) {
      // Keep the specific reason, including unexpected filesystem errors, in the message.
      const reason = cause instanceof Error ? cause.message : String(cause);
      throw new Error(`Invalid ${PI_WEB_PI_PACKAGE_DIR_ENV}=${JSON.stringify(explicit)}: ${reason}`, { cause });
    }
  }

  let localEntry: string | undefined;
  try {
    localEntry = (options.resolveLocalSdk ?? (() => import.meta.resolve(SDK_PACKAGE)))();
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ERR_MODULE_NOT_FOUND")) throw error;
  }
  if (localEntry !== undefined) {
    const sdk = await findSdkAncestor(fileURLToPath(localEntry));
    if (sdk !== undefined) return sdk;
    throw new Error(`The resolved Pi SDK at ${localEntry} has no ${SDK_PACKAGE} package root.`);
  }

  for (const directory of (env["PATH"] ?? "").split(delimiter)) {
    const executable = join(directory, platform === "win32" ? "pi.cmd" : "pi");
    try {
      await access(executable, constants.X_OK);
    } catch (error) {
      if (error instanceof Error && "code" in error
        && (error.code === "ENOENT" || error.code === "ENOTDIR" || error.code === "EACCES")) continue;
      throw error;
    }
    const resolved = await realpath(executable);
    const sdk = await findSdkAncestor(resolved);
    if (sdk !== undefined) return sdk;
    if (platform === "win32") {
      // npm's Windows command shim is a regular file beside node_modules, not
      // a symlink into the SDK. Use the shim's ordinary Node search paths.
      const requireFromShim = createRequire(resolved);
      for (const moduleDirectory of requireFromShim.resolve.paths(SDK_PACKAGE) ?? []) {
        const candidate = join(moduleDirectory, SDK_PACKAGE);
        if (await isSdkPackage(candidate)) return candidate;
      }
    } else {
      // The managed installer's `pi` is a shell script at `<agent dir>/bin/pi`
      // that runs the release named by `<agent dir>/install/current-version`.
      const managed = await managedInstallSdk(join(dirname(dirname(resolved)), "install"));
      if (managed !== undefined) return managed;
    }
    throw new Error(`The pi command at ${JSON.stringify(executable)} does not expose a Pi npm SDK package. Run /pi-web from Pi or set ${PI_WEB_PI_PACKAGE_DIR_ENV} to that installation's SDK package root. PI WEB will not select a different Pi from later on PATH.`);
  }
  throw new Error(`Cannot locate the Pi npm SDK. Run PI WEB from the hosting Pi installation or set ${PI_WEB_PI_PACKAGE_DIR_ENV} to its ${SDK_PACKAGE} package root. Standalone Pi binaries without an SDK package are not supported.`);
}

let packageDirPromise: Promise<string> | undefined;
let sdkPromise: Promise<typeof import("@earendil-works/pi-coding-agent")> | undefined;
let aiPromise: Promise<typeof import("@earendil-works/pi-ai")> | undefined;

function selectedPackageDir(): Promise<string> {
  // One identity per process. Children and installed services inherit the choice.
  return packageDirPromise ??= selectPiRuntimePackageDir().then((directory) => {
    process.env[PI_WEB_PI_PACKAGE_DIR_ENV] = directory;
    return directory;
  });
}

export async function resolvePiRuntimeImport(specifier: string): Promise<string> {
  const directory = await selectedPackageDir();
  return resolveImport(specifier, pathToFileURL(join(directory, "package.json")).href);
}

export function loadPiSdk(): Promise<typeof import("@earendil-works/pi-coding-agent")> {
  return sdkPromise ??= resolvePiRuntimeImport(SDK_PACKAGE).then(async (entry) => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- The selected package supplies the public SDK interface used for development types.
    const sdk: typeof import("@earendil-works/pi-coding-agent") = await import(entry);
    return sdk;
  });
}

export function loadPiAi(): Promise<typeof import("@earendil-works/pi-ai")> {
  return aiPromise ??= resolvePiRuntimeImport("@earendil-works/pi-ai").then(async (entry) => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Resolve the AI package from the selected SDK, keeping its runtime identity.
    const ai: typeof import("@earendil-works/pi-ai") = await import(entry);
    return ai;
  });
}

/** The package's declared executable, not a private SDK file layout. */
export async function piRuntimeCliPath(): Promise<string> {
  const directory = await selectedPackageDir();
  const manifest: unknown = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
  if (typeof manifest === "object" && manifest !== null && "bin" in manifest) {
    const bin = manifest.bin;
    const entry = typeof bin === "string" ? bin
      : typeof bin === "object" && bin !== null && "pi" in bin ? bin.pi : undefined;
    if (typeof entry === "string") return resolve(directory, entry);
  }
  throw new Error(`The selected Pi package at ${directory} does not declare a pi executable.`);
}
