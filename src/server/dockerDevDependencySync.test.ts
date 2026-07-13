import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const syncScript = join(repoRoot, "docker", "internal", "dev", "sync-node-modules");
const dockerSyncIt = it.skipIf(process.platform === "win32");

let tempDir = "";

interface SyncFixture {
  workspaceDir: string;
  seedDir: string;
  targetDir: string;
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "pi-web-docker-dependencies-test-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("Docker development dependency synchronization", () => {
  dockerSyncIt("replaces a stale dependency tree once per image generation", async () => {
    const fixture = await createSyncFixture();

    const first = await runSync(fixture);

    expect(first.exitCode).toBe(0);
    expect(first.stderr).toContain("Synchronizing PI WEB Docker dev dependencies");
    expect(await readFile(join(fixture.targetDir, "fresh", "version.txt"), "utf8")).toBe("0.80.6\n");
    expect(await readlink(join(fixture.targetDir, ".bin", "fresh"))).toBe("../fresh/version.txt");
    expect(await readFile(join(fixture.targetDir, ".pi-web-dev-dependency-generation"), "utf8")).toBe("image-generation-2\n");
    await expect(readFile(join(fixture.targetDir, "stale.txt"), "utf8")).rejects.toThrow();

    await writeFile(join(fixture.targetDir, "keep-on-current-generation.txt"), "kept\n", "utf8");
    const second = await runSync(fixture);

    expect(second.exitCode).toBe(0);
    expect(second.stderr).toContain("dependencies are current");
    expect(await readFile(join(fixture.targetDir, "keep-on-current-generation.txt"), "utf8")).toBe("kept\n");
  });

  dockerSyncIt("fails without changing the volume when the image manifests are stale", async () => {
    const fixture = await createSyncFixture();
    await writeFile(join(fixture.workspaceDir, "package-lock.json"), '{"lockfileVersion":3,"changed":true}\n', "utf8");

    const result = await runSync(fixture);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("development image dependencies do not match the checkout");
    expect(await readFile(join(fixture.targetDir, "stale.txt"), "utf8")).toBe("stale\n");
  });
});

async function createSyncFixture(): Promise<SyncFixture> {
  const workspaceDir = join(tempDir, "workspace");
  const seedDir = join(tempDir, "seed");
  const targetDir = join(workspaceDir, "node_modules");
  const packageJson = '{"name":"dependency-sync-fixture","private":true}\n';
  const packageLock = '{"name":"dependency-sync-fixture","lockfileVersion":3}\n';

  await Promise.all([
    mkdir(join(seedDir, "node_modules", "fresh"), { recursive: true }),
    mkdir(join(seedDir, "node_modules", ".bin"), { recursive: true }),
    mkdir(targetDir, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(workspaceDir, "package.json"), packageJson, "utf8"),
    writeFile(join(workspaceDir, "package-lock.json"), packageLock, "utf8"),
    writeFile(join(seedDir, "package.json"), packageJson, "utf8"),
    writeFile(join(seedDir, "package-lock.json"), packageLock, "utf8"),
    writeFile(join(seedDir, "generation"), "image-generation-2\n", "utf8"),
    writeFile(join(seedDir, "node_modules", "fresh", "version.txt"), "0.80.6\n", "utf8"),
    writeFile(join(targetDir, "stale.txt"), "stale\n", "utf8"),
    writeFile(join(targetDir, ".pi-web-dev-dependency-generation"), "image-generation-1\n", "utf8"),
  ]);
  await symlink("../fresh/version.txt", join(seedDir, "node_modules", ".bin", "fresh"));

  return { workspaceDir, seedDir, targetDir };
}

function runSync(fixture: SyncFixture): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolvePromise) => {
    execFile("bash", [syncScript], {
      encoding: "utf8",
      env: {
        ...process.env,
        PI_WEB_DEV_WORKSPACE_DIR: fixture.workspaceDir,
        PI_WEB_DEV_DEPENDENCY_SEED_DIR: fixture.seedDir,
      },
    }, (error, stdout, stderr) => {
      const exitCode = typeof error === "object" && error !== null && "code" in error && typeof error.code === "number" ? error.code : 0;
      resolvePromise({ stdout, stderr, exitCode });
    });
  });
}
