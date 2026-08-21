import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfiguredPiPackage, PiPackageProvider } from "../piWebPluginCatalog.js";
import { PiPackageDismissalStore } from "../storage/piPackageDismissalStore.js";
import {
  reconcileAutoInstallablePiPackages,
  type PiPackageAutoInstallDismissalChecker,
  type PiPackageAutoInstallIdentityResolver,
  type PiPackageAutoInstaller,
  type PiPackageAutoInstallLogger,
} from "./autoInstallPiPackages.js";

const KNOWN_PACKAGE_ID = "@jmfederico/pi-relay";
const PACKAGE_ROOT = "/pi-web";
const KNOWN_PACKAGES = [{ id: KNOWN_PACKAGE_ID, label: "Relays", description: "Relay method prompts and skill.", shippedPathSegments: ["dist", "pi-packages", "relays"] }];

function fakePackageProvider(packages: ConfiguredPiPackage[] = [], getInstalledPath: PiPackageProvider["getInstalledPath"] = () => undefined): PiPackageProvider {
  return { listPackages: () => packages, getInstalledPath };
}

function fakeInstaller(implementation: PiPackageAutoInstaller["install"] = () => Promise.resolve()) {
  const install = vi.fn<PiPackageAutoInstaller["install"]>(implementation);
  return { installer: { install }, install };
}

function fakeDismissalChecker(isDismissed: PiPackageAutoInstallDismissalChecker["isDismissed"] = () => Promise.resolve(false)): PiPackageAutoInstallDismissalChecker {
  return { isDismissed };
}

function fakeIdentityResolver(resolveDeclaredName: PiPackageAutoInstallIdentityResolver["resolveDeclaredName"]): PiPackageAutoInstallIdentityResolver {
  return { resolveDeclaredName };
}

function fakeLogger() {
  const warn = vi.fn<PiPackageAutoInstallLogger["warn"]>();
  const info = vi.fn<NonNullable<PiPackageAutoInstallLogger["info"]>>();
  return { logger: { warn, info }, warn, info };
}

describe("reconcileAutoInstallablePiPackages", () => {
  it("installs a known package from its shipped local path when not configured and not dismissed", async () => {
    const { installer, install } = fakeInstaller();
    const { logger, info } = fakeLogger();

    await reconcileAutoInstallablePiPackages({
      profileDir: "/agent",
      packageProvider: fakePackageProvider([]),
      installer,
      dismissalChecker: fakeDismissalChecker(),
      identityResolver: fakeIdentityResolver(() => Promise.resolve(undefined)),
      packageRoot: PACKAGE_ROOT,
      knownPackages: KNOWN_PACKAGES,
      logger,
    });

    expect(install).toHaveBeenCalledWith(join(PACKAGE_ROOT, "dist", "pi-packages", "relays"));
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ packageId: KNOWN_PACKAGE_ID, profileDir: "/agent" }),
      expect.any(String),
    );
  });

  it("does not install when a configured package already declares the known name", async () => {
    const { installer, install } = fakeInstaller();
    const packageProvider = fakePackageProvider([{ source: "npm:@acme/other", scope: "user", installedPath: "/agent/pi-packages/other" }]);

    await reconcileAutoInstallablePiPackages({
      profileDir: "/agent",
      packageProvider,
      installer,
      dismissalChecker: fakeDismissalChecker(),
      identityResolver: fakeIdentityResolver((path) => Promise.resolve(path === "/agent/pi-packages/other" ? KNOWN_PACKAGE_ID : undefined)),
      packageRoot: PACKAGE_ROOT,
      knownPackages: KNOWN_PACKAGES,
    });

    expect(install).not.toHaveBeenCalled();
  });

  it("resolves installedPath via getInstalledPath when a configured package omits it", async () => {
    const { installer, install } = fakeInstaller();
    const getInstalledPath = vi.fn<PiPackageProvider["getInstalledPath"]>(() => "/agent/pi-packages/other");
    const packageProvider = fakePackageProvider([{ source: "npm:@acme/other", scope: "user" }], getInstalledPath);

    await reconcileAutoInstallablePiPackages({
      profileDir: "/agent",
      packageProvider,
      installer,
      dismissalChecker: fakeDismissalChecker(),
      identityResolver: fakeIdentityResolver(() => Promise.resolve(KNOWN_PACKAGE_ID)),
      packageRoot: PACKAGE_ROOT,
      knownPackages: KNOWN_PACKAGES,
    });

    expect(getInstalledPath).toHaveBeenCalledWith("npm:@acme/other", "user");
    expect(install).not.toHaveBeenCalled();
  });

  it("does not install when the profile has dismissed the package, even though it is not configured", async () => {
    const { installer, install } = fakeInstaller();

    await reconcileAutoInstallablePiPackages({
      profileDir: "/agent",
      packageProvider: fakePackageProvider([]),
      installer,
      dismissalChecker: fakeDismissalChecker(() => Promise.resolve(true)),
      identityResolver: fakeIdentityResolver(() => Promise.resolve(undefined)),
      packageRoot: PACKAGE_ROOT,
      knownPackages: KNOWN_PACKAGES,
    });

    expect(install).not.toHaveBeenCalled();
  });

  it("is best-effort: an install failure is logged and never thrown", async () => {
    const { installer, install } = fakeInstaller(() => Promise.reject(new Error("offline")));
    const { logger, warn } = fakeLogger();

    await expect(reconcileAutoInstallablePiPackages({
      profileDir: "/agent",
      packageProvider: fakePackageProvider([]),
      installer,
      dismissalChecker: fakeDismissalChecker(),
      identityResolver: fakeIdentityResolver(() => Promise.resolve(undefined)),
      packageRoot: PACKAGE_ROOT,
      knownPackages: KNOWN_PACKAGES,
      logger,
    })).resolves.toBeUndefined();

    expect(install).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ packageId: KNOWN_PACKAGE_ID, profileDir: "/agent" }),
      expect.any(String),
    );
  });

  it("is best-effort: a dismissal-check failure is logged and never thrown, and never installs", async () => {
    const { installer, install } = fakeInstaller();
    const { logger, warn } = fakeLogger();

    await expect(reconcileAutoInstallablePiPackages({
      profileDir: "/agent",
      packageProvider: fakePackageProvider([]),
      installer,
      dismissalChecker: fakeDismissalChecker(() => Promise.reject(new Error("corrupt dismissal file"))),
      identityResolver: fakeIdentityResolver(() => Promise.resolve(undefined)),
      packageRoot: PACKAGE_ROOT,
      knownPackages: KNOWN_PACKAGES,
      logger,
    })).resolves.toBeUndefined();

    expect(install).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledOnce();
  });

  it("reconciles each known package independently: one failure does not block the others", async () => {
    const otherPackageId = "@acme/other-known-package";
    const { installer, install } = fakeInstaller((source) => source.includes("relays") ? Promise.reject(new Error("boom")) : Promise.resolve());
    const { logger, warn, info } = fakeLogger();

    await reconcileAutoInstallablePiPackages({
      profileDir: "/agent",
      packageProvider: fakePackageProvider([]),
      installer,
      dismissalChecker: fakeDismissalChecker(),
      identityResolver: fakeIdentityResolver(() => Promise.resolve(undefined)),
      packageRoot: PACKAGE_ROOT,
      knownPackages: [
        ...KNOWN_PACKAGES,
        { id: otherPackageId, label: "Other", description: "Another known package.", shippedPathSegments: ["dist", "pi-packages", "other"] },
      ],
      logger,
    });

    expect(install).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ packageId: KNOWN_PACKAGE_ID }), expect.any(String));
    expect(info).toHaveBeenCalledWith(expect.objectContaining({ packageId: otherPackageId }), expect.any(String));
  });

  describe("defaults", () => {
    let tempDir: string;

    beforeEach(async () => {
      tempDir = await mkdtemp(join(tmpdir(), "pi-web-auto-install-defaults-test-"));
    });

    afterEach(async () => {
      await rm(tempDir, { recursive: true, force: true });
    });

    it("defaults to the production known-package registry and identity resolver, and respects an isolated dismissal store", async () => {
      const { installer, install } = fakeInstaller();
      const dismissalChecker = new PiPackageDismissalStore(join(tempDir, "pi-package-dismissals.json"));

      // No identityResolver/knownPackages/logger overrides: this exercises the real production
      // defaults end to end, with only the dismissal store pointed at a scratch file so no real
      // pi-web data directory is ever touched.
      await reconcileAutoInstallablePiPackages({
        profileDir: "/agent",
        packageProvider: fakePackageProvider([]),
        installer,
        dismissalChecker,
        packageRoot: PACKAGE_ROOT,
      });

      expect(install).toHaveBeenCalledWith(join(PACKAGE_ROOT, "dist", "pi-packages", "relays"));
    });

    it("does not install through the production defaults once the isolated dismissal store recorded a dismissal", async () => {
      const { installer, install } = fakeInstaller();
      const dismissalChecker = new PiPackageDismissalStore(join(tempDir, "pi-package-dismissals.json"));
      await dismissalChecker.dismiss("/agent", KNOWN_PACKAGE_ID);

      await reconcileAutoInstallablePiPackages({
        profileDir: "/agent",
        packageProvider: fakePackageProvider([]),
        installer,
        dismissalChecker,
        packageRoot: PACKAGE_ROOT,
      });

      expect(install).not.toHaveBeenCalled();
    });
  });
});
