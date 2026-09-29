#!/usr/bin/env node
import { watch } from "node:fs";
import { copyFile, mkdir, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { build as viteBuild } from "vite";

const bundledPluginsSourceDir = resolve("pi-web-plugins");
const bundledPluginsOutputDir = resolve("dist/pi-web-plugins");
const filesPluginSourceDir = resolve(bundledPluginsSourceDir, "files");
const filesPluginOutputDir = resolve(bundledPluginsOutputDir, "files");
const terminalPluginSourceDir = resolve(bundledPluginsSourceDir, "terminal");
const terminalPluginOutputDir = resolve(bundledPluginsOutputDir, "terminal");
const mermaidPluginSourceDir = resolve(bundledPluginsSourceDir, "mermaid");
const mermaidPluginOutputDir = resolve(bundledPluginsOutputDir, "mermaid");

// Two independent source trees ship inside the npm package: bundled PI WEB
// plugins (discovered by directory scan, see PiWebPluginCatalog) and Pi
// packages that ship alongside them without being discovered that way (for
// example a Pi package that is installed rather than scanned). They retain
// separate output roots so neither becomes a discovery root for the other.
// Files, Terminal, and Mermaid are exceptions to plain transpilation: each
// browser entry is replaced below by a self-contained bundle. Terminal also
// keeps a package-local transpiled server graph. Captain's Log likewise bundles
// its browser entry after transpiling its standalone package graph.
const buildTargets = [
  { rootDir: bundledPluginsSourceDir, outDir: bundledPluginsOutputDir, label: "plugin" },
  { rootDir: resolve("pi-packages"), outDir: resolve("dist/pi-packages"), label: "package" },
];
const watchMode = process.argv.includes("--watch");
const cwd = process.cwd();

if (isDirectExecution()) {
  if (watchMode) {
    await watchAndBuild();
  } else {
    await buildAll();
  }
}

async function buildAll() {
  // Cold-start readiness only; the supported restart command orders web before sessiond.
  const readyPath = resolve("dist", ".plugins-ready");
  await rm(readyPath, { force: true });
  for (const target of buildTargets) {
    await rm(target.outDir, { recursive: true, force: true });
    const excludedDirectories = target.rootDir === bundledPluginsSourceDir
      ? new Set([
          await realpath(filesPluginSourceDir),
          await realpath(terminalPluginSourceDir),
          await realpath(mermaidPluginSourceDir),
        ])
      : new Set();
    const result = target.label === "package"
      ? await buildPiPackages(target.rootDir, target.outDir)
      : await buildDirectory(target.rootDir, target.outDir, new Set(), excludedDirectories);
    if (target.rootDir === bundledPluginsSourceDir) {
      await buildFilesBrowserPackage(filesPluginSourceDir, filesPluginOutputDir);
      await buildTerminalPackage(terminalPluginSourceDir, terminalPluginOutputDir);
      await buildMermaidPackage(mermaidPluginSourceDir, mermaidPluginOutputDir);
    } else {
      await viteBuild({
        configFile: resolve(target.rootDir, "captains-log/vite.config.mjs"),
        logLevel: "silent",
        build: { outDir: resolve(target.outDir, "captains-log/dist/browser") },
      });
    }
    const suffix = result.transpiled === 1 ? "file" : "files";
    const bundleSuffix = target.rootDir === bundledPluginsSourceDir ? " and the Files/Terminal/Mermaid browser bundles" : "";
    console.log(`[plugins] built ${String(result.transpiled)} TypeScript ${target.label} ${suffix}${bundleSuffix} into ${relative(cwd, target.outDir)}`);
  }
  await writeFile(readyPath, "ready\n");
  process.send?.({ type: "plugin-build-ready" });
}

// Packages with a standalone tsconfig retain their own src -> dist layout.
// Rebuild that graph rather than copying locally generated (possibly stale) JS.
export async function buildPiPackages(sourceDir, targetDir) {
  const result = { copied: 0, transpiled: 0 };
  for (const entry of await readDirectory(sourceDir)) {
    if (!entry.isDirectory() || entry.name === "node_modules") continue;
    const packageDir = resolve(sourceDir, entry.name);
    const outputDir = resolve(targetDir, entry.name);
    const configPath = resolve(packageDir, "tsconfig.json");
    let configText;
    try {
      configText = await readFile(configPath, "utf8");
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
    }
    let built;
    if (configText === undefined) {
      built = await buildDirectory(packageDir, outputDir);
    } else {
      const json = ts.parseConfigFileTextToJson(configPath, configText);
      if (json.error) throw new Error(formatDiagnostics([json.error]));
      const config = ts.parseJsonConfigFileContent(json.config, ts.sys, packageDir);
      if (config.errors.length > 0) throw new Error(formatDiagnostics(config.errors));
      const { rootDir, outDir } = config.options;
      if (!rootDir || !outDir) throw new Error(`${configPath} must declare rootDir and outDir`);
      const sourceRoot = packageSubdirectory(packageDir, rootDir);
      const outputRoot = packageSubdirectory(packageDir, outDir);
      const copied = await buildDirectory(packageDir, outputDir, new Set(), new Set([
        await realpath(rootDir),
        await realpath(outDir).catch(() => outDir),
      ]));
      const compiled = await buildDirectory(resolve(packageDir, sourceRoot), resolve(outputDir, outputRoot));
      built = { copied: copied.copied + compiled.copied, transpiled: copied.transpiled + compiled.transpiled };
    }
    result.copied += built.copied;
    result.transpiled += built.transpiled;
  }
  return result;
}

function packageSubdirectory(packageDir, path) {
  const subdirectory = relative(packageDir, path);
  if (!subdirectory || isAbsolute(subdirectory) || subdirectory === ".." || subdirectory.startsWith(`..${sep}`)) {
    throw new Error(`Package build directory must be inside ${packageDir}: ${path}`);
  }
  return subdirectory;
}

export async function buildDirectory(sourceDir, targetDir, visited = new Set(), excludedDirectories = new Set()) {
  // Mirrors findWatchDirs's visited-realpath guard below: a symlinked
  // directory can point at one of its own ancestors, and recursing on the
  // symlink's own (ever-lengthening) path would never terminate. Resolving
  // each directory to its realpath before descending catches that cycle
  // regardless of how many symlink hops produced it.
  const realSourceDir = await realpath(sourceDir).catch(() => undefined);
  if (realSourceDir === undefined || visited.has(realSourceDir) || excludedDirectories.has(realSourceDir)) {
    return { copied: 0, transpiled: 0 };
  }
  visited.add(realSourceDir);

  const entries = await readDirectory(sourceDir);
  let copied = 0;
  let transpiled = 0;

  for (const entry of entries) {
    const sourcePath = resolve(sourceDir, entry.name);
    const targetPath = resolve(targetDir, entry.name);

    // Plugin sources may symlink files or directories whose canonical home is
    // elsewhere in the repository. The build materializes the link target, so
    // emitted packages contain real files and never carry links that escape
    // them; a broken link throws here and fails the build instead of silently
    // dropping the content.
    const linked = entry.isSymbolicLink() ? await stat(sourcePath) : undefined;

    if (entry.isDirectory() || linked?.isDirectory() === true) {
      if (entry.name === "node_modules") continue;
      const result = await buildDirectory(sourcePath, targetPath, visited, excludedDirectories);
      copied += result.copied;
      transpiled += result.transpiled;
      continue;
    }

    if (!entry.isFile() && linked?.isFile() !== true) continue;
    // npm excludes .gitignore from tarballs; do not emit non-distributable build artifacts.
    if (entry.name === ".gitignore" || entry.name.endsWith(".d.ts") || isTestSource(entry.name)) continue;

    if (isPluginSource(entry.name)) {
      await buildFile(sourcePath, targetPath.replace(/\.ts$/u, ".js"));
      transpiled += 1;
      continue;
    }

    if (entry.name.endsWith(".js") && await hasTypeScriptSource(sourcePath)) continue;
    await mkdir(dirname(targetPath), { recursive: true });
    await copyFile(sourcePath, targetPath);
    copied += 1;
  }

  return { copied, transpiled };
}

export function filesBrowserBuildConfig(sourceDir, targetDir) {
  return complexBrowserBuildConfig(sourceDir, targetDir);
}

export function complexBrowserBuildConfig(sourceDir, targetDir) {
  return {
    configFile: false,
    root: sourceDir,
    base: "./",
    publicDir: false,
    logLevel: "silent",
    build: {
      outDir: resolve(targetDir, "browser"),
      emptyOutDir: true,
      copyPublicDir: false,
      target: "es2022",
      minify: true,
      cssMinify: true,
      sourcemap: false,
      assetsInlineLimit: 0,
      reportCompressedSize: false,
      rollupOptions: {
        input: resolve(sourceDir, "pi-web-plugin.ts"),
        preserveEntrySignatures: "strict",
        output: {
          format: "es",
          entryFileNames: "pi-web-plugin.js",
          chunkFileNames: "assets/[name]-[hash].js",
          assetFileNames: "assets/[name]-[hash][extname]",
        },
      },
    },
  };
}

export async function buildFilesBrowserPackage(sourceDir, targetDir, buildBrowser = viteBuild) {
  await rm(targetDir, { recursive: true, force: true });
  await mkdir(targetDir, { recursive: true });
  await copyFile(resolve(sourceDir, "package.json"), resolve(targetDir, "package.json"));
  await buildBrowser(filesBrowserBuildConfig(sourceDir, targetDir));
}

export async function buildMermaidPackage(sourceDir, targetDir, buildBrowser = viteBuild) {
  await buildFilesBrowserPackage(sourceDir, targetDir, buildBrowser);
  await buildBrowser({
    configFile: false,
    root: sourceDir,
    publicDir: false,
    logLevel: "silent",
    build: {
      outDir: resolve(targetDir, "browser"),
      emptyOutDir: false,
      target: "es2022",
      minify: true,
      reportCompressedSize: false,
      lib: { entry: resolve(sourceDir, "mermaid-engine.ts"), name: "MermaidEngine", formats: ["iife"], fileName: () => "mermaid-engine.js" },
    },
  });
}

export async function buildTerminalPackage(sourceDir, targetDir, buildBrowser = viteBuild) {
  await rm(targetDir, { recursive: true, force: true });
  await mkdir(targetDir, { recursive: true });
  await copyFile(resolve(sourceDir, "package.json"), resolve(targetDir, "package.json"));
  await buildDirectory(resolve(sourceDir, "server"), targetDir);
  await buildBrowser(complexBrowserBuildConfig(sourceDir, targetDir));
}

async function buildFile(file, outputPath) {
  const source = await readFile(file, "utf8");
  const transpiled = ts.transpileModule(source, {
    fileName: file,
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      verbatimModuleSyntax: true,
      sourceMap: false,
      inlineSourceMap: false,
    },
  });

  const errors = (transpiled.diagnostics ?? []).filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
  if (errors.length > 0) throw new Error(formatDiagnostics(errors));

  const output = `// Generated from ${relative(cwd, file)}. Do not edit directly.\n${transpiled.outputText}`;
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, output);
}

/**
 * Directories watch mode listens on: the real plugin tree plus the homes of
 * symlinked build inputs, so editing a canonical file living outside the
 * plugin tree still triggers a rebuild.
 */
export async function findWatchDirs(dir) {
  const dirs = [];
  const visited = new Set();
  const pending = [dir];
  while (pending.length > 0) {
    const current = pending.pop();
    const realCurrent = await realpath(current).catch(() => undefined);
    if (realCurrent === undefined || visited.has(realCurrent)) continue;
    visited.add(realCurrent);
    dirs.push(current);
    for (const entry of await readDirectory(current)) {
      if (entry.name === "node_modules") continue;
      const path = resolve(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(path);
        continue;
      }
      if (entry.isSymbolicLink()) {
        const linkedRealpath = await realpath(path).catch(() => undefined);
        if (linkedRealpath === undefined) continue;
        const linked = await stat(linkedRealpath).catch(() => undefined);
        if (linked?.isDirectory()) pending.push(linkedRealpath);
        else if (linked?.isFile()) dirs.push(dirname(linkedRealpath));
      }
    }
  }
  return [...new Set(dirs)].sort((left, right) => left.localeCompare(right));
}

function isPluginSource(fileName) {
  return fileName.endsWith(".ts") && !fileName.endsWith(".d.ts");
}

function isTestSource(fileName) {
  return /\.(?:test|spec)\.[cm]?[jt]s$/u.test(fileName);
}

async function hasTypeScriptSource(javaScriptPath) {
  const typeScriptPath = javaScriptPath.replace(/\.js$/u, ".ts");
  try {
    await readFile(typeScriptPath, "utf8");
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

async function readDirectory(dir) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return [];
    throw error;
  }
}

async function watchAndBuild() {
  let watchers = [];
  let timer;
  let building = false;
  let pending = false;
  let builtOnce = false;

  const closeWatchers = () => {
    for (const watcher of watchers) watcher.close();
    watchers = [];
  };

  const refreshWatchers = async () => {
    closeWatchers();
    const dirs = (await Promise.all(buildTargets.map((target) => findWatchDirs(target.rootDir)))).flat();
    watchers = dirs.map((dir) => watch(dir, () => scheduleBuild()));
  };

  const runBuild = async () => {
    if (building) {
      pending = true;
      return;
    }
    building = true;
    try {
      do {
        pending = false;
        await refreshWatchers();
        await buildAll();
        builtOnce = true;
      } while (pending);
    } catch (error) {
      console.error(`[plugins] ${formatUnknownError(error)}`);
      if (!builtOnce) {
        closeWatchers();
        throw error;
      }
    } finally {
      building = false;
    }
  };

  const scheduleBuild = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void runBuild();
    }, 100);
  };

  const stop = () => {
    if (timer !== undefined) clearTimeout(timer);
    closeWatchers();
    process.exit(0);
  };

  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  await runBuild();
  console.log(`[plugins] watching ${buildTargets.map((target) => relative(cwd, target.rootDir)).join(", ")}`);
  await new Promise(() => undefined);
}

function formatDiagnostics(diagnostics) {
  return ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: (fileName) => fileName,
    getCurrentDirectory: () => cwd,
    getNewLine: () => "\n",
  });
}

function formatUnknownError(error) {
  return error instanceof Error ? error.message : String(error);
}

function isNodeError(error) {
  return error instanceof Error && "code" in error;
}

function isDirectExecution() {
  const entryPath = process.argv[1];
  if (entryPath === undefined) return false;
  return pathToFileURL(resolve(entryPath)).href === import.meta.url;
}
