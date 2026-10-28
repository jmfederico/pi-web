import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { DefaultPackageManager, SettingsManager } from "../piSdk.js";
import type { PiPackageInfo, PiPackageInstallableSuggestion, PiPackageMutationAction, PiPackageMutationResponse, PiPackageScope, PiPackagesResponse } from "../shared/apiTypes.js";
import { requireActiveAgentProfile, type ActiveAgentProfileProvider } from "./activeAgentProfileProvider.js";
import {
  defaultPiWebPackageRoot,
  isKnownAutoInstallablePiPackageId,
  resolveShippedPiPackagePath,
} from "./knownAutoInstallPiPackages.js";
import { KNOWN_PI_PACKAGES, type KnownPiPackage } from "./knownPiPackages.js";
import { resolveDeclaredPiPackageName } from "./piPackageIdentity.js";
import { PiPackageDismissalStore } from "./storage/piPackageDismissalStore.js";

/**
 * Resolves the stable identity of a configured package so two configured
 * sources that point at the same on-disk package collapse to one. Split from
 * {@link PiPackageManagerPort} so tests can supply a deterministic identity
 * and production can canonicalize with `realpath`.
 */
export interface PiPackageSourceCanonicalizer {
  /** Canonical identity for a configured package; equal identities mean the same installed package. */
  canonicalIdentity(pkg: PiPackageInfo): Promise<string>;
}

/** A configured package dropped because another entry already resolves to the same identity. */
export interface DuplicatePiPackageDrop {
  /** The configured source that was dropped. */
  source: string;
  /** Scope of the dropped entry. */
  scope: PiPackageScope;
  /** The earlier configured source that was kept in its place. */
  keptSource: string;
}

/** Narrow seam for surfacing a dropped duplicate instead of discarding it silently. */
export interface PiPackageDuplicateReporter {
  onDuplicateDropped(drop: DuplicatePiPackageDrop): void;
}

export interface PiPackageManagerPort {
  listConfiguredPackages(): PiPackageInfo[];
  installAndPersist(source: string, options?: { local?: boolean }): Promise<void>;
  removeAndPersist(source: string, options?: { local?: boolean }): Promise<boolean>;
  update(source?: string): Promise<void>;
  flush?(): Promise<void>;
}

export interface PiPackageService {
  list(): Promise<PiPackagesResponse>;
  install(source: string): Promise<PiPackageMutationResponse>;
  remove(source: string, scope?: PiPackageScope): Promise<PiPackageMutationResponse>;
  update(source?: string): Promise<PiPackageMutationResponse>;
}

export type PiPackageServiceForAgentDir = (agentDir: string) => PiPackageService;

/** Narrow seam for recording that a user dismissed (removed) a known auto-installable Pi package for a profile. */
export interface PiPackageDismissalTracker {
  dismiss(profileDir: string, packageId: string): Promise<void>;
}

/** Narrow seam for resolving an installed Pi package's declared identity from its installed path. */
export interface PiPackageIdentityResolver {
  resolveDeclaredName(installedPath: string): Promise<string | undefined>;
}

const noopDismissalTracker: PiPackageDismissalTracker = {
  dismiss: () => Promise.resolve(),
};

const noopDuplicateReporter: PiPackageDuplicateReporter = {
  onDuplicateDropped: () => {},
};

const defaultIdentityResolver: PiPackageIdentityResolver = {
  resolveDeclaredName: resolveDeclaredPiPackageName,
};

/**
 * Canonicalizes a configured package by the real path of its installed
 * directory, falling back to the resolved absolute source when the package has
 * no installed path yet or the path is not resolvable. `realpath` collapses
 * symlinks, so a package reached through two different source strings (for
 * example a dev checkout and the global install it is symlinked from) yields
 * one identity.
 */
const defaultSourceCanonicalizer: PiPackageSourceCanonicalizer = {
  canonicalIdentity: async (pkg) => {
    const candidate = pkg.installedPath;
    if (candidate === undefined) return resolve(pkg.source);
    return await realpath(candidate).catch(() => resolve(candidate));
  },
};

export class ActiveProfilePiPackageService implements PiPackageService {
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly activeAgentProfile: ActiveAgentProfileProvider,
    private readonly serviceForAgentDir: PiPackageServiceForAgentDir,
    private readonly dismissalTracker: PiPackageDismissalTracker = noopDismissalTracker,
    private readonly identityResolver: PiPackageIdentityResolver = defaultIdentityResolver,
    private readonly knownPackages: readonly KnownPiPackage[] = KNOWN_PI_PACKAGES,
    private readonly packageRoot: string = defaultPiWebPackageRoot(),
  ) {}

  async list(): Promise<PiPackagesResponse> {
    return await this.withActiveService(async (service) => this.withInstallableKnownPackages(await service.list()));
  }

  install(source: string): Promise<PiPackageMutationResponse> {
    return this.enqueueMutation(async (service) => this.withInstallableKnownPackages(await service.install(source)));
  }

  remove(source: string, scope?: PiPackageScope): Promise<PiPackageMutationResponse> {
    return this.enqueueMutation(async (service, profileDir) => {
      const dismissedPackageId = await this.resolveKnownAutoInstallablePackageId(service, source, scope);
      const response = await service.remove(source, scope);
      if (dismissedPackageId !== undefined && response.removed === true) {
        await this.dismissalTracker.dismiss(profileDir, dismissedPackageId);
      }
      return this.withInstallableKnownPackages(response);
    });
  }

  update(source?: string): Promise<PiPackageMutationResponse> {
    return this.enqueueMutation(async (service) => this.withInstallableKnownPackages(await service.update(source)));
  }

  /**
   * Adds {@link PiPackagesResponse.installableKnownPackages} for every known
   * shipped package not already configured for the active profile, so Settings
   * can offer an explicit one-click (re)install without granting auto-install permission.
   */
  private async withInstallableKnownPackages<T extends PiPackagesResponse>(response: T): Promise<T> {
    if (this.knownPackages.length === 0) return response;
    const installedIds = await this.resolveInstalledKnownPackageIds(response.packages);
    const installableKnownPackages: PiPackageInstallableSuggestion[] = this.knownPackages
      .filter((known) => !installedIds.has(known.id))
      .map((known) => ({
        id: known.id,
        label: known.label,
        description: known.description,
        source: resolveShippedPiPackagePath(known, this.packageRoot),
      }));
    return installableKnownPackages.length === 0 ? response : { ...response, installableKnownPackages };
  }

  private async resolveInstalledKnownPackageIds(packages: readonly PiPackageInfo[]): Promise<Set<string>> {
    const ids = new Set<string>();
    for (const configured of packages) {
      if (configured.installedPath === undefined) continue;
      const declaredName = await this.identityResolver.resolveDeclaredName(configured.installedPath);
      if (declaredName !== undefined) ids.add(declaredName);
    }
    return ids;
  }

  /** Resolves the removed package's declared identity, if any, before the removal makes it unavailable. */
  private async resolveKnownAutoInstallablePackageId(
    service: PiPackageService,
    source: string,
    scope: PiPackageScope | undefined,
  ): Promise<string | undefined> {
    const effectiveScope = scope ?? "user";
    const { packages } = await service.list();
    const configured = packages.find((candidate) => candidate.source === source && candidate.scope === effectiveScope);
    if (configured?.installedPath === undefined) return undefined;

    const declaredName = await this.identityResolver.resolveDeclaredName(configured.installedPath);
    return declaredName !== undefined && isKnownAutoInstallablePiPackageId(declaredName) ? declaredName : undefined;
  }

  private enqueueMutation(
    operation: (service: PiPackageService, profileDir: string) => Promise<PiPackageMutationResponse>,
  ): Promise<PiPackageMutationResponse> {
    const queuedMutation = this.mutationQueue.then(() => this.withActiveService(operation));
    this.mutationQueue = queuedMutation.then(
      () => undefined,
      () => undefined,
    );
    return queuedMutation;
  }

  private async withActiveService<T>(operation: (service: PiPackageService, profileDir: string) => Promise<T>): Promise<T> {
    const profile = await requireActiveAgentProfile(this.activeAgentProfile);
    return await operation(this.serviceForAgentDir(profile.dir), profile.dir);
  }
}

export class DefaultPiPackageService implements PiPackageService {
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly manager: PiPackageManagerPort,
    private readonly sourceCanonicalizer: PiPackageSourceCanonicalizer = defaultSourceCanonicalizer,
    private readonly duplicates: PiPackageDuplicateReporter = noopDuplicateReporter,
  ) {}

  async list(): Promise<PiPackagesResponse> {
    return Promise.resolve({ packages: await this.listPackages() });
  }

  async install(source: string): Promise<PiPackageMutationResponse> {
    return this.enqueueMutation(async () => {
      await this.manager.installAndPersist(source);
      await this.flushSettings();
      return await this.mutationResponse("install", { source });
    });
  }

  async remove(source: string, scope: PiPackageScope = "user"): Promise<PiPackageMutationResponse> {
    return this.enqueueMutation(async () => {
      const removed = scope === "project"
        ? await this.manager.removeAndPersist(source, { local: true })
        : await this.manager.removeAndPersist(source);
      await this.flushSettings();
      return await this.mutationResponse("remove", { source, scope, removed });
    });
  }

  async update(source?: string): Promise<PiPackageMutationResponse> {
    return this.enqueueMutation(async () => {
      if (source === undefined) {
        await this.manager.update();
        await this.flushSettings();
        return await this.mutationResponse("update", {});
      }

      await this.manager.update(source);
      await this.flushSettings();
      return await this.mutationResponse("update", { source });
    });
  }

  private async enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const queuedMutation = this.mutationQueue.then(operation);
    this.mutationQueue = queuedMutation.then(
      () => undefined,
      () => undefined,
    );
    return queuedMutation;
  }

  private async mutationResponse(action: PiPackageMutationAction, metadata: Omit<PiPackageMutationResponse, "action" | "packages">): Promise<PiPackageMutationResponse> {
    return { action, ...metadata, packages: await this.listPackages() };
  }

  private async flushSettings(): Promise<void> {
    await this.manager.flush?.();
  }

  /**
   * Lists configured packages with duplicates collapsed by canonical identity.
   * Pi registers every configured package's tools, skills, and prompts, so two
   * configured sources pointing at the same installed package make Pi abort at
   * startup with a resource conflict. Keeping the first configured entry and
   * dropping later ones turns a fatal collision into a visible, recoverable
   * condition.
   */
  private async listPackages(): Promise<PiPackageInfo[]> {
    const configured = this.manager.listConfiguredPackages().map((configuredPackage): PiPackageInfo => ({
      source: configuredPackage.source,
      scope: configuredPackage.scope,
      filtered: configuredPackage.filtered,
      ...(configuredPackage.installedPath === undefined ? {} : { installedPath: configuredPackage.installedPath }),
    }));

    const keptByIdentity = new Map<string, PiPackageInfo>();
    const deduplicated: PiPackageInfo[] = [];
    for (const pkg of configured) {
      const identity = await this.sourceCanonicalizer.canonicalIdentity(pkg);
      const kept = keptByIdentity.get(identity);
      if (kept !== undefined) {
        this.duplicates.onDuplicateDropped({ source: pkg.source, scope: pkg.scope, keptSource: kept.source });
        continue;
      }
      keptByIdentity.set(identity, pkg);
      deduplicated.push(pkg);
    }
    return deduplicated;
  }

  /**
   * Returns the current set of deduplicated packages so mutation responses
   * stay consistent with {@link listPackages}.
   */
  private async listPackagesSnapshot(): Promise<PiPackageInfo[]> {
    return this.listPackages();
  }
}

/** Minimal logger shape for surfacing a dropped duplicate package. */
export interface PiPackageDuplicateLogger {
  warn(details: Record<string, unknown>, message: string): void;
}

export function createActiveProfilePiPackageService(
  activeAgentProfile: ActiveAgentProfileProvider,
  cwd = process.cwd(),
  dismissalTracker: PiPackageDismissalTracker = new PiPackageDismissalStore(),
  duplicateLogger?: PiPackageDuplicateLogger,
): PiPackageService {
  return new ActiveProfilePiPackageService(
    activeAgentProfile,
    (agentDir) => createDefaultPiPackageService(cwd, agentDir, duplicateLogger),
    dismissalTracker,
  );
}

export function createDefaultPiPackageService(cwd: string, agentDir: string, logger?: PiPackageDuplicateLogger): PiPackageService {
  const settingsManager = SettingsManager.create(cwd, agentDir);
  const manager = new DefaultPackageManager({ cwd, agentDir, settingsManager });
  return new DefaultPiPackageService(
    {
      listConfiguredPackages: () => manager.listConfiguredPackages(),
      installAndPersist: (source, options) => manager.installAndPersist(source, options),
      removeAndPersist: async (source, options) => {
        const settings = options?.local === true ? settingsManager.getProjectSettings() : settingsManager.getGlobalSettings();
        const packages = settings.packages ?? [];
        const remaining = packages.filter((entry) => (typeof entry === "string" ? entry : entry.source) !== source);
        if (remaining.length === packages.length) return await manager.removeAndPersist(source, options);

        // The UI sends a configured source, whose relative paths are profile/project-relative,
        // not cwd-relative like the SDK's removeAndPersist input matching.
        await manager.remove(source, options);
        if (options?.local === true) settingsManager.setProjectPackages(remaining);
        else settingsManager.setPackages(remaining);
        return true;
      },
      update: (source) => manager.update(source),
      flush: () => settingsManager.flush(),
    },
    undefined,
    logger === undefined
      ? noopDuplicateReporter
      : { onDuplicateDropped: (drop) => { logger.warn({ ...drop }, "ignoring duplicate configured Pi package that resolves to an already-configured package"); } },
  );
}
