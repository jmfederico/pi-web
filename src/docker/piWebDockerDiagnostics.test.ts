import { execFile as execFileCallback } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFile = promisify(execFileCallback);
const controller = resolve("docker/pi-web-docker");
const posixIt = it.skipIf(process.platform === "win32");

async function fixture(run: (root: string, env: NodeJS.ProcessEnv, calls: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "pi-web-docker-diagnostics-"));
  try {
    const bin = join(root, "bin");
    const data = join(root, "data");
    const calls = join(root, "calls");
    await mkdir(bin);
    await mkdir(data);
    await writeFile(join(data, "container.env"), "SECRET_TOKEN=never-print-this\n");
    await writeFile(join(root, ".env"), [
      `PI_WEB_DOCKER_DATA_DIR=${data}`,
      "COMPOSE_PROJECT_NAME=diagnostics-test",
      "PI_WEB_UBUNTU_IMAGE=ubuntu:26.04",
      "PI_WEB_EXTRA_APT_PACKAGES='fd-find bat'",
      "UNRELATED_SECRET=also-private",
      "",
    ].join("\n"));
    for (const name of ["compose.yml", "compose.override.yml", "compose.local.yml"]) {
      await writeFile(join(root, name), "services: {}\n");
    }
    const docker = join(bin, "docker");
    await writeFile(docker, `#!/bin/sh
printf '%s\\n' "$*" >> '${calls}'
case "$*" in
  'compose version') echo 'Docker Compose version test' ;;
  *'config --quiet') exit "\${FAIL_CONFIG:-0}" ;;
  'ps -q '*) echo test-web ;;
  'exec test-web pi-web-image-doctor') printf 'Image manifest\\nGit test; mise test; PATH test\\n' ;;
  'exec test-web sh -c '*) echo 'probe ok' ;;
  'exec '*) echo 'tool version test' ;;
  'version '*) echo 'daemon test' ;;
  '--version') echo 'Docker version test' ;;
esac
`);
    await chmod(docker, 0o755);
    await run(root, {
      ...process.env,
      PI_WEB_DOCKER_RUNTIME: "0",
      PI_WEB_DOCKER_INSTALL_DIR: root,
      PATH: `${bin}:${process.env["PATH"] ?? ""}`,
      PI_WEB_UBUNTU_IMAGE: "ubuntu:26.04@sha256:test",
    }, calls);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("Docker controller build and diagnostics", () => {
  posixIt("builds and validates without pulling Git or deploying, loading local Compose last", async () => {
    await fixture(async (root, env, calls) => {
      await execFile(controller, ["build"], { env });
      await execFile(controller, ["validate"], { env });
      const commands = await readFile(calls, "utf8");
      const prefix = "compose --project-name diagnostics-test --env-file .env -f compose.yml -f compose.override.yml -f compose.local.yml";
      expect(commands).toContain(`${prefix} build\n`);
      expect(commands).toContain(`${prefix} config --quiet\n`);
      expect(commands).toContain(`${prefix} build --check\n`);
      expect(commands).not.toMatch(/(?:up|restart|pull|run) /);
      expect(await readFile(join(root, "compose.local.yml"), "utf8")).toBe("services: {}\n");
    });
  });

  posixIt("routes dev build and validation only through the dev Compose launcher", async () => {
    await fixture(async (root, env, calls) => {
      const internal = join(root, "docker/internal/dev");
      await mkdir(internal, { recursive: true });
      const wrapper = join(internal, "compose");
      await writeFile(wrapper, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\n`);
      await chmod(wrapper, 0o755);
      const devEnv = { ...env, PI_WEB_DOCKER_DEV_REPO_ROOT: root };
      await execFile(controller, ["--dev", "--allow-root", "build"], { env: devEnv });
      await execFile(controller, ["--dev", "--allow-root", "validate"], { env: devEnv });
      expect(await readFile(calls, "utf8")).toBe("build\nconfig --quiet\nbuild --check\n");
    });
  });

  posixIt("fails validation before build checks when Compose is invalid", async () => {
    await fixture(async (_root, env, calls) => {
      await expect(execFile(controller, ["validate"], { env: { ...env, FAIL_CONFIG: "17" } })).rejects.toMatchObject({ code: 17 });
      expect(await readFile(calls, "utf8")).not.toContain("build --check");
    });
  });

  posixIt("reports safe values, sources and probes as JSON without process secrets", async () => {
    await fixture(async (root, env, calls) => {
      const { stdout } = await execFile(controller, ["doctor", "--json"], { env });
      const report: unknown = JSON.parse(stdout);
      expect(report).toHaveProperty("schemaVersion", 1);
      expect(report).toHaveProperty("diagnostics", expect.arrayContaining([
          { key: "PI_WEB_UBUNTU_IMAGE", value: env["PI_WEB_UBUNTU_IMAGE"], source: "shell environment" },
          { key: "PI_WEB_EXTRA_APT_PACKAGES", value: "fd-find bat", source: join(root, ".env") },
          { key: "PI_WEB_NODE_IMAGE", value: "node:22.22.2-bookworm-slim", source: "default" },
          { key: "container_environment", value: join(root, "data/container.env"), source: "path only; contents private" },
          { key: "image_diagnostics", value: "Image manifest\nGit test; mise test; PATH test", source: "pi-web-image-doctor" },
      ]));
      expect(stdout).not.toMatch(/never-print-this|also-private|SECRET_TOKEN|UNRELATED_SECRET/);
      const commands = await readFile(calls, "utf8");
      expect(commands).not.toMatch(/(?:compose .*config| run | up | restart )/);
      const human = await execFile(controller, ["doctor"], { env });
      expect(human.stdout).toContain("PI WEB Docker mode: runtime");
      expect(human.stdout).toContain("mise_path_health:");
      expect(human.stdout).not.toContain("never-print-this");
    });
  });

  posixIt("escapes JSON configuration values instead of emitting invalid JSON", async () => {
    await fixture(async (_root, env) => {
      const value = 'quoted" path\\with\ttab\nnext line\b\f\u0001';
      const { stdout } = await execFile(controller, ["doctor", "--json"], { env: { ...env, PI_WEB_EXTRA_APT_PACKAGES: value } });
      const report: unknown = JSON.parse(stdout);
      expect(report).toHaveProperty("diagnostics", expect.arrayContaining([
        { key: "PI_WEB_EXTRA_APT_PACKAGES", value, source: "shell environment" },
      ]));
    });
  });
});
