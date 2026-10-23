import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import { PI_WEB_PI_PACKAGE_DIR_ENV, selectPiRuntimePackageDir } from "./piRuntime.js";

const exec = promisify(execFile);
const sdkName = "@earendil-works/pi-coding-agent";
const temporaryDirectories: string[] = [];

async function workspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-web-runtime-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function packageFixture(directory: string, name = sdkName, version = "1.0.0"): Promise<string> {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "package.json"), JSON.stringify({
    name, version, type: "module", bin: { pi: "bin/pi.js" },
    exports: { ".": "./index.js", "./public": "./public.js" },
  }));
  await writeFile(join(directory, "index.js"), `export const identity = ${JSON.stringify(directory)};`);
  await writeFile(join(directory, "public.js"), 'export const value = "public";');
  return directory;
}

async function executableFixture(root: string, bin: string): Promise<void> {
  await mkdir(join(root, "bin"), { recursive: true });
  const target = join(root, "bin", "pi.js");
  await writeFile(target, "#!/usr/bin/env node\n");
  await chmod(target, 0o755);
  await mkdir(bin, { recursive: true });
  await symlink(target, join(bin, process.platform === "win32" ? "pi.cmd" : "pi"));
}

function missingLocalSdk(): never {
  throw Object.assign(new Error("SDK not installed locally"), { code: "ERR_MODULE_NOT_FOUND" });
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Pi package selection", () => {
  it("prefers the explicit host and preserves a stable package-manager symlink", async () => {
    const directory = await workspace();
    const host = await packageFixture(join(directory, "host"));
    const alias = join(directory, "alias");
    await symlink(host, alias);
    expect(await selectPiRuntimePackageDir({
      env: { [PI_WEB_PI_PACKAGE_DIR_ENV]: alias, PATH: directory },
      resolveLocalSdk: () => { throw new Error("Must not resolve locally"); },
    })).toBe(alias);
  });

  it.each(["", "missing", "wrong-package", "malformed"])("rejects explicit %s without fallback", async (kind) => {
    const directory = await workspace();
    const invalid = kind === "" ? "" : join(directory, kind);
    if (kind === "wrong-package") await packageFixture(invalid, "unrelated");
    if (kind === "malformed") {
      await mkdir(invalid);
      await writeFile(join(invalid, "package.json"), "{");
    }
    await expect(selectPiRuntimePackageDir({
      env: { [PI_WEB_PI_PACKAGE_DIR_ENV]: invalid },
      resolveLocalSdk: () => { throw new Error("Must not fall back"); },
    })).rejects.toThrow(`Invalid ${PI_WEB_PI_PACKAGE_DIR_ENV}`);
  });

  it("uses ordinary npm resolution before an unrelated Pi on PATH", async () => {
    const directory = await workspace();
    const local = await packageFixture(join(directory, "local"));
    const pathHost = await packageFixture(join(directory, "path-host"));
    const bin = join(directory, "bin");
    await executableFixture(pathHost, bin);
    expect(await selectPiRuntimePackageDir({
      env: { PATH: bin }, resolveLocalSdk: () => pathToFileURL(join(local, "index.js")).href,
    })).toBe(local);
  });

  it("follows the PATH executable to the SDK when npm has no local peer", async () => {
    const directory = await workspace();
    const host = await packageFixture(join(directory, "host"));
    const bin = join(directory, "bin");
    await executableFixture(host, bin);
    expect(await selectPiRuntimePackageDir({
      env: { PATH: [join(directory, "absent"), bin].join(delimiter) }, resolveLocalSdk: missingLocalSdk,
    })).toBe(await realpath(host));
  });

  it("finds the SDK beside an npm Windows command shim", async () => {
    const directory = await workspace();
    const prefix = join(directory, "npm-prefix");
    const host = await packageFixture(join(prefix, "node_modules", sdkName));
    await writeFile(join(prefix, "pi.cmd"), '@ECHO OFF\r\n');
    await chmod(join(prefix, "pi.cmd"), 0o755);
    expect(await selectPiRuntimePackageDir({
      env: { PATH: prefix }, platform: "win32", resolveLocalSdk: missingLocalSdk,
    })).toBe(await realpath(host));
  });

  it("does not silently replace an unsupported PATH Pi with a later installation", async () => {
    const directory = await workspace();
    const firstBin = join(directory, "first");
    const laterBin = join(directory, "later");
    await executableFixture(join(directory, "standalone"), firstBin);
    const laterHost = await packageFixture(join(directory, "later-host"));
    await executableFixture(laterHost, laterBin);
    await expect(selectPiRuntimePackageDir({
      env: { PATH: [firstBin, laterBin].join(delimiter) }, resolveLocalSdk: missingLocalSdk,
    })).rejects.toThrow("PI WEB will not select a different Pi");
  });

  it("does not hide a broken npm dependency behind a PATH fallback", async () => {
    const failure = Object.assign(new Error("Broken package exports"), { code: "ERR_INVALID_PACKAGE_CONFIG" });
    await expect(selectPiRuntimePackageDir({
      env: {}, resolveLocalSdk: () => { throw failure; },
    })).rejects.toBe(failure);
  });

  it("reports missing SDKs with the standalone-binary limitation", async () => {
    await expect(selectPiRuntimePackageDir({
      env: { PATH: "" }, resolveLocalSdk: missingLocalSdk,
    })).rejects.toThrow("Standalone Pi binaries without an SDK package are not supported");
  });
});

it("loads the selected public SDK/AI graph without changing other Node imports and follows upgrades on restart", async () => {
  const directory = await workspace();
  const firstHost = await packageFixture(join(directory, "host-v1"));
  // No version gate: a future major is selected just like the earlier release.
  const nextHost = await packageFixture(join(directory, "host-v99"), sdkName, "99.0.0");
  for (const host of [firstHost, nextHost]) {
    await packageFixture(join(host, "node_modules", "@earendil-works/pi-ai"), "@earendil-works/pi-ai");
  }
  const selectedHost = join(directory, "selected-host");
  await symlink(firstHost, selectedHost);
  const application = await packageFixture(join(directory, "app"), "test-application");
  const localSdk = await packageFixture(join(application, "node_modules", sdkName));
  const unrelated = await packageFixture(join(application, "node_modules", "unrelated"), "unrelated");
  // Only compile the import boundary. Native Node must do the real ESM resolution,
  // without Vitest aliases or a process-wide hook changing unrelated imports.
  const source = await readFile(new URL("./piRuntime.ts", import.meta.url), "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  });
  await writeFile(join(application, "piRuntime.js"), output.outputText);
  const resolverRoot = dirname(fileURLToPath(import.meta.resolve("import-meta-resolve/package.json")));
  await symlink(resolverRoot, join(application, "node_modules", "import-meta-resolve"));
  await writeFile(join(application, "probe.js"), `
    import assert from 'node:assert/strict';
    import { join } from 'node:path';
    import { loadPiSdk, loadPiAi, resolvePiRuntimeImport, piRuntimeCliPath } from './piRuntime.js';
    const sdk = await loadPiSdk();
    assert.equal(await loadPiSdk(), sdk);
    const ai = await loadPiAi();
    assert.equal(await loadPiAi(), ai);
    assert.equal(ai.identity, join(sdk.identity, 'node_modules', '@earendil-works/pi-ai'));
    assert.equal((await import(await resolvePiRuntimeImport('${sdkName}/public'))).value, 'public');
    await assert.rejects(resolvePiRuntimeImport('${sdkName}/private'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
    assert.equal((await import('${sdkName}')).identity, ${JSON.stringify(localSdk)});
    assert.equal((await import('unrelated')).identity, ${JSON.stringify(unrelated)});
    assert.equal(process.env.PI_WEB_PI_PACKAGE_DIR, ${JSON.stringify(selectedHost)});
    assert.equal(await piRuntimeCliPath(), ${JSON.stringify(join(selectedHost, "bin", "pi.js"))});
    console.log(sdk.identity);
  `);
  const run = () => exec(process.execPath, [join(application, "probe.js")], {
    env: { ...process.env, [PI_WEB_PI_PACKAGE_DIR_ENV]: selectedHost, NODE_OPTIONS: "" },
  });
  expect((await run()).stdout.trim()).toBe(firstHost);
  await unlink(selectedHost);
  await symlink(nextHost, selectedHost);
  expect((await run()).stdout.trim()).toBe(nextHost);
});
