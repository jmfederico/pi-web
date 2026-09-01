import { execFile } from "node:child_process";
import { copyFile, cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const publicApiDeclarationPaths = [
  "plugin-api.d.ts",
  "server-plugin-api.d.ts",
  "shared/pluginApiTypes.d.ts",
] as const;

describe("production build contents", () => {
  it("builds bundled plugins before every development sessiond entrypoint", async () => {
    const metadata: unknown = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));
    if (!isRecord(metadata) || !isRecord(metadata["scripts"])) throw new Error("package.json scripts are missing");

    const scripts = metadata["scripts"];
    expect(scripts["dev"]).toContain("npm run dev:sessiond");
    for (const scriptName of ["dev:sessiond", "start:sessiond"] as const) {
      const command = scripts[scriptName];
      if (typeof command !== "string") throw new Error(`package.json script is missing: ${scriptName}`);
      expect(command).toMatch(/^npm run build:plugins && /u);
      expect(command).toContain("src/server/sessiond.ts");
    }
  });

  // Constructing the full compiler graph can exceed Vitest's default timeout under parallel-suite CPU contention.
  it("keeps test-support modules out of the TypeScript build graph", { timeout: 15_000 }, () => {
    const buildConfig = readBuildConfig();
    const program = ts.createProgram({ rootNames: buildConfig.fileNames, options: buildConfig.options });
    const projectSources = program.getSourceFiles()
      .map((sourceFile) => normalizePath(relative(repoRoot, sourceFile.fileName)))
      .filter((path) => path.startsWith("src/"));

    expect(projectSources).toContain("src/server/app.ts");
    expect(projectSources.filter(isTestSupportPath)).toEqual([]);
  });

  it("keeps test-support artifacts out of the npm tarball", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "pi-web-package-contents-"));
    try {
      const fixtureDist = join(fixtureRoot, "dist", "server");
      await mkdir(fixtureDist, { recursive: true });
      await Promise.all([
        // Lifecycle hooks do not affect which files are packed, and npm 10 runs
        // `prepare` during `npm pack` even with `--ignore-scripts`, so strip
        // them: the fixture has no scripts/ tree for a hook to resolve.
        writeFixtureManifest(fixtureRoot),
        copyFile(join(repoRoot, "plugin-api.d.ts"), join(fixtureRoot, "plugin-api.d.ts")),
        copyFile(join(repoRoot, "server-plugin-api.d.ts"), join(fixtureRoot, "server-plugin-api.d.ts")),
        writeFile(join(fixtureRoot, "dist", "plugin-api.d.ts"), "export {};\n", "utf8"),
        writeFile(join(fixtureRoot, "dist", "server-plugin-api.d.ts"), "export {};\n", "utf8"),
        writeFile(join(fixtureDist, "app.js"), "export {};\n", "utf8"),
        writeFile(join(fixtureDist, "app.testSupport.js"), "export {};\n", "utf8"),
        writeFile(join(fixtureDist, "app.testSupport.js.map"), "{}\n", "utf8"),
      ]);

      const stdout = await runNpm(["pack", "--dry-run", "--json", "--ignore-scripts"], fixtureRoot);
      const packagedFiles = packageFilePaths(stdout);

      expect(packagedFiles).toEqual(expect.arrayContaining([
        "dist/plugin-api.d.ts",
        "dist/server-plugin-api.d.ts",
        "dist/server/app.js",
        "plugin-api.d.ts",
        "server-plugin-api.d.ts",
      ]));
      expect(packagedFiles).not.toContain("dist/plugin-api/unstable.d.ts");
      expect(packagedFiles).not.toContain("plugin-api/unstable.d.ts");
      expect(packagedFiles.filter(isTestSupportPath)).toEqual([]);
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("exports and maps only the supported type-only plugin API subpaths", async () => {
    const metadata: unknown = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));
    if (!isRecord(metadata)) throw new Error("package.json was not an object");

    expect(metadata["exports"]).toEqual({
      "./plugin-api": { types: "./dist/plugin-api.d.ts" },
      "./server-plugin-api": { types: "./dist/server-plugin-api.d.ts" },
    });
    expect(metadata["typesVersions"]).toEqual({
      "*": {
        "plugin-api": ["dist/plugin-api.d.ts"],
        "server-plugin-api": ["dist/server-plugin-api.d.ts"],
      },
    });
  });

  it("matches the committed browser and server plugin API declaration baseline", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "pi-web-plugin-api-baseline-"));
    try {
      emitPluginApiDeclarations(fixtureRoot);
      for (const declarationPath of publicApiDeclarationPaths) {
        const [actual, baseline] = await Promise.all([
          readFile(join(fixtureRoot, declarationPath), "utf8"),
          readFile(join(repoRoot, "test-fixtures", "plugin-api-baseline", declarationPath), "utf8"),
        ]);
        expect(
          normalizeLineEndings(actual),
          `${declarationPath} changed; update the baseline only for an intentional public API change`,
        ).toBe(normalizeLineEndings(baseline));
        expect(
          actual,
          `${declarationPath} must not expose the host-internal terminal command-run filter`,
        ).not.toContain("TerminalCommandRunFilter");
      }
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  // This exercises the same command a clean development startup runs, including
  // typechecking, copying package metadata, and transpiling the complete import graph.
  it("builds package-complete importable bundled server plugins without prior output", { timeout: 60_000 }, async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "pi-web-clean-plugin-build-"));
    try {
      await createCleanPluginBuildFixture(fixtureRoot);
      await runNpm(["run", "build:plugins"], fixtureRoot, 60_000);

      const sourcePlugins = await bundledServerPlugins(join(fixtureRoot, "pi-web-plugins"));
      const builtPluginsRoot = join(fixtureRoot, "dist", "pi-web-plugins");
      const builtPlugins = await bundledServerPlugins(builtPluginsRoot);
      expect(sourcePlugins.length).toBeGreaterThan(0);
      expect(sourcePlugins.every((plugin) => plugin.moduleType === "module")).toBe(true);
      expect(builtPlugins).toEqual(sourcePlugins);

      for (const plugin of builtPlugins) {
        const moduleUrl = pathToFileURL(join(builtPluginsRoot, plugin.packageDirectory, plugin.serverModule));
        moduleUrl.searchParams.set("cleanBuild", plugin.id);
        const imported: unknown = await import(moduleUrl.href);
        if (!isRecord(imported)) throw new Error(`Built server plugin did not import as a module: ${plugin.id}`);
        const pluginExport = imported["default"];
        if (!isRecord(pluginExport)) throw new Error(`Built server plugin has no default object export: ${plugin.id}`);
        expect(pluginExport["apiVersion"]).toBe(1);
        expect(typeof pluginExport["activate"]).toBe("function");
      }

      const stdout = await runNpm(["pack", "--dry-run", "--json", "--ignore-scripts"], fixtureRoot);
      const packagedFiles = packageFilePaths(stdout);
      const builtPluginFiles = (await recursiveFiles(builtPluginsRoot))
        .map((path) => normalizePath(relative(fixtureRoot, path)))
        .sort();
      expect(packagedFiles.filter((path) => path.startsWith("dist/pi-web-plugins/")).sort()).toEqual(builtPluginFiles);
      expect(builtPluginFiles.some((path) => /\.(?:test|spec)\./u.test(path))).toBe(false);
      expect(builtPluginFiles.some((path) => path.includes("/relays/"))).toBe(false);

      // pi-packages/ ships Pi packages (like relays) alongside bundled plugins
      // without becoming a bundled/local discovery root for them (see
      // PiWebPluginCatalog). The same clean build:plugins command still emits
      // them into their own dist directory and packs them into the tarball.
      const builtPackagesRoot = join(fixtureRoot, "dist", "pi-packages");
      const builtPackageFiles = (await recursiveFiles(builtPackagesRoot))
        .map((path) => normalizePath(relative(fixtureRoot, path)))
        .sort();
      expect(builtPackageFiles).toContain("dist/pi-packages/relays/package.json");
      expect(builtPackageFiles).toContain("dist/pi-packages/relays/pi-web-plugin.js");
      expect(builtPackageFiles).toContain("dist/pi-packages/relays/prompts/relay.md");
      expect(builtPackageFiles).toContain("dist/pi-packages/relays/prompts/relay-worktree.md");
      expect(builtPackageFiles).toContain("dist/pi-packages/relays/skills/relay/SKILL.md");
      expect(builtPackageFiles).toContain("dist/pi-packages/relays/skills/relay-runner/SKILL.md");
      expect(builtPackageFiles.some((path) => /\.(?:test|spec)\./u.test(path))).toBe(false);
      expect(packagedFiles.filter((path) => path.startsWith("dist/pi-packages/")).sort()).toEqual(builtPackageFiles);

      const builtRelaysPackage: unknown = JSON.parse(
        await readFile(join(builtPackagesRoot, "relays", "package.json"), "utf8"),
      );
      if (!isRecord(builtRelaysPackage)) throw new Error("Built relays package metadata was not an object");
      expect(builtRelaysPackage["name"]).toBe("@jmfederico/pi-relay");
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });
});

interface BundledServerPlugin {
  packageDirectory: string;
  id: string;
  serverModule: string;
  moduleType: unknown;
}

async function createCleanPluginBuildFixture(fixtureRoot: string): Promise<void> {
  await mkdir(join(fixtureRoot, "scripts"), { recursive: true });
  await Promise.all([
    cp(join(repoRoot, "src"), join(fixtureRoot, "src"), { recursive: true }),
    cp(join(repoRoot, "pi-web-plugins"), join(fixtureRoot, "pi-web-plugins"), { recursive: true }),
    cp(join(repoRoot, "pi-packages"), join(fixtureRoot, "pi-packages"), { recursive: true }),
    copyFile(join(repoRoot, "package.json"), join(fixtureRoot, "package.json")),
    copyFile(join(repoRoot, "tsconfig.json"), join(fixtureRoot, "tsconfig.json")),
    copyFile(join(repoRoot, "tsconfig.plugins.json"), join(fixtureRoot, "tsconfig.plugins.json")),
    copyFile(join(repoRoot, "scripts", "build-plugins.mjs"), join(fixtureRoot, "scripts", "build-plugins.mjs")),
    // npm 10 runs `prepare` even under `pack --ignore-scripts`; the hook installer exits 0 without a .git directory.
    copyFile(join(repoRoot, "scripts", "install-git-hooks.mjs"), join(fixtureRoot, "scripts", "install-git-hooks.mjs")),
    symlink(
      join(repoRoot, "node_modules"),
      join(fixtureRoot, "node_modules"),
      process.platform === "win32" ? "junction" : "dir",
    ),
  ]);
}

async function bundledServerPlugins(pluginsRoot: string): Promise<BundledServerPlugin[]> {
  const plugins: BundledServerPlugin[] = [];
  for (const entry of await readdir(pluginsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const metadata: unknown = JSON.parse(await readFile(join(pluginsRoot, entry.name, "package.json"), "utf8"));
    if (!isRecord(metadata)) throw new Error(`Bundled plugin package metadata is invalid: ${entry.name}`);
    const piWeb = metadata["piWeb"];
    if (!isRecord(piWeb)) continue;
    const declarations = piWeb["plugins"];
    if (!Array.isArray(declarations)) throw new Error(`Bundled plugin declarations are invalid: ${entry.name}`);

    for (const declaration of declarations) {
      if (!isRecord(declaration)) throw new Error(`Bundled plugin declaration is invalid: ${entry.name}`);
      const serverModule = declaration["serverModule"];
      if (serverModule === undefined) continue;
      const id = declaration["id"];
      if (typeof id !== "string" || typeof serverModule !== "string") {
        throw new Error(`Bundled server plugin declaration is invalid: ${entry.name}`);
      }
      plugins.push({ packageDirectory: entry.name, id, serverModule, moduleType: metadata["type"] });
    }
  }
  return plugins.sort((left, right) =>
    left.packageDirectory.localeCompare(right.packageDirectory)
    || left.id.localeCompare(right.id)
    || left.serverModule.localeCompare(right.serverModule));
}

async function recursiveFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...await recursiveFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

function emitPluginApiDeclarations(outDir: string): void {
  const configPath = join(repoRoot, "tsconfig.plugin-api.json");
  const config = ts.getParsedCommandLineOfConfigFile(configPath, {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic(diagnostic) {
      throw new Error(formatDiagnostics([diagnostic]));
    },
  });
  if (config === undefined) throw new Error(`Unable to parse ${configPath}`);
  if (config.errors.length > 0) throw new Error(formatDiagnostics(config.errors));

  const program = ts.createProgram({
    rootNames: config.fileNames,
    options: { ...config.options, outDir },
  });
  const emitResult = program.emit();
  const diagnostics = [...ts.getPreEmitDiagnostics(program), ...emitResult.diagnostics];
  if (diagnostics.length > 0) throw new Error(formatDiagnostics(diagnostics));
  if (emitResult.emitSkipped) throw new Error("Plugin API declaration emit was skipped");
}

function readBuildConfig(): ts.ParsedCommandLine {
  const configPath = join(repoRoot, "tsconfig.build.json");
  const config = ts.getParsedCommandLineOfConfigFile(configPath, {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic(diagnostic) {
      throw new Error(formatDiagnostics([diagnostic]));
    },
  });
  if (config === undefined) throw new Error(`Unable to parse ${configPath}`);
  if (config.errors.length > 0) throw new Error(formatDiagnostics(config.errors));
  return config;
}

function formatDiagnostics(diagnostics: readonly ts.Diagnostic[]): string {
  return ts.formatDiagnostics(diagnostics, {
    getCanonicalFileName: (fileName) => fileName,
    getCurrentDirectory: () => repoRoot,
    getNewLine: () => "\n",
  });
}

async function writeFixtureManifest(fixtureRoot: string): Promise<void> {
  const manifest: unknown = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));
  if (!isRecord(manifest)) throw new Error("package.json was not an object");
  delete manifest["scripts"];
  await writeFile(join(fixtureRoot, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

function normalizePath(path: string): string {
  return path.split(sep).join("/");
}

function normalizeLineEndings(contents: string): string {
  return contents.replaceAll("\r\n", "\n");
}

function isTestSupportPath(path: string): boolean {
  return path.includes(".testSupport.");
}

function runNpm(args: string[], cwd: string, timeoutMs = 30_000): Promise<string> {
  const npmExecPath = process.env["npm_execpath"];
  if (npmExecPath === undefined || npmExecPath.length === 0) {
    throw new Error("npm_execpath is required to verify npm package contents");
  }
  return execUtf8(process.execPath, [npmExecPath, ...args], cwd, timeoutMs);
}

function execUtf8(file: string, args: string[], cwd: string, timeoutMs: number): Promise<string> {
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

function packageFilePaths(output: string): string[] {
  const parsed: unknown = JSON.parse(output);
  if (!Array.isArray(parsed) || parsed.length !== 1) throw new Error("npm pack returned an unexpected result");

  const packResult: unknown = parsed[0];
  if (!isRecord(packResult)) throw new Error("npm pack result was not an object");
  const filesValue = packResult["files"];
  if (!Array.isArray(filesValue)) throw new Error("npm pack result did not include files");
  const files: unknown[] = filesValue;

  return files.map((file) => {
    if (!isRecord(file) || typeof file["path"] !== "string") {
      throw new Error("npm pack returned an invalid file entry");
    }
    return file["path"];
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
