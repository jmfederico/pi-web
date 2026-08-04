import { mkdir, mkdtemp, realpath, rm, stat, symlink, truncate, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PI_WEB_PLUGIN_ARTIFACT_MAX_BYTES, PiWebPluginCatalog, type PiPackageProvider } from "./piWebPluginCatalog.js";

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
      packageJson: { piWeb: { plugins: [{ id: "browser-only", module: "dist/plugin.js" }] } },
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

  it("uses package content revisions even when browser asset timestamps are preserved", async () => {
    const pluginRoot = join(tempDir, "plugins", "content-revision");
    const browserPath = join(pluginRoot, "browser.js");
    await writePlugin(pluginRoot, {
      packageJson: { piWeb: { plugins: [{ id: "content-revision", module: "browser.js" }] } },
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
      packageJson: { piWeb: { plugins: [{ id: "bounded", module: "browser.js" }] } },
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
      packageJson: { piWeb: { plugins: [{ id: "dual", module: "browser.js", serverModule: "server.js" }] } },
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
      packageJson: { piWeb: { plugins: [{ id: "dual-unscoped", module: "browser.js", serverModule: "server.js", machineSpecific: false }] } },
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

  it("uses one duplicate-id winner across browser and server capabilities", async () => {
    const firstRoot = join(tempDir, "first");
    const secondRoot = join(tempDir, "second");
    await writePlugin(join(firstRoot, "duplicate"), {
      packageJson: { piWeb: { plugins: [{ id: "duplicate", serverModule: "server.js" }] } },
      files: { "server.js": "export default {};" },
    });
    await writePlugin(join(secondRoot, "duplicate"), {
      packageJson: { piWeb: { plugins: [{ id: "duplicate", module: "browser.js" }] } },
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

async function writePlugin(root: string, options: { packageJson: unknown; files: Record<string, string> }): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "package.json"), `${JSON.stringify(options.packageJson, null, 2)}\n`);
  for (const [path, content] of Object.entries(options.files)) {
    const filePath = join(root, path);
    await mkdir(join(filePath, ".."), { recursive: true });
    await writeFile(filePath, content);
  }
}
