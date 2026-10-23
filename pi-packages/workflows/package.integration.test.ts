import { copyFile, cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KNOWN_AUTO_INSTALLABLE_PI_PACKAGES, resolveShippedPiPackagePath } from "../../src/server/knownAutoInstallPiPackages.js";
import { ActiveProfilePiPackageService, createDefaultPiPackageService } from "../../src/server/piPackageService.js";
import { reconcileAutoInstallablePiPackages } from "../../src/server/sessiond/autoInstallPiPackages.js";
import { createAutoInstallPiPackageProfile } from "../../src/server/sessiond/autoInstallPiPackageSources.js";
import { PiPackageDismissalStore } from "../../src/server/storage/piPackageDismissalStore.js";

const known = KNOWN_AUTO_INSTALLABLE_PI_PACKAGES.find(({ id }) => id === "@jmfederico/pi-web-workflows");
if (known === undefined) throw new Error("Workflows must be in the default-install registry");

let root = "";
let cwd = "";
let agentDir = "";
let source = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pi-web-workflows-"));
  cwd = join(root, "project");
  agentDir = join(root, "profile");
  source = resolveShippedPiPackagePath(known, root);
  await Promise.all([mkdir(cwd), mkdir(agentDir), mkdir(source, { recursive: true })]);
  await copyFile(new URL("./package.json", import.meta.url), join(source, "package.json"));
  await cp(new URL("./prompts", import.meta.url), join(source, "prompts"), { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function loadPrompts(settingsManager = SettingsManager.create(cwd, agentDir)) {
  const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true, noSkills: true, noThemes: true });
  await loader.reload();
  const result = loader.getPrompts();
  expect(result.diagnostics).toEqual([]);
  return result.prompts;
}

describe("shipped Workflows Pi package", () => {
  it("loads by default, remembers removal, and supports explicit reinstall without a personal prompt copy", async () => {
    const dismissals = new PiPackageDismissalStore(join(root, "dismissals.json"));
    const service = new ActiveProfilePiPackageService(
      { getActiveAgentProfile: () => Promise.resolve({ status: "available", profile: { schemaVersion: 2, dir: agentDir } }) },
      (dir) => createDefaultPiPackageService(cwd, dir),
      dismissals,
      undefined,
      undefined,
      root,
    );
    const reconcile = () => reconcileAutoInstallablePiPackages({
      profileDir: agentDir,
      ...createAutoInstallPiPackageProfile(agentDir),
      dismissalChecker: dismissals,
      packageRoot: root,
      knownPackages: [known],
    });

    await reconcile();
    expect(await loadPrompts()).toEqual([expect.objectContaining({
      name: "worktree",
      argumentHint: "Purpose and/or base branch",
      filePath: join(source, "prompts", "worktree.md"),
    })]);
    const configured = (await service.list()).packages.find(({ installedPath }) => installedPath === source);
    if (configured === undefined) throw new Error("Workflows was not auto-installed");

    expect(await service.remove(configured.source)).toMatchObject({ removed: true, packages: [] });
    expect(await dismissals.isDismissed(agentDir, known.id)).toBe(true);
    await reconcile();
    expect(await loadPrompts()).toEqual([]);
    expect((await service.list()).installableKnownPackages).toContainEqual(expect.objectContaining({ id: known.id, source }));

    await service.install(source);
    await reconcile();
    expect((await service.list()).packages).toHaveLength(1);
    expect((await loadPrompts()).map(({ name }) => name)).toEqual(["worktree"]);
  });

  it("loads the current resources after migrating an obsolete installation", async () => {
    const old = join(root, "old-workflows");
    await mkdir(join(old, "prompts"), { recursive: true });
    await writeFile(join(old, "package.json"), JSON.stringify({ name: known.id }));
    await writeFile(join(old, "prompts", "obsolete.md"), "Old installed prompt");
    const settings = SettingsManager.create(cwd, agentDir);
    settings.setPackages([old, { source, themes: [] }]);
    await settings.flush();

    await reconcileAutoInstallablePiPackages({
      profileDir: agentDir,
      ...createAutoInstallPiPackageProfile(agentDir),
      dismissalChecker: { isDismissed: () => Promise.resolve(false) },
      packageRoot: root,
      knownPackages: [known],
    });

    expect((await loadPrompts()).map(({ name, filePath }) => ({ name, filePath }))).toEqual([
      { name: "worktree", filePath: join(source, "prompts", "worktree.md") },
    ]);
  });

  it("allows Pi resource filters to disable its prompts without removing the package", async () => {
    const settings = SettingsManager.inMemory({ packages: [{ source, prompts: [] }] });
    expect(await loadPrompts(settings)).toEqual([]);
  });
});
