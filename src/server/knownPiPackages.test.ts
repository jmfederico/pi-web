import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isKnownAutoInstallablePiPackageId, KNOWN_AUTO_INSTALLABLE_PI_PACKAGES, resolveShippedPiPackagePath } from "./knownAutoInstallPiPackages.js";
import { KNOWN_PI_PACKAGES } from "./knownPiPackages.js";
import { ActiveProfilePiPackageService, createDefaultPiPackageService } from "./piPackageService.js";

const packageId = "@jmfederico/pi-captains-log";
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("optional shipped Pi packages", () => {
  it("offers Captain’s Log without granting auto-install permission", () => {
    expect(KNOWN_PI_PACKAGES.find((entry) => entry.id === packageId)).toMatchObject({
      shippedPathSegments: ["dist", "pi-packages", "captains-log"],
    });
    expect(isKnownAutoInstallablePiPackageId(packageId)).toBe(false);
    expect(KNOWN_AUTO_INSTALLABLE_PI_PACKAGES.some((entry) => entry.id === packageId)).toBe(false);
  });

  it("leaves the profile unconfigured until explicit install, hides the installed suggestion, and offers it again after removal", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-web-optional-package-"));
    tempDirs.push(root);
    const agentDir = join(root, "profile");
    const cwd = join(root, "project");
    await mkdir(agentDir);
    await mkdir(cwd);
    const entry = KNOWN_PI_PACKAGES.find((candidate) => candidate.id === packageId);
    if (entry === undefined) throw new Error("Captain’s Log missing from Settings catalog");
    const source = resolveShippedPiPackagePath(entry, root);
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "package.json"), JSON.stringify({ name: packageId, pi: { extensions: [] } }));
    const dismiss = vi.fn(() => Promise.resolve());
    const service = new ActiveProfilePiPackageService(
      { getActiveAgentProfile: () => Promise.resolve({ status: "available", profile: { schemaVersion: 2, dir: agentDir } }) },
      (dir) => createDefaultPiPackageService(cwd, dir),
      { dismiss },
      undefined,
      undefined,
      root,
    );

    const initial = await service.list();
    expect(initial.packages).toEqual([]);
    expect(initial.installableKnownPackages).toContainEqual(expect.objectContaining({ id: packageId, source }));
    await expect(readFile(join(agentDir, "settings.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    const installed = await service.install(source);
    const configuredSource = join("..", "dist", "pi-packages", "captains-log");
    expect(installed.packages).toContainEqual(expect.objectContaining({ source: configuredSource, installedPath: source, scope: "user" }));
    expect(installed.installableKnownPackages?.some((suggestion) => suggestion.id === packageId)).toBe(false);
    expect(JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8"))).toMatchObject({ packages: [configuredSource] });

    const removed = await service.remove(configuredSource);
    expect(removed.packages).toEqual([]);
    expect(removed.installableKnownPackages).toContainEqual(expect.objectContaining({ id: packageId, source }));
    expect(dismiss).not.toHaveBeenCalled();
  });
});
