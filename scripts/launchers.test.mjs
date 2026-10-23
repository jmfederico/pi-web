import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildLaunchers, launcherTargets, minimumSupportedNodeVersion } from "./build-launchers.mjs";

const roots = [];
const minimum = "22.19.0";
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

// Real shell processes own the symlink, quoting and exec contract. Discovery is
// isolated: PATH contains only fixture runtimes and the launcher's shell utilities.
const shells = [
  { name: "system sh", command: "/bin/sh", args: [] },
  { name: "Dash", command: "/bin/dash", args: [] },
  { name: "BusyBox sh", command: "/bin/busybox", args: ["sh"] },
];
for (const shell of shells) {
  describe.skipIf(process.platform === "win32" || !existsSync(shell.command))(`runtime launchers (${shell.name})`, () => launcherContract(shell));
}

function launcherContract(shell) {
  const installation = (options = {}) => createInstallation(shell, options);
  it("builds all three executable bins from one template", async () => {
    const fixture = await installation();
    for (const [name, target] of Object.entries(launcherTargets)) {
      const path = fixture.launcher(name);
      expect((await lstat(path)).mode & 0o111).not.toBe(0);
      const text = await readFile(path, "utf8");
      expect(text).toContain(`TARGET="${target}"`);
      expect(text.startsWith("#!/bin/sh\n")).toBe(true);
      expect(text).not.toMatch(/__[A-Z_]+__/u);
      expect(await execute(shell.command, [...shell.args, "-n", path], fixture.env)).toMatchObject({ code: 0 });
    }
    await expect(minimumSupportedNodeVersion()).resolves.toBe(minimum);
  });

  it.each([undefined, "", "auto"])("prefers Node with PI_WEB_RUNTIME=%s", async (runtime) => {
    const fixture = await installation({ node: "node", bun: "bun" });
    expect(await fixture.run("pi-web", ["--print-runtime"], { PI_WEB_RUNTIME: runtime })).toEqual({ code: 0, stdout: "node\n", stderr: "" });
    await expect(readFile(join(fixture.path, "bun.ran"))).rejects.toThrow();
  });

  it("starts a package command found on PATH without Bash", async () => {
    const fixture = await installation({ node: "node" });
    expect(await execute("pi-web", ["--print-runtime"], { ...fixture.env, PATH: `${fixture.bin}:${fixture.env.PATH}` }))
      .toEqual({ code: 0, stdout: "node\n", stderr: "" });
  });

  it("honors explicit runtime selection without falling back", async () => {
    const fixture = await installation({ node: "node", bun: "bun" });
    expect(await fixture.run("pi-web", ["--print-runtime"], { PI_WEB_RUNTIME: "bun" })).toMatchObject({ code: 0, stdout: "bun\n" });
    await rm(join(fixture.path, "bun"));
    const failed = await fixture.run("pi-web", [], { PI_WEB_RUNTIME: "bun" });
    expect(failed.code).toBe(127);
    expect(failed.stderr).toContain("PI_WEB_RUNTIME=bun");
    expect(failed.stdout).toBe("");
  });

  it("falls back to Bun without requiring PTY capability", async () => {
    const fixture = await installation({ node: "old-node", bun: "bun" });
    expect(await fixture.run("pi-web", ["--print-runtime"])).toMatchObject({ code: 0, stdout: "bun\n" });
    // The stub rejects any probe that asks about Bun.Terminal.
    expect(await fixture.run("pi-web", [], { PI_WEB_RUNTIME: "node" })).toMatchObject({ code: 127 });
  });

  it("detects the engine rather than trusting an executable called node", async () => {
    const fixture = await installation({ node: "bun", bun: "bun" });
    expect(await fixture.run("pi-web", ["--print-runtime"])).toMatchObject({ code: 0, stdout: "bun\n" });
    expect(await fixture.run("pi-web", [], { PI_WEB_RUNTIME: "node" })).toMatchObject({ code: 127 });
    const reverse = await installation({ bun: "node" });
    expect(await reverse.run("pi-web", ["--print-runtime"])).toMatchObject({ code: 127, stdout: "" });
  });

  it("uses fixed candidates after PATH and tolerates unset HOME", async () => {
    const fixture = await installation({ candidate: "bun" });
    expect(await fixture.run("pi-web", ["--print-runtime"], { HOME: undefined })).toMatchObject({ code: 0, stdout: "bun\n" });
  });

  it("expands the HOME candidate as one path, including spaces", async () => {
    const fixture = await installation({ homeBun: true });
    expect(await fixture.run("pi-web", ["--print-runtime"])).toMatchObject({ code: 0, stdout: "bun\n" });
  });

  it("rejects invalid selection before probing binaries", async () => {
    const fixture = await installation({ node: "node" });
    expect(await fixture.run("pi-web", [], { PI_WEB_RUNTIME: "deno" })).toMatchObject({ code: 2, stdout: "", stderr: expect.stringContaining("PI_WEB_RUNTIME=deno") });
    await expect(readFile(join(fixture.path, "node.ran"))).rejects.toThrow();
  });

  it("reports missing runtimes consistently for probing and startup", async () => {
    const fixture = await installation();
    const startup = await fixture.run("pi-web", []);
    expect(startup).toMatchObject({ code: 127, stdout: "", stderr: expect.stringContaining("PI_WEB_RUNTIME") });
    expect(await fixture.run("pi-web", ["--print-runtime"])).toEqual(startup);
  });

  it("validates entrypoints without starting them during a runtime probe", async () => {
    const fixture = await installation({ node: "node" });
    expect(await fixture.run("pi-web-sessiond", ["--print-runtime"])).toEqual({ code: 0, stdout: "node\n", stderr: "" });
    await rm(join(fixture.dist, "server", "sessiond.js"));
    const startup = await fixture.run("pi-web-sessiond", []);
    expect(startup.code).toBe(127);
    expect(startup.stderr).toContain("entrypoint is missing or unreadable");
    expect(await fixture.run("pi-web-sessiond", ["--print-runtime"])).toEqual(startup);
  });

  it.each(["node", "bun"])("checks service abilities with the selected %s interpreter without starting the service", async (engine) => {
    const fixture = await installation({ [engine]: engine });
    await writeFile(join(fixture.dist, "runtimePreflight.js"), "fixture preflight");
    expect(await fixture.run("pi-web-sessiond", ["--check-runtime"])).toEqual({
      code: 0, stdout: `ran:${engine}:${fixture.dist}/bin/../runtimePreflight.js\narg:<--terminal>\n`, stderr: "",
    });
    expect(await fixture.run("pi-web-server", ["--check-runtime"])).toEqual({
      code: 0, stdout: `ran:${engine}:${fixture.dist}/bin/../runtimePreflight.js\n`, stderr: "",
    });
    const failed = await fixture.run("pi-web-sessiond", ["--check-runtime"], { FAKE_PREFLIGHT_FAIL: "1" });
    expect(failed).toMatchObject({ code: 1, stdout: "", stderr: "native PTY unavailable\n" });
    expect(await fixture.run("pi-web-sessiond", ["--print-runtime"], { FAKE_PREFLIGHT_FAIL: "1" })).toMatchObject({ code: 0, stdout: `${engine}\n` });
    await rm(join(fixture.dist, "runtimePreflight.js"));
    expect(await fixture.run("pi-web-sessiond", ["--check-runtime"])).toMatchObject({ code: 127, stderr: expect.stringContaining("runtime preflight entrypoint is missing") });
  });

  it("resolves relative and absolute symlink chains and preserves arguments", async () => {
    const fixture = await installation({ bun: "bun" });
    await symlink("pi-web", join(fixture.bin, "middle"));
    await symlink(join(fixture.bin, "middle"), join(fixture.bin, "outer"));
    const result = await execute(shell.command, [...shell.args, join(fixture.bin, "outer"), "doctor", "a b", "", "quote'"], fixture.env);
    expect(result).toEqual({
      code: 0,
      stdout: `ran:bun:${fixture.dist}/bin/../cli.js\narg:<doctor>\narg:<a b>\narg:<>\narg:<quote'>\n`,
      stderr: "",
    });
    for (const [name, target] of Object.entries(launcherTargets)) {
      expect(await fixture.run(name, [])).toMatchObject({ code: 0, stdout: `ran:bun:${fixture.dist}/bin/${target}\n` });
    }
  });

  it("reports its resolved launcher directory without runtime selection", async () => {
    const fixture = await installation();
    expect(await fixture.run("pi-web", ["--print-launcher"], { PI_WEB_RUNTIME: "invalid" })).toEqual({ code: 0, stdout: `${fixture.dist}/bin\n`, stderr: "" });
  });
}

async function createInstallation(shell, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "pi-web launcher-"));
  roots.push(root);
  const dist = join(root, "package", "dist");
  const bin = join(root, "bin");
  const path = join(root, "path");
  const candidates = join(root, "candidates");
  await Promise.all([dist, bin, path, candidates, join(dist, "server")].map((directory) => mkdir(directory, { recursive: true })));
  // No host runtime can leak into PATH, including /usr/bin/node.
  for (const command of ["dirname", "readlink"]) {
    await symlink(`/usr/bin/${command}`, join(path, command));
  }
  for (const name of ["node", "bun"]) {
    if (options[name]) await executable(join(path, name), runtimeStub(options[name]));
  }
  if (options.candidate) await executable(join(candidates, options.candidate), runtimeStub(options.candidate));
  if (options.homeBun) await executable(join(root, ".bun", "bin", "bun"), runtimeStub("bun"));
  const quoted = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  await buildLaunchers({
    outDir: join(dist, "bin"), minimumNodeVersion: minimum,
    candidates: { node: [quoted(join(candidates, "node"))],
      bun: options.homeBun ? ['"${HOME:-/nonexistent}/.bun/bin/bun"'] : [quoted(join(candidates, "bun"))] },
  });
  for (const name of Object.keys(launcherTargets)) await symlink(`../package/dist/bin/${name}.sh`, join(bin, name));
  for (const entry of ["cli.js", "server/index.js", "server/sessiond.js"]) await writeFile(join(dist, entry), "fixture entrypoint");
  const env = { PATH: path, HOME: root };
  return {
    path, dist, bin, env,
    launcher: (name) => join(dist, "bin", `${name}.sh`),
    run: (name, args, extra = {}) => execute(shell.command, [...shell.args, join(bin, name), ...args], Object.fromEntries(Object.entries({ ...env, ...extra }).filter(([, value]) => value !== undefined))),
  };
}

function runtimeStub(engine) {
  return `#!/bin/sh
printf x >> "$0.ran"
if [ "$1" = -e ]; then
  case "$2" in
    *Bun.Terminal*) exit 1 ;;
    *'!process.versions.node'*) ${engine === "node" ? "exit 0" : "exit 1"} ;;
    *'process.versions.bun ?'*) ${engine === "bun" ? "exit 0" : "exit 1"} ;;
  esac
  exit 1
fi
case "$1" in
  */runtimePreflight.js) if [ "$FAKE_PREFLIGHT_FAIL" = 1 ]; then printf 'native PTY unavailable\\n' >&2; exit 1; fi ;;
esac
printf 'ran:${engine}:%s\\n' "$1"
shift
for arg in "$@"; do printf 'arg:<%s>\\n' "$arg"; done
`;
}

async function executable(path, content) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
  await chmod(path, 0o755);
}

function execute(file, args, env) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { env, encoding: "utf8", timeout: 10_000 }, (error, stdout, stderr) => {
      if (error && typeof error.code !== "number") return reject(error);
      resolve({ code: error?.code ?? 0, stdout, stderr });
    });
  });
}
