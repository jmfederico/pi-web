import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Pi packages PI WEB may install automatically for users out of the box (see
 * the `relay-pi-package-autoinstall` relay). Identity is the package's own
 * declared `name` (its `package.json` "name" field), not the install-source
 * string used to configure it: a locally shipped package is configured by
 * filesystem path today, which is not a stable identity to match against.
 */
export interface KnownAutoInstallablePiPackage {
  /** The package's own declared `name`, matched via {@link resolveDeclaredPiPackageName}. */
  id: string;
  /** Short human-friendly name for Settings UI affordances (e.g. one-click reinstall). */
  label: string;
  /** Short human-friendly description for Settings UI affordances. */
  description: string;
  /**
   * Path segments, relative to the running `@jmfederico/pi-web` package root
   * (see `defaultPluginRoots`/`bundledPluginRoot` in `piWebPluginCatalog.ts`
   * for the equivalent resolution), to this package's shipped local
   * directory. Used as the install source when auto-installing it.
   */
  shippedPathSegments: readonly string[];
}

export const KNOWN_AUTO_INSTALLABLE_PI_PACKAGES: readonly KnownAutoInstallablePiPackage[] = [
  {
    id: "@jmfederico/pi-relay",
    label: "Relays",
    description: "Generic Relay method: /relay and /relay-worktree prompts and a relay skill for chaining independent pi sessions.",
    shippedPathSegments: ["dist", "pi-packages", "relays"],
  },
];

export const KNOWN_AUTO_INSTALLABLE_PI_PACKAGE_IDS: readonly string[] = KNOWN_AUTO_INSTALLABLE_PI_PACKAGES.map((known) => known.id);

export function isKnownAutoInstallablePiPackageId(id: string): boolean {
  return KNOWN_AUTO_INSTALLABLE_PI_PACKAGE_IDS.includes(id);
}

/**
 * Running `@jmfederico/pi-web` package root; {@link resolveShippedPiPackagePath}
 * resolves shipped package paths relative to this by default. Resolution is
 * anchored to this module's own on-disk location (`src/server/`, one level
 * under the package root) rather than the caller's, so every caller gets the
 * same package root regardless of how deeply nested the caller module is.
 */
export function defaultPiWebPackageRoot(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  return join(moduleDir, "..", "..");
}

/** Resolves a known auto-installable package's shipped local install source path. */
export function resolveShippedPiPackagePath(known: KnownAutoInstallablePiPackage, packageRoot = defaultPiWebPackageRoot()): string {
  return join(packageRoot, ...known.shippedPathSegments);
}
