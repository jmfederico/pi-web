#!/usr/bin/env node
import { watch } from "node:fs";
import { copyFile, mkdir, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

// Two independent source trees ship inside the npm package: bundled PI WEB
// plugins (discovered by directory scan, see PiWebPluginCatalog) and Pi
// packages that ship alongside them without being discovered that way (for
// example a Pi package that is installed rather than scanned). Both are
// built the same way, just into separate output directories, so neither one
// becomes a discovery root for the other.
const buildTargets = [
  { rootDir: resolve("pi-web-plugins"), outDir: resolve("dist/pi-web-plugins"), label: "plugin" },
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
  for (const target of buildTargets) {
    await rm(target.outDir, { recursive: true, force: true });
    const result = await buildDirectory(target.rootDir, target.outDir);
    const suffix = result.transpiled === 1 ? "file" : "files";
    console.log(`[plugins] built ${String(result.transpiled)} TypeScript ${target.label} ${suffix} into ${relative(cwd, target.outDir)}`);
  }
}

export async function buildDirectory(sourceDir, targetDir, visited = new Set()) {
  // Mirrors findWatchDirs's visited-realpath guard below: a symlinked
  // directory can point at one of its own ancestors, and recursing on the
  // symlink's own (ever-lengthening) path would never terminate. Resolving
  // each directory to its realpath before descending catches that cycle
  // regardless of how many symlink hops produced it.
  const realSourceDir = await realpath(sourceDir).catch(() => undefined);
  if (realSourceDir === undefined || visited.has(realSourceDir)) return { copied: 0, transpiled: 0 };
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
      const result = await buildDirectory(sourcePath, targetPath, visited);
      copied += result.copied;
      transpiled += result.transpiled;
      continue;
    }

    if (!entry.isFile() && linked?.isFile() !== true) continue;
    if (entry.name.endsWith(".d.ts") || isTestSource(entry.name)) continue;

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
async function findWatchDirs(dir) {
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
  return /\.(?:test|spec)\.ts$/u.test(fileName);
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
      } while (pending);
    } catch (error) {
      console.error(`[plugins] ${formatUnknownError(error)}`);
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
