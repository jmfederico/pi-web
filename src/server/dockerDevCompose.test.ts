import { execFile, spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const hostProfileScript = join(repoRoot, "docker", "internal", "host-profile.sh");
const execUtf8 = promisify(execFile);
// Keep CLI/plugin lookup, but do not inherit live PI WEB, Compose, or Docker endpoint settings.
const cliEnv: NodeJS.ProcessEnv = {
  PATH: process.env["PATH"],
  HOME: process.env["HOME"],
  DOCKER_CONFIG: process.env["DOCKER_CONFIG"],
};
const composeAvailable = process.platform !== "win32"
  && spawnSync("sh", ["-c", ":"], { env: cliEnv, timeout: 5_000 }).status === 0
  && spawnSync("docker", ["compose", "version"], { env: cliEnv, timeout: 5_000 }).status === 0;
const hostProfiles = ["linux-native-docker", "mac-docker-desktop"];
const devScenarios = hostProfiles.flatMap((profile) => [
  { profile, checkout: "absolute host path with spaces" },
  { profile, checkout: "/workspace" },
]);

interface ComposeMount {
  type: string;
  source: string;
  target: string;
}

let tempDir = "";
let checkoutDir = "";
let dockerDir = "";
let dataDir = "";

describe.skipIf(!composeAvailable)("Docker Compose mount ownership (requires POSIX sh and Docker Compose CLI; no daemon required)", () => {
  beforeEach(async () => {
    // Resolve temporary-directory symlinks (notably /var on macOS) so the checkout is canonical.
    tempDir = await realpath(await mkdtemp(join(tmpdir(), "pi-web-docker-compose-test-")));
    checkoutDir = join(tempDir, "checkout with spaces");
    dockerDir = join(checkoutDir, "docker");
    dataDir = join(tempDir, "data");
    const devEnvDir = join(checkoutDir, ".pi-web");
    await Promise.all([
      mkdir(dockerDir, { recursive: true }),
      mkdir(devEnvDir, { recursive: true }),
      mkdir(dataDir, { recursive: true }),
    ]);
    await Promise.all([
      copyFile(join(repoRoot, "docker", "compose.dev.yml"), join(dockerDir, "compose.dev.yml")),
      copyFile(join(repoRoot, "docker", "compose.yml"), join(dockerDir, "compose.yml")),
      writeFile(join(devEnvDir, "docker-compose-dev.container.env"), "# Test fixture only\n", "utf8"),
      writeFile(join(dataDir, "container.env"), "# Test fixture only\n", "utf8"),
    ]);
  });

  afterEach(async () => {
    if (tempDir !== "") await rm(tempDir, { recursive: true, force: true });
    tempDir = "";
  });

  it.each(devScenarios)("preserves dev mounts after host override ($profile, $checkout)", async ({ profile, checkout }) => {
    const hostCheckout = checkout === "/workspace" ? "/workspace" : checkoutDir;
    const config = await effectiveComposeConfig("compose.dev.yml", profile, hostCheckout);
    const checkoutTargets = [...new Set(["/workspace", hostCheckout])];
    const dependencyTargets = checkoutTargets.map((target) => `${target}/node_modules`);

    // Compose config reports logical volume keys, not the project-prefixed engine volume name.
    expect(config).toHaveProperty("volumes.node_modules");
    for (const serviceName of ["web", "sessiond"]) {
      const mounts = serviceMounts(config, serviceName);
      expectUniqueTargets(mounts, serviceName);
      for (const target of checkoutTargets) {
        expect(mounts.filter((mount) => mount.target === target)).toMatchObject([
          { type: "bind", source: hostCheckout, target },
        ]);
      }
      const dependencyMounts = mounts.filter((mount) => mount.type === "volume");
      expect(dependencyMounts.map((mount) => mount.target).sort()).toEqual([...dependencyTargets].sort());
      for (const target of dependencyTargets) {
        expect(dependencyMounts.filter((mount) => mount.target === target)).toMatchObject([
          { type: "volume", source: "node_modules", target, volume: { nocopy: true } },
        ]);
      }
      // Prove the generated host override actually participated in the merge.
      expect(mounts).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "bind", source: "/var/run/docker.sock", target: "/var/run/docker.sock" }),
      ]));
      expect(config).toHaveProperty(`services.${serviceName}.environment.HOSTEXEC_MODE`, profile === "linux-native-docker" ? "nsenter" : "disabled");
    }

    const initMounts = serviceMounts(config, "data-init");
    expectUniqueTargets(initMounts, "data-init");
    // Exact targets exclude broad host mounts and the host-path checkout/dependency aliases.
    expect(initMounts.map((mount) => mount.target).sort()).toEqual(["/data", "/workspace", "/workspace/node_modules"]);
    expect(initMounts).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "bind", source: hostCheckout, target: "/workspace" }),
      expect.objectContaining({ type: "volume", source: "node_modules", target: "/workspace/node_modules", volume: { nocopy: true } }),
      expect.objectContaining({ type: "bind", source: dataDir, target: "/data" }),
    ]));
  }, 15_000);

  it.each(hostProfiles)("does not add development volumes to runtime (%s)", async (profile) => {
    // Even with the dev repo variable set, the runtime file must not consume it.
    const config = await effectiveComposeConfig("compose.yml", profile, checkoutDir);

    expect(config).not.toHaveProperty("volumes.node_modules");
    expect(config).not.toHaveProperty("services.data-init");
    for (const serviceName of ["web", "sessiond"]) {
      const mounts = serviceMounts(config, serviceName);
      expectUniqueTargets(mounts, serviceName);
      expect(mounts.filter((mount) => mount.type === "volume")).toEqual([]);
      const targets = mounts.map((mount) => mount.target);
      for (const target of ["/workspace", "/workspace/node_modules", checkoutDir, join(checkoutDir, "node_modules")]) {
        expect(targets).not.toContain(target);
      }
      expect(mounts).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "bind", source: dataDir, target: "/data" }),
        expect.objectContaining({ type: "bind", source: "/var/run/docker.sock", target: "/var/run/docker.sock" }),
      ]));
    }
  }, 15_000);
});

async function effectiveComposeConfig(composeFile: string, profile: string, hostCheckout: string): Promise<unknown> {
  const overridePath = join(dockerDir, "compose.host.override.yml");
  const env: NodeJS.ProcessEnv = {
    ...cliEnv,
    PI_WEB_DOCKER_DATA_DIR: dataDir,
    PI_WEB_DOCKER_DEV_REPO_ROOT: hostCheckout,
    PI_WEB_DOCKER_INSTALL_DIR: dockerDir,
    // A nonexistent endpoint makes this explicitly daemon-independent.
    DOCKER_HOST: `unix://${join(tempDir, "absent-docker.sock")}`,
  };
  // Source the real generator, supplying only target and profile: no control-path bind.
  await execUtf8("sh", [
    "-eu", "-c", '. "$1"\npi_web_docker_host_write_compose_override "$2" "$3"',
    "pi-web-compose-test", hostProfileScript, overridePath, profile,
  ], { env, encoding: "utf8", timeout: 5_000 });
  const { stdout } = await execUtf8("docker", [
    "compose", "--project-name", "pi-web-compose-test",
    "--env-file", join(dataDir, "container.env"),
    "-f", join(dockerDir, composeFile), "-f", overridePath,
    "config", "--format", "json",
  ], { cwd: dockerDir, env, encoding: "utf8", timeout: 5_000 });
  const config: unknown = JSON.parse(stdout);
  return config;
}

function serviceMounts(config: unknown, serviceName: string): ComposeMount[] {
  if (!isRecord(config) || !isRecord(config["services"])) throw new Error("Compose config is missing services");
  const service = config["services"][serviceName];
  if (!isRecord(service) || !Array.isArray(service["volumes"])) throw new Error(`Compose service ${serviceName} is missing volumes`);
  const mounts: unknown[] = service["volumes"];
  if (!mounts.every(isComposeMount)) throw new Error(`Compose service ${serviceName} has invalid mount JSON`);
  return mounts;
}

function expectUniqueTargets(mounts: ComposeMount[], serviceName: string): void {
  expect(new Set(mounts.map((mount) => mount.target)).size, `${serviceName} effective mount targets must be unique`).toBe(mounts.length);
}

function isComposeMount(value: unknown): value is ComposeMount {
  return isRecord(value) && typeof value["type"] === "string" && typeof value["source"] === "string" && typeof value["target"] === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
