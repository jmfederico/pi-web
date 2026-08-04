import { execFile } from "node:child_process";
import { copyFile, cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

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
      // npm 10 runs `prepare` even under `pack --ignore-scripts`; the hook installer exits 0 without a .git directory.
      await mkdir(join(fixtureRoot, "scripts"), { recursive: true });
      await Promise.all([
        copyFile(join(repoRoot, "package.json"), join(fixtureRoot, "package.json")),
        copyFile(join(repoRoot, "scripts", "install-git-hooks.mjs"), join(fixtureRoot, "scripts", "install-git-hooks.mjs")),
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
      expect(packagedFiles.filter(isTestSupportPath)).toEqual([]);
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("resolves packaged plugin declaration subpaths for NodeNext consumers", async () => {
    // TypeScript resolves declaration paths through the real path; on Windows
    // the temp dir may use an 8.3 short name, so anchor at the real path.
    const fixtureRoot = await realpath(await mkdtemp(join(tmpdir(), "pi-web-plugin-types-")));
    try {
      const packageRoot = join(fixtureRoot, "node_modules", "@jmfederico", "pi-web");
      await mkdir(join(packageRoot, "dist", "plugin-api"), { recursive: true });
      const consumerPath = join(fixtureRoot, "provider.mts");
      await Promise.all([
        copyFile(join(repoRoot, "package.json"), join(packageRoot, "package.json")),
        copyFile(join(repoRoot, "server-plugin-api.d.ts"), join(packageRoot, "server-plugin-api.d.ts")),
        copyFile(join(repoRoot, "src", "server-plugin-api.ts"), join(packageRoot, "dist", "server-plugin-api.d.ts")),
        writeFile(join(packageRoot, "dist", "plugin-api.d.ts"), "export interface PiWebPlugin { apiVersion: 1; }\n", "utf8"),
        writeFile(join(packageRoot, "dist", "plugin-api", "unstable.d.ts"), "export interface UnstablePluginRuntimeContext {}\n", "utf8"),
        writeFile(join(fixtureRoot, "package.json"), '{"private":true,"type":"module"}\n', "utf8"),
        writeFile(consumerPath, `
import type { PiWebServerPlugin } from "@jmfederico/pi-web/server-plugin-api";

const plugin: PiWebServerPlugin = {
  apiVersion: 1,
  name: "External declaration fixture",
  activate: () => ({
    workspaceProvider: {
      probe: async () => "claim",
      list: async (project) => [{ key: "main", path: project.path, label: project.name, isMain: true }],
    },
  }),
};

export default plugin;
`, "utf8"),
      ]);

      const nodeNextOptions: ts.CompilerOptions = {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
      };
      const expectedDeclarations = new Map([
        ["@jmfederico/pi-web/plugin-api", "node_modules/@jmfederico/pi-web/dist/plugin-api.d.ts"],
        ["@jmfederico/pi-web/plugin-api/unstable", "node_modules/@jmfederico/pi-web/dist/plugin-api/unstable.d.ts"],
        ["@jmfederico/pi-web/server-plugin-api", "node_modules/@jmfederico/pi-web/dist/server-plugin-api.d.ts"],
      ]);
      for (const [specifier, expected] of expectedDeclarations) {
        const resolved = ts.resolveModuleName(specifier, consumerPath, nodeNextOptions, ts.sys).resolvedModule;
        expect(resolved === undefined ? undefined : normalizePath(relative(fixtureRoot, resolved.resolvedFileName))).toBe(expected);
      }

      const program = ts.createProgram({
        rootNames: [consumerPath],
        options: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.NodeNext,
          moduleResolution: ts.ModuleResolutionKind.NodeNext,
          strict: true,
          exactOptionalPropertyTypes: true,
          noUncheckedIndexedAccess: true,
          noEmit: true,
          skipLibCheck: false,
          types: [],
        },
      });
      const diagnostics = ts.getPreEmitDiagnostics(program);
      if (diagnostics.length > 0) throw new Error(formatDiagnostics(diagnostics));

      const projectSources = program.getSourceFiles().map((sourceFile) => normalizePath(relative(fixtureRoot, sourceFile.fileName)));
      expect(projectSources).toContain("node_modules/@jmfederico/pi-web/dist/server-plugin-api.d.ts");
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

function normalizePath(path: string): string {
  return path.split(sep).join("/");
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
