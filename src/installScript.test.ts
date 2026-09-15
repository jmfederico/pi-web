import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const installerPath = join(repoRoot, "install.sh");
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
  tempRoots.length = 0;
});

// SPEC §4.6: bun is a supported alternative installer, but npm stays the blessed default in this
// script, and the docs must not send people at `--bun` (verified in the SPEC: `bun add -g --bun`
// does not change the bin shape that made bun installs run under Node).
describe("global install script surface", () => {
  it("keeps npm as the default and documents the bun alternative", async () => {
    const contents = await readFile(installerPath, "utf8");
    const lines = contents.split("\n");

    // The bun branch is live code, not a commented suggestion, and npm stays the default branch.
    expect(lines.filter((line) => line.includes("bun add -g @jmfederico/pi-web"))).toEqual([
      "    bun add -g @jmfederico/pi-web",
    ]);
    expect(lines.filter((line) => line.includes("bun pm trust node-pty"))).toHaveLength(1);
    expect(lines.filter((line) => line.includes("npm install -g @jmfederico/pi-web"))).toEqual([
      "    npm install -g @jmfederico/pi-web --allow-scripts=node-pty",
    ]);
    expect(contents).toContain('case "${PI_WEB_INSTALLER:-npm}"');
    expect(contents).not.toContain("bun add -g @jmfederico/pi-web --bun");
  });

  it("runs the bun alternative when PI_WEB_INSTALLER=bun and skips npm", async () => {
    const fixture = await createFixture({ bun: true });

    await execUtf8("sh", [installerPath], { ...fixture.env, PI_WEB_INSTALLER: "bun" });

    expect((await readFile(fixture.bunArgsPath, "utf8")).trim().split("\n")).toEqual(["add", "-g", "@jmfederico/pi-web"]);
    expect((await readFile(fixture.piWebArgsPath, "utf8")).trim()).toBe("install");
    await expect(readFile(fixture.npmArgsPath, "utf8")).rejects.toThrow();
  });

  it("rejects an unknown installer instead of guessing", async () => {
    const fixture = await createFixture({ bun: true });

    // Nothing may be installed on a typo: the script must fail before reaching either package manager.
    await expect(execUtf8("sh", [installerPath], { ...fixture.env, PI_WEB_INSTALLER: "deno" })).rejects.toThrow(/deno/u);
    await expect(readFile(fixture.bunArgsPath, "utf8")).rejects.toThrow();
    await expect(readFile(fixture.npmArgsPath, "utf8")).rejects.toThrow();
    await expect(readFile(fixture.piWebArgsPath, "utf8")).rejects.toThrow();
  });

  it("installs with npm when PI_WEB_INSTALLER is unset", async () => {
    const fixture = await createFixture({ bun: true });

    await execUtf8("sh", [installerPath], fixture.env);

    expect((await readFile(fixture.npmArgsPath, "utf8")).trim()).toContain("--allow-scripts=node-pty");
    await expect(readFile(fixture.bunArgsPath, "utf8")).rejects.toThrow();
  });
});

describe.skipIf(process.platform === "win32")("global install script", () => {
  it("scopes script approval to node-pty before installing services", async () => {
    const fixture = await createFixture();

    await execUtf8("sh", [installerPath], fixture.env);

    expect((await readFile(fixture.npmArgsPath, "utf8")).trim().split("\n")).toEqual([
      "install",
      "-g",
      "@jmfederico/pi-web",
      "--allow-scripts=node-pty",
    ]);
    expect((await readFile(fixture.piWebArgsPath, "utf8")).trim().split("\n")).toEqual(["install"]);
  });
});

async function createFixture(options: { bun?: boolean } = {}): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "pi-web-install-script-"));
  tempRoots.push(root);
  const npmArgsPath = join(root, "npm-args");
  const piWebArgsPath = join(root, "pi-web-args");
  const npmPath = join(root, "npm");
  const piWebPath = join(root, "pi-web");
  const bunPath = join(root, "bun");
  const bunArgsPath = join(root, "bun-args");
  const stubs: [string, string][] = [
    [npmPath, "#!/usr/bin/env sh\nprintf '%s\\n' \"$@\" > \"$FAKE_NPM_ARGS\"\n"],
    [piWebPath, "#!/usr/bin/env sh\nprintf '%s\\n' \"$@\" > \"$FAKE_PI_WEB_ARGS\"\n"],
  ];
  if (options.bun === true) {
    stubs.push([bunPath, "#!/usr/bin/env sh\nprintf '%s\\n' \"$@\" > \"$FAKE_BUN_ARGS\"\n"]);
  }
  await Promise.all(stubs.map(([path, contents]) => writeFile(path, contents).then(() => chmod(path, 0o755))));
  return {
    env: {
      ...process.env,
      PATH: `${root}:${process.env["PATH"] ?? ""}`,
      FAKE_NPM_ARGS: npmArgsPath,
      FAKE_PI_WEB_ARGS: piWebArgsPath,
      FAKE_BUN_ARGS: bunArgsPath,
    },
    npmArgsPath,
    piWebArgsPath,
    bunArgsPath,
  };
}

interface Fixture {
  env: NodeJS.ProcessEnv;
  npmArgsPath: string;
  piWebArgsPath: string;
  bunArgsPath: string;
}

function execUtf8(file: string, args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile(file, args, { env, encoding: "utf8" }, (error, stdout) => {
      if (error !== null) {
        reject(error instanceof Error ? error : new Error("Command failed"));
        return;
      }
      resolvePromise(stdout);
    });
  });
}
