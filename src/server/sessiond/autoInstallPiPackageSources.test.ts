import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsManager, type PackageSource } from "../../piSdk.js";
import { KNOWN_AUTO_INSTALLABLE_PI_PACKAGES, resolveShippedPiPackagePath } from "../knownAutoInstallPiPackages.js";
import { DefaultPiPackageProvider } from "../piWebPluginCatalog.js";
import { createAutoInstallPiPackageProfile } from "./autoInstallPiPackageSources.js";
import { reconcileAutoInstallablePiPackages } from "./autoInstallPiPackages.js";

function knownPackage(id: string) {
  const entry = KNOWN_AUTO_INSTALLABLE_PI_PACKAGES.find((known) => known.id === id);
  if (!entry) throw new Error(`Expected bundled package registry entry: ${id}`);
  return entry;
}
const relays = knownPackage("@jmfederico/pi-relay");
const workflows = knownPackage("@jmfederico/pi-web-workflows");
let root: string;
let cwd: string;
let profile: string;
let packageRoot: string;
let current: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pi-web-package-migration-"));
  cwd = join(root, "project");
  profile = join(root, "agent");
  packageRoot = join(root, "current", "node_modules", "@jmfederico", "pi-web");
  current = resolveShippedPiPackagePath(relays, packageRoot);
  await Promise.all([mkdir(cwd), mkdir(profile), writePackage(current, relays.id), writePackage(resolveShippedPiPackagePath(workflows, packageRoot), workflows.id)]);
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

async function writePackage(path: string, name: string) {
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "package.json"), JSON.stringify({ name }));
}

async function configure(packages: PackageSource[], projectPackages?: PackageSource[]) {
  const settings = SettingsManager.create(cwd, profile);
  settings.setPackages(packages);
  if (projectPackages) settings.setProjectPackages(projectPackages);
  await settings.flush();
  expect(settings.drainErrors()).toEqual([]);
}

function reconcile(knownPackages = [relays], dismissed = false) {
  const warn = vi.fn();
  return {
    warn,
    run: () => reconcileAutoInstallablePiPackages({
      profileDir: profile,
      ...createAutoInstallPiPackageProfile(profile),
      dismissalChecker: { isDismissed: () => Promise.resolve(dismissed) },
      packageRoot,
      knownPackages,
      logger: { warn },
    }),
  };
}

function packages() {
  return SettingsManager.create(cwd, profile).getGlobalSettings().packages;
}

describe("managed bundled package source migration", () => {
  it("repoints an old Node installation in place, retains filters and other settings, and is idempotent", async () => {
    const old = join(root, "node-v-old", "node_modules", "@jmfederico", "pi-web", "dist", "pi-packages", "relays");
    await writePackage(old, relays.id);
    const filters = { extensions: [], skills: ["skills/relay"], prompts: [], themes: [], autoload: false };
    await configure(["npm:@example/other", { source: relative(profile, old), ...filters }]);
    const settings = SettingsManager.create(cwd, profile);
    settings.setTheme("dark");
    await settings.flush();
    const migration = reconcile();
    await migration.run();
    expect(migration.warn).not.toHaveBeenCalled();
    expect(packages()).toEqual(["npm:@example/other", { source: current, ...filters }]);
    expect(SettingsManager.create(cwd, profile).getTheme()).toBe("dark");
    expect(JSON.parse(await readFile(join(old, "package.json"), "utf8"))).toEqual({ name: relays.id });
    const saved = await readFile(join(profile, "settings.json"), "utf8");
    await migration.run();
    expect(await readFile(join(profile, "settings.json"), "utf8")).toBe(saved);
  });

  it("recovers deleted global-install paths without keeping the obsolete entry", async () => {
    const old = join(root, "deleted-node", "node_modules", "@jmfederico", "pi-web", "dist", "pi-packages", "relays");
    await configure([relative(profile, old)]);
    const migration = reconcile();
    await migration.run();
    expect(migration.warn).not.toHaveBeenCalled();
    expect(packages()).toEqual([current]);
  });

  it("recognizes a checkout with missing dist only when its package root identifies PI WEB", async () => {
    const checkout = join(root, "checkout");
    await writePackage(checkout, "@jmfederico/pi-web");
    const old = resolveShippedPiPackagePath(relays, checkout);
    const unrelated = join(root, "unrelated", "dist", "pi-packages", "relays");
    await configure([old, unrelated]);
    await reconcile().run();
    expect(packages()).toEqual([current, unrelated]);
  });

  it("does not adopt an existing unrelated package just because its path resembles a shipped copy", async () => {
    const unrelated = join(root, "old", "node_modules", "@jmfederico", "pi-web", "dist", "pi-packages", "relays");
    await writePackage(unrelated, "@example/other");
    await configure([unrelated]);
    await reconcile().run();
    expect(packages()).toEqual([unrelated, expect.any(String)]);
    expect(new DefaultPiPackageProvider(cwd, profile).listPackages().map(({ installedPath }) => installedPath)).toEqual([unrelated, current]);
  });

  it("preserves differing profile filters and leaves project entries untouched", async () => {
    const old = join(root, "old-relays");
    await writePackage(old, relays.id);
    await configure([{ source: old, skills: [] }, current], [{ source: old, prompts: [] }, current]);
    const migration = reconcile();
    await migration.run();
    expect(migration.warn).not.toHaveBeenCalled();
    const settings = SettingsManager.create(cwd, profile);
    expect(settings.getGlobalSettings().packages).toEqual([{ source: current, skills: [] }, current]);
    expect(settings.getProjectSettings().packages).toEqual([{ source: old, prompts: [] }, current]);
    const saved = await readFile(join(profile, "settings.json"), "utf8");
    await migration.run();
    expect(await readFile(join(profile, "settings.json"), "utf8")).toBe(saved);
  });

  it("registers an absent profile package independently of project-local package settings", async () => {
    const old = join(root, "deleted-node", "node_modules", "@jmfederico", "pi-web", "dist", "pi-packages", "relays");
    await configure([], [{ source: relative(join(cwd, ".pi"), old), extensions: [] }]);
    const projectFile = join(cwd, ".pi", "settings.json");
    const saved = await readFile(projectFile, "utf8");
    const migration = reconcile();
    await migration.run();
    expect(migration.warn).not.toHaveBeenCalled();
    expect(packages()).toEqual([current]);
    expect(await readFile(projectFile, "utf8")).toBe(saved);
  });

  it("does not read or write project settings even beneath the profile directory", async () => {
    const projectFile = join(profile, ".pi", "settings.json");
    await mkdir(join(profile, ".pi"));
    await writeFile(projectFile, "{invalid project settings");
    const migration = reconcile();
    await migration.run();
    expect(migration.warn).not.toHaveBeenCalled();
    expect(packages()).toEqual([current]);
    expect(await readFile(projectFile, "utf8")).toBe("{invalid project settings");
  });

  it("updates stale Workflows sources using the same managed-package policy", async () => {
    const old = join(root, "old-workflows");
    await writePackage(old, workflows.id);
    await configure([{ source: old, prompts: [] }]);
    const migration = reconcile([workflows]);
    await migration.run();
    expect(migration.warn).not.toHaveBeenCalled();
    expect(packages()).toEqual([{ source: resolveShippedPiPackagePath(workflows, packageRoot), prompts: [] }]);
  });

  it("does not replace a symlink alias of the current copy", async () => {
    const alias = join(root, "alias");
    await symlink(current, alias, "junction");
    await configure([alias]);
    await reconcile().run();
    expect(packages()).toEqual([alias]);
  });

  it("keeps an absent dismissed package absent, but updates an explicitly configured stale copy", async () => {
    await configure([]);
    await reconcile([relays], true).run();
    expect(packages()).toEqual([]);
    const old = join(root, "old-relays");
    await writePackage(old, relays.id);
    await configure([old]);
    await reconcile([relays], true).run();
    expect(packages()).toEqual([current]);
  });

  it("does not undo a migration when subsequently installing another bundled package", async () => {
    const old = join(root, "old-relays");
    await writePackage(old, relays.id);
    await configure([old]);
    const migration = reconcile([relays, workflows]);
    await migration.run();
    expect(migration.warn).not.toHaveBeenCalled();
    expect(new DefaultPiPackageProvider(cwd, profile).listPackages().map(({ installedPath }) => installedPath)).toEqual([
      current, resolveShippedPiPackagePath(workflows, packageRoot),
    ]);
  });

  it("reads fresh profile settings when applying a previously planned source replacement", async () => {
    const old = join(root, "old-relays");
    await writePackage(old, relays.id);
    await configure([old]);
    const profilePackages = createAutoInstallPiPackageProfile(profile);
    const configured = profilePackages.packageProvider.listPackages();
    await configure([old, "npm:@example/added-after-planning"]);
    await profilePackages.installer.replaceSources(configured, current);
    expect(packages()).toEqual([current, "npm:@example/added-after-planning"]);
  });

  it("logs a missing shipped target without removing the configured copy and retries next startup", async () => {
    const old = join(root, "old-relays");
    await writePackage(old, relays.id);
    await configure([old]);
    await rm(current, { recursive: true });
    const migration = reconcile();
    await migration.run();
    expect(migration.warn).toHaveBeenCalledOnce();
    expect(packages()).toEqual([old]);
    await writePackage(current, relays.id);
    await migration.run();
    expect(packages()).toEqual([current]);
  });

  it("leaves malformed settings untouched and reports the failed replacement", async () => {
    const file = join(profile, "settings.json");
    await writeFile(file, "{broken");
    await expect(createAutoInstallPiPackageProfile(profile).installer.replaceSources([
      { source: "old", scope: "user" },
    ], current)).rejects.toThrow("Could not reconcile Pi package settings");
    expect(await readFile(file, "utf8")).toBe("{broken");
  });
});
