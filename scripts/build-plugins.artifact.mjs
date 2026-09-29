import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Window } from "happy-dom";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PI_WEB_PLUGIN_ARTIFACT_MAX_BYTES, PI_WEB_PLUGIN_ARTIFACT_MAX_ENTRIES } from "../src/server/piWebPluginCatalog.js";
import { PluginRegistry } from "../src/client/src/plugins/registry.js";

// Delivery-only: run after npm run build. Never build or mutate checkout artifacts here.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let tempDir;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "pi-web-build-plugins-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

it("scans static imports, re-exports and dynamic imports without mistaking comments or strings for dependencies", () => {
  expect(
    moduleSpecifiers(`
    import x from "./static.js";
    export { y } from "./export.js";
    const z = import("./dynamic.js");
    // import "./comment.js";
    const text = 'import("./string.js")';
    require("commonjs-shim");
    define(["amd-shim"], () => {});
  `)
  ).toEqual(["./static.js", "./export.js", "./dynamic.js"]);
});

describe("plugin delivery artifacts", () => {
  it("ships package-complete importable bundled server plugins", { timeout: 60_000 }, async () => {
    const fixtureRoot = repoRoot;
    const readyPath = join(fixtureRoot, "dist", ".plugins-ready");
    expect(await readFile(readyPath, "utf8")).toBe("ready\n");
    const sourcePlugins = await bundledServerPlugins(join(fixtureRoot, "pi-web-plugins"));
    const builtPluginsRoot = join(fixtureRoot, "dist", "pi-web-plugins");
    const builtPlugins = await bundledServerPlugins(builtPluginsRoot);
    expect(sourcePlugins.length).toBeGreaterThan(0);
    expect(sourcePlugins.every((plugin) => plugin.moduleType === "module")).toBe(true);
    expect(builtPlugins).toEqual(sourcePlugins);
    for (const plugin of builtPlugins) {
      const moduleUrl = pathToFileURL(join(builtPluginsRoot, plugin.packageDirectory, plugin.serverModule));
      moduleUrl.searchParams.set("artifact", plugin.id);
      const imported = await import(moduleUrl.href);
      if (!isRecord(imported)) throw new Error(`Built server plugin did not import as a module: ${plugin.id}`);
      const pluginExport = imported["default"];
      if (!isRecord(pluginExport)) throw new Error(`Built server plugin has no default object export: ${plugin.id}`);
      expect(pluginExport["apiVersion"]).toBe(3);
      expect(typeof pluginExport["activate"]).toBe("function");
    }
    // npm 10 can still execute prepare with --ignore-scripts. Pack a copy of
    // the declared payload with lifecycle scripts removed: no rebuilds or git-hook changes.
    const packRoot = join(tempDir, "pack");
    await mkdir(packRoot);
    const metadata = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));
    delete metadata.scripts;
    await writeFile(join(packRoot, "package.json"), JSON.stringify(metadata));
    for (const path of new Set([...metadata.files.filter((path) => !path.startsWith("!")), "README.md", "LICENSE"])) {
      await cp(join(repoRoot, path), join(packRoot, path), { recursive: true });
    }
    const stdout = await runNpm(["pack", "--dry-run", "--json", "--ignore-scripts"], packRoot);
    const packagedFiles = packageFilePaths(stdout);
    const distFiles = await recursiveFiles(join(repoRoot, "dist"));
    const isTestArtifact = (path) => /\.(?:test|spec|testSupport|artifact)\./u.test(path);
    expect(distFiles.filter(isTestArtifact)).toEqual([]);
    expect(packagedFiles.filter(isTestArtifact)).toEqual([]);
    expect(packagedFiles).toEqual(expect.arrayContaining([
      "dist/cli.js", "dist/server/app.js", "dist/server/index.js", "dist/server/sessiond.js",
      "dist/plugin-api.d.ts", "dist/server-plugin-api.d.ts", "dist/server-plugin-api.js",
      "dist/shared/pluginApiTypes.d.ts",
      "plugin-api.d.ts", "server-plugin-api.d.ts", "dist/client/index.html",
      "examples/session-bridge-plugin/package.json",
    ]));
    expect(packagedFiles.some((path) => path.includes("/node_modules/") || /^examples\/[^/]+\/dist\//u.test(path))).toBe(false);
    expect(packagedFiles).not.toContain("dist/plugin-api/unstable.d.ts");
    expect(packagedFiles).not.toContain("plugin-api/unstable.d.ts");
    const builtPluginFiles = (await recursiveFiles(builtPluginsRoot)).map((path) => `dist/pi-web-plugins/${path}`).sort();
    expect(packagedFiles.filter((path) => path.startsWith("dist/pi-web-plugins/")).sort()).toEqual(builtPluginFiles);
    expect(builtPluginFiles.some((path) => /\.(?:test|spec)\./u.test(path))).toBe(false);
    expect(builtPluginFiles.some((path) => path.includes("/relays/"))).toBe(false);
    const filesPluginFiles = builtPluginFiles.filter((path) => path.startsWith("dist/pi-web-plugins/files/"));
    expect(filesPluginFiles).toEqual(
      expect.arrayContaining(["dist/pi-web-plugins/files/package.json", "dist/pi-web-plugins/files/browser/pi-web-plugin.js"])
    );
    expect(filesPluginFiles.some((path) => /\/browser\/assets\/viewerDependencies-[^/]+\.js$/u.test(path))).toBe(false);
    expect(filesPluginFiles.some((path) => /\/browser\/assets\/files-icon-[^/]+\.svg$/u.test(path))).toBe(true);
    expect(filesPluginFiles.every((path) => path.endsWith("/package.json") || path.includes("/browser/"))).toBe(true);
    expect(packagedFiles).toEqual(expect.arrayContaining(filesPluginFiles));
    // pi-packages/ ships Pi packages (like relays) alongside bundled plugins
    // without becoming a bundled/local discovery root for them (see
    // PiWebPluginCatalog). The delivery build emits
    // them into their own dist directory and packs them into the tarball.
    const builtPackagesRoot = join(fixtureRoot, "dist", "pi-packages");
    const builtPackageFiles = (await recursiveFiles(builtPackagesRoot)).map((path) => `dist/pi-packages/${path}`).sort();
    expect(builtPackageFiles).toContain("dist/pi-packages/relays/package.json");
    expect(builtPackageFiles).toContain("dist/pi-packages/relays/pi-web-plugin.js");
    expect(builtPackageFiles).toContain("dist/pi-packages/relays/prompts/relay.md");
    expect(builtPackageFiles).toContain("dist/pi-packages/relays/prompts/relay-worktree.md");
    expect(builtPackageFiles).toContain("dist/pi-packages/relays/skills/relay/SKILL.md");
    expect(builtPackageFiles).toContain("dist/pi-packages/relays/skills/relay-runner/SKILL.md");
    expect(builtPackageFiles.some((path) => /\.(?:test|spec)\./u.test(path))).toBe(false);
    expect(packagedFiles.filter((path) => path.startsWith("dist/pi-packages/")).sort()).toEqual(builtPackageFiles);
    const builtRelaysPackage = JSON.parse(await readFile(join(builtPackagesRoot, "relays", "package.json"), "utf8"));
    if (!isRecord(builtRelaysPackage)) throw new Error("Built relays package metadata was not an object");
    expect(builtRelaysPackage["name"]).toBe("@jmfederico/pi-relay");
  });
  describe("Mermaid browser package build", () => {
    it("ships a self-contained sandbox engine and browser entry within artifact limits", { timeout: 60_000 }, async () => {
      const target = join(repoRoot, "dist/pi-web-plugins/mermaid");
      const files = await recursiveFiles(target);
      expect(files).toEqual(["browser/mermaid-engine.js", "browser/pi-web-plugin.js", "package.json"]);
      let bytes = 0;
      for (const file of files) bytes += (await stat(join(target, file))).size;
      expect(bytes).toBeLessThan(PI_WEB_PLUGIN_ARTIFACT_MAX_BYTES);
      const engine = await readFile(join(target, "browser/mermaid-engine.js"), "utf8");
      expect(moduleSpecifiers(engine)).toEqual([]);
      expect(engine).not.toMatch(/\bimport\s*\(/u);
      const entry = await readFile(join(target, "browser/pi-web-plugin.js"), "utf8");
      expect(moduleSpecifiers(entry)).toEqual([]);
      expect(entry).toContain("./mermaid-engine.js");
      expect(entry).toContain("allow-scripts");
      expect(entry).not.toContain("allow-same-origin");
    });
  });

  describe("Files browser package build", () => {
    it("emits only package metadata and an entry-resident browser graph within catalog bounds", { timeout: 30_000 }, async () => {
      const target = join(tempDir, "files");
      await cp(join(repoRoot, "dist/pi-web-plugins/files"), target, { recursive: true });

      const packageFiles = await recursiveFiles(target);
      expect(packageFiles.filter((path) => !path.startsWith("browser/"))).toEqual(["package.json"]);
      expect(packageFiles).toContain("browser/pi-web-plugin.js");
      expect(packageFiles.some((path) => /^browser\/assets\/viewerDependencies-[^/]+\.js$/u.test(path))).toBe(false);
      expect(packageFiles.some((path) => /^browser\/assets\/files-icon-[^/]+\.svg$/u.test(path))).toBe(true);
      expect(packageFiles.some((path) => path.endsWith(".map"))).toBe(false);
      expect(packageFiles.some((path) => /\.(?:ts|css)$/u.test(path))).toBe(false);

      const metadata = JSON.parse(await readFile(join(target, "package.json"), "utf8"));
      expect(metadata).toMatchObject({
        private: true,
        type: "module",
        piWeb: {
          plugins: [{
            id: "files",
            browserRoot: "browser",
            module: "browser/pi-web-plugin.js",
            machineSpecific: false,
          }],
        },
      });

      const browserRoot = join(target, "browser");
      const browserJavaScript = packageFiles.filter((path) => path.startsWith("browser/") && path.endsWith(".js"));
      expect(browserJavaScript).toEqual(["browser/pi-web-plugin.js"]);
      for (const packagePath of browserJavaScript) {
        const file = join(target, packagePath);
        const sourceText = await readFile(file, "utf8");
        expect(sourceText).not.toMatch(/@jmfederico\/pi-web|src\/client\/src|(?:\.\.\/)+src\//u);
        for (const specifier of moduleSpecifiers(sourceText)) {
          expect(specifier, `${packagePath} contains a bare or absolute runtime import`).toMatch(/^\.\.?\//u);
          const dependency = resolve(dirname(file), specifier);
          expect(dependency === browserRoot || dependency.startsWith(`${browserRoot}${sep}`)).toBe(true);
          expect((await stat(dependency)).isFile()).toBe(true);
        }
      }

      const entryPath = join(browserRoot, "pi-web-plugin.js");
      const entrySource = await readFile(entryPath, "utf8");
      expect(moduleSpecifiers(entrySource).filter((specifier) => specifier.endsWith(".js"))).toEqual([]);

      const artifactProbeRoot = join(tempDir, "_artifact-probe");
      const firstBrowserRoot = join(artifactProbeRoot, "remote-a", "browser");
      const secondBrowserRoot = join(artifactProbeRoot, "remote-b", "browser");
      await mkdir(artifactProbeRoot, { recursive: true });
      await cp(browserRoot, firstBrowserRoot, { recursive: true });
      await cp(browserRoot, secondBrowserRoot, { recursive: true });
      const firstModuleUrl = pathToFileURL(join(firstBrowserRoot, "pi-web-plugin.js"));
      const secondModuleUrl = pathToFileURL(join(secondBrowserRoot, "pi-web-plugin.js"));
      const remoteBContent = "const selectedOnRemoteB: string = 'healthy';";
      const { builtModule, secondBuiltModule, registrations, viewerProbe } = await withBrowserGlobals(async () => {
        const imported = await import(firstModuleUrl.href);
        const secondImported = await import(secondModuleUrl.href);
        const template = (strings, ...values) => ({ strings, values });
        await imported.default.activate({
          apiVersion: 4,
          pluginId: "files",
          runtimePluginId: "files",
          html: template,
          svg: template,
          signal: new AbortController().signal,
          lifetimeSignal: new AbortController().signal,
        });
        const firstElementConstructor = customElements.get("pi-web-files-panel");
        const firstCodeViewerConstructor = customElements.get("pi-web-files-code-viewer");
        const registry = new PluginRegistry();
        await registry.register({ id: "remote-1.files", sourcePluginId: "files", machineId: "remote-1", plugin: imported.default });
        await registry.register({ id: "remote-2.files", sourcePluginId: "files", machineId: "remote-2", plugin: secondImported.default });
        const panels = registry.getWorkspacePanels();
        const firstContext = builtWorkspacePanelContext("remote-1");
        const secondContext = builtWorkspacePanelContext("remote-2");
        const firstRendered = panels.find((panel) => panel.machineId === "remote-1")?.render(firstContext);
        const secondRendered = panels.find((panel) => panel.machineId === "remote-2")?.render(secondContext);

        // The retained canonical constructor belongs to remote A. Remove every
        // post-entry A asset, then prove healthy remote B content still gets a
        // real CodeMirror editor without consulting A's old artifact root.
        await rm(join(firstBrowserRoot, "assets"), { recursive: true, force: true });
        const secondDependencies = await secondImported.loadFilesViewerDependencies();
        const codeViewer = document.createElement("pi-web-files-code-viewer");
        codeViewer.content = remoteBContent;
        codeViewer.language = "typescript";
        document.body.append(codeViewer);
        await waitFor(() => codeViewer.shadowRoot?.querySelector(".cm-editor") != null);

        return {
          builtModule: imported,
          secondBuiltModule: secondImported,
          registrations: {
            panelMachineIds: panels.map((panel) => panel.machineId),
            firstElementConstructor,
            secondElementConstructor: customElements.get("pi-web-files-panel"),
            firstCodeViewerConstructor,
            secondCodeViewerConstructor: customElements.get("pi-web-files-code-viewer"),
            firstContextBound: firstRendered?.values.includes(firstContext) === true,
            secondContextBound: secondRendered?.values.includes(secondContext) === true,
            firstRuntime: firstRendered?.values.find((value) => value instanceof imported.FilesRuntime),
            secondRuntime: secondRendered?.values.find((value) => value instanceof secondImported.FilesRuntime),
          },
          viewerProbe: {
            firstAssetsUnavailable: await stat(join(firstBrowserRoot, "assets")).then(() => false, () => true),
            secondLoaderSucceeded: typeof secondDependencies.EditorView === "function",
            rendered: codeViewer.shadowRoot?.querySelector(".cm-editor") != null,
            text: codeViewer.shadowRoot?.textContent ?? "",
          },
        };
      });
      expect(builtModule.default).toMatchObject({ apiVersion: 4, name: "Files" });
      expect(secondBuiltModule.default).toMatchObject({ apiVersion: 4, name: "Files" });
      expect(secondBuiltModule.FilesRuntime).not.toBe(builtModule.FilesRuntime);
      expect(registrations.panelMachineIds).toEqual(["remote-1", "remote-2"]);
      expect(registrations.firstElementConstructor).toBeDefined();
      expect(registrations.secondElementConstructor).toBe(registrations.firstElementConstructor);
      expect(registrations.firstCodeViewerConstructor).toBeDefined();
      expect(registrations.secondCodeViewerConstructor).toBe(registrations.firstCodeViewerConstructor);
      expect(registrations.firstContextBound).toBe(true);
      expect(registrations.secondContextBound).toBe(true);
      expect(registrations.firstRuntime).toBeInstanceOf(builtModule.FilesRuntime);
      expect(registrations.secondRuntime).toBeInstanceOf(secondBuiltModule.FilesRuntime);
      expect(registrations.secondRuntime).not.toBe(registrations.firstRuntime);
      expect(viewerProbe).toMatchObject({
        firstAssetsUnavailable: true,
        secondLoaderSucceeded: true,
        rendered: true,
      });
      expect(viewerProbe.text).toContain("selectedOnRemoteB");
      expect(typeof secondBuiltModule.filesIconUrl).toBe("string");
      expect((await stat(fileURLToPath(secondBuiltModule.filesIconUrl))).isFile()).toBe(true);

      let bytes = 0;
      for (const file of packageFiles) bytes += (await stat(join(target, file))).size;
      expect(bytes).toBeLessThan(PI_WEB_PLUGIN_ARTIFACT_MAX_BYTES);
      expect(await recursiveEntryCount(target)).toBeLessThan(PI_WEB_PLUGIN_ARTIFACT_MAX_ENTRIES);

    });
  });
});

async function bundledServerPlugins(pluginsRoot) {
  const plugins = [];
  for (const entry of await readdir(pluginsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const metadata = JSON.parse(await readFile(join(pluginsRoot, entry.name, "package.json"), "utf8"));
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
  return plugins.sort(
    (left, right) =>
      left.packageDirectory.localeCompare(right.packageDirectory) ||
      left.id.localeCompare(right.id) ||
      left.serverModule.localeCompare(right.serverModule)
  );
}
function runNpm(args, cwd, timeoutMs = 30_000) {
  const npmExecPath = process.env["npm_execpath"];
  if (npmExecPath === undefined || npmExecPath.length === 0) {
    throw new Error("npm_execpath is required to verify npm package contents");
  }
  return execUtf8(process.execPath, [npmExecPath, ...args], cwd, timeoutMs);
}
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
function packageFilePaths(output) {
  const parsed = JSON.parse(output);
  if (!Array.isArray(parsed) || parsed.length !== 1) throw new Error("npm pack returned an unexpected result");
  const packResult = parsed[0];
  if (!isRecord(packResult)) throw new Error("npm pack result was not an object");
  const filesValue = packResult["files"];
  if (!Array.isArray(filesValue)) throw new Error("npm pack result did not include files");
  const files = filesValue;
  return files.map((file) => {
    if (!isRecord(file) || typeof file["path"] !== "string") {
      throw new Error("npm pack returned an invalid file entry");
    }
    return file["path"];
  });
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function moduleSpecifiers(source) {
  // Dependency scanning is the contract here, not a full AST for multi-MB bundles.
  // Leave CommonJS/AMD detection off: bundled shims can contain require/define,
  // whereas this check has always covered ESM imports and re-exports only.
  return ts.preProcessFile(source, true, false).importedFiles.map((file) => file.fileName);
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

async function recursiveEntryCount(root) {
  let count = 0;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    count += 1;
    if (entry.isDirectory()) count += await recursiveEntryCount(join(root, entry.name));
  }
  return count;
}

function builtWorkspacePanelContext(machineId) {
  return {
    machine: { id: machineId, name: machineId, kind: "remote" },
    workspace: { id: "workspace-1", projectId: "project-1", path: "/repo", label: "repo", isMain: true },
    files: {
      capabilityVersion: 1,
      defaultUploadFolder: ".pi-web/uploads",
      maxInlinePreviewBytes: 1024,
      readFile: () => Promise.reject(new Error("not used")),
      listFiles: () => Promise.reject(new Error("not used")),
      writeFile: () => Promise.reject(new Error("not used")),
      deleteFile: () => Promise.reject(new Error("not used")),
      moveFile: () => Promise.reject(new Error("not used")),
      previewUrl: () => "about:blank",
      downloadUrl: () => "about:blank",
      uploadFile: () => { throw new Error("not used"); },
    },
    host: { requestRender: () => undefined },
    prompt: { insertText: () => undefined, getText: () => "", getSelection: () => null },
    terminal: { open: () => undefined, runCommand: () => Promise.reject(new Error("not used")) },
    navigation: { version: 1, contributionId: "files:workspace.files", query: {}, set: () => undefined },
  };
}

async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolvePromise) => { setTimeout(resolvePromise, 10); });
  }
  throw new Error(`Timed out after ${String(timeoutMs)}ms waiting for built browser behavior`);
}

async function withBrowserGlobals(action) {
  const browser = new Window({ url: "http://localhost/" });
  const names = [
    "window",
    "document",
    "customElements",
    "Window",
    "HTMLElement",
    "HTMLDivElement",
    "HTMLDialogElement",
    "HTMLInputElement",
    "Element",
    "Node",
    "Text",
    "ShadowRoot",
    "Document",
    "DocumentFragment",
    "Range",
    "Selection",
    "CSSStyleSheet",
    "CSS",
    "DOMRect",
    "DOMRectReadOnly",
    "MutationObserver",
    "ResizeObserver",
    "EventTarget",
    "CustomEvent",
    "Event",
    "FocusEvent",
    "KeyboardEvent",
    "MouseEvent",
    "InputEvent",
    "CompositionEvent",
    "File",
    "DOMException",
    "navigator",
    "getComputedStyle",
    "requestAnimationFrame",
    "cancelAnimationFrame",
  ];
  const ownersKey = Symbol.for("pi-web.files.custom-element-owners.v1");
  const previousOwners = Object.getOwnPropertyDescriptor(globalThis, ownersKey);
  Reflect.deleteProperty(globalThis, ownersKey);
  const previous = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const name of names) {
    let value = name === "window" ? browser : name === "document" ? browser.document : browser[name];
    if (typeof value === "function" && ["getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"].includes(name)) {
      value = value.bind(browser);
    }
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  }
  try {
    return await action();
  } finally {
    for (const name of names) {
      const descriptor = previous.get(name);
      if (descriptor === undefined) delete globalThis[name];
      else Object.defineProperty(globalThis, name, descriptor);
    }
    if (previousOwners === undefined) Reflect.deleteProperty(globalThis, ownersKey);
    else Object.defineProperty(globalThis, ownersKey, previousOwners);
    await browser.happyDOM.abort();
  }
}
