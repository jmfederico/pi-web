import { execFile } from "node:child_process";
import { copyFile, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, afterEach, describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const dockerEntrypoint = join(repoRoot, "docker", "pi-web-docker");

let tempDir = "";

interface CommandResult {
  stdout: string;
  stderr: string;
}

interface FakeDocker {
  binDir: string;
  logPath: string;
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "pi-web-docker-test-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("Docker command assets", () => {
  // The Docker control shell scripts intentionally support Linux and macOS hosts.
  // Keep Windows CI on static/syntax coverage instead of executing POSIX host-path and socket flows there.
  const dockerCommandIt = it.skipIf(process.platform === "win32");

  it("keeps shell entrypoints syntactically valid", async () => {
    await Promise.all([
      execUtf8("sh", ["-n", dockerEntrypoint], process.env),
      execUtf8("sh", ["-n", join(repoRoot, "docker", "install.sh")], process.env),
      execUtf8("sh", ["-n", join(repoRoot, "docker", "internal", "dev", "compose")], process.env),
      execUtf8("sh", ["-n", join(repoRoot, "docker", "internal", "host-profile.sh")], process.env),
    ]);
  });

  it("packages the canonical Docker command and internal support assets", async () => {
    const [dockerfile, devDockerfile, runtimeCompose, devCompose, installer, devWrapper, dockerignore] = await Promise.all([
      readRepoFile("docker/Dockerfile"),
      readRepoFile("docker/Dockerfile.dev"),
      readRepoFile("docker/compose.yml"),
      readRepoFile("docker/compose.dev.yml"),
      readRepoFile("docker/install.sh"),
      readRepoFile("docker/internal/dev/compose"),
      readRepoFile("docker/.dockerignore"),
    ]);

    expect(dockerfile).toContain("COPY pi-web-docker /usr/local/bin/pi-web-docker");
    expect(dockerfile).toContain("COPY internal/bin/hostexec /usr/local/bin/hostexec");
    expect(dockerfile).toContain("COPY internal/image/install-opensuse-base /usr/local/sbin/install-pi-web-opensuse-base");
    expect(devDockerfile).toContain("COPY docker/pi-web-docker /usr/local/bin/pi-web-docker");
    expect(devDockerfile).toContain("COPY docker/internal/bin/hostexec /usr/local/bin/hostexec");
    expect(dockerignore).toContain("!pi-web-docker");
    expect(dockerignore).toContain("!internal/bin/hostexec");
    expect(installer).toContain("write_asset pi-web-docker 0755");
    expect(installer).toContain("write_asset internal/host-profile.sh 0644");
    expect(installer).toContain("compose_cmd --project-name \"$compose_project_name\"");
    expect(installer).toContain("PI_WEB_DOCKER_INSTALL_DIR=$install_dir");
    expect(installer).toContain("PI_WEB_DOCKER_REF=$asset_ref");
    expect(installer).toContain("COMPOSE_PROJECT_NAME=$compose_project_name");
    expect(devWrapper).toContain("$repo_root/docker/internal/host-profile.sh");
    expect(devWrapper).toContain("--project-name \"$compose_project_name\"");
    expect(devWrapper).toContain("PI_WEB_DOCKER_DEV_REPO_ROOT=$repo_root");
    expect(devWrapper).toContain("COMPOSE_PROJECT_NAME=$compose_project_name");
    expect(runtimeCompose).toContain("PI_WEB_DOCKER_RUNTIME: \"1\"");
    expect(runtimeCompose).toContain("PI_WEB_DOCKER_MODE: runtime");
    expect(runtimeCompose).toContain("PI_WEB_DOCKER_INSTALL_DIR: ${PI_WEB_DOCKER_INSTALL_DIR:?set by docker/install.sh}");
    expect(runtimeCompose).toContain("PI_WEB_DOCKER_HELPER_IMAGE: ${PI_WEB_IMAGE:-pi-web:local}");
    expect(runtimeCompose).toContain("COMPOSE_PROJECT_NAME: ${COMPOSE_PROJECT_NAME:-pi-web}");
    expect(devCompose).toContain("PI_WEB_DOCKER_MODE: dev");
    expect(devCompose).toContain("PI_WEB_DOCKER_DEV_REPO_ROOT: ${PI_WEB_DOCKER_DEV_REPO_ROOT:?set by docker/pi-web-docker --dev}");
    expect(devCompose).toContain("PI_WEB_DOCKER_HELPER_IMAGE: ${PI_WEB_DEV_IMAGE:-pi-web:dev}");
    expect(devCompose).toContain("COMPOSE_PROJECT_NAME: ${COMPOSE_PROJECT_NAME:-pi-web-dev}");
  });

  dockerCommandIt("runs status through Docker Compose in the foreground", async () => {
    const installDir = await createRuntimeInstall();
    const fakeDocker = await installFakeDocker();

    const result = await runDockerCommand(["status"], runtimeEnv(fakeDocker, installDir));

    expect(result.stdout).toContain("fake docker compose --project-name pi-web-test --env-file .env -f compose.yml -f compose.override.yml ps");
    const log = await readFile(fakeDocker.logPath, "utf8");
    expect(log).toContain("compose version");
    expect(log).toContain("compose --project-name pi-web-test --env-file .env -f compose.yml -f compose.override.yml ps");
    expect(log).not.toContain("run -d");
  });

  dockerCommandIt("runs production host lifecycle commands through the generated runtime env", async () => {
    const installDir = await createRuntimeInstall();
    const fakeDocker = await installFakeDocker();
    const env = runtimeHostEnv(fakeDocker, installDir);

    await runDockerCommand(["start"], env);
    await runDockerCommand(["stop"], env);
    await runDockerCommand(["restart-sessiond"], env);
    await runDockerCommand(["logs", "web"], env);
    await runDockerCommand(["shell", "sessiond"], env);
    await runDockerCommand(["cli", "config", "show"], env);

    const log = await readFile(fakeDocker.logPath, "utf8");
    expect(log).toContain("compose --project-name pi-web-test --env-file .env -f compose.yml -f compose.override.yml up -d");
    expect(log).toContain("compose --project-name pi-web-test --env-file .env -f compose.yml -f compose.override.yml down");
    expect(log).toContain("compose --project-name pi-web-test --env-file .env -f compose.yml -f compose.override.yml restart sessiond");
    expect(log).toContain("compose --project-name pi-web-test --env-file .env -f compose.yml -f compose.override.yml logs -f web");
    expect(log).toContain("compose --project-name pi-web-test --env-file .env -f compose.yml -f compose.override.yml exec sessiond bash");
    expect(log).toContain("compose --project-name pi-web-test --env-file .env -f compose.yml -f compose.override.yml exec web pi-web config show");
    expect(log).not.toContain("run -d");
  });

  dockerCommandIt("ignores ambient Compose project names for runtime lifecycle commands", async () => {
    const installDir = await createRuntimeInstall();
    const fakeDocker = await installFakeDocker();

    await runDockerCommand(["status"], {
      ...runtimeHostEnv(fakeDocker, installDir),
      COMPOSE_PROJECT_NAME: "ambient-project",
    });

    const log = await readFile(fakeDocker.logPath, "utf8");
    expect(log).toContain("compose --project-name pi-web-test --env-file .env -f compose.yml -f compose.override.yml ps");
    expect(log).not.toContain("--project-name ambient-project");
  });

  dockerCommandIt("runs development commands through generated env while preserving host user ids", async () => {
    const devRoot = await createDevRepoFixture();
    const fakeDocker = await installFakeDocker();
    await installFakeUname(fakeDocker.binDir, "Darwin");
    await installFakeId(fakeDocker.binDir, 1234, 2345);
    const home = join(tempDir, "home");
    const runtimeDataDir = join(tempDir, "runtime-data");
    const runtimeEnvFile = join(tempDir, "runtime.env");
    const socketPath = join(home, ".docker", "run", "docker.sock");
    await writeFile(runtimeEnvFile, [
      "PI_WEB_UID=0",
      "PI_WEB_GID=0",
      `PI_WEB_DOCKER_DATA_DIR=${runtimeDataDir}`,
      "PI_WEB_BIND_ADDR=0.0.0.0",
      "COMPOSE_PROJECT_NAME=runtime-project",
      "",
    ].join("\n"));

    await withUnixSocket(socketPath, async () => {
      await runDockerCommand(["--dev", "status"], devHostEnv(fakeDocker, devRoot, home, { PI_WEB_DOCKER_RUNTIME_ENV_FILE: runtimeEnvFile }));
    });

    const generatedEnvPath = join(devRoot, ".pi-web", "docker-compose-dev.generated.env");
    const generatedEnv = await readFile(generatedEnvPath, "utf8");
    expect(generatedEnv).toContain("PI_WEB_UID=1234\n");
    expect(generatedEnv).toContain("PI_WEB_GID=2345\n");
    expect(generatedEnv).toContain("DOCKER_GID=0\n");
    expect(generatedEnv).toContain(`PI_WEB_DOCKER_DATA_DIR=${runtimeDataDir}\n`);
    expect(generatedEnv).toContain(`PI_WEB_DOCKER_DEV_REPO_ROOT=${devRoot}\n`);
    expect(generatedEnv).toContain("COMPOSE_PROJECT_NAME=pi-web-dev\n");
    expect(generatedEnv).toContain("PI_WEB_DEV_API_BIND_ADDR=0.0.0.0\n");
    expect(generatedEnv).not.toContain("COMPOSE_PROJECT_NAME=runtime-project");

    await withUnixSocket(socketPath, async () => {
      await runDockerCommand(["--dev", "status"], devHostEnv(fakeDocker, devRoot, home, {
        COMPOSE_PROJECT_NAME: "ambient-dev-project",
        PI_WEB_DOCKER_RUNTIME_ENV_FILE: runtimeEnvFile,
      }));
    });
    const regeneratedEnv = await readFile(generatedEnvPath, "utf8");
    expect(regeneratedEnv).toContain("COMPOSE_PROJECT_NAME=pi-web-dev\n");
    expect(regeneratedEnv).toContain(`PI_WEB_DOCKER_DATA_DIR=${runtimeDataDir}\n`);
    expect(regeneratedEnv).not.toContain("COMPOSE_PROJECT_NAME=ambient-dev-project");

    const localConfig = await readFile(join(devRoot, ".pi-web", "docker-compose-dev.local.env"), "utf8");
    expect(localConfig).toContain("docker/pi-web-docker --dev creates this file once");
    expect(localConfig).toContain("PI_WEB_UID and PI_WEB_GID default to the current host user");
    const override = await readFile(join(devRoot, ".pi-web", "docker-compose-dev.host.generated.yml"), "utf8");
    expect(override).toContain(socketPath);
    expect(override).toContain(devRoot);
    const log = await readFile(fakeDocker.logPath, "utf8");
    expect(log).toContain(`compose --project-name pi-web-dev --env-file ${generatedEnvPath} -f ${devRoot}/docker/compose.dev.yml -f ${devRoot}/.pi-web/docker-compose-dev.host.generated.yml ps`);
  });

  dockerCommandIt("rejects development commands as root unless explicitly allowed", async () => {
    const fakeDocker = await installFakeDocker();
    await installFakeId(fakeDocker.binDir, 0, 0);

    const result = await runDockerCommandAllowFailure(["--dev", "status"], {
      ...cleanProcessEnv(),
      PATH: `${fakeDocker.binDir}:${process.env["PATH"] ?? ""}`,
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("refusing to run Docker development mode as root");
  });

  dockerCommandIt("passes the root override through to the development compose helper", async () => {
    const fakeDocker = await installFakeDocker();
    await installFakeId(fakeDocker.binDir, 0, 0);
    const helperLog = join(tempDir, "dev-helper.log");
    const devRoot = await createDevRepoFixtureWithFakeHelper(helperLog);

    await runDockerCommand(["--dev", "--allow-root", "status"], {
      ...cleanProcessEnv(),
      PATH: `${fakeDocker.binDir}:${process.env["PATH"] ?? ""}`,
      PI_WEB_DOCKER_DEV_REPO_ROOT: devRoot,
    });

    expect(await readFile(helperLog, "utf8")).toBe("allow=1 args=ps\n");
  });

  dockerCommandIt("starts development detached helpers as the generated dev user", async () => {
    const devRoot = await createDevGeneratedEnv({ uid: 1234, gid: 2345, dockerGid: 3456 });
    const fakeDocker = await installFakeDocker();
    await installFakeId(fakeDocker.binDir, 1234, 2345);

    await runDockerCommand(["--dev", "restart-sessiond"], devRuntimeEnv(fakeDocker, devRoot));

    const log = await readFile(fakeDocker.logPath, "utf8");
    expect(log).toContain(`--env-file ${devRoot}/.pi-web/docker-compose-dev.generated.env`);
    expect(log).toContain("--group-add 3456");
    expect(log).toContain("--user 1234:2345");
    expect(log).toContain("PI_WEB_DOCKER_MODE=dev");
    expect(log).toContain("PI_WEB_DOCKER_ALLOW_ROOT=0");
    expect(log).toContain("PI_WEB_DOCKER_HELPER_IMAGE=pi-web:test");
    expect(log).toContain(`PI_WEB_DOCKER_DEV_REPO_ROOT=${devRoot}`);
    expect(log).toContain("COMPOSE_PROJECT_NAME=pi-web-dev-test");
    expect(log).toContain("pi-web.docker-helper.mode=dev");
    expect(log).toContain("pi-web:test pi-web-docker --dev __run-detached restart-sessiond");
    expect(log).not.toContain("--user 0:0");
  });

  dockerCommandIt("rejects inside-container commands whose explicit mode does not match the container mode", async () => {
    const result = await runDockerCommandAllowFailure(["restart-sessiond"], {
      ...cleanProcessEnv(),
      PI_WEB_DOCKER_RUNTIME: "1",
      PI_WEB_DOCKER_MODE: "dev",
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("this PI WEB Docker container is in dev mode");
  });

  dockerCommandIt("routes production install to the bootstrap installer", async () => {
    const result = await runDockerCommand(["install", "--help"], cleanProcessEnv());

    expect(result.stdout).toContain("Usage: docker/install.sh [options]");
  });

  dockerCommandIt("explains source checkout runtime-mode mistakes", async () => {
    const fakeDocker = await installFakeDocker();

    const result = await runDockerCommandAllowFailure(["start"], {
      ...cleanProcessEnv(),
      PATH: `${fakeDocker.binDir}:${process.env["PATH"] ?? ""}`,
      HOME: "/home/pi-web-test",
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("runtime install assets were not found");
    expect(result.stderr).toContain("running this checkout's Docker command in runtime mode");
    expect(result.stderr).toContain("./docker/pi-web-docker --dev start");
    expect(result.stderr).toContain("/home/pi-web-test/.local/share/pi-web-docker/pi-web-docker start");
    expect(result.stderr).toContain("PI_WEB_DOCKER_INSTALL_DIR");
  });

  dockerCommandIt("starts restart-sessiond in a detached Docker helper", async () => {
    const installDir = await createRuntimeInstall();
    const fakeDocker = await installFakeDocker();

    const result = await runDockerCommand(["restart-sessiond"], runtimeEnv(fakeDocker, installDir));

    expect(result.stdout).toContain("Started detached PI WEB Docker helper");
    expect(result.stdout).toContain("Follow progress with: docker logs -f pi-web-docker-restart-sessiond-");
    const log = await readFile(fakeDocker.logPath, "utf8");
    expect(log).toContain("container inspect");
    expect(log).toContain("run -d");
    expect(log).toContain("--env-file");
    expect(log).toContain(`${installDir}/.env`);
    expect(log).toContain("--volumes-from");
    expect(log).toContain("--group-add 3456");
    expect(log).toContain("--user 1234:2345");
    expect(log).toContain(`PI_WEB_DOCKER_INSTALL_DIR=${installDir}`);
    expect(log).toContain(`PI_WEB_DOCKER_DATA_DIR=${join(installDir, "data")}`);
    expect(log).toContain("PI_WEB_PORT=12345");
    expect(log).toContain("PI_WEB_DOCKER_EXTRA_HOST_PATHS=/srv/pi-web-extra /opt/pi-web-extra");
    expect(log).toContain("PI_WEB_EXTRA_ZYPPER_PACKAGES=git-lfs jq");
    expect(log).not.toContain('PI_WEB_EXTRA_ZYPPER_PACKAGES="git-lfs jq"');
    expect(log).toContain("PI_WEB_DOCKER_HELPER_IMAGE=pi-web:test");
    expect(log).toContain("COMPOSE_PROJECT_NAME=pi-web-test");
    expect(log).toContain("pi-web.docker-helper.mode=runtime");
    expect(log).toContain("pi-web.docker-helper.root=");
    expect(log).toContain("pi-web.docker-helper.project=pi-web-test");
    expect(log).toContain("pi-web:test pi-web-docker __run-detached restart-sessiond");
    expect(log).not.toContain("--user 0:0");
    expect(log).not.toContain("compose -f compose.yml -f compose.override.yml restart sessiond");
  });

  dockerCommandIt("executes the detached restart-sessiond action through Compose", async () => {
    const installDir = await createRuntimeInstall();
    const fakeDocker = await installFakeDocker();

    await runDockerCommand(["__run-detached", "restart-sessiond"], runtimeEnv(fakeDocker, installDir));

    const log = await readFile(fakeDocker.logPath, "utf8");
    expect(log).toContain("compose --project-name pi-web-test --env-file .env -f compose.yml -f compose.override.yml restart sessiond");
    expect(log).not.toContain("run -d");
  });

  dockerCommandIt("executes the detached runtime update action through Compose without nesting helpers", async () => {
    const installDir = await createRuntimeInstall();
    const fakeDocker = await installFakeDocker();

    await runDockerCommand(["__run-detached", "update"], runtimeEnv(fakeDocker, installDir));

    const log = await readFile(fakeDocker.logPath, "utf8");
    expect(log).toContain("compose --project-name pi-web-test --env-file .env -f compose.yml -f compose.override.yml build --pull --no-cache");
    expect(log).toContain("compose --project-name pi-web-test --env-file .env -f compose.yml -f compose.override.yml up -d --force-recreate --remove-orphans");
    expect(log).not.toContain("run -d");
  });
});

async function readRepoFile(relativePath: string): Promise<string> {
  return await readFile(join(repoRoot, relativePath), "utf8");
}

function runDockerCommand(args: string[], env: NodeJS.ProcessEnv): Promise<CommandResult> {
  return execUtf8("sh", [dockerEntrypoint, ...args], env);
}

function runDockerCommandAllowFailure(args: string[], env: NodeJS.ProcessEnv): Promise<CommandResult & { exitCode: number }> {
  return execUtf8AllowFailure("sh", [dockerEntrypoint, ...args], env);
}

function execUtf8(file: string, args: string[], env: NodeJS.ProcessEnv): Promise<CommandResult> {
  return new Promise((resolvePromise, reject) => {
    execFile(file, args, { encoding: "utf8", env }, (error, stdout, stderr) => {
      if (error !== null) {
        reject(error instanceof Error ? error : new Error("Process failed"));
        return;
      }
      resolvePromise({ stdout, stderr });
    });
  });
}

function execUtf8AllowFailure(file: string, args: string[], env: NodeJS.ProcessEnv): Promise<CommandResult & { exitCode: number }> {
  return new Promise((resolvePromise) => {
    execFile(file, args, { encoding: "utf8", env }, (error, stdout, stderr) => {
      const exitCode = typeof error === "object" && error !== null && "code" in error && typeof error.code === "number" ? error.code : 0;
      resolvePromise({ stdout, stderr, exitCode });
    });
  });
}

async function createRuntimeInstall(): Promise<string> {
  const installDir = join(tempDir, "runtime");
  await mkdir(installDir, { recursive: true });
  await writeFile(join(installDir, ".env"), [
    "PI_WEB_UID=1234",
    "PI_WEB_GID=2345",
    "DOCKER_GID=3456",
    `PI_WEB_DOCKER_DATA_DIR=${join(installDir, "data")}`,
    `PI_WEB_DOCKER_INSTALL_DIR=${installDir}`,
    "PI_WEB_DOCKER_EXTRA_HOST_PATHS=\"/srv/pi-web-extra /opt/pi-web-extra\"",
    "PI_WEB_BIND_ADDR=127.0.0.1",
    "PI_WEB_PORT=12345",
    "PI_WEB_EXTRA_ZYPPER_PACKAGES=\"git-lfs jq\"",
    "PI_WEB_IMAGE=pi-web:test",
    "COMPOSE_PROJECT_NAME=pi-web-test",
    "",
  ].join("\n"), "utf8");
  await writeFile(join(installDir, "compose.yml"), "name: pi-web\nservices: {}\n", "utf8");
  await writeFile(join(installDir, "compose.override.yml"), "services: {}\n", "utf8");
  return installDir;
}

async function createDevRepoFixture(): Promise<string> {
  const devRoot = join(tempDir, "dev-repo");
  await mkdir(join(devRoot, "docker", "internal", "dev"), { recursive: true });
  await copyFile(join(repoRoot, "docker", "internal", "dev", "compose"), join(devRoot, "docker", "internal", "dev", "compose"));
  await chmod(join(devRoot, "docker", "internal", "dev", "compose"), 0o755);
  await copyFile(join(repoRoot, "docker", "internal", "host-profile.sh"), join(devRoot, "docker", "internal", "host-profile.sh"));
  await writeFile(join(devRoot, "docker", "compose.dev.yml"), "name: pi-web-dev\nservices: {}\n", "utf8");
  return devRoot;
}

async function createDevRepoFixtureWithFakeHelper(logPath: string): Promise<string> {
  const devRoot = join(tempDir, "dev-repo-fake-helper");
  const helperPath = join(devRoot, "docker", "internal", "dev", "compose");
  await mkdir(dirname(helperPath), { recursive: true });
  await writeFile(helperPath, `#!/usr/bin/env sh
set -eu
printf 'allow=%s args=%s\n' "\${PI_WEB_DOCKER_ALLOW_ROOT:-}" "$*" >${shellSingleQuote(logPath)}
`, "utf8");
  await chmod(helperPath, 0o755);
  return devRoot;
}

async function createDevGeneratedEnv(ids: { uid: number; gid: number; dockerGid: number }): Promise<string> {
  const devRoot = join(tempDir, "dev-runtime");
  await mkdir(join(devRoot, ".pi-web"), { recursive: true });
  await writeFile(join(devRoot, ".pi-web", "docker-compose-dev.generated.env"), [
    `PI_WEB_UID=${String(ids.uid)}`,
    `PI_WEB_GID=${String(ids.gid)}`,
    `DOCKER_GID=${String(ids.dockerGid)}`,
    `PI_WEB_DOCKER_DATA_DIR=${join(tempDir, "dev-data")}`,
    `PI_WEB_DOCKER_DEV_REPO_ROOT=${devRoot}`,
    "PI_WEB_DEV_API_BIND_ADDR=127.0.0.1",
    "PI_WEB_DEV_BIND_ADDR=127.0.0.1",
    "PI_WEB_DEV_API_PORT=8504",
    "PI_WEB_DEV_PORT=8505",
    "PI_WEB_DEV_IMAGE=pi-web:test",
    "COMPOSE_PROJECT_NAME=pi-web-dev-test",
    "",
  ].join("\n"), "utf8");
  return devRoot;
}

async function installFakeDocker(): Promise<FakeDocker> {
  const binDir = join(tempDir, "bin");
  const logPath = join(tempDir, "docker.log");
  const dockerPath = join(binDir, "docker");
  await mkdir(binDir, { recursive: true });
  await writeFile(dockerPath, `#!/usr/bin/env sh
set -eu
: "\${FAKE_DOCKER_LOG:?}"
printf '%s\n' "$*" >>"$FAKE_DOCKER_LOG"
case "\${1:-}" in
  --version)
    printf 'Docker version 99.0.0, fake\n'
    exit 0
    ;;
  context)
    case "\${2:-}" in
      show)
        printf 'default\n'
        exit 0
        ;;
      inspect)
        exit 0
        ;;
    esac
    ;;
  info)
    if [ "\${2:-}" = --format ]; then
      printf 'Docker Desktop\n'
    else
      printf 'Fake Docker info\n'
    fi
    exit 0
    ;;
  compose)
    if [ "\${2:-}" = version ]; then
      exit 0
    fi
    printf 'fake docker'
    for arg in "$@"; do
      printf ' %s' "$arg"
    done
    printf '\n'
    exit 0
    ;;
  container)
    if [ "\${2:-}" = inspect ]; then
      for arg in "$@"; do
        if [ "$arg" = --format ]; then
          printf 'pi-web:test\n'
          exit 0
        fi
      done
      printf '{}\n'
      exit 0
    fi
    ;;
  ps|rm)
    exit 0
    ;;
  run)
    printf 'fake-helper-container-id\n'
    exit 0
    ;;
esac
printf 'unexpected fake docker args: %s\n' "$*" >&2
exit 9
`, "utf8");
  await chmod(dockerPath, 0o755);
  return { binDir, logPath };
}

async function installFakeUname(binDir: string, osName: string): Promise<void> {
  const unamePath = join(binDir, "uname");
  await writeFile(unamePath, `#!/usr/bin/env sh
set -eu
printf '%s\n' ${shellSingleQuote(osName)}
`, "utf8");
  await chmod(unamePath, 0o755);
}

async function installFakeId(binDir: string, uid: number, gid: number): Promise<void> {
  const idPath = join(binDir, "id");
  await writeFile(idPath, `#!/usr/bin/env sh
set -eu
case "\${1:-}" in
  -u) printf '%s\n' ${String(uid)} ;;
  -g) printf '%s\n' ${String(gid)} ;;
  *) printf '%s\n' ${String(uid)} ;;
esac
`, "utf8");
  await chmod(idPath, 0o755);
}

async function withUnixSocket<T>(socketPath: string, callback: () => Promise<T>): Promise<T> {
  await mkdir(dirname(socketPath), { recursive: true });
  const server = createServer();
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolvePromise);
  });
  try {
    return await callback();
  } finally {
    await new Promise<void>((resolvePromise) => {
      server.close(() => {
        resolvePromise();
      });
    });
    await rm(socketPath, { force: true });
  }
}

function cleanProcessEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key === "COMPOSE_PROJECT_NAME" || key === "DOCKER_GID" || key === "HOSTEXEC_IMAGE" || key.startsWith("PI_WEB_")) {
      Reflect.deleteProperty(env, key);
    }
  }
  return env;
}

function runtimeEnv(fakeDocker: FakeDocker, installDir: string): NodeJS.ProcessEnv {
  return {
    ...runtimeHostEnv(fakeDocker, installDir),
    PI_WEB_DOCKER_RUNTIME: "1",
  };
}

function runtimeHostEnv(fakeDocker: FakeDocker, installDir: string): NodeJS.ProcessEnv {
  return {
    ...cleanProcessEnv(),
    PATH: `${fakeDocker.binDir}:${process.env["PATH"] ?? ""}`,
    FAKE_DOCKER_LOG: fakeDocker.logPath,
    PI_WEB_DOCKER_RUNTIME: "0",
    PI_WEB_DOCKER_MODE: "runtime",
    PI_WEB_DOCKER_INSTALL_DIR: installDir,
  };
}

function devHostEnv(fakeDocker: FakeDocker, devRoot: string, home: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...cleanProcessEnv(),
    ...extra,
    PATH: `${fakeDocker.binDir}:${process.env["PATH"] ?? ""}`,
    HOME: home,
    DOCKER_HOST: "",
    FAKE_DOCKER_LOG: fakeDocker.logPath,
    PI_WEB_DOCKER_RUNTIME: "0",
    PI_WEB_DOCKER_MODE: "dev",
    PI_WEB_DOCKER_DEV_REPO_ROOT: devRoot,
  };
}

function devRuntimeEnv(fakeDocker: FakeDocker, devRoot: string): NodeJS.ProcessEnv {
  return {
    ...cleanProcessEnv(),
    PATH: `${fakeDocker.binDir}:${process.env["PATH"] ?? ""}`,
    FAKE_DOCKER_LOG: fakeDocker.logPath,
    PI_WEB_DOCKER_RUNTIME: "1",
    PI_WEB_DOCKER_MODE: "dev",
    PI_WEB_DOCKER_DEV_REPO_ROOT: devRoot,
    PI_WEB_DOCKER_CONTAINER_ID: "current-container",
  };
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
