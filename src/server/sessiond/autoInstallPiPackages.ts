/**
 * Bundled Pi packages are distributed with PI WEB. Their known package
 * identities are managed: configured copies follow the running installation,
 * while users retain control of resource filters and whether to install them.
 * Missing packages are installed unless dismissed through Settings.
 * Reconciliation is local and best-effort; failures are logged per package.
 */
import { stat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import {
  defaultPiWebPackageRoot,
  KNOWN_AUTO_INSTALLABLE_PI_PACKAGES,
  resolveShippedPiPackagePath,
  type KnownAutoInstallablePiPackage,
} from "../knownAutoInstallPiPackages.js";
import { resolveDeclaredPiPackageName } from "../piPackageIdentity.js";
import { PiPackageDismissalStore } from "../storage/piPackageDismissalStore.js";
import type { ConfiguredPiPackage, PiPackageProvider } from "../piWebPluginCatalog.js";

export interface PiPackageAutoInstallLogger {
  warn(details: Record<string, unknown>, message: string): void;
  info?(details: Record<string, unknown>, message: string): void;
}

/** Registers already-shipped local packages in the active agent profile. */
export interface PiPackageAutoInstaller {
  install(source: string): Promise<unknown>;
  /** Replace matching profile entries in place, retaining resource filters. */
  replaceSources(configured: readonly ConfiguredPiPackage[], source: string): Promise<void>;
}

/** Narrow seam for checking whether a profile dismissed (removed on purpose) a known auto-installable package. */
export interface PiPackageAutoInstallDismissalChecker {
  isDismissed(profileDir: string, packageId: string): Promise<boolean>;
}

/** Narrow seam for resolving an installed Pi package's declared identity from its installed path. */
export interface PiPackageAutoInstallIdentityResolver {
  resolveDeclaredName(installedPath: string): Promise<string | undefined>;
}

export interface ReconcileAutoInstallablePiPackagesOptions {
  /** Active agent profile directory reconciliation applies to. */
  profileDir: string;
  /** Lists/resolves packages already configured for the active agent profile. */
  packageProvider: PiPackageProvider;
  /** Registers shipped sources in profile settings without installing dependencies. */
  installer: PiPackageAutoInstaller;
  dismissalChecker?: PiPackageAutoInstallDismissalChecker;
  identityResolver?: PiPackageAutoInstallIdentityResolver;
  /** Running `@jmfederico/pi-web` package root; shipped package paths resolve relative to this. Defaults to this module's own package root. */
  packageRoot?: string;
  /** Known auto-installable packages to reconcile. Defaults to the production registry; overridable for tests. */
  knownPackages?: readonly KnownAutoInstallablePiPackage[];
  logger?: PiPackageAutoInstallLogger;
}

const defaultIdentityResolver: PiPackageAutoInstallIdentityResolver = {
  resolveDeclaredName: resolveDeclaredPiPackageName,
};

/**
 * Reconciles the active agent profile's configured Pi packages against the
 * known auto-installable registry, replacing stale managed sources and
 * installing absent packages unless dismissed. Never throws: every failure is
 * caught and logged so one broken package (or a broken check) never prevents
 * reconciling the rest, and never aborts session daemon startup.
 */
export async function reconcileAutoInstallablePiPackages(options: ReconcileAutoInstallablePiPackagesOptions): Promise<void> {
  const {
    profileDir,
    packageProvider,
    installer,
    dismissalChecker = new PiPackageDismissalStore(),
    identityResolver = defaultIdentityResolver,
    packageRoot = defaultPiWebPackageRoot(),
    knownPackages = KNOWN_AUTO_INSTALLABLE_PI_PACKAGES,
    logger,
  } = options;

  for (const knownPackage of knownPackages) {
    try {
      const source = resolveShippedPiPackagePath(knownPackage, packageRoot);
      const configured = await findConfiguredCopies(knownPackage, packageProvider, identityResolver, profileDir);
      if (configured.length > 0) {
        const currentPath = await canonicalPath(source);
        const paths = await Promise.all(configured.map((entry) => canonicalPath(entry.installedPath)));
        if (paths.some((path) => path !== currentPath)) {
          await installer.replaceSources(configured, source);
          logger?.info?.({ packageId: knownPackage.id, profileDir, source, previousSources: configured.map(({ source, scope }) => ({ source, scope })) }, "reconciled managed Pi package sources to the current shipped copy");
        }
        continue;
      }
      if (await dismissalChecker.isDismissed(profileDir, knownPackage.id)) continue;
      await installer.install(source);
      logger?.info?.({ packageId: knownPackage.id, profileDir, source }, "auto-installed known Pi package for the active agent profile");
    } catch (error) {
      logger?.warn(
        { err: error, packageId: knownPackage.id, profileDir },
        "best-effort auto-install reconciliation failed for a known Pi package; continuing without it",
      );
    }
  }
}

async function findConfiguredCopies(
  known: KnownAutoInstallablePiPackage,
  packageProvider: PiPackageProvider,
  identityResolver: PiPackageAutoInstallIdentityResolver,
  profileDir: string,
): Promise<(ConfiguredPiPackage & { installedPath: string })[]> {
  const copies: (ConfiguredPiPackage & { installedPath: string })[] = [];
  for (const configured of packageProvider.listPackages()) {
    if (configured.scope !== "user") continue;
    // Pi omits installedPath for missing local directories; recover only a local
    // source here so deleted installations can still be recognized below.
    const installedPath = configured.installedPath
      ?? packageProvider.getInstalledPath(configured.source, configured.scope)
      ?? localSourcePath(configured.source, profileDir);
    if (installedPath === undefined) continue;
    const declaredName = await identityResolver.resolveDeclaredName(installedPath);
    if (declaredName === known.id || (declaredName === undefined && await isMissingShippedCopy(installedPath, known, identityResolver))) {
      copies.push({ ...configured, installedPath });
    }
  }
  return copies;
}

function localSourcePath(source: string, baseDir: string): string | undefined {
  if (isAbsolute(source)) return resolve(source);
  if (source.startsWith("~/")) return resolve(homedir(), source.slice(2));
  if (source.includes(":")) return undefined;
  return resolve(baseDir, source);
}

/** Missing manifests cannot identify arbitrary paths. Only recover recognizable shipped locations. */
async function isMissingShippedCopy(
  installedPath: string,
  known: KnownAutoInstallablePiPackage,
  identityResolver: PiPackageAutoInstallIdentityResolver,
): Promise<boolean> {
  const path = resolve(installedPath);
  const suffix = `${sep}${join(...known.shippedPathSegments)}`;
  if (!path.endsWith(suffix)) return false;
  try {
    await stat(path);
    return false;
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
  }
  const root = path.slice(0, -suffix.length);
  // An entire old global installation may have been removed during a Node upgrade.
  if (root.endsWith(`${sep}${join("node_modules", "@jmfederico", "pi-web")}`)) return true;
  // A checkout can still identify its owner when only dist/ has been deleted.
  return await identityResolver.resolveDeclaredName(root || sep) === "@jmfederico/pi-web";
}

async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    return resolve(path);
  }
}
