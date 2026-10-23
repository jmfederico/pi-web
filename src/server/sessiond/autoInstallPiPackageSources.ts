import { stat } from "node:fs/promises";
import { DefaultPackageManager, SettingsManager, type PackageSource } from "../../piSdk.js";
import type { PiPackageProvider } from "../piWebPluginCatalog.js";
import type { PiPackageAutoInstaller } from "./autoInstallPiPackages.js";

/** Profile registration only: bundled contents already ship with PI WEB. */
export function createAutoInstallPiPackageProfile(profileDir: string): {
  packageProvider: PiPackageProvider;
  installer: PiPackageAutoInstaller;
} {
  const packageManager = () => new DefaultPackageManager({
    cwd: profileDir,
    agentDir: profileDir,
    settingsManager: profileSettings(profileDir),
  });
  return {
    packageProvider: {
      listPackages: () => packageManager().listConfiguredPackages(),
      getInstalledPath: (source) => packageManager().getInstalledPath(source, "user"),
    },
    installer: {
      install: (source) => updateProfilePackages(profileDir, source, (packages) => [...packages, source]),
      replaceSources: (configured, source) => updateProfilePackages(profileDir, source, (packages) => {
        const sources = new Set(configured.filter((entry) => entry.scope === "user").map((entry) => entry.source));
        const matches = (entry: PackageSource) => sources.has(typeof entry === "string" ? entry : entry.source);
        if (!packages.some(matches)) throw new Error("Configured Pi package changed during profile reconciliation");
        return packages.map((entry) => {
          if (!matches(entry)) return entry;
          // Preserve every entry's filters. Duplicate configuration is a separate concern.
          return typeof entry === "string" ? source : { ...entry, source };
        });
      }),
    },
  };
}

async function updateProfilePackages(
  profileDir: string,
  source: string,
  update: (packages: PackageSource[]) => PackageSource[],
): Promise<void> {
  if (!(await stat(source)).isDirectory()) throw new Error(`Shipped Pi package is not a directory: ${source}`);
  // Read fresh immediately before changing the list. Pi locks persistence, not
  // this whole read/modify/write operation: a concurrent package-list edit can
  // still be lost. Accept that startup risk rather than duplicate Pi's locking.
  const settings = profileSettings(profileDir);
  settings.setPackages(update(settings.getGlobalSettings().packages ?? []));
  await settings.flush();
  throwSettingsErrors(settings);
}

function profileSettings(profileDir: string): SettingsManager {
  // No project read, trust grant, or project-file mutation depends on daemon cwd.
  const settings = SettingsManager.create(profileDir, profileDir, { projectTrusted: false });
  throwSettingsErrors(settings);
  return settings;
}

function throwSettingsErrors(settings: SettingsManager): void {
  const errors = settings.drainErrors();
  if (errors.length > 0) throw new AggregateError(errors.map((entry) => entry.error), "Could not reconcile Pi package settings");
}
