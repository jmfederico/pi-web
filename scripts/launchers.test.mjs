import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { buildLaunchers, launcherTargets, minimumSupportedNodeVersion } from "./build-launchers.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MIN_NODE_VERSION = "22.19.0";

const posixIt = it.skipIf(process.platform === "win32");

/**
 * Launcher contract (SPEC D1/D2, ACCEPTANCE A2).
 *
 * Every case runs against an **installed-shaped** tree (`bin/<name>` symlinks + generated
 * `bin/<name>.sh` + `dist/cli.js` + `dist/server/*.js`), never the repository layout: the repo has
 * no `../cli.js` next to a launcher, so spawning there would exercise something users never get.
 *
 * The generated launchers get their SPEC D2 candidate lists from the fixture too. Without that,
 * whether "no runtime is discoverable" passes would depend on what the test host happens to have
 * installed at `/usr/bin/node`, which silently turned contractual cases into skips.
 *
 * Stub runtimes are POSIX shell on purpose — a stub that needed the host's node would silently
 * stop testing the "node is absent" cases. `HOME` points into the fixture because the candidate
 * list includes `$HOME/.bun/bin/bun`, which exists on real dev machines, and PATH is rebuilt as
 * `/usr/bin:/bin:<sandbox>` so the host's runtimes (fnm shims, ~/.bun/bin) cannot leak in.
 */

const tempRoots = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe.skipIf(process.platform === "win32")("launcher build", () => {
  it("emits one executable, syntax-valid launcher per package bin target", async () => {
    const outDir = await freshDir("pi-web-launcher-build-");
    const written = await buildLaunchers({ outDir, minimumNodeVersion: MIN_NODE_VERSION });

    expect(written.map((path) => path.slice(outDir.length + 1)).sort()).toEqual([
      "pi-web-server.sh",
      "pi-web-sessiond.sh",
      "pi-web.sh",
    ]);
    for (const path of written) {
      expect((await lstat(path)).mode & 0o111, `${path} must be executable`).not.toBe(0);
      const contents = await readFile(path, "utf8");
      expect(contents.startsWith("#!/usr/bin/env bash")).toBe(true);
      expect(contents).not.toContain("__TARGET__");
      expect(contents).not.toContain("__MIN_NODE_VERSION__");
      expect(contents).toContain(`MIN_NODE_VERSION="${MIN_NODE_VERSION}"`);
      expect(await exec("bash", ["-n", path], process.cwd(), {})).toMatchObject({ code: 0 });
    }
  });

  it("wires each launcher to the entrypoint its bin name promises", async () => {
    const outDir = await freshDir("pi-web-launcher-targets-");
    await buildLaunchers({ outDir, minimumNodeVersion: MIN_NODE_VERSION });

    for (const [name, target] of Object.entries(launcherTargets)) {
      const contents = await readFile(join(outDir, `${name}.sh`), "utf8");
      expect(contents).toContain(`TARGET="${target}"`);
    }
    const manifest = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));
    expect(manifest.bin).toEqual(Object.fromEntries(
      Object.keys(launcherTargets).map((name) => [name, `dist/bin/${name}.sh`]),
    ));
  });

  it("takes the node floor from package.json engines", async () => {
    await expect(minimumSupportedNodeVersion()).resolves.toBe(MIN_NODE_VERSION);
  });
});

describe.skipIf(process.platform === "win32")("launcher runtime resolution", () => {
  posixIt("prefers node when both runtimes are discoverable (npm install)", async () => {
    // The default fixture tree is npm-shaped (`prefix/lib/node_modules`), so the runtime the
    // installing package manager chose is Node.js and `auto` starts there even when a capable bun
    // is also discoverable — npm-installed machines must not silently move to Bun.
    const install = await createInstall({ bun: "capable", node: "ok", onPath: ["bun", "node"] });

    expect(await runLauncher(install, "pi-web", ["--print-runtime"])).toEqual({ code: 0, stdout: "node\n", stderr: "" });
    expect(await runLauncher(install, "pi-web", [])).toEqual({
      code: 0,
      stdout: `ran:node:${install.entryRef("../cli.js")}\nargv:\n`,
      stderr: "",
    });
  });

  posixIt("runs on bun when the package was installed with bun, even with node present", async () => {
    // The bun-shaped fixture installs under `<root>/store/install/global/node_modules` with HOME
    // pointed elsewhere, so detection is proven to come from the tree layout, not from $HOME. The
    // package manager the user installed with wins over whatever else is on PATH.
    const install = await createInstall({ shape: "bun", bun: "capable", node: "ok", onPath: ["bun", "node"] });

    expect(await runLauncher(install, "pi-web", ["--print-runtime"])).toEqual({ code: 0, stdout: "bun\n", stderr: "" });
    expect(await runLauncher(install, "pi-web", [])).toEqual({
      code: 0,
      stdout: `ran:bun:${install.entryRef("../cli.js")}\nargv:\n`,
      stderr: "",
    });
  });

  posixIt("falls back to node with a warning when the bun installation's bun lacks Bun.Terminal", async () => {
    const install = await createInstall({ shape: "bun", bun: "incapable", node: "ok", onPath: ["bun", "node"] });

    const launched = await runLauncher(install, "pi-web", []);
    expect(launched.code).toBe(0);
    expect(launched.stdout).toContain(`ran:node:${install.entryRef("../cli.js")}`);
    expect(launched.stderr).toContain("Bun.Terminal");
    expect(launched.stderr).toContain("bun upgrade");
    expect(launched.stderr).toContain("bun pm trust node-pty");
  });

  posixIt("does not execute bun when an npm install already has a usable node", async () => {
    // Performance contract: discovery must not pay a runtime startup for a runtime it will not
    // use. An npm-shaped tree with a usable Node resolves without ever executing bun.
    const install = await createInstall({ bun: "capable", node: "ok", onPath: ["bun", "node"] });

    expect(await runLauncher(install, "pi-web", ["--print-runtime"])).toMatchObject({ code: 0, stdout: "node\n" });
    await expect(readFile(`${install.stub("bun")}.ran`, "utf8")).rejects.toThrow();
    await readFile(`${install.stub("node")}.ran`, "utf8");
  });

  posixIt("does not execute node when the bun installation already has a capable bun", async () => {
    // The mirror case: a bun-shaped tree resolves on its first probe and leaves node untouched.
    const install = await createInstall({ shape: "bun", bun: "capable", node: "ok", onPath: ["bun", "node"] });

    expect(await runLauncher(install, "pi-web", ["--print-runtime"])).toMatchObject({ code: 0, stdout: "bun\n" });
    await readFile(`${install.stub("bun")}.ran`, "utf8");
    await expect(readFile(`${install.stub("node")}.ran`, "utf8")).rejects.toThrow();
  });

  posixIt("fails with actionable advice when a bun installation has no usable runtime at all", async () => {
    // A bun without Bun.Terminal cannot host terminals, and a bun install that never trusted
    // node-pty has no usable binding either, so there is nothing to fall back to: name the bun,
    // name the fix, and stop before a partial start.
    const install = await createInstall({ shape: "bun", bun: "incapable", onPath: ["bun"] });

    const result = await runLauncher(install, "pi-web", []);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Bun.Terminal");
    expect(result.stderr).toContain("bun upgrade");
    expect(result.stderr).toContain("install PI WEB with npm");

    const probe = await runLauncher(install, "pi-web", ["--print-runtime"]);
    expect(probe.code).toBe(1);
    expect(probe.stdout).toBe("");
    expect(probe.stderr).toEqual(result.stderr);
  });

  posixIt("keeps PI_WEB_RUNTIME=node above the installer preference on a bun installation", async () => {
    const install = await createInstall({ shape: "bun", bun: "capable", node: "ok", onPath: ["bun", "node"] });

    const forced = await runLauncher(install, "pi-web", [], { PI_WEB_RUNTIME: "node" });
    expect(forced.code).toBe(0);
    expect(forced.stdout).toContain("ran:node:");
    expect(forced.stderr).toBe("");
  });

  posixIt("runs on bun when the npm-installed package has no node anywhere", async () => {
    const install = await createInstall({ bun: "capable", onPath: ["bun"] });

    expect(await runLauncher(install, "pi-web-server", [])).toMatchObject({
      code: 0,
      stdout: `ran:bun:${install.entryRef("../server/index.js")}\nargv:\n`,
    });
  });

  posixIt("falls back to node when no capable bun exists anywhere", async () => {
    const install = await createInstall({ node: "ok", onPath: ["node"] });

    expect(await runLauncher(install, "pi-web-sessiond", [])).toMatchObject({
      code: 0,
      stdout: `ran:node:${install.entryRef("../server/sessiond.js")}\nargv:\n`,
    });
  });

  posixIt("finds bun through the fixed candidate paths under a manager-like PATH", async () => {
    // The service-manager environment (F6): neither runtime is on PATH, and the candidate list is
    // the fixture's own, so no host installation can decide this case. An npm install falls back
    // to a capable bun when Node.js is not usable at all.
    const install = await createInstall({ bun: "capable", atCandidate: "fixed", onPath: [] });

    const launched = await runLauncher(install, "pi-web", []);
    expect(launched.stderr).toBe("");
    expect(launched).toMatchObject({
      code: 0,
      stdout: expect.stringContaining("ran:bun:"),
    });
    expect(await runLauncher(install, "pi-web-sessiond", ["--print-runtime"])).toMatchObject({ code: 0, stdout: "bun\n" });
  });

  posixIt("exits 127 with a message naming PI_WEB_RUNTIME when nothing is discoverable", async () => {
    const install = await createInstall({ onPath: [] });

    const result = await runLauncher(install, "pi-web", []);
    expect(result.code).toBe(127);
    expect(result.stderr).toContain("PI_WEB_RUNTIME");
    expect(result.stdout).toBe("");
  });

  posixIt("honours PI_WEB_RUNTIME=bun when node is the PATH runtime", async () => {
    const install = await createInstall({ bun: "capable", node: "ok", atCandidate: "bun", onPath: ["node"] });

    expect(await runLauncher(install, "pi-web", [], { PI_WEB_RUNTIME: "bun" })).toMatchObject({
      code: 0,
      stdout: expect.stringContaining("ran:bun:"),
    });
  });

  posixIt("honours PI_WEB_RUNTIME=node on a machine that also has bun", async () => {
    const install = await createInstall({ bun: "capable", node: "ok", onPath: ["bun", "node"] });

    expect(await runLauncher(install, "pi-web", [], { PI_WEB_RUNTIME: "node" })).toMatchObject({
      code: 0,
      stdout: expect.stringContaining("ran:node:"),
    });
  });

  posixIt("rejects an invalid PI_WEB_RUNTIME with exit 2 before touching a runtime", async () => {
    const install = await createInstall({ bun: "capable", onPath: ["bun"] });

    const result = await runLauncher(install, "pi-web", [], { PI_WEB_RUNTIME: "deno" });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("PI_WEB_RUNTIME=deno");
    expect(result.stdout).toBe("");
  });

  posixIt("fails clearly when PI_WEB_RUNTIME=bun is forced but bun is missing", async () => {
    const install = await createInstall({ node: "ok", onPath: ["node"] });

    const result = await runLauncher(install, "pi-web", [], { PI_WEB_RUNTIME: "bun" });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Bun.Terminal");
    expect(result.stdout).toBe("");
  });

  posixIt("fails clearly when PI_WEB_RUNTIME=node is forced but node is too old", async () => {
    const install = await createInstall({ node: "too-old", onPath: ["node"] });

    const result = await runLauncher(install, "pi-web", [], { PI_WEB_RUNTIME: "node" });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`node >= ${MIN_NODE_VERSION}`);
  });

  posixIt("gates bun on the Bun.Terminal capability, not on bun existing", async () => {
    const install = await createInstall({ bun: "incapable", node: "ok", onPath: ["bun", "node"] });

    // auto falls through to node; a forced bun reports the capability gap instead of exec'ing it.
    expect(await runLauncher(install, "pi-web", [])).toMatchObject({ code: 0, stdout: expect.stringContaining("ran:node:") });
    const forced = await runLauncher(install, "pi-web", [], { PI_WEB_RUNTIME: "bun" });
    expect(forced.code).toBe(1);
    expect(forced.stderr).toContain("Bun.Terminal");
  });

  posixIt("prints exactly one runtime name for --print-runtime and never reaches the entrypoint", async () => {
    // npm-shaped install with both runtimes: the probe answers "node", the installer's choice.
    const install = await createInstall({ bun: "capable", node: "ok", onPath: ["bun", "node"] });

    expect(await runLauncher(install, "pi-web-server", ["--print-runtime"])).toEqual({ code: 0, stdout: "node\n", stderr: "" });
    expect(await runLauncher(install, "pi-web", ["--print-runtime"], { PI_WEB_RUNTIME: "node" })).toEqual({
      code: 0,
      stdout: "node\n",
      stderr: "",
    });

    // A bun without Bun.Terminal and no node leaves nothing usable: the probe reports the same
    // 127 the real command would, so the service and the probe cannot disagree (SPEC §8).
    const incapableProbe = await runLauncher(await createInstall({ bun: "incapable", onPath: ["bun"] }), "pi-web", ["--print-runtime"]);
    expect(incapableProbe.code).toBe(127);
    expect(incapableProbe.stdout).toBe("");

    const unresolvable = await runLauncher(await createInstall({ onPath: [] }), "pi-web", ["--print-runtime"]);
    expect(unresolvable.code).toBe(127);
    expect(unresolvable.stdout).toBe("");
  });

  posixIt("reports the same failure for --print-runtime when the package entrypoint is gone", async () => {
    // Preflight runs --print-runtime; the service runs the real command. A partial install must
    // fail both the same way, or install says "ready" about a unit that cannot start.
    const install = await createInstall({ bun: "capable", onPath: ["bun"] });
    await rm(install.entry("server/sessiond.js"));

    const real = await runLauncher(install, "pi-web-sessiond", []);
    const probe = await runLauncher(install, "pi-web-sessiond", ["--print-runtime"]);

    expect(real.code).toBe(127);
    expect(probe.code, probe.stderr).toBe(127);
    expect(probe.stdout).toBe("");
    expect(probe.stderr).toContain("entrypoint is missing or unreadable");
    expect(real.stderr).toEqual(probe.stderr);
  });

  posixIt("does not abort when HOME is unset", async () => {
    // The $HOME candidate is expanded under `set -u`; an unset HOME must skip that candidate, not
    // kill the script with an unbound-variable error before any runtime is tried.
    const install = await createInstall({ bun: "capable", onPath: ["bun"] });

    expect(await runLauncher(install, "pi-web", [], { HOME: undefined })).toMatchObject({
      code: 0,
      stdout: expect.stringContaining("ran:bun:"),
    });

    const empty = await createInstall({ onPath: [] });
    const result = await runLauncher(empty, "pi-web", [], { HOME: undefined });
    expect(result.code).toBe(127);
    expect(result.stderr).not.toContain("unbound variable");
    expect(result.stderr).toContain("PI_WEB_RUNTIME");
  });

  posixIt("reports the launcher directory it resolved, before choosing any runtime", async () => {
    // The native-service preflight uses this to prove the command it is about to exec belongs to
    // this installation: a byte-identical launcher from a second install resolves to its own
    // directory. It must work with no usable runtime and no runtime-variable validation, because
    // the identity check runs first.
    const install = await createInstall({ bun: "capable", onPath: ["bun"] });

    expect(await runLauncher(install, "pi-web-sessiond", ["--print-launcher"], { PI_WEB_RUNTIME: "nonsense" })).toMatchObject({
      code: 0,
      stdout: `${install.launcherDir}${String.fromCharCode(10)}`,
      stderr: "",
    });

    const noRuntime = await runLauncher(await createInstall({ onPath: [] }), "pi-web", ["--print-launcher"]);
    expect(noRuntime).toMatchObject({ code: 0, stdout: expect.stringContaining("/dist/bin") });
  });

  posixIt("passes user arguments through to the entrypoint untouched", async () => {
    const install = await createInstall({ bun: "capable", onPath: ["bun"] });

    expect(await runLauncher(install, "pi-web", ["doctor", "--flag", "a b"])).toMatchObject({
      code: 0,
      stdout: expect.stringContaining("argv:doctor --flag a b\n"),
    });
  });

  posixIt("resolves the entrypoint through a chain of symlinks", async () => {
    const install = await createInstall({ bun: "capable", onPath: ["bun"] });
    const real = install.launcher("pi-web");
    const middle = join(install.globalBin, "pi-web-middle.sh");
    const outer = join(install.globalBin, "pi-web-outer.sh");
    await symlink(real, middle);
    await symlink(middle, outer);

    const result = await exec(outer, [], install.root, launcherEnv(install));
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain(`ran:bun:${install.entryRef("../cli.js")}`);
  });

  posixIt("fails with a clear error when the entrypoint is missing", async () => {
    const install = await createInstall({ bun: "capable", onPath: ["bun"] });
    await rm(install.entry("cli.js"));

    const result = await runLauncher(install, "pi-web", []);
    expect(result.code).toBe(127);
    expect(result.stderr).toContain("entrypoint is missing");
  });
});

/**
 * An installed-shaped package. `shape` picks the global tree layout the launcher sees — `npm`
 * (`prefix/lib/node_modules`) or `bun` (`store/install/global/node_modules`) — and with it the
 * package manager whose runtime preference wins. `bun`/`node` name the stub to create:
 * `capable`/`incapable` drives the Bun.Terminal gate, `ok`/`too-old` drives the node floor.
 */
async function createInstall(options) {
  const root = await freshDir("pi-web-install-");
  // Shaped like `npm install -g` / `bun add -g`: a package tree whose bins live in dist/bin,
  // reached through symlinks from the global bin directory.
  const bunShaped = options.shape === "bun";
  const globalRoot = bunShaped ? join(root, "store", "install", "global") : join(root, "prefix", "lib");
  const packageDir = join(globalRoot, "node_modules", "@jmfederico", "pi-web");
  const launcherDir = join(packageDir, "dist", "bin");
  const globalBin = bunShaped ? join(root, "store", "bin") : join(root, "prefix", "bin");
  const pathDir = join(root, "sandbox", "path");
  const home = join(root, "sandbox", "home");
  const candidateDir = join(root, "sandbox", "candidates");
  await Promise.all([
    mkdir(launcherDir, { recursive: true }),
    mkdir(join(packageDir, "dist", "server"), { recursive: true }),
    mkdir(globalBin, { recursive: true }),
    mkdir(pathDir, { recursive: true }),
    mkdir(candidateDir, { recursive: true }),
    mkdir(home, { recursive: true }),
  ]);

  await Promise.all([
    writeFile(join(packageDir, "dist", "cli.js"), "cli entrypoint stub\n", "utf8"),
    writeFile(join(packageDir, "dist", "server", "index.js"), "server entrypoint stub\n", "utf8"),
    writeFile(join(packageDir, "dist", "server", "sessiond.js"), "sessiond entrypoint stub\n", "utf8"),
  ]);

  // `atCandidate` places a stub in a candidate directory instead of on PATH, which is how the
  // manager-PATH cases are exercised without touching the host's /usr/local/bin.
  const bunDirectory = options.atCandidate === "bun" ? join(home, ".bun", "bin") : options.atCandidate === "fixed" ? join(candidateDir, "bun") : pathDir;
  const nodeDirectory = options.atCandidate === "node" ? join(candidateDir, "node") : pathDir;
  if (options.bun !== undefined) {
    await writeExecutable(join(bunDirectory, "bun"), shellRuntimeStub("bun", options.bun));
  }
  if (options.node !== undefined) {
    await writeExecutable(join(nodeDirectory, "node"), shellRuntimeStub("node", options.node));
  }

  await buildLaunchers({
    outDir: launcherDir,
    minimumNodeVersion: MIN_NODE_VERSION,
    candidates: {
      bun: ['"${HOME:-/nonexistent}/.bun/bin/bun"', join(candidateDir, "bun", "bun")],
      node: [join(candidateDir, "node", "node")],
    },
  });
  for (const name of Object.keys(launcherTargets)) {
    await symlink(join(launcherDir, `${name}.sh`), join(globalBin, name));
  }

  return {
    root,
    globalBin,
    home,
    pathDir,
    launcherDir,
    candidateDir,
    /** Absolute path of a stub runtime. `${stub(kind)}.ran` exists once that runtime was executed. */
    stub: (kind) => join(kind === "bun" ? bunDirectory : nodeDirectory, kind),
    /** Absolute path of a dist entrypoint as the package ships it. */
    entry: (relativePath) => join(packageDir, "dist", ...String(relativePath).split("/")),
    /** How the launcher names that entrypoint: `$SCRIPT_DIR/<target>`, un-normalised. */
    entryRef: (target) => `${launcherDir}/${target}`,
    launcher: (name) => join(launcherDir, `${name}.sh`),
  };
}

function launcherEnv(install, extra = {}) {
  // The sandbox PATH comes first so a stub always wins over anything the host has; /usr/bin:/bin
  // stays behind it for the shell utilities the launcher itself needs. `HOME: undefined` deletes
  // the key (an unset HOME), which is a case of its own.
  const environment = { PATH: `${install.pathDir}:/usr/bin:/bin`, HOME: install.home, ...extra };
  return Object.fromEntries(Object.entries(environment).filter(([, value]) => value !== undefined));
}

function runLauncher(install, name, args, extra = {}) {
  return exec(join(install.globalBin, name), args, install.root, launcherEnv(install, extra));
}

/**
 * Stub runtime in POSIX shell. It answers the launcher's two `-e` probes (Bun.Terminal capability
 * and the node floor — read out of the probe script itself, so a wrong floor in the launcher is
 * caught) and otherwise stamps the file it was asked to run, which is what proves TARGET and the
 * symlink resolution.
 */
function shellRuntimeStub(kind, behaviour) {
  const version = behaviour === "too-old" ? "20.0.0" : "24.0.0";
  const capabilityExit = behaviour === "incapable" ? "1" : "0";
  return [
    "#!/bin/sh",
    `# Stub ${kind} runtime (behaviour: ${behaviour}).`,
    // Records every execution next to itself, so a test can prove a runtime was never started.
    "printf 'x' >> \"$0.ran\" 2>/dev/null || true",
    'if [ "$1" = "-e" ]; then',
    '  case "$2" in',
    `    *Bun.Terminal*) exit ${capabilityExit} ;;`,
    "    *process.versions.node*)",
    `    wanted=${version}`,
    "    minimum=$(printf '%s' \"$2\" | grep -o '[0-9][0-9]*\\.[0-9][0-9]*\\.[0-9][0-9]*' | head -n 1)",
    '    if [ -z "$minimum" ]; then exit 0; fi',
    "    i=1",
    '    while [ "$i" -le 3 ]; do',
    '      have=$(printf \'%s\' "$wanted" | cut -d. -f"$i")',
    '      want=$(printf \'%s\' "$minimum" | cut -d. -f"$i")',
    "      have=${have:-0}; want=${want:-0}",
    '      if [ "$have" -gt "$want" ]; then exit 0; fi',
    '      if [ "$have" -lt "$want" ]; then exit 1; fi',
    "      i=$((i + 1))",
    "    done",
    "    exit 0",
    "    ;;",
    "  esac",
    "  exit 0",
    "fi",
    `printf 'ran:${kind}:%s\\n' "$1"`,
    "shift",
    `printf 'argv:%s\\n' "$*"`,
    "exit 0",
    "",
  ].join("\n");
}

async function writeExecutable(path, contents) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents, "utf8");
  await chmod(path, 0o755);
}

function exec(file, args, cwd, env) {
  return new Promise((resolvePromise, reject) => {
    execFile(file, args, { cwd, env, encoding: "utf8", timeout: 20_000 }, (error, stdout, stderr) => {
      if (error !== null && typeof error.code !== "number") {
        reject(new Error(`Failed to run ${file} ${args.join(" ")}: ${error.message}\\n${stderr}`));
        return;
      }
      resolvePromise({ code: error === null ? 0 : error.code, stdout, stderr });
    });
  });
}

async function freshDir(prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}
