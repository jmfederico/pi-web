import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KNOWN_AUTO_INSTALLABLE_PI_PACKAGE_IDS, resolveShippedPiPackagePath } from "./knownAutoInstallPiPackages.js";
import { KNOWN_PI_PACKAGES } from "./knownPiPackages.js";
import { ActiveProfilePiPackageService, createDefaultPiPackageService } from "./piPackageService.js";

const packageId = "@example/pi-optional";
const optionalPackage = {
  id: packageId,
  label: "Optional package",
  description: "An optional test package.",
  shippedPathSegments: ["dist", "pi-packages", "optional"],
};
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("optional shipped Pi packages", () => {
  it("offers scheduled tasks for explicit installation without authorizing auto-installation", () => {
    const id = "@jmfederico/pi-web-scheduled-tasks";
    expect(KNOWN_PI_PACKAGES.find((known) => known.id === id)?.shippedPathSegments).toEqual(["dist", "pi-packages", "scheduled-tasks"]);
    expect(KNOWN_AUTO_INSTALLABLE_PI_PACKAGE_IDS).not.toContain(id);
  });

  it.each(["user", "project"] as const)("removes a missing relative package from %s settings without removing other entries", async (scope) => {
    const root = await mkdtemp(join(tmpdir(), "pi-web-stale-package-"));
    tempDirs.push(root);
    const agentDir = join(root, "profile");
    const cwd = join(root, "project");
    const projectDir = join(cwd, ".pi");
    await mkdir(agentDir);
    await mkdir(projectDir, { recursive: true });
    const settingsPath = join(scope === "user" ? agentDir : projectDir, "settings.json");
    const source = "../missing-package";
    const other = { source: "../other-package", extensions: [] };
    await writeFile(settingsPath, JSON.stringify({ packages: [source, other], theme: "dark" }));
    const service = createDefaultPiPackageService(cwd, agentDir);

    const removed = await service.remove(source, scope);

    expect(removed.removed).toBe(true);
    expect(removed.packages).toEqual([{ source: other.source, scope, filtered: true }]);
    expect(JSON.parse(await readFile(settingsPath, "utf8"))).toMatchObject({ packages: [other], theme: "dark" });
    await expect(createDefaultPiPackageService(cwd, agentDir).list()).resolves.toEqual({ packages: removed.packages });
  });

  it("installs only on request and allows removing a stale package entry after its shipped directory disappears", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-web-optional-package-"));
    tempDirs.push(root);
    const agentDir = join(root, "profile");
    const cwd = join(root, "project");
    await mkdir(agentDir);
    await mkdir(cwd);
    const source = resolveShippedPiPackagePath(optionalPackage, root);
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "package.json"), JSON.stringify({ name: packageId, pi: { extensions: [] } }));
    const dismiss = vi.fn(() => Promise.resolve());
    const service = new ActiveProfilePiPackageService(
      { getActiveAgentProfile: () => Promise.resolve({ status: "available", profile: { schemaVersion: 2, dir: agentDir } }) },
      (dir) => createDefaultPiPackageService(cwd, dir),
      { dismiss },
      undefined,
      [optionalPackage],
      root,
    );

    const initial = await service.list();
    expect(initial.packages).toEqual([]);
    expect(initial.installableKnownPackages).toContainEqual(expect.objectContaining({ id: packageId, source }));
    await expect(readFile(join(agentDir, "settings.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    const installed = await service.install(source);
    const configuredSource = join("..", "dist", "pi-packages", "optional");
    expect(installed.packages).toContainEqual(expect.objectContaining({ source: configuredSource, installedPath: source, scope: "user" }));
    expect(installed.installableKnownPackages ?? []).not.toContainEqual(expect.objectContaining({ id: packageId }));
    expect(JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8"))).toMatchObject({ packages: [configuredSource] });

    // An update can remove a shipped optional package without editing the profile.
    await rm(source, { recursive: true });
    const afterUpdate = await service.list();
    expect(afterUpdate.packages).toEqual([{ source: configuredSource, scope: "user", filtered: false }]);

    const removed = await service.remove(configuredSource);
    expect(removed.packages).toEqual([]);
    expect(removed.installableKnownPackages).toContainEqual(expect.objectContaining({ id: packageId, source }));
    expect(dismiss).not.toHaveBeenCalled();
  });
});
