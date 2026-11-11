import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PiPackageDismissalStore } from "../storage/piPackageDismissalStore.js";
import { PiPackageProvisioningStore } from "../storage/piPackageProvisioningStore.js";
import { reconcileAutoInstallablePiPackages, type ReconcileAutoInstallablePiPackagesOptions } from "./autoInstallPiPackages.js";

const PACKAGE_ID = "@jmfederico/pi-relay";
const PACKAGE_ROOT = "/pi-web";
const KNOWN_PACKAGES = [{ id: PACKAGE_ID, label: "Relays", description: "Relay method prompts and skill.", shippedPathSegments: ["dist", "pi-packages", "relays"] }];
const NOW = "2026-11-12T10:00:00.000Z";
const DISMISSED_AT = "2026-10-01T10:00:00.000Z";
let tempDir: string;
let provisioningPath: string;
let dismissalPath: string;
let provisioningStore: PiPackageProvisioningStore;
let dismissalStore: PiPackageDismissalStore;
let options: ReconcileAutoInstallablePiPackagesOptions;
const install = vi.fn<ReconcileAutoInstallablePiPackagesOptions["installer"]["install"]>();
const replaceSources = vi.fn<ReconcileAutoInstallablePiPackagesOptions["installer"]["replaceSources"]>();
const warn = vi.fn();

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "pi-web-provisioning-test-"));
  provisioningPath = join(tempDir, "pi-package-provisioning.json");
  dismissalPath = join(tempDir, "pi-package-dismissals.json");
  provisioningStore = new PiPackageProvisioningStore(provisioningPath);
  dismissalStore = new PiPackageDismissalStore(dismissalPath);
  install.mockReset().mockResolvedValue(undefined);
  replaceSources.mockReset().mockResolvedValue(undefined);
  warn.mockReset();
  options = {
    profileDir: "/agent",
    packageProvider: { listPackages: () => [], getInstalledPath: () => undefined },
    installer: { install, replaceSources },
    dismissalStore,
    provisioningStore,
    identityResolver: { resolveDeclaredName: () => Promise.resolve(undefined) },
    packageRoot: PACKAGE_ROOT,
    knownPackages: KNOWN_PACKAGES,
    now: () => NOW,
    logger: { warn },
  };
});
afterEach(async () => { await rm(tempDir, { recursive: true, force: true }); });

async function records(): Promise<unknown> {
  return JSON.parse(await readFile(provisioningPath, "utf8"));
}

function configuredPackage() {
  const source = join(PACKAGE_ROOT, "dist", "pi-packages", "relays");
  options.packageProvider = { listPackages: () => [{ source, scope: "user", installedPath: source }], getInstalledPath: () => undefined };
  options.identityResolver = { resolveDeclaredName: () => Promise.resolve(PACKAGE_ID) };
}

describe("one-time Pi package provisioning", () => {
  it("installs an unknown absent package once and keeps it absent on subsequent startups", async () => {
    await reconcileAutoInstallablePiPackages(options);
    expect(install).toHaveBeenCalledWith(join(PACKAGE_ROOT, "dist", "pi-packages", "relays"));
    expect(await records()).toEqual({ provisioned: [{ profileDir: "/agent", packageId: PACKAGE_ID, provisionedAt: NOW }] });

    // Fresh store and a new PI WEB installation path must not reset the decision.
    await reconcileAutoInstallablePiPackages({ ...options, provisioningStore: new PiPackageProvisioningStore(provisioningPath), packageRoot: "/new-pi-web" });
    expect(install).toHaveBeenCalledOnce();
    expect(warn).not.toHaveBeenCalled();
  });

  it("records already configured packages without installing them, then respects later removal", async () => {
    const emptyProvider = options.packageProvider;
    configuredPackage();
    await reconcileAutoInstallablePiPackages(options);
    expect(await records()).toEqual({ provisioned: [{ profileDir: "/agent", packageId: PACKAGE_ID, provisionedAt: NOW }] });
    expect(replaceSources).not.toHaveBeenCalled();
    await reconcileAutoInstallablePiPackages({ ...options, packageProvider: emptyProvider });
    expect(install).not.toHaveBeenCalled();
  });

  it("imports all legacy dismissals with their dates and preserves existing provisioning records", async () => {
    const dismissals = [
      { profileDir: "/agent", packageId: PACKAGE_ID, dismissedAt: DISMISSED_AT },
      { profileDir: "/other-agent", packageId: "@example/retired", dismissedAt: DISMISSED_AT },
    ];
    await writeFile(dismissalPath, JSON.stringify({ dismissals }));
    await provisioningStore.record({ profileDir: "/other-agent", packageId: "@example/retired", provisionedAt: NOW });
    await reconcileAutoInstallablePiPackages(options);
    await reconcileAutoInstallablePiPackages(options);
    expect(install).not.toHaveBeenCalled();
    expect(await records()).toEqual({ provisioned: [
      { profileDir: "/other-agent", packageId: "@example/retired", provisionedAt: NOW },
      { profileDir: "/agent", packageId: PACKAGE_ID, provisionedAt: DISMISSED_AT },
    ] });
    expect(JSON.parse(await readFile(dismissalPath, "utf8"))).toEqual({ dismissals });
  });

  it("uses the dismissal date even if the dismissed package was explicitly reinstalled", async () => {
    await writeFile(dismissalPath, JSON.stringify({ dismissals: [{ profileDir: "/agent", packageId: PACKAGE_ID, dismissedAt: DISMISSED_AT }] }));
    configuredPackage();
    await reconcileAutoInstallablePiPackages(options);
    expect(await records()).toEqual({ provisioned: [{ profileDir: "/agent", packageId: PACKAGE_ID, provisionedAt: DISMISSED_AT }] });
    expect(install).not.toHaveBeenCalled();
  });

  it("does not record failed installs, retries them, and continues provisioning other packages", async () => {
    const other = { id: "@example/other", label: "Other", description: "Other", shippedPathSegments: ["other"] };
    options.knownPackages = [...KNOWN_PACKAGES, other];
    install.mockRejectedValueOnce(new Error("missing shipped package"));
    await reconcileAutoInstallablePiPackages(options);
    expect(await provisioningStore.has("/agent", PACKAGE_ID)).toBe(false);
    expect(await provisioningStore.has("/agent", other.id)).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ packageId: PACKAGE_ID }), expect.any(String));
    await reconcileAutoInstallablePiPackages(options);
    expect(install).toHaveBeenCalledTimes(3);
    expect(await provisioningStore.has("/agent", PACKAGE_ID)).toBe(true);
  });

  it.each(["dismissal", "provisioning"])("logs corrupt %s state without treating it as permission to install", async (kind) => {
    await writeFile(kind === "dismissal" ? dismissalPath : provisioningPath, "{broken");
    await expect(reconcileAutoInstallablePiPackages(options)).resolves.toBeUndefined();
    expect(install).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledOnce();
  });

  it.each(["dismissal read", "provisioning read", "dismissal migration write", "provisioning write"])("updates stale configured sources despite a %s failure without installing absent packages", async (failure) => {
    const source = join(tempDir, "obsolete-relays");
    const configured = { source, scope: "user" as const, installedPath: source };
    const laterConfigured = { source: join(tempDir, "obsolete-other"), scope: "user" as const, installedPath: join(tempDir, "obsolete-other") };
    options.packageProvider = { listPackages: () => [configured, laterConfigured], getInstalledPath: () => undefined };
    options.identityResolver = { resolveDeclaredName: (path) => Promise.resolve(path === source ? PACKAGE_ID : "@example/configured") };
    options.knownPackages = [
      ...KNOWN_PACKAGES,
      { id: "@example/absent", label: "Absent", description: "Absent", shippedPathSegments: ["absent"] },
      { id: "@example/configured", label: "Configured", description: "Configured", shippedPathSegments: ["configured"] },
    ];
    if (failure === "dismissal read" || failure === "provisioning read") {
      await writeFile(failure === "dismissal read" ? dismissalPath : provisioningPath, "{broken");
    } else {
      if (failure === "dismissal migration write") await dismissalStore.dismiss("/agent", PACKAGE_ID);
      options.provisioningStore = {
        has: (profile, id) => provisioningStore.has(profile, id),
        record: () => Promise.reject(new Error("ledger is read-only")),
      };
    }

    await reconcileAutoInstallablePiPackages(options);

    expect(replaceSources).toHaveBeenCalledWith([configured], join(PACKAGE_ROOT, "dist", "pi-packages", "relays"));
    expect(replaceSources).toHaveBeenCalledWith([laterConfigured], join(PACKAGE_ROOT, "configured"));
    expect(install).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });

  it("reports a ledger write failure and records the configured package on the next startup", async () => {
    await reconcileAutoInstallablePiPackages({
      ...options,
      provisioningStore: { has: (profile, id) => provisioningStore.has(profile, id), record: () => Promise.reject(new Error("disk full")) },
    });
    expect(install).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledOnce();
    expect(await provisioningStore.has("/agent", PACKAGE_ID)).toBe(false);
    configuredPackage();
    await reconcileAutoInstallablePiPackages(options);
    expect(install).toHaveBeenCalledOnce();
    expect(await provisioningStore.has("/agent", PACKAGE_ID)).toBe(true);
  });

  it("stops before any installs when legacy dismissal migration cannot be saved", async () => {
    await dismissalStore.dismiss("/agent", PACKAGE_ID);
    await reconcileAutoInstallablePiPackages({
      ...options,
      provisioningStore: { has: () => Promise.resolve(false), record: () => Promise.reject(new Error("disk full")) },
    });
    expect(install).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledOnce();
  });

  it("defaults to the production registry while honoring profile-specific dismissals", async () => {
    await dismissalStore.dismiss("/agent", PACKAGE_ID);
    delete options.knownPackages;
    delete options.identityResolver;
    await reconcileAutoInstallablePiPackages(options);
    expect(install).not.toHaveBeenCalledWith(join(PACKAGE_ROOT, "dist", "pi-packages", "relays"));
    expect(install).toHaveBeenCalledWith(join(PACKAGE_ROOT, "dist", "pi-packages", "workflows"));
    expect(install).toHaveBeenCalledWith(join(PACKAGE_ROOT, "dist", "pi-packages", "session-naming"));
    expect(install).toHaveBeenCalledTimes(2);
    await reconcileAutoInstallablePiPackages({ ...options, profileDir: "/new-agent", knownPackages: KNOWN_PACKAGES });
    expect(install).toHaveBeenCalledTimes(3);
  });
});
