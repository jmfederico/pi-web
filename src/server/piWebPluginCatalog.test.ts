import { mkdir, mkdtemp, readdir, realpath, rm, stat, symlink, truncate, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { piWebDataDir } from "../config.js";
import { defaultPluginRoots, isWithin, PI_WEB_PLUGIN_ARTIFACT_MAX_BYTES, PiWebPluginCatalog, type PiPackageProvider } from "./piWebPluginCatalog.js";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "pi-web-plugin-catalog-test-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("PiWebPluginCatalog", () => {
  it("describes browser-only metadata and desired config without changing source or scope", async () => {
    const pluginRoot = join(tempDir, "plugins", "browser-only");
    await writePlugin(pluginRoot, {
      packageJson: { piWeb: { plugins: [{ id: "browser-only", browserRoot: "dist", module: "dist/plugin.js" }] } },
      files: { "dist/plugin.js": "export default {};" },
    });
    const catalog = new PiWebPluginCatalog({
      roots: [{ path: join(tempDir, "plugins"), source: "fixture", scope: "project" }],
      packageProvider: false,
      configProvider: () => ({ plugins: { "browser-only": { enabled: false, settings: { color: "blue" } } } }),
    });

    const snapshot = await catalog.snapshot();

    expect(snapshot.diagnostics).toEqual([]);
    const [plugin] = snapshot.plugins;
    expect(plugin).toMatchObject({
      id: "browser-only",
      packageRoot: await realpath(pluginRoot),
      browserRoot: {
        path: "dist",
        directoryPath: await realpath(join(pluginRoot, "dist")),
      },
      browserModule: {
        path: "dist/plugin.js",
        filePath: await realpath(join(pluginRoot, "dist/plugin.js")),
      },
      source: "fixture",
      scope: "project",
      machineSpecific: false,
      enabled: false,
      settings: { color: "blue" },
    });
    expect(plugin?.browserModule?.revision).toMatch(/^sha256:[a-f\d]{64}$/u);
    expect(plugin?.settingsRevision).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it("requires a safe browser root and keeps browser modules inside its logical and canonical boundary", async () => {
    const pluginsRoot = join(tempDir, "plugins");
    await writePlugin(join(pluginsRoot, "valid-root"), {
      packageJson: { piWeb: { plugins: [{ id: "valid-root", browserRoot: "public", module: "public/plugin.js" }] } },
      files: { "public/plugin.js": "export default {};", "private/server.js": "not browser public" },
    });
    await writePlugin(join(pluginsRoot, "missing-root"), {
      packageJson: { piWeb: { plugins: [{ id: "missing-root", module: "browser.js" }] } },
      files: { "browser.js": "export default {};" },
    });
    await writePlugin(join(pluginsRoot, "invalid-root"), {
      packageJson: { piWeb: { plugins: [{ id: "invalid-root", browserRoot: "", module: "browser.js" }] } },
      files: { "browser.js": "export default {};" },
    });
    await writePlugin(join(pluginsRoot, "unsafe-root"), {
      packageJson: { piWeb: { plugins: [{ id: "unsafe-root", browserRoot: "../public", module: "browser.js" }] } },
      files: { "browser.js": "export default {};" },
    });
    await writePlugin(join(pluginsRoot, "absent-root"), {
      packageJson: { piWeb: { plugins: [{ id: "absent-root", browserRoot: "public", module: "public/browser.js" }] } },
      files: {},
    });
    await writePlugin(join(pluginsRoot, "outside-root"), {
      packageJson: { piWeb: { plugins: [{ id: "outside-root", browserRoot: "public", module: "private/browser.js" }] } },
      files: { "public/asset.css": "", "private/browser.js": "export default {};" },
    });

    const symlinkedModuleRoot = join(pluginsRoot, "symlinked-module");
    await writePlugin(symlinkedModuleRoot, {
      packageJson: { piWeb: { plugins: [{ id: "symlinked-module", browserRoot: "public", module: "public/browser.js" }] } },
      files: { "private/browser.js": "export default {};" },
    });
    await mkdir(join(symlinkedModuleRoot, "public"), { recursive: true });
    await symlink(join(symlinkedModuleRoot, "private", "browser.js"), join(symlinkedModuleRoot, "public", "browser.js"));

    const escapedRoot = join(pluginsRoot, "escaped-root");
    const externalBrowserRoot = join(tempDir, "external-browser-root");
    await mkdir(externalBrowserRoot, { recursive: true });
    await writeFile(join(externalBrowserRoot, "browser.js"), "export default {};\n");
    await mkdir(escapedRoot, { recursive: true });
    await writeFile(join(escapedRoot, "package.json"), `${JSON.stringify({
      piWeb: { plugins: [{ id: "escaped-root", browserRoot: "public", module: "public/browser.js" }] },
    }, null, 2)}\n`);
    await symlink(externalBrowserRoot, join(escapedRoot, "public"), process.platform === "win32" ? "junction" : "dir");

    const catalog = new PiWebPluginCatalog({
      roots: [{ path: pluginsRoot, source: "fixture", scope: "local" }],
      packageProvider: false,
      warningSink: () => undefined,
    });

    const snapshot = await catalog.snapshot();

    expect(snapshot.plugins.map((plugin) => plugin.id)).toEqual(["valid-root"]);
    expect(snapshot.diagnostics).toHaveLength(7);
    expect(snapshot.diagnostics.map(({ message }) => message)).toEqual(expect.arrayContaining([
      expect.stringContaining("with a browser module must declare browserRoot"),
      expect.stringContaining("Invalid PI WEB plugin browserRoot"),
      expect.stringContaining("Unsafe PI WEB plugin browser root"),
      expect.stringContaining("browser root not found for absent-root"),
      expect.stringContaining("browser module is outside browser root for outside-root"),
      expect.stringContaining("browser module is outside browser root for symlinked-module"),
      expect.stringContaining("browser root escapes its package for escaped-root"),
    ]));
  });

  it("rejects browser paths whose spelling differs from enumerated package entries", async () => {
    const pluginsRoot = join(tempDir, "plugins");
    const rootSpellingRoot = join(pluginsRoot, "root-spelling");
    await writePlugin(rootSpellingRoot, {
      packageJson: { piWeb: { plugins: [{ id: "root-spelling", browserRoot: "public", module: "public/browser.js" }] } },
      files: { "public/browser.js": "export default {};" },
    });

    const moduleSpellingRoot = join(pluginsRoot, "module-spelling");
    const composedModuleName = "caf\u00e9.js";
    const decomposedModuleName = "cafe\u0301.js";
    await writePlugin(moduleSpellingRoot, {
      packageJson: { piWeb: { plugins: [{ id: "module-spelling", browserRoot: "public", module: `public/${composedModuleName}` }] } },
      files: { [`public/${composedModuleName}`]: "export default {};" },
    });

    const exactAliasRoot = join(pluginsRoot, "exact-alias");
    await writePlugin(exactAliasRoot, {
      packageJson: { piWeb: { plugins: [{ id: "exact-alias", browserRoot: "public", module: "public/browser.js" }] } },
      files: { "assets/browser.js": "export default {};" },
    });
    await symlink(join(exactAliasRoot, "assets"), join(exactAliasRoot, "public"), process.platform === "win32" ? "junction" : "dir");

    const canonicalRootSpellingRoot = await realpath(rootSpellingRoot);
    const canonicalModuleSpellingRoot = await realpath(moduleSpellingRoot);
    const catalog = new PiWebPluginCatalog({
      roots: [{ path: pluginsRoot, source: "fixture", scope: "local" }],
      packageProvider: false,
      warningSink: () => undefined,
      // Simulate lookup aliases on case-insensitive/normalizing filesystems while
      // retaining real stat, realpath, scanning, and symlink behavior.
      directoryEntryNamesProvider: async (directoryPath) => {
        const entryNames = await readdir(directoryPath);
        if (directoryPath === canonicalRootSpellingRoot) {
          return entryNames.map((entryName) => entryName === "public" ? "Public" : entryName);
        }
        if (directoryPath === join(canonicalModuleSpellingRoot, "public")) {
          return entryNames.map((entryName) => entryName === composedModuleName ? decomposedModuleName : entryName);
        }
        return entryNames;
      },
    });

    const snapshot = await catalog.snapshot();

    expect(snapshot.plugins.map(({ id }) => id)).toEqual(["exact-alias"]);
    expect(snapshot.diagnostics).toHaveLength(2);
    expect(snapshot.diagnostics.find(({ source }) => source === rootSpellingRoot)).toEqual({
      code: "invalid-package",
      source: rootSpellingRoot,
      message: "PI WEB plugin browser root path does not exactly match package directory entries for root-spelling: public",
    });
    expect(snapshot.diagnostics.find(({ source }) => source === moduleSpellingRoot)).toEqual({
      code: "invalid-package",
      source: moduleSpellingRoot,
      message: `PI WEB plugin browser module path does not exactly match package directory entries for module-spelling: public/${composedModuleName}`,
    });
  });

  it("rejects browser-root directory paths that revisit canonical ancestors with attributed diagnostics", async () => {
    const pluginsRoot = join(tempDir, "plugins");
    const directRoot = join(pluginsRoot, "direct-ancestor-root");
    await writePlugin(directRoot, {
      packageJson: { piWeb: { plugins: [{ id: "direct-ancestor-root", browserRoot: "public", module: "public/browser.js" }] } },
      files: { "browser.js": "export default {};" },
    });
    await symlink(directRoot, join(directRoot, "public"), process.platform === "win32" ? "junction" : "dir");

    const nestedRoot = join(pluginsRoot, "nested-ancestor-root");
    await writePlugin(nestedRoot, {
      packageJson: { piWeb: { plugins: [{ id: "nested-ancestor-root", browserRoot: "assets/public", module: "assets/public/browser.js" }] } },
      files: { "browser.js": "export default {};" },
    });
    await mkdir(join(nestedRoot, "assets"), { recursive: true });
    await symlink(nestedRoot, join(nestedRoot, "assets", "public"), process.platform === "win32" ? "junction" : "dir");

    const intermediateRoot = join(pluginsRoot, "intermediate-ancestor-root");
    await writePlugin(intermediateRoot, {
      packageJson: { piWeb: { plugins: [{
        id: "intermediate-ancestor-root",
        browserRoot: "assets/public/dist",
        module: "assets/public/dist/browser.js",
      }] } },
      files: { "assets/dist/browser.js": "export default {};" },
    });
    await symlink(join(intermediateRoot, "assets"), join(intermediateRoot, "assets", "public"), process.platform === "win32" ? "junction" : "dir");

    const catalog = new PiWebPluginCatalog({
      roots: [{ path: pluginsRoot, source: "fixture", scope: "local" }],
      packageProvider: false,
      warningSink: () => undefined,
    });

    const snapshot = await catalog.snapshot();

    expect(snapshot.plugins).toEqual([]);
    expect(snapshot.diagnostics).toHaveLength(3);
    for (const { source, pluginId } of [
      { source: directRoot, pluginId: "direct-ancestor-root" },
      { source: nestedRoot, pluginId: "nested-ancestor-root" },
      { source: intermediateRoot, pluginId: "intermediate-ancestor-root" },
    ]) {
      const diagnostic = snapshot.diagnostics.find((candidate) => candidate.source === source);
      expect(diagnostic).toMatchObject({ code: "invalid-package", source });
      expect(diagnostic?.message).toContain(`browser root path revisits a canonical ancestor for ${pluginId}`);
    }
  });

  it("rejects browser-root prefixes that leave the package or enter an excluded directory before returning", async () => {
    const pluginsRoot = join(tempDir, "plugins");
    const escapedRoot = join(pluginsRoot, "escaped-root-prefix");
    await writePlugin(escapedRoot, {
      packageJson: { piWeb: { plugins: [{
        id: "escaped-root-prefix",
        browserRoot: "assets/public/dist",
        module: "assets/public/dist/browser.js",
      }] } },
      files: { "assets/dist/browser.js": "export default {};" },
    });
    const externalPrefix = join(tempDir, "external-browser-prefix");
    await mkdir(externalPrefix, { recursive: true });
    await symlink(externalPrefix, join(escapedRoot, "assets", "public"), process.platform === "win32" ? "junction" : "dir");
    await symlink(join(escapedRoot, "assets", "dist"), join(externalPrefix, "dist"), process.platform === "win32" ? "junction" : "dir");

    const excludedRoot = join(pluginsRoot, "excluded-root-prefix");
    await writePlugin(excludedRoot, {
      packageJson: { piWeb: { plugins: [{
        id: "excluded-root-prefix",
        browserRoot: "assets/public/dist",
        module: "assets/public/dist/browser.js",
      }] } },
      files: { "assets/dist/browser.js": "export default {};" },
    });
    await mkdir(join(excludedRoot, ".git"), { recursive: true });
    await symlink(join(excludedRoot, ".git"), join(excludedRoot, "assets", "public"), process.platform === "win32" ? "junction" : "dir");
    await symlink(join(excludedRoot, "assets", "dist"), join(excludedRoot, ".git", "dist"), process.platform === "win32" ? "junction" : "dir");

    const catalog = new PiWebPluginCatalog({
      roots: [{ path: pluginsRoot, source: "fixture", scope: "local" }],
      packageProvider: false,
      warningSink: () => undefined,
    });

    const snapshot = await catalog.snapshot();

    expect(snapshot.plugins).toEqual([]);
    expect(snapshot.diagnostics).toHaveLength(2);
    const escapedDiagnostic = snapshot.diagnostics.find(({ source }) => source === escapedRoot);
    expect(escapedDiagnostic).toMatchObject({ code: "invalid-package", source: escapedRoot });
    expect(escapedDiagnostic?.message).toContain("browser root path escapes its package for escaped-root-prefix");
    const excludedDiagnostic = snapshot.diagnostics.find(({ source }) => source === excludedRoot);
    expect(excludedDiagnostic).toMatchObject({ code: "invalid-package", source: excludedRoot });
    expect(excludedDiagnostic?.message).toContain("browser root path resolves inside excluded .git directory for excluded-root-prefix");
  });

  it("rejects browser-module directory paths that revisit canonical ancestors for narrow and broad roots", async () => {
    const pluginsRoot = join(tempDir, "plugins");
    const narrowRoot = join(pluginsRoot, "narrow-module-cycle");
    await writePlugin(narrowRoot, {
      packageJson: { piWeb: { plugins: [{
        id: "narrow-module-cycle",
        browserRoot: "public",
        module: "public/alias/browser.js",
      }] } },
      files: { "public/browser.js": "export default {};" },
    });
    await symlink(join(narrowRoot, "public"), join(narrowRoot, "public", "alias"), process.platform === "win32" ? "junction" : "dir");

    const broadRoot = join(pluginsRoot, "broad-module-cycle");
    await writePlugin(broadRoot, {
      packageJson: { piWeb: { plugins: [{ id: "broad-module-cycle", browserRoot: ".", module: "alias/browser.js" }] } },
      files: { "browser.js": "export default {};" },
    });
    await symlink(broadRoot, join(broadRoot, "alias"), process.platform === "win32" ? "junction" : "dir");

    const catalog = new PiWebPluginCatalog({
      roots: [{ path: pluginsRoot, source: "fixture", scope: "local" }],
      packageProvider: false,
      warningSink: () => undefined,
    });

    const snapshot = await catalog.snapshot();

    expect(snapshot.plugins).toEqual([]);
    expect(snapshot.diagnostics).toHaveLength(2);
    for (const { source, pluginId } of [
      { source: narrowRoot, pluginId: "narrow-module-cycle" },
      { source: broadRoot, pluginId: "broad-module-cycle" },
    ]) {
      const diagnostic = snapshot.diagnostics.find((candidate) => candidate.source === source);
      expect(diagnostic).toMatchObject({ code: "invalid-package", source });
      expect(diagnostic?.message).toContain(`browser module path revisits a canonical ancestor for ${pluginId}`);
    }
  });

  it.each([".git", "node_modules"])("rejects browser roots canonically aliased into %s with an attributed diagnostic", async (excludedDirectory) => {
    const idSuffix = excludedDirectory === ".git" ? "git" : "node-modules";
    const pluginRoot = join(tempDir, "plugins", `root-alias-${idSuffix}`);
    await writePlugin(pluginRoot, {
      packageJson: { piWeb: { plugins: [{ id: `root-alias-${idSuffix}`, browserRoot: "public", module: "public/browser.js" }] } },
      files: { [`${excludedDirectory}/browser.js`]: "export default {};" },
    });
    await symlink(join(pluginRoot, excludedDirectory), join(pluginRoot, "public"), process.platform === "win32" ? "junction" : "dir");
    const catalog = new PiWebPluginCatalog({
      roots: [{ path: join(tempDir, "plugins"), source: "fixture", scope: "local" }],
      packageProvider: false,
      warningSink: () => undefined,
    });

    const snapshot = await catalog.snapshot();

    expect(snapshot.plugins).toEqual([]);
    expect(snapshot.diagnostics).toHaveLength(1);
    expect(snapshot.diagnostics[0]?.source).toBe(pluginRoot);
    expect(snapshot.diagnostics[0]?.message).toContain(`browser root resolves inside excluded ${excludedDirectory} directory`);
  });

  it.each([".git", "node_modules"])("rejects browser modules canonically aliased into %s with an attributed diagnostic", async (excludedDirectory) => {
    const idSuffix = excludedDirectory === ".git" ? "git" : "node-modules";
    const pluginRoot = join(tempDir, "plugins", `module-alias-${idSuffix}`);
    await writePlugin(pluginRoot, {
      packageJson: { piWeb: { plugins: [{ id: `module-alias-${idSuffix}`, browserRoot: ".", module: "browser.js" }] } },
      files: { [`${excludedDirectory}/browser.js`]: "export default {};" },
    });
    await symlink(join(pluginRoot, excludedDirectory, "browser.js"), join(pluginRoot, "browser.js"));
    const catalog = new PiWebPluginCatalog({
      roots: [{ path: join(tempDir, "plugins"), source: "fixture", scope: "local" }],
      packageProvider: false,
      warningSink: () => undefined,
    });

    const snapshot = await catalog.snapshot();

    expect(snapshot.plugins).toEqual([]);
    expect(snapshot.diagnostics).toHaveLength(1);
    expect(snapshot.diagnostics[0]?.source).toBe(pluginRoot);
    expect(snapshot.diagnostics[0]?.message).toContain(`browser module resolves inside excluded ${excludedDirectory} directory`);
  });

  it("rejects absolute containment results across Windows volumes", () => {
    const packageRoot = "C:\\plugins\\example";

    expect(isWithin(packageRoot, "C:\\plugins\\example\\public", win32)).toBe(true);
    expect(win32.isAbsolute(win32.relative(packageRoot, "D:\\external\\public"))).toBe(true);
    expect(isWithin(packageRoot, "D:\\external\\public", win32)).toBe(false);
  });

  it("rejects noncanonical and Windows drive-relative plugin metadata paths", async () => {
    const pluginsRoot = join(tempDir, "plugins");
    await writePlugin(join(pluginsRoot, "double-separator"), {
      packageJson: { piWeb: { plugins: [{ id: "double-separator", browserRoot: ".", module: "public//browser.js" }] } },
      files: { "public/browser.js": "export default {};" },
    });
    await writePlugin(join(pluginsRoot, "leading-dot"), {
      packageJson: { piWeb: { plugins: [{ id: "leading-dot", browserRoot: ".", module: "./browser.js" }] } },
      files: { "browser.js": "export default {};" },
    });
    await writePlugin(join(pluginsRoot, "dot-segment"), {
      packageJson: { piWeb: { plugins: [{ id: "dot-segment", browserRoot: ".", module: "public/./browser.js" }] } },
      files: { "public/browser.js": "export default {};" },
    });
    await writePlugin(join(pluginsRoot, "drive-browser"), {
      packageJson: { piWeb: { plugins: [{ id: "drive-browser", browserRoot: ".", module: "D:browser.js" }] } },
      files: {},
    });
    await writePlugin(join(pluginsRoot, "drive-server"), {
      packageJson: { piWeb: { plugins: [{ id: "drive-server", serverModule: "D:server.js" }] } },
      files: {},
    });
    await writePlugin(join(pluginsRoot, "drive-root"), {
      packageJson: { piWeb: { plugins: [{ id: "drive-root", browserRoot: "D:assets", module: "browser.js" }] } },
      files: { "browser.js": "export default {};" },
    });
    const catalog = new PiWebPluginCatalog({
      roots: [{ path: pluginsRoot, source: "fixture", scope: "local" }],
      packageProvider: false,
      warningSink: () => undefined,
    });

    const snapshot = await catalog.snapshot();

    expect(snapshot.plugins).toEqual([]);
    expect(snapshot.diagnostics.map(({ message }) => message)).toEqual(expect.arrayContaining([
      "Unsafe PI WEB plugin browser module path for double-separator: public//browser.js",
      "Unsafe PI WEB plugin browser module path for leading-dot: ./browser.js",
      "Unsafe PI WEB plugin browser module path for dot-segment: public/./browser.js",
      "Unsafe PI WEB plugin browser module path for drive-browser: D:browser.js",
      "Unsafe PI WEB plugin server module path for drive-server: D:server.js",
      "Unsafe PI WEB plugin browser root for drive-root: D:assets",
    ]));
    expect(snapshot.diagnostics).toHaveLength(6);
  });

  it("uses package content revisions even when browser asset timestamps are preserved", async () => {
    const pluginRoot = join(tempDir, "plugins", "content-revision");
    const browserPath = join(pluginRoot, "browser.js");
    await writePlugin(pluginRoot, {
      packageJson: { piWeb: { plugins: [{ id: "content-revision", browserRoot: ".", module: "browser.js" }] } },
      files: { "browser.js": "export const value = 'one';" },
    });
    const catalog = new PiWebPluginCatalog({
      roots: [{ path: join(tempDir, "plugins"), source: "fixture", scope: "local" }],
      packageProvider: false,
    });
    const firstRevision = (await catalog.snapshot()).plugins[0]?.browserModule?.revision;
    const originalStat = await stat(browserPath);

    await writeFile(browserPath, "export const value = 'two';");
    await utimes(browserPath, originalStat.atime, originalStat.mtime);

    const secondRevision = (await catalog.snapshot()).plugins[0]?.browserModule?.revision;
    expect(firstRevision).toMatch(/^sha256:[a-f\d]{64}$/u);
    expect(secondRevision).toMatch(/^sha256:[a-f\d]{64}$/u);
    expect(secondRevision).not.toBe(firstRevision);
  });

  it("ignores excluded package metadata while bounding the serveable artifact", async () => {
    const pluginRoot = join(tempDir, "plugins", "bounded");
    await writePlugin(pluginRoot, {
      packageJson: { piWeb: { plugins: [{ id: "bounded", browserRoot: ".", module: "browser.js" }] } },
      files: { "browser.js": "export default {};", ".git/objects/transient": "one" },
    });
    const catalog = new PiWebPluginCatalog({
      roots: [{ path: join(tempDir, "plugins"), source: "fixture", scope: "local" }],
      packageProvider: false,
    });
    const firstRevision = (await catalog.snapshot()).plugins[0]?.browserModule?.revision;

    await writeFile(join(pluginRoot, ".git", "objects", "transient"), "two");

    expect((await catalog.snapshot()).plugins[0]?.browserModule?.revision).toBe(firstRevision);
    const largePath = join(pluginRoot, "large.bin");
    await writeFile(largePath, "");
    await truncate(largePath, PI_WEB_PLUGIN_ARTIFACT_MAX_BYTES + 1);
    const oversized = await catalog.snapshot();
    expect(oversized.plugins).toEqual([]);
    expect(oversized.diagnostics).toHaveLength(1);
    expect(oversized.diagnostics[0]?.code).toBe("invalid-package");
    expect(oversized.diagnostics[0]?.message).toContain("byte artifact limit");
  });

  it("fingerprints server settings canonically without exposing their values", async () => {
    await writePlugin(join(tempDir, "plugins", "configured"), {
      packageJson: { piWeb: { plugins: [{ id: "configured", serverModule: "server.js" }] } },
      files: { "server.js": "export default {};" },
    });
    let settings: Record<string, unknown> = { token: "secret-a", nested: { z: true, a: 1 } };
    const catalog = new PiWebPluginCatalog({
      roots: [{ path: join(tempDir, "plugins"), source: "fixture", scope: "local" }],
      packageProvider: false,
      configProvider: () => ({ plugins: { configured: { settings } } }),
    });

    const first = (await catalog.snapshot()).plugins[0]?.settingsRevision;
    settings = { nested: { a: 1, z: true }, token: "secret-a" };
    const reordered = (await catalog.snapshot()).plugins[0]?.settingsRevision;
    settings = { nested: { a: 1, z: true }, token: "secret-b" };
    const changed = (await catalog.snapshot()).plugins[0]?.settingsRevision;

    expect(first).toBe(reordered);
    expect(changed).not.toBe(first);
    expect(first).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(first).not.toContain("secret-a");
  });

  it("discovers server-only and dual-entry modules without executing them", async () => {
    const marker = "__piWebCatalogExecutedServerModule";
    Reflect.deleteProperty(globalThis, marker);
    await writePlugin(join(tempDir, "plugins", "server-only"), {
      packageJson: { piWeb: { plugins: [{ id: "server-only", serverModule: "server-plugin.js" }] } },
      files: { "server-plugin.js": `globalThis.${marker} = true; throw new Error("must not execute");` },
    });
    await writePlugin(join(tempDir, "plugins", "dual"), {
      packageJson: { piWeb: { plugins: [{ id: "dual", browserRoot: ".", module: "browser.js", serverModule: "server.js" }] } },
      files: { "browser.js": "export default {};", "server.js": "throw new Error('must not execute');" },
    });
    const catalog = new PiWebPluginCatalog({
      roots: [{ path: join(tempDir, "plugins"), source: "fixture", scope: "local" }],
      packageProvider: false,
    });

    const { plugins } = await catalog.snapshot();

    expect(Reflect.get(globalThis, marker)).toBeUndefined();
    expect(plugins.map((plugin) => plugin.id)).toEqual(["dual", "server-only"]);
    expect(plugins[0]).toMatchObject({
      id: "dual",
      machineSpecific: true,
      browserModule: { path: "browser.js" },
      serverModule: { path: "server.js" },
    });
    expect(plugins[0]?.browserModule?.revision).toMatch(/^sha256:[a-f\d]{64}$/u);
    expect(plugins[0]?.serverModule?.revision).toMatch(/^sha256:[a-f\d]{64}$/u);
    expect(plugins[1]).toMatchObject({
      id: "server-only",
      machineSpecific: false,
      serverModule: { path: "server-plugin.js" },
    });
    expect(plugins[1]?.serverModule?.revision).toMatch(/^sha256:[a-f\d]{64}$/u);
    expect(plugins[1]?.browserModule).toBeUndefined();
  });

  it("attributes unsafe, missing, empty, and incompatible declarations while keeping valid packages", async () => {
    const pluginsRoot = join(tempDir, "plugins");
    await writePlugin(join(pluginsRoot, "valid"), {
      packageJson: { piWeb: { plugins: [{ id: "valid", serverModule: "server.js" }] } },
      files: { "server.js": "export default {};" },
    });
    await writePlugin(join(pluginsRoot, "empty"), {
      packageJson: { piWeb: { plugins: [{ id: "empty" }] } },
      files: {},
    });
    await writePlugin(join(pluginsRoot, "missing"), {
      packageJson: { piWeb: { plugins: [{ id: "missing", serverModule: "missing.js" }] } },
      files: {},
    });
    await writePlugin(join(pluginsRoot, "unsafe"), {
      packageJson: { piWeb: { plugins: [{ id: "unsafe", serverModule: "../escape.js" }] } },
      files: {},
    });
    await writePlugin(join(pluginsRoot, "dual-unscoped"), {
      packageJson: { piWeb: { plugins: [{ id: "dual-unscoped", browserRoot: ".", module: "browser.js", serverModule: "server.js", machineSpecific: false }] } },
      files: { "browser.js": "export default {};", "server.js": "export default {};" },
    });
    const warnings: string[] = [];
    const catalog = new PiWebPluginCatalog({
      roots: [{ path: pluginsRoot, source: "fixture", scope: "local" }],
      packageProvider: false,
      warningSink: (message) => { warnings.push(message); },
    });

    const snapshot = await catalog.snapshot();

    expect(snapshot.plugins.map((plugin) => plugin.id)).toEqual(["valid"]);
    expect(snapshot.diagnostics).toHaveLength(4);
    expect(snapshot.diagnostics.map((diagnostic) => diagnostic.message)).toEqual(expect.arrayContaining([
      expect.stringContaining("must declare module or serverModule"),
      expect.stringContaining("server module not found for missing"),
      expect.stringContaining("Unsafe PI WEB plugin server module path for unsafe"),
      expect.stringContaining("must be machine-specific"),
    ]));
    expect(snapshot.diagnostics.every((diagnostic) => diagnostic.source.startsWith(pluginsRoot))).toBe(true);
    expect(warnings).toEqual(snapshot.diagnostics.map((diagnostic) => `Skipping PI WEB plugin from ${diagnostic.source}: ${diagnostic.message}`));
  });

  it("rejects reserved external plugin ids with package-attributed diagnostics", async () => {
    const pluginsRoot = join(tempDir, "plugins");
    const reservedPlugins = [
      { directory: "reserved-core", id: "core" },
      { directory: "reserved-themes", id: "themes" },
      { directory: "reserved-machine", id: "machine.remote.tools" },
    ];
    for (const { directory, id } of reservedPlugins) {
      await writePlugin(join(pluginsRoot, directory), {
        packageJson: { piWeb: { plugins: [{ id, browserRoot: ".", module: "browser.js" }] } },
        files: { "browser.js": "export default {};" },
      });
    }
    await writePlugin(join(pluginsRoot, "valid"), {
      packageJson: { piWeb: { plugins: [{ id: "valid", browserRoot: ".", module: "browser.js" }] } },
      files: { "browser.js": "export default {};" },
    });
    const catalog = new PiWebPluginCatalog({
      roots: [{ path: pluginsRoot, source: "fixture", scope: "local" }],
      packageProvider: false,
      warningSink: () => undefined,
    });

    const snapshot = await catalog.snapshot();

    expect(snapshot.plugins.map((plugin) => plugin.id)).toEqual(["valid"]);
    expect(snapshot.diagnostics).toHaveLength(3);
    for (const { directory, id } of reservedPlugins) {
      const source = join(pluginsRoot, directory);
      const diagnostic = snapshot.diagnostics.find((candidate) => candidate.source === source);
      expect(diagnostic?.code).toBe("invalid-package");
      expect(diagnostic?.message).toContain(`Reserved PI WEB plugin id in ${join(source, "package.json")}: ${id}`);
    }
  });

  it("uses one duplicate-id winner across browser and server capabilities", async () => {
    const firstRoot = join(tempDir, "first");
    const secondRoot = join(tempDir, "second");
    await writePlugin(join(firstRoot, "duplicate"), {
      packageJson: { piWeb: { plugins: [{ id: "duplicate", serverModule: "server.js" }] } },
      files: { "server.js": "export default {};" },
    });
    await writePlugin(join(secondRoot, "duplicate"), {
      packageJson: { piWeb: { plugins: [{ id: "duplicate", browserRoot: ".", module: "browser.js" }] } },
      files: { "browser.js": "export default {};" },
    });
    const catalog = new PiWebPluginCatalog({
      roots: [
        { path: firstRoot, source: "first", scope: "bundled" },
        { path: secondRoot, source: "second", scope: "local" },
      ],
      packageProvider: false,
      warningSink: () => undefined,
    });

    const snapshot = await catalog.snapshot();

    expect(snapshot.plugins).toHaveLength(1);
    expect(snapshot.plugins[0]).toMatchObject({ id: "duplicate", source: "first" });
    expect(snapshot.plugins[0]?.serverModule).toBeDefined();
    expect(snapshot.plugins[0]?.browserModule).toBeUndefined();
    expect(snapshot.diagnostics).toEqual([{
      code: "duplicate-id",
      source: "second",
      message: "Duplicate PI WEB plugin id: duplicate",
      pluginId: "duplicate",
    }]);
    await expect(catalog.browserPlugin("duplicate")).resolves.toBeUndefined();
  });

  it("limits bundled-only discovery before consulting external package providers", async () => {
    const bundledRoot = join(tempDir, "bundled");
    const localRoot = join(tempDir, "local");
    await writePlugin(join(bundledRoot, "bundled-provider"), {
      packageJson: { piWeb: { plugins: [{ id: "bundled-provider", serverModule: "server.js" }] } },
      files: { "server.js": "export default {};" },
    });
    await writePlugin(join(localRoot, "local-provider"), {
      packageJson: { piWeb: { plugins: [{ id: "local-provider", serverModule: "server.js" }] } },
      files: { "server.js": "export default {};" },
    });
    const listPackages = vi.fn<PiPackageProvider["listPackages"]>(() => {
      throw new Error("external package discovery must not run");
    });
    const catalog = new PiWebPluginCatalog({
      roots: [
        { path: bundledRoot, source: "bundled", scope: "bundled" },
        { path: localRoot, source: "local", scope: "local" },
      ],
      packageProvider: { listPackages, getInstalledPath: () => undefined },
    });

    const snapshot = await catalog.snapshot({ scope: "bundled" });

    expect(snapshot.plugins.map(({ id }) => id)).toEqual(["bundled-provider"]);
    expect(listPackages).not.toHaveBeenCalled();
  });

  it("preserves configured Pi-package source and scope for server entries", async () => {
    const packageRoot = join(tempDir, "package");
    await writePlugin(packageRoot, {
      packageJson: { piWeb: { plugins: [{ id: "package-provider", serverModule: "dist/server.js" }] } },
      files: { "dist/server.js": "export default {};" },
    });
    const packageProvider: PiPackageProvider = {
      listPackages: () => [{ source: "npm:@acme/provider", scope: "user", installedPath: packageRoot }],
      getInstalledPath: () => undefined,
    };
    const catalog = new PiWebPluginCatalog({ roots: [], packageProvider });

    await expect(catalog.snapshot()).resolves.toMatchObject({
      plugins: [{ id: "package-provider", source: "npm:@acme/provider", scope: "user", enabled: true }],
      diagnostics: [],
    });
  });

  it.each([".git", "node_modules"])("rejects package metadata canonically aliased into %s with an attributed diagnostic", async (excludedDirectory) => {
    const idSuffix = excludedDirectory === ".git" ? "git" : "node-modules";
    const pluginRoot = join(tempDir, "plugins", `metadata-alias-${idSuffix}`);
    const metadataPath = join(pluginRoot, excludedDirectory, "package.json");
    await mkdir(join(pluginRoot, excludedDirectory), { recursive: true });
    await writeFile(metadataPath, `${JSON.stringify({
      piWeb: { plugins: [{ id: `metadata-alias-${idSuffix}`, browserRoot: ".", module: "browser.js" }] },
    }, null, 2)}\n`);
    await writeFile(join(pluginRoot, "browser.js"), "export default {};\n");
    await symlink(metadataPath, join(pluginRoot, "package.json"));
    const catalog = new PiWebPluginCatalog({
      roots: [{ path: join(tempDir, "plugins"), source: "fixture", scope: "local" }],
      packageProvider: false,
      warningSink: () => undefined,
    });

    const snapshot = await catalog.snapshot();

    expect(snapshot.plugins).toEqual([]);
    expect(snapshot.diagnostics).toHaveLength(1);
    expect(snapshot.diagnostics[0]).toMatchObject({ code: "invalid-package", source: pluginRoot });
    expect(snapshot.diagnostics[0]?.message).toContain(`package metadata resolves inside excluded ${excludedDirectory} directory`);
  });

  it("rejects package metadata symlinks that escape the canonical package root", async () => {
    const pluginRoot = join(tempDir, "plugins", "escaped-metadata");
    const externalMetadata = join(tempDir, "external-package.json");
    await mkdir(pluginRoot, { recursive: true });
    await writeFile(externalMetadata, `${JSON.stringify({
      piWeb: { plugins: [{ id: "escaped-metadata", browserRoot: ".", module: "browser.js" }] },
    }, null, 2)}\n`);
    await writeFile(join(pluginRoot, "browser.js"), "export default {};\n");
    await symlink(externalMetadata, join(pluginRoot, "package.json"));
    const catalog = new PiWebPluginCatalog({
      roots: [{ path: join(tempDir, "plugins"), source: "fixture", scope: "local" }],
      packageProvider: false,
      warningSink: () => undefined,
    });

    const snapshot = await catalog.snapshot();

    expect(snapshot.plugins).toEqual([]);
    expect(snapshot.diagnostics).toHaveLength(1);
    expect(snapshot.diagnostics[0]).toMatchObject({ code: "invalid-package", source: pluginRoot });
    expect(snapshot.diagnostics[0]?.message).toContain("package metadata escapes its package");
  });

  it("rejects module symlinks that escape the plugin package", async () => {
    const pluginRoot = join(tempDir, "plugins", "escaped");
    const externalModule = join(tempDir, "outside.js");
    await mkdir(pluginRoot, { recursive: true });
    await writeFile(externalModule, "export default {};\n");
    await symlink(externalModule, join(pluginRoot, "server.js"));
    await writeFile(join(pluginRoot, "package.json"), `${JSON.stringify({ piWeb: { plugins: [{ id: "escaped", serverModule: "server.js" }] } }, null, 2)}\n`);
    const catalog = new PiWebPluginCatalog({
      roots: [{ path: join(tempDir, "plugins"), source: "fixture", scope: "local" }],
      packageProvider: false,
      warningSink: () => undefined,
    });

    const snapshot = await catalog.snapshot();

    expect(snapshot.plugins).toEqual([]);
    expect(snapshot.diagnostics).toHaveLength(1);
    expect(snapshot.diagnostics[0]?.message).toContain("escapes its package");
  });
});

describe("defaultPluginRoots", () => {
  it("never scans pi-packages/, so Pi packages shipped there are never bundled/local discovery roots", () => {
    const roots = defaultPluginRoots(tempDir);

    expect(roots.some((root) => root.path.includes("pi-packages"))).toBe(false);
  });

  it("keeps a single bundled root at dist/pi-web-plugins, unaffected by Pi packages shipped alongside it", () => {
    const roots = defaultPluginRoots(tempDir);

    const bundled = roots.filter((root) => root.scope === "bundled");
    expect(bundled).toHaveLength(1);
    expect(bundled[0]?.source).toBe("bundled");
    expect(bundled[0]?.path.endsWith(join("dist", "pi-web-plugins"))).toBe(true);
  });

  it("keeps a single data-directory local root, distinct from any Pi package install location", () => {
    const roots = defaultPluginRoots(tempDir);

    const local = roots.filter((root) => root.scope === "local" && root.source === "local");
    expect(local).toHaveLength(1);
    expect(local[0]?.path).toBe(join(piWebDataDir(), "plugins"));
  });
});

async function writePlugin(root: string, options: { packageJson: unknown; files: Record<string, string> }): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "package.json"), `${JSON.stringify(options.packageJson, null, 2)}\n`);
  for (const [path, content] of Object.entries(options.files)) {
    const filePath = join(root, path);
    await mkdir(join(filePath, ".."), { recursive: true });
    await writeFile(filePath, content);
  }
}
