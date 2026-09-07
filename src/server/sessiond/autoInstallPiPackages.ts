/**
 * Sessiond-startup auto-install reconciliation for Pi packages PI WEB ships
 * "out of the box" (see the `relay-pi-package-autoinstall` relay).
 *
 * Some Pi-package plugins (currently just `@jmfederico/pi-relay`, the Relays
 * plugin) are shipped inside PI WEB's own npm tarball but must be installed
 * as a real Pi package for pi's own package resolution to pick them up,
 * rather than being bundled-discovered by directory scan. To keep today's
 * zero-extra-steps experience, sessiond reconciles this at startup for the
 * active agent profile: if the profile does not already have a package
 * declaring one of these known names configured, and the profile has not
 * dismissed it (removed it on purpose through the Settings UI — tracked by
 * {@link PiPackageDismissalStore}), sessiond installs it from its shipped
 * local path using the same install mechanism the manual Settings UI Install
 * action already uses.
 *
 * This is entirely best-effort and non-fatal: any failure (offline, a
 * read-only agent directory, a package-manager error, a corrupt dismissal
 * file, etc.) is logged and reconciliation moves on, per package and overall.
 * It must never crash or block session daemon startup — callers should not
 * await this before the daemon starts serving requests.
 */
import {
  defaultPiWebPackageRoot,
  KNOWN_AUTO_INSTALLABLE_PI_PACKAGES,
  resolveShippedPiPackagePath,
  type KnownAutoInstallablePiPackage,
} from "../knownAutoInstallPiPackages.js";
import { resolveDeclaredPiPackageName } from "../piPackageIdentity.js";
import { PiPackageDismissalStore } from "../storage/piPackageDismissalStore.js";
import type { PiPackageProvider } from "../piWebPluginCatalog.js";

export interface PiPackageAutoInstallLogger {
  warn(details: Record<string, unknown>, message: string): void;
  info?(details: Record<string, unknown>, message: string): void;
}

/** Narrow seam for installing a Pi package the same way the manual Settings UI Install action does. */
export interface PiPackageAutoInstaller {
  install(source: string): Promise<unknown>;
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
  /** Installs and persists a package the same way the manual Install action does. */
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
 * known auto-installable registry, installing any that are neither already
 * configured nor dismissed. Never throws: every failure, per package, is
 * caught and logged so one broken package (or a broken check) never prevents
 * reconciling the rest, and never affects session daemon startup.
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
      if (await isAlreadyConfigured(knownPackage.id, packageProvider, identityResolver)) continue;
      if (await dismissalChecker.isDismissed(profileDir, knownPackage.id)) continue;

      const source = resolveShippedPiPackagePath(knownPackage, packageRoot);
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

async function isAlreadyConfigured(
  packageId: string,
  packageProvider: PiPackageProvider,
  identityResolver: PiPackageAutoInstallIdentityResolver,
): Promise<boolean> {
  for (const configured of packageProvider.listPackages()) {
    const installedPath = configured.installedPath ?? packageProvider.getInstalledPath(configured.source, configured.scope);
    if (installedPath === undefined) continue;
    if (await identityResolver.resolveDeclaredName(installedPath) === packageId) return true;
  }
  return false;
}
