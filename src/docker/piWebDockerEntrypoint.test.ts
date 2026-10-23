import { execFile as execFileCallback } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFile = promisify(execFileCallback);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("pi-web-docker entrypoint", () => {
  // The entrypoint intentionally supports POSIX hosts, so Windows CI cannot execute it directly.
  const posixHostIt = it.skipIf(process.platform === "win32");

  posixHostIt("streams detached helper logs inline after scheduling runtime updates", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "pi-web-docker-entrypoint-"));
    try {
      const runtimeRoot = join(tempDir, "runtime");
      const binDir = join(tempDir, "bin");
      const dockerCallsPath = join(tempDir, "docker-calls.log");
      await mkdir(runtimeRoot);
      await mkdir(binDir);
      await writeFile(join(runtimeRoot, ".env"), [
        `PI_WEB_DOCKER_INSTALL_DIR=${runtimeRoot}`,
        "COMPOSE_PROJECT_NAME=pi-web-test",
        "PI_WEB_UID=1000",
        "PI_WEB_GID=1000",
        "DOCKER_GID=998",
        "PI_WEB_IMAGE=pi-web:test",
        "PI_WEB_UBUNTU_IMAGE=ubuntu:26.04",
        "PI_WEB_NODE_IMAGE=node:24-bookworm-slim",
        "PI_WEB_EXTRA_APT_PACKAGES='fd-find bat'",
        "PI_WEB_DOCKER_CLI_VERSION=29-cli",
        "PI_WEB_MISE_VERSION=2026.5.0",
        "PI_WEB_GIT_VERSION=",
        "",
      ].join("\n"));

      const fakeDockerPath = join(binDir, "docker");
      await writeFile(fakeDockerPath, fakeDockerScript(dockerCallsPath));
      await chmod(fakeDockerPath, 0o755);

      const { stdout, stderr } = await execFile(join(repoRoot, "docker/pi-web-docker"), ["update"], {
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env["PATH"] ?? ""}`,
          PI_WEB_DOCKER_RUNTIME: "1",
          PI_WEB_DOCKER_MODE: "runtime",
          PI_WEB_DOCKER_INSTALL_DIR: runtimeRoot,
          PI_WEB_DOCKER_CONTAINER_ID: "current-web-container",
        },
      });

      const output = `${stdout}${stderr}`;
      expect(output).toContain("Started detached PI WEB Docker helper: pi-web-docker-update-");
      expect(output).toContain("Streaming detached PI WEB Docker helper logs inline.");
      expect(output).toContain("Reconnect with: docker logs -f pi-web-docker-update-");
      expect(output).toContain("helper log: update in progress");
      expect(output).not.toContain("Follow progress with:");

      const dockerCalls = await readFile(dockerCallsPath, "utf8");
      expect(dockerCalls).toContain("__run-detached update");
      for (const key of ["PI_WEB_UBUNTU_IMAGE", "PI_WEB_NODE_IMAGE", "PI_WEB_EXTRA_APT_PACKAGES", "PI_WEB_DOCKER_CLI_VERSION", "PI_WEB_MISE_VERSION", "PI_WEB_GIT_VERSION"]) {
        expect(dockerCalls).toContain(`--env ${key}=`);
      }
      expect(dockerCalls).not.toMatch(/PI_WEB_OPENSUSE_IMAGE|PI_WEB_NODEJS_REPO|PI_WEB_EXTRA_ZYPPER_PACKAGES/);
      expect(dockerCalls).toMatch(/(?:^|\n)logs -f pi-web-docker-update-\d{14}-\d+(?:\n|$)/);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

function fakeDockerScript(dockerCallsPath: string): string {
  return `#!/usr/bin/env sh
set -eu
printf '%s\\n' "$*" >> ${shellQuote(dockerCallsPath)}
case "$1" in
  ps)
    exit 0
    ;;
  run)
    printf '%s\\n' fake-helper-container-id
    ;;
  logs)
    printf '%s\\n' 'helper log: update in progress'
    ;;
  inspect)
    printf '%s\\n' 0
    ;;
  rm)
    exit 0
    ;;
  *)
    printf 'unexpected docker command: %s\\n' "$*" >&2
    exit 42
    ;;
esac
`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
