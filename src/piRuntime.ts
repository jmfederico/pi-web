import { constants } from "node:fs";
import { access, readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { delimiter, dirname, join, resolve } from "node:path";
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

/** Prefer an explicit Pi host, then ordinary npm resolution, then the Pi command. */
export async function selectPiRuntimePackageDir(options: PiRuntimeSelectionOptions = {}): Promise<string> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const explicit = env[PI_WEB_PI_PACKAGE_DIR_ENV];
  if (explicit !== undefined) {
    try {
      if (explicit.trim() === "") throw new Error("The package directory is empty.");
      // Preserve a supplied symlink: a package manager may retarget it on upgrade.
      const directory = resolve(explicit);
      if (!await isSdkPackage(directory)) throw new Error(`Expected a package.json named ${SDK_PACKAGE}.`);
      return directory;
    } catch (cause) {
      throw new Error(`Invalid ${PI_WEB_PI_PACKAGE_DIR_ENV}=${JSON.stringify(explicit)}. Point it to the hosting Pi npm SDK package root, not a standalone binary.`, { cause });
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
    const sdk = await findSdkAncestor(await realpath(executable));
    if (sdk !== undefined) return sdk;
    if (platform === "win32") {
      // npm's Windows command shim is a regular file beside node_modules, not
      // a symlink into the SDK. Use the shim's ordinary Node search paths.
      const requireFromShim = createRequire(await realpath(executable));
      for (const moduleDirectory of requireFromShim.resolve.paths(SDK_PACKAGE) ?? []) {
        const candidate = join(moduleDirectory, SDK_PACKAGE);
        if (await isSdkPackage(candidate)) return candidate;
      }
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
