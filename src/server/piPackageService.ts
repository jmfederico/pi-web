import { DefaultPackageManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { PiPackageInfo, PiPackageMutationAction, PiPackageMutationResponse, PiPackageScope, PiPackagesResponse } from "../shared/apiTypes.js";
import { requireActiveAgentProfile, type ActiveAgentProfileProvider } from "./activeAgentProfileProvider.js";

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

export class ActiveProfilePiPackageService implements PiPackageService {
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly activeAgentProfile: ActiveAgentProfileProvider,
    private readonly serviceForAgentDir: PiPackageServiceForAgentDir,
  ) {}

  async list(): Promise<PiPackagesResponse> {
    return await this.withActiveService((service) => service.list());
  }

  install(source: string): Promise<PiPackageMutationResponse> {
    return this.enqueueMutation((service) => service.install(source));
  }

  remove(source: string, scope?: PiPackageScope): Promise<PiPackageMutationResponse> {
    return this.enqueueMutation((service) => service.remove(source, scope));
  }

  update(source?: string): Promise<PiPackageMutationResponse> {
    return this.enqueueMutation((service) => service.update(source));
  }

  private enqueueMutation(operation: (service: PiPackageService) => Promise<PiPackageMutationResponse>): Promise<PiPackageMutationResponse> {
    const queuedMutation = this.mutationQueue.then(() => this.withActiveService(operation));
    this.mutationQueue = queuedMutation.then(
      () => undefined,
      () => undefined,
    );
    return queuedMutation;
  }

  private async withActiveService<T>(operation: (service: PiPackageService) => Promise<T>): Promise<T> {
    const profile = await requireActiveAgentProfile(this.activeAgentProfile);
    return await operation(this.serviceForAgentDir(profile.dir));
  }
}

export class DefaultPiPackageService implements PiPackageService {
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly manager: PiPackageManagerPort) {}

  list(): Promise<PiPackagesResponse> {
    return Promise.resolve({ packages: this.listPackages() });
  }

  install(source: string): Promise<PiPackageMutationResponse> {
    return this.enqueueMutation(async () => {
      await this.manager.installAndPersist(source);
      await this.flushSettings();
      return this.mutationResponse("install", { source });
    });
  }

  remove(source: string, scope: PiPackageScope = "user"): Promise<PiPackageMutationResponse> {
    return this.enqueueMutation(async () => {
      const removed = scope === "project"
        ? await this.manager.removeAndPersist(source, { local: true })
        : await this.manager.removeAndPersist(source);
      await this.flushSettings();
      return this.mutationResponse("remove", { source, scope, removed });
    });
  }

  update(source?: string): Promise<PiPackageMutationResponse> {
    return this.enqueueMutation(async () => {
      if (source === undefined) {
        await this.manager.update();
        await this.flushSettings();
        return this.mutationResponse("update", {});
      }

      await this.manager.update(source);
      await this.flushSettings();
      return this.mutationResponse("update", { source });
    });
  }

  private enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const queuedMutation = this.mutationQueue.then(operation);
    this.mutationQueue = queuedMutation.then(
      () => undefined,
      () => undefined,
    );
    return queuedMutation;
  }

  private mutationResponse(action: PiPackageMutationAction, metadata: Omit<PiPackageMutationResponse, "action" | "packages">): PiPackageMutationResponse {
    return { action, ...metadata, packages: this.listPackages() };
  }

  private async flushSettings(): Promise<void> {
    await this.manager.flush?.();
  }

  private listPackages(): PiPackageInfo[] {
    return this.manager.listConfiguredPackages().map((configuredPackage) => ({
      source: configuredPackage.source,
      scope: configuredPackage.scope,
      filtered: configuredPackage.filtered,
      ...(configuredPackage.installedPath === undefined ? {} : { installedPath: configuredPackage.installedPath }),
    }));
  }
}

export function createActiveProfilePiPackageService(activeAgentProfile: ActiveAgentProfileProvider, cwd = process.cwd()): PiPackageService {
  return new ActiveProfilePiPackageService(activeAgentProfile, (agentDir) => createDefaultPiPackageService(cwd, agentDir));
}

export function createDefaultPiPackageService(cwd: string, agentDir: string): PiPackageService {
  const settingsManager = SettingsManager.create(cwd, agentDir);
  const manager = new DefaultPackageManager({ cwd, agentDir, settingsManager });
  return new DefaultPiPackageService({
    listConfiguredPackages: () => manager.listConfiguredPackages(),
    installAndPersist: (source, options) => manager.installAndPersist(source, options),
    removeAndPersist: (source, options) => manager.removeAndPersist(source, options),
    update: (source) => manager.update(source),
    flush: () => settingsManager.flush(),
  });
}
