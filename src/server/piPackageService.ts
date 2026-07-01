import { DefaultPackageManager, getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { PiPackageInfo, PiPackageMutationAction, PiPackageMutationResponse, PiPackageScope, PiPackagesResponse } from "../shared/apiTypes.js";

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

export function createDefaultPiPackageService(cwd = process.cwd(), agentDir = getAgentDir()): PiPackageService {
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
