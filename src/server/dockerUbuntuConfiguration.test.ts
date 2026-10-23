import { execFile } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const exec = promisify(execFile);
let root = "";
let env: NodeJS.ProcessEnv;
const hostFacts = "PI_WEB_DOCKER_HOST_PROFILE=linux-native-docker\nHOSTEXEC_MODE=nsenter\nPI_WEB_DOCKER_SOCKET_SOURCE=/var/run/docker.sock\n";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pi-web-ubuntu-config-"));
  const bin = join(root, "bin");
  await mkdir(bin);
  await writeFile(join(bin, "docker"), '#!/bin/sh\nprintf "%s\\n" "$@" >> "$COMMAND_LOG"\n');
  await chmod(join(bin, "docker"), 0o755);
  env = {
    PATH: `${bin}:${process.env["PATH"] ?? ""}`,
    HOME: join(root, "home"),
    COMMAND_LOG: join(root, "commands"),
    PI_WEB_DOCKER_RUNTIME: "1",
    PI_WEB_DOCKER_ALLOW_ROOT: "1",
  };
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32")("Ubuntu Docker configuration", () => {
  it("persists new installer inputs and preserves user hooks, environment, and local Compose", async () => {
    const assets = join(root, "assets");
    const install = join(root, "install");
    const data = join(root, "data");
    for (const path of ["Dockerfile", "compose.yml", ".dockerignore", "install.sh", "pi-web-docker", "internal/bin/hostexec", "internal/image/install-ubuntu-base", "internal/bin/pi-web-service", "internal/bin/pi-web-image-doctor", "internal/bin/pi-web-reconcile-mise", "internal/image/write-manifest", "internal/host-profile.sh"]) {
      await mkdir(dirname(join(assets, path)), { recursive: true });
      if (path === "internal/host-profile.sh" || path === "install.sh") {
        await copyFile(join(repoRoot, "docker", path), join(assets, path));
      } else {
        await writeFile(join(assets, path), `# fixture ${path}\n`);
      }
    }
    await mkdir(join(install, "custom-image.d"), { recursive: true });
    await mkdir(data);
    await writeFile(join(install, ".env"), hostFacts);
    await writeFile(join(install, "custom-image.d", "10-local.sh"), "# user hook\n");
    await writeFile(join(install, "compose.local.yml"), "# user compose\n");
    await writeFile(join(data, "container.env"), "USER_SETTING=kept\n");
    const args = [join(repoRoot, "docker/install.sh"), "--install-dir", install, "--data-dir", data, "--asset-dir", assets, "--skip-compose"];
    await exec("sh", [...args, "--ubuntu-image", "ubuntu:26.04@sha256:example", "--extra-apt-packages", "jq ripgrep", "--docker-cli-version", "29-cli@sha256:example", "--mise-version", "2026.10.12", "--git-version", "1:2.53.0-test"], { env });
    // Rerunning without build flags retains the recorded inputs, not defaults.
    await exec("sh", args, { env });
    const effective = await readFile(join(install, ".env"), "utf8");
    expect(effective).toContain("PI_WEB_UBUNTU_IMAGE=ubuntu:26.04@sha256:example");
    expect(effective).toContain('PI_WEB_EXTRA_APT_PACKAGES="jq ripgrep"');
    expect(effective).toContain("PI_WEB_DOCKER_CLI_VERSION=29-cli@sha256:example");
    expect(effective).toContain("PI_WEB_NODE_IMAGE=node:22.22.2-bookworm-slim");
    expect(effective).toContain("PI_WEB_MISE_VERSION=2026.10.12");
    expect(effective).toContain("PI_WEB_GIT_VERSION=1:2.53.0-test");
    expect(effective).not.toMatch(/OPENSUSE|ZYPPER|NODEJS_REPO/u);
    expect(await readFile(join(install, "internal/bin/pi-web-service"), "utf8")).toContain("fixture");
    expect(await readFile(join(install, "internal/image/install-ubuntu-base"), "utf8")).toContain("fixture");
    expect(await readFile(join(install, "custom-image.d/10-local.sh"), "utf8")).toBe("# user hook\n");
    expect(await readFile(join(install, "compose.local.yml"), "utf8")).toBe("# user compose\n");
    expect(await readFile(join(data, "container.env"), "utf8")).toBe("USER_SETTING=kept\n");
    // Every lifecycle operation stays inside the fake Docker boundary.
    await exec("sh", args.filter((arg) => arg !== "--skip-compose"), { env });
    const commands = await readFile(join(root, "commands"), "utf8");
    expect(commands).toContain("-f\ncompose.yml\n-f\ncompose.override.yml\n-f\ncompose.local.yml\nbuild\n");
    expect(commands).toContain("-f\ncompose.local.yml\nup\n");
    expect(commands).toContain("-f\ncompose.local.yml\nps\n");
  });

  it("loads dev local Compose last and retains build-input precedence on detached invocations", async () => {
    const checkout = join(root, "checkout");
    const config = join(checkout, ".pi-web");
    await mkdir(join(checkout, "docker/internal/dev"), { recursive: true });
    await mkdir(config);
    await copyFile(join(repoRoot, "docker/internal/dev/compose"), join(checkout, "docker/internal/dev/compose"));
    await copyFile(join(repoRoot, "docker/internal/host-profile.sh"), join(checkout, "docker/internal/host-profile.sh"));
    await writeFile(join(config, "docker-compose-dev.generated.env"), `${hostFacts}PI_WEB_MISE_VERSION=2026.10.12\nPI_WEB_DOCKER_CLI_VERSION=29-cli\n`);
    const localEnv = "PI_WEB_UBUNTU_IMAGE=ubuntu:26.04\nPI_WEB_EXTRA_APT_PACKAGES=jq ripgrep\n";
    await writeFile(join(config, "docker-compose-dev.local.env"), localEnv);
    const localCompose = join(config, "docker-compose-dev.local.yml");
    await writeFile(localCompose, "# user override\n");
    const runtimeEnv = join(root, "runtime.env");
    await writeFile(runtimeEnv, "PI_WEB_GIT_VERSION=1:2.53.0-runtime\nPI_WEB_NODE_IMAGE=node:22.22.2-bookworm-slim\n");
    const devEnv = {
      ...env,
      PI_WEB_DOCKER_DATA_DIR: join(root, "data"),
      PI_WEB_DOCKER_RUNTIME_ENV_FILE: runtimeEnv,
      PI_WEB_UBUNTU_IMAGE: "ignored-shell-image",
      PI_WEB_MISE_VERSION: "ignored-shell-version",
    };
    await exec("sh", [join(checkout, "docker/internal/dev/compose"), "config"], { env: devEnv });
    const effective = await readFile(join(config, "docker-compose-dev.generated.env"), "utf8");
    expect(effective).toContain("PI_WEB_UBUNTU_IMAGE=ubuntu:26.04");
    expect(effective).toContain("PI_WEB_MISE_VERSION=2026.10.12");
    expect(effective).toContain("PI_WEB_DOCKER_CLI_VERSION=29-cli");
    expect(effective).toContain("PI_WEB_EXTRA_APT_PACKAGES=jq ripgrep");
    expect(effective).toContain("PI_WEB_GIT_VERSION=1:2.53.0-runtime");
    expect(effective).not.toMatch(/OPENSUSE|ZYPPER|NODEJS_REPO/u);
    const command = await readFile(join(root, "commands"), "utf8");
    expect(command).toContain(`-f\n${checkout}/docker/compose.dev.yml\n-f\n${config}/docker-compose-dev.host.generated.yml\n-f\n${localCompose}\nconfig\n`);
    expect(await readFile(localCompose, "utf8")).toBe("# user override\n");
    expect(await readFile(join(config, "docker-compose-dev.local.env"), "utf8")).toBe(localEnv);
  });
});
