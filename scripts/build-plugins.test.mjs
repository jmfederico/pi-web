import { execFile } from "node:child_process";
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildDirectory, buildPiPackages, filesBrowserBuildConfig, findWatchDirs } from "./build-plugins.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let tempDir;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "pi-web-build-plugins-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("buildDirectory", () => {
  it("ships optional Pi packages with compiled entry graphs and unchanged manifests without including test sources", async () => {
    const source = join(tempDir, "pi-packages");
    const packageDir = join(source, "captains-log");
    await mkdir(join(packageDir, "src"), { recursive: true });
    await mkdir(join(packageDir, "dist"));
    await mkdir(join(packageDir, "test"));
    const manifest = { name: "@jmfederico/pi-captains-log", type: "module", pi: { extensions: ["./dist/index.js"] } };
    await writeFile(join(packageDir, "tsconfig.json"), JSON.stringify({ compilerOptions: { rootDir: "src", outDir: "dist" }, include: ["src/**/*.ts"] }));
    await writeFile(join(packageDir, "dist/index.js"), 'throw new Error("stale output");');
    await writeFile(join(packageDir, "dist/deleted.js"), 'throw new Error("deleted source");');
    await writeFile(join(packageDir, "test/index.test.mjs"), 'throw new Error("tests must not ship");');
    await writeFile(join(packageDir, "package.json"), JSON.stringify(manifest));
    await writeFile(join(packageDir, "src/index.ts"), 'import { name } from "./name.js"; export default function register(): string { return name; }');
    await writeFile(join(packageDir, "src/name.ts"), 'export const name: string = "Captain’s Log";');
    await writeFile(join(packageDir, "src/index.test.ts"), 'throw new Error("tests must not ship");');
    await writeFile(join(packageDir, "src/types.d.ts"), 'export type Name = string;');

    const target = join(tempDir, "dist/pi-packages");
    await buildPiPackages(source, target);
    const output = join(target, "captains-log");
    expect(await recursiveFiles(output)).toEqual(["dist/index.js", "dist/name.js", "package.json", "tsconfig.json"]);
    expect(JSON.parse(await readFile(join(output, "package.json"), "utf8"))).toEqual(manifest);
    const compiled = await import(pathToFileURL(join(output, "dist/index.js")).href);
    expect(compiled.default()).toBe("Captain’s Log");
  });

  it("materializes a symlinked file as a real file", async () => {
    const source = join(tempDir, "source");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "target.txt"), "linked content");
    await symlink(join(source, "target.txt"), join(source, "link.txt"));

    const target = join(tempDir, "out");
    await buildDirectory(source, target);

    await expect(readFile(join(target, "link.txt"), "utf8")).resolves.toBe("linked content");
    expect((await lstat(join(target, "link.txt"))).isSymbolicLink()).toBe(false);
  });

  it("materializes a symlinked directory as a real directory tree", async () => {
    const linkedDir = join(tempDir, "external-dir");
    await mkdir(linkedDir, { recursive: true });
    await writeFile(join(linkedDir, "nested.txt"), "nested content");

    const source = join(tempDir, "source");
    await mkdir(source, { recursive: true });
    await symlink(linkedDir, join(source, "link-dir"));

    const target = join(tempDir, "out");
    await buildDirectory(source, target);

    await expect(readFile(join(target, "link-dir", "nested.txt"), "utf8")).resolves.toBe("nested content");
    expect((await lstat(join(target, "link-dir"))).isSymbolicLink()).toBe(false);
  });

  it("fails the build on a broken symlink instead of silently dropping it", async () => {
    const source = join(tempDir, "source");
    await mkdir(source, { recursive: true });
    await symlink(join(tempDir, "does-not-exist.txt"), join(source, "broken.txt"));

    await expect(buildDirectory(source, join(tempDir, "out"))).rejects.toThrow();
  });

  it("guards against a symlinked directory cycling back into an ancestor", async () => {
    const source = join(tempDir, "source");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "marker.txt"), "marker content");
    // A directory symlinking into itself (or any ancestor) previously made
    // buildDirectory recurse on an ever-lengthening synthetic path
    // (source/self/self/self/...) with no termination condition.
    await symlink(source, join(source, "self"));

    const target = join(tempDir, "out");
    await expect(buildDirectory(source, target)).resolves.toEqual({ copied: 1, transpiled: 0 });

    expect(await readdir(target)).toEqual(["marker.txt"]);
  });
});

describe("Files browser build configuration", () => {
  it("uses a fixed relative ES bundle layout without source maps", () => {
    const source = resolve("pi-web-plugins/files");
    const target = join(tempDir, "files");

    expect(filesBrowserBuildConfig(source, target)).toMatchObject({
      configFile: false,
      root: source,
      base: "./",
      publicDir: false,
      build: {
        outDir: join(target, "browser"),
        emptyOutDir: true,
        copyPublicDir: false,
        target: "es2022",
        minify: true,
        cssMinify: true,
        sourcemap: false,
        assetsInlineLimit: 0,
        rollupOptions: {
          input: join(source, "pi-web-plugin.ts"),
          preserveEntrySignatures: "strict",
          output: {
            format: "es",
            entryFileNames: "pi-web-plugin.js",
            chunkFileNames: "assets/[name]-[hash].js",
            assetFileNames: "assets/[name]-[hash][extname]",
          },
        },
      },
    });
  });

  it("keeps the dedicated Files source directory in plugin watch coverage", async () => {
    const watchDirectories = await findWatchDirs(resolve("pi-web-plugins"));
    expect(watchDirectories).toContain(resolve("pi-web-plugins/files"));
  });
});

it("removes stale readiness when a rebuild fails", async () => {
  await mkdir(join(tempDir, "scripts"));
  await copyFile(join(repoRoot, "scripts/build-plugins.mjs"), join(tempDir, "scripts/build-plugins.mjs"));
  await symlink(join(repoRoot, "node_modules"), join(tempDir, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  // Empty special-plugin directories reach the missing Files manifest before any bundle work.
  for (const plugin of ["files", "terminal", "mermaid"]) {
    await mkdir(join(tempDir, "pi-web-plugins", plugin), { recursive: true });
  }
  const readyPath = join(tempDir, "dist/.plugins-ready");
  await mkdir(dirname(readyPath), { recursive: true });
  await writeFile(readyPath, "ready\n");
  await expect(execUtf8(process.execPath, ["scripts/build-plugins.mjs"], tempDir, 30_000)).rejects.toThrow(/files[/\\]package\.json/u);
  await expect(readFile(readyPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
});

function execUtf8(file, args, cwd, timeoutMs) {
  return new Promise((resolvePromise, reject) => {
    execFile(file, args, { cwd, encoding: "utf8", maxBuffer: 10 * 1024 * 1024, timeout: timeoutMs }, (error, stdout) => {
      if (error !== null) {
        reject(error instanceof Error ? error : new Error("Command failed"));
        return;
      }
      resolvePromise(stdout);
    });
  });
}

async function recursiveFiles(root, base = root) {
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...await recursiveFiles(path, base));
    else if (entry.isFile()) files.push(relative(base, path).split(sep).join("/"));
  }
  return files.sort((left, right) => left.localeCompare(right));
}
