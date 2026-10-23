import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const exec = promisify(execFile);

describe("Docker image tooling boundaries", () => {
  it.skipIf(process.platform === "win32")("selects the service interpreter without changing PATH inherited by child tools", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-web-service-path-"));
    try {
      const bin = join(root, "bin");
      await mkdir(bin);
      await writeFile(join(bin, "node"), "#!/bin/sh\nprintf 'project-node\\n'\n");
      await chmod(join(bin, "node"), 0o755);
      const entry = join(root, "service.cjs");
      await writeFile(entry, `
const { spawnSync } = require('node:child_process');
const child = spawnSync('node', [], { encoding: 'utf8' });
if (child.status !== 0) process.exit(1);
process.stdout.write(JSON.stringify({ path: process.env.PATH, executable: process.execPath, child: child.stdout.trim() }));
`);
      const toolPath = `${bin}:/data/home/.local/share/mise/shims:/usr/local/bin:/usr/bin:/bin`;
      // Replace only the unavailable image-owned interpreter at the process
      // boundary. The launcher and the service's child process run normally.
      const { stdout } = await exec("bash", ["--noprofile", "--norc", "-c", `
exec() {
  [ "$1" = /usr/local/lib/pi-web-node/bin/node ] || return 99
  shift
  builtin exec "$SERVICE_TEST_NODE" "$@"
}
# Establish the launcher's input after any host shell initialization.
export PATH=$SERVICE_TEST_PATH
source "$SERVICE_TEST_LAUNCHER" "$SERVICE_TEST_ENTRY"
`], {
        env: {
          PATH: toolPath,
          BASH_ENV: "",
          SERVICE_TEST_PATH: toolPath,
          SERVICE_TEST_NODE: process.execPath,
          SERVICE_TEST_LAUNCHER: resolve("docker/internal/bin/pi-web-service"),
          SERVICE_TEST_ENTRY: entry,
        },
      });
      const report: unknown = JSON.parse(stdout);
      expect(report).toEqual({ path: toolPath, executable: process.execPath, child: "project-node" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("launches Docker development entrypoints directly rather than through PATH-selected npm scripts", async () => {
    const compose = await readFile("docker/compose.dev.yml", "utf8");
    expect(compose).toContain('["pi-web-service", "scripts/dev-sessiond.mjs"]');
    expect(compose).toContain("pi-web-service scripts/dev-web.mjs");
    expect(compose).toContain("pi-web-service node_modules/vite/bin/vite.js");
    expect(compose).not.toContain("npm run");
    const runtime = await readFile("docker/compose.yml", "utf8");
    expect(runtime).toContain('["pi-web-service", "/usr/local/bin/pi-web-server"]');
    expect(runtime).toContain('["pi-web-service", "/usr/local/bin/pi-web-sessiond"]');
  });

  it("requires a verified upstream Git index instead of silently using distro Git", async () => {
    const installer = await readFile("docker/internal/image/install-ubuntu-base", "utf8");
    expect(installer).toContain("signed-by=/etc/apt/keyrings/git-core-ppa.gpg");
    expect(installer.match(/apt-get update --error-on=any/gu)).toHaveLength(2);
  });

  it("ships gh through shared mise installs with writable user upgrades and lower-precedence defaults", async () => {
    const installer = await readFile("docker/internal/image/install-ubuntu-base", "utf8");
    const packages = /packages=\(([\s\S]*?)\n\)/u.exec(installer)?.[1] ?? "";
    expect(packages).toContain("git-lfs");
    expect(packages).not.toMatch(/\bgh\b/u);
    expect(installer).toContain("/etc/mise/config.toml");
    expect(installer).toContain('gh = { version = "latest", minimum_release_age = "0s" }');
    expect(installer).toContain("MISE_DATA_DIR=/usr/local/share/pi-web/mise MISE_SHARED_INSTALL_DIRS=");
    expect(installer).toContain("mise -C / install gh");
    expect(installer).not.toMatch(/mise[^\n]*install --system/u);
    // A relative global alias would be pruned when an upgrade or user pin
    // selects /data, making mise fail against the protected shared directory.
    expect(installer).toContain('ln -sfn "$(readlink -f "$gh_global")" "$gh_global"');
    for (const path of ["docker/Dockerfile", "docker/Dockerfile.dev"]) {
      const dockerfile = await readFile(path, "utf8");
      expect(dockerfile).toContain("MISE_SHARED_INSTALL_DIRS=/usr/local/share/pi-web/mise/installs");
      expect(dockerfile).toContain("/data/home/.local/share/mise/shims:/usr/local/share/pi-web/mise/shims:");
      expect(dockerfile).toContain("MISE_PARANOID=true");
      expect(dockerfile).toContain("MISE_AUTO_INSTALL=false");
      expect(dockerfile).toContain("MISE_NOT_FOUND_SYSTEM_FALLBACK=false");
      expect(dockerfile).not.toContain("MISE_MINIMUM_RELEASE_AGE=");
    }
  });

  it("keeps expensive ownership walks out of dev startup and stamps dependencies after hooks", async () => {
    const compose = await readFile("docker/compose.dev.yml", "utf8");
    expect(compose).not.toMatch(/chown\s+-R/u);
    const dockerfile = await readFile("docker/Dockerfile.dev", "utf8");
    const hooks = dockerfile.indexOf("for script in /tmp/pi-web-custom-image.d/*.sh");
    expect(dockerfile.indexOf("/opt/pi-web-dev-dependencies/generation")).toBeGreaterThan(hooks);
    expect(dockerfile.indexOf("find /opt/pi-web-dev-dependencies/node_modules")).toBeGreaterThan(hooks);
  });
});
