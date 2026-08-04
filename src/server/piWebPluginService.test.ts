import { mkdtemp, rm, writeFile, mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ActiveAgentProfileAccessError } from "./activeAgentProfileProvider.js";
import { PiWebPluginCatalog, PiWebPluginService, type PiPackageProvider } from "./piWebPluginService.js";
import { WorkspaceCatalogProtocolError, type WorkspaceProviderRuntimeReader } from "./workspaces/workspaceCatalog.js";

let tempDir: string;

const originalDockerRuntime = process.env["PI_WEB_DOCKER_RUNTIME"];
const originalDockerMode = process.env["PI_WEB_DOCKER_MODE"];
const originalDockerDevRepoRoot = process.env["PI_WEB_DOCKER_DEV_REPO_ROOT"];
const originalDockerInstallDir = process.env["PI_WEB_DOCKER_INSTALL_DIR"];

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "pi-web-plugin-service-test-"));
});

afterEach(async () => {
  restoreEnv("PI_WEB_DOCKER_RUNTIME", originalDockerRuntime);
  restoreEnv("PI_WEB_DOCKER_MODE", originalDockerMode);
  restoreEnv("PI_WEB_DOCKER_DEV_REPO_ROOT", originalDockerDevRepoRoot);
  restoreEnv("PI_WEB_DOCKER_INSTALL_DIR", originalDockerInstallDir);
  await rm(tempDir, { recursive: true, force: true });
});

describe("PiWebPluginService", () => {
  it("discovers local plugins and serves assets", async () => {
    const pluginDir = join(tempDir, "plugins", "info");
    await writePlugin(pluginDir, {
      packageJson: { piWeb: { plugins: [{ id: "info", module: "pi-web-plugin.js" }] } },
      files: { "pi-web-plugin.js": "export default { apiVersion: 1, name: 'Info', activate: () => ({ contributions: {} }) };" },
    });

    const service = new PiWebPluginService({ roots: [{ path: join(tempDir, "plugins"), source: "test", scope: "local" }], packageProvider: false });

    await expect(service.manifest()).resolves.toEqual({
      lifecycleVersion: 1,
      plugins: [expect.objectContaining({ id: "info", source: "test", scope: "local", machineSpecific: false })],
    });
    const manifest = await service.manifest();
    const module = manifest.plugins[0]?.module;
    expect(module).toMatch(/^\/pi-web-plugins\/info\/pi-web-plugin\.js\?v=sha256%3A[a-f\d]{64}$/u);
    expect(new URL(module ?? "", "http://old-gateway.test/pi-web-plugins/info/").pathname).toBe("/pi-web-plugins/info/pi-web-plugin.js");
    await expect(service.plugins()).resolves.toMatchObject({ plugins: [{ module }] });

    const asset = await service.readAsset("info", "pi-web-plugin.js");
    expect(asset?.contentType).toBe("application/javascript; charset=utf-8");
    expect(asset?.content.toString("utf8")).toContain("export default");
  });

  it("preserves content types for extension-only asset names", async () => {
    const pluginDir = join(tempDir, "plugins", "extension-only");
    await writePlugin(pluginDir, {
      packageJson: { piWeb: { plugins: [{ id: "extension-only", module: ".js" }] } },
      files: {
        ".js": "export default {};",
        ".svg": '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
      },
    });

    const service = new PiWebPluginService({ roots: [{ path: join(tempDir, "plugins"), source: "test", scope: "local" }], packageProvider: false });

    await expect(service.readAsset("extension-only", ".js")).resolves.toMatchObject({ contentType: "application/javascript; charset=utf-8" });
    await expect(service.readAsset("extension-only", ".svg")).resolves.toMatchObject({ contentType: "image/svg+xml" });
  });

  it("serves nested SVG assets with a browser-compatible content type", async () => {
    const pluginDir = join(tempDir, "plugins", "icons");
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"></svg>';
    await writePlugin(pluginDir, {
      packageJson: { piWeb: { plugins: [{ id: "icons", module: "pi-web-plugin.js" }] } },
      files: {
        "pi-web-plugin.js": "export default {};",
        "assets/icon.svg": svg,
        "assets/uppercase.SVG": svg,
        "assets/data.bin": "unknown",
      },
    });

    const service = new PiWebPluginService({ roots: [{ path: join(tempDir, "plugins"), source: "test", scope: "local" }], packageProvider: false });

    const svgAsset = await service.readAsset("icons", "assets/icon.svg");
    expect(svgAsset?.contentType).toBe("image/svg+xml");
    expect(svgAsset?.content.toString("utf8")).toBe(svg);
    await expect(service.readAsset("icons", "assets/uppercase.SVG")).resolves.toMatchObject({ contentType: "image/svg+xml" });
    await expect(service.readAsset("icons", "assets/data.bin")).resolves.toMatchObject({ contentType: "application/octet-stream" });
  });

  it("includes machine-specific preferences in plugin manifests", async () => {
    await writePlugin(join(tempDir, "plugins", "updates"), {
      packageJson: { piWeb: { plugins: [{ id: "updates", module: "pi-web-plugin.js", machineSpecific: true }] } },
      files: { "pi-web-plugin.js": "export default {};" },
    });

    const service = new PiWebPluginService({ roots: [{ path: join(tempDir, "plugins"), source: "test", scope: "local" }], packageProvider: false });

    await expect(service.manifest()).resolves.toMatchObject({ plugins: [{ id: "updates", machineSpecific: true }] });
    await expect(service.plugins()).resolves.toMatchObject({ plugins: [{ id: "updates", machineSpecific: true, enabled: true }] });
  });

  it("keeps server-only entries out of browser manifests and assets while reporting their desired state", async () => {
    await writePlugin(join(tempDir, "plugins", "server-only"), {
      packageJson: { piWeb: { plugins: [{ id: "server-only", serverModule: "server.js" }] } },
      files: { "server.js": "throw new Error('must not execute');" },
    });
    await writePlugin(join(tempDir, "plugins", "dual"), {
      packageJson: { piWeb: { plugins: [{ id: "dual", module: "browser.js", serverModule: "server.js" }] } },
      files: { "browser.js": "export default {};", "server.js": "throw new Error('must not execute');" },
    });
    const catalog = new PiWebPluginCatalog({
      roots: [{ path: join(tempDir, "plugins"), source: "test", scope: "local" }],
      packageProvider: false,
      configProvider: () => ({ plugins: { "server-only": { enabled: false } } }),
    });
    const service = new PiWebPluginService({ catalog, runtimeProvider: activeRuntimeProvider(catalog) });

    const manifest = await service.manifest();
    expect(manifest).toMatchObject({ plugins: [{ id: "dual", machineSpecific: true }] });
    expect(manifest.plugins[0]?.backendRevision).toMatch(/^sha256:[a-f\d]{64}$/u);
    const plugins = await service.plugins();
    expect(plugins.plugins[0]).toMatchObject({ id: "dual", enabled: true, machineSpecific: true });
    expect(plugins.plugins[0]?.module).toContain("/dual/browser.js?v=");
    expect(plugins.plugins[1]).toMatchObject({
      id: "server-only",
      source: "test",
      scope: "local",
      machineSpecific: false,
      enabled: false,
      discovered: true,
      server: { state: "disabled", restartRequired: false },
    });
    await expect(service.readAsset("server-only", "server.js")).resolves.toBeUndefined();
    await expect(service.readAsset("dual", "browser.js")).resolves.toBeDefined();
  });

  it("pins every server-backed browser asset to the active package content revision", async () => {
    const pluginDir = join(tempDir, "plugins", "dual-assets");
    const chunkPath = join(pluginDir, "chunk.js");
    await writePlugin(pluginDir, {
      packageJson: { piWeb: { plugins: [{ id: "dual-assets", module: "browser.js", serverModule: "server.js" }] } },
      files: {
        "browser.js": "import './chunk.js'; export default {};",
        "chunk.js": "export const value = 'active';",
        "server.js": "export default {};",
      },
    });
    const catalog = new PiWebPluginCatalog({
      roots: [{ path: join(tempDir, "plugins"), source: "test", scope: "local" }],
      packageProvider: false,
    });
    const service = new PiWebPluginService({ catalog, runtimeProvider: activeRuntimeProvider(catalog) });

    await expect(service.manifest()).resolves.toMatchObject({ plugins: [{ id: "dual-assets" }] });
    await expect(service.readAsset("dual-assets", "chunk.js")).resolves.toBeDefined();

    await writeFile(chunkPath, "export const value = 'desired-update';");

    await expect(service.manifest()).resolves.toEqual({ lifecycleVersion: 1, plugins: [] });
    const pinnedChunk = await service.readAsset("dual-assets", "chunk.js");
    expect(pinnedChunk?.content.toString("utf8")).toBe("export const value = 'active';");
  });

  it("withholds server-backed browser modules and reports an incompatible sessiond protocol", async () => {
    await writePlugin(join(tempDir, "plugins", "dual"), {
      packageJson: { piWeb: { plugins: [{ id: "dual", module: "browser.js", serverModule: "server.js" }] } },
      files: { "browser.js": "export default {};", "server.js": "export default {};" },
    });
    const service = new PiWebPluginService({
      roots: [{ path: join(tempDir, "plugins"), source: "test", scope: "local" }],
      packageProvider: false,
      runtimeProvider: {
        providerRuntime: () => Promise.reject(new WorkspaceCatalogProtocolError("unsupported provider runtime protocol")),
      },
    });

    await expect(service.manifest()).resolves.toEqual({ lifecycleVersion: 1, plugins: [] });
    await expect(service.plugins()).resolves.toMatchObject({
      plugins: [{ id: "dual", server: { state: "unknown" } }],
      serverRuntime: { status: "incompatible", message: "unsupported provider runtime protocol" },
    });
  });

  it.each(["bundled-only", "none"] as const)("reports desired %s safe start as restart-pending before sessiond imports plugins", async (safeStart) => {
    await writePlugin(join(tempDir, "plugins", "browser-only"), {
      packageJson: { piWeb: { plugins: [{ id: "browser-only", module: "browser.js" }] } },
      files: { "browser.js": "export default {};" },
    });
    const service = new PiWebPluginService({
      roots: [{ path: join(tempDir, "plugins"), source: "test", scope: "local" }],
      packageProvider: false,
      runtimeProvider: {
        providerRuntime: () => Promise.resolve({ protocolVersion: 1, records: [], health: [], diagnostics: [] }),
      },
      recoveryProvider: () => ({ safeStart }),
    });

    await expect(service.plugins()).resolves.toMatchObject({
      serverRuntime: { status: "available", desiredSafeStart: safeStart, restartRequired: true },
    });
    await expect(service.manifest()).resolves.toMatchObject({ plugins: [{ id: "browser-only" }] });
  });

  it("encodes browser module path segments without changing revision query behavior", async () => {
    await writePlugin(join(tempDir, "plugins", "encoded"), {
      packageJson: { piWeb: { plugins: [{ id: "encoded", module: "dist/plugin file#1.js" }] } },
      files: { "dist/plugin file#1.js": "export default {};" },
    });
    const service = new PiWebPluginService({ roots: [{ path: join(tempDir, "plugins"), source: "test", scope: "local" }], packageProvider: false });

    const manifest = await service.manifest();

    expect(manifest.plugins[0]?.module).toMatch(/^\/pi-web-plugins\/encoded\/dist\/plugin%20file%231\.js\?v=sha256%3A[a-f\d]{64}$/u);
  });

  it("serves an immutable cached browser artifact until a new manifest revision replaces it", async () => {
    const pluginDir = join(tempDir, "plugins", "changing");
    const browserPath = join(pluginDir, "browser.js");
    await writePlugin(pluginDir, {
      packageJson: { piWeb: { plugins: [{ id: "changing", module: "browser.js" }] } },
      files: { "browser.js": "export default {};" },
    });
    const service = new PiWebPluginService({ roots: [{ path: join(tempDir, "plugins"), source: "test", scope: "local" }], packageProvider: false });
    const module = (await service.manifest()).plugins[0]?.module;
    const revision = new URL(module ?? "", "http://pi-web.local").searchParams.get("v");
    if (revision === null) throw new Error("Expected browser manifest revision");

    await expect(service.readAsset("changing", "browser.js", revision)).resolves.toBeDefined();
    await writeFile(browserPath, "export default { changed: true };");

    const pinned = await service.readAsset("changing", "browser.js", revision);
    expect(pinned?.content.toString("utf8")).toBe("export default {};");
    await expect(service.manifest()).resolves.toMatchObject({ plugins: [{ id: "changing" }] });
    await expect(service.readAsset("changing", "browser.js", revision)).resolves.toBeUndefined();
  });

  it("adds Docker runtime hints to the Updates plugin module URL", async () => {
    process.env["PI_WEB_DOCKER_RUNTIME"] = "1";
    process.env["PI_WEB_DOCKER_MODE"] = "dev";
    await writePlugin(join(tempDir, "plugins", "updates"), {
      packageJson: { piWeb: { plugins: [{ id: "updates", module: "pi-web-plugin.js", machineSpecific: true }] } },
      files: { "pi-web-plugin.js": "export default {};" },
    });

    const service = new PiWebPluginService({ roots: [{ path: join(tempDir, "plugins"), source: "test", scope: "local" }], packageProvider: false });

    const manifest = await service.manifest();
    const moduleUrl = new URL(manifest.plugins[0]?.module ?? "", "http://pi-web.test/pi-web-plugins/manifest.json");
    expect(moduleUrl.pathname).toBe("/pi-web-plugins/updates/pi-web-plugin.js");
    expect(moduleUrl.searchParams.get("v")).toMatch(/^sha256:[a-f\d]{64}$/u);
    expect(moduleUrl.searchParams.get("piWebDockerMode")).toBe("dev");
  });

  it("discovers Pi package plugins through an injected package provider", async () => {
    const packageDir = join(tempDir, "pkg");
    await writePlugin(packageDir, {
      packageJson: { piWeb: { plugins: [{ id: "review", module: "dist/review.js" }] } },
      files: { "dist/review.js": "export default { apiVersion: 1, name: 'Review', activate: () => ({ contributions: {} }) };" },
    });
    const packageProvider: PiPackageProvider = {
      listPackages: () => [{ source: "npm:@acme/review", scope: "user", installedPath: packageDir }],
      getInstalledPath: () => undefined,
    };

    const service = new PiWebPluginService({ roots: [], packageProvider });

    const manifest = await service.manifest();
    expect(manifest.plugins).toHaveLength(1);
    expect(manifest.plugins[0]).toMatchObject({ id: "review", source: "npm:@acme/review", scope: "user" });
    expect(manifest.plugins[0]?.module).toMatch(/^\/pi-web-plugins\/review\/dist\/review\.js\?v=sha256%3A[a-f\d]{64}$/u);
  });

  it("uses the active agent directory on every Pi package plugin discovery", async () => {
    const packageDir = join(tempDir, "pkg");
    const initialAgentDir = join(tempDir, "initial-agent");
    const updatedAgentDir = join(tempDir, "updated-agent");
    let activeAgentDir = initialAgentDir;
    await writePlugin(packageDir, {
      packageJson: { piWeb: { plugins: [{ id: "agent-package", module: "dist/plugin.js" }] } },
      files: { "dist/plugin.js": "export default {};" },
    });
    await mkdir(initialAgentDir, { recursive: true });
    await mkdir(updatedAgentDir, { recursive: true });
    await writeFile(join(updatedAgentDir, "settings.json"), `${JSON.stringify({ packages: [packageDir] }, null, 2)}\n`, "utf8");
    const service = new PiWebPluginService({ roots: [], cwd: tempDir, agentDirProvider: () => activeAgentDir });

    await expect(service.manifest()).resolves.toEqual({ lifecycleVersion: 1, plugins: [] });

    activeAgentDir = updatedAgentDir;

    await expect(service.manifest()).resolves.toMatchObject({ plugins: [{ id: "agent-package", source: packageDir, scope: "user" }] });
  });

  it("fails complete package-backed discovery closed while keeping known local assets independent", async () => {
    const pluginDir = join(tempDir, "plugins", "local-only");
    await writePlugin(pluginDir, {
      packageJson: { piWeb: { plugins: [{ id: "local-only", module: "pi-web-plugin.js" }] } },
      files: { "pi-web-plugin.js": "export default {};" },
    });
    const profileError = new ActiveAgentProfileAccessError({ status: "invalid", error: "missing descriptor" });
    const service = new PiWebPluginService({
      roots: [{ path: join(tempDir, "plugins"), source: "test", scope: "local" }],
      agentDirProvider: () => { throw profileError; },
    });

    await expect(service.manifest()).rejects.toBe(profileError);
    await expect(service.readAsset("local-only", "pi-web-plugin.js")).resolves.toMatchObject({ contentType: "application/javascript; charset=utf-8" });
  });

  it("refreshes Pi package plugin discovery after Pi package settings change", async () => {
    const agentDir = join(tempDir, "agent");
    const firstPackageDir = join(tempDir, "first-package");
    const secondPackageDir = join(tempDir, "second-package");
    await writePlugin(firstPackageDir, {
      packageJson: { piWeb: { plugins: [{ id: "first", module: "pi-web-plugin.js" }] } },
      files: { "pi-web-plugin.js": "export default {};" },
    });
    await writePlugin(secondPackageDir, {
      packageJson: { piWeb: { plugins: [{ id: "second", module: "pi-web-plugin.js" }] } },
      files: { "pi-web-plugin.js": "export default {};" },
    });
    await writePiPackageSettings(agentDir, [firstPackageDir]);
    const service = new PiWebPluginService({ roots: [], cwd: tempDir, agentDir });

    await expect(service.manifest()).resolves.toMatchObject({ plugins: [{ id: "first" }] });

    await writePiPackageSettings(agentDir, [secondPackageDir]);

    const manifest = await service.manifest();
    expect(manifest.plugins.map((plugin) => plugin.id)).toEqual(["second"]);
  });

  it("discovers source checkout plugin packages without symlinks", async () => {
    await mkdir(join(tempDir, "src", "server"), { recursive: true });
    await writeFile(join(tempDir, "src", "server", "index.ts"), "export {};\n");
    await writePlugin(join(tempDir, "plugins", "source-dev"), {
      packageJson: { piWeb: { plugins: [{ id: "source-dev", module: "dist/pi-web-plugin.js" }] } },
      files: { "dist/pi-web-plugin.js": "export default { apiVersion: 1, name: 'Source Dev', activate: () => ({ contributions: {} }) };" },
    });

    const service = new PiWebPluginService({ cwd: tempDir, packageProvider: false });

    const manifest = await service.manifest();
    expect(manifest.plugins).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "source-dev", source: "dev", scope: "local" }),
    ]));
    await expect(service.readAsset("source-dev", "dist/pi-web-plugin.js")).resolves.toBeDefined();
  });

  it("discovers local plugins through symlinks for development", async () => {
    const pluginDir = join(tempDir, "dev-plugin");
    await writePlugin(pluginDir, {
      packageJson: { piWeb: { plugins: [{ id: "dev", module: "pi-web-plugin.js" }] } },
      files: { "pi-web-plugin.js": "export default { apiVersion: 1, name: 'Dev', activate: () => ({ contributions: {} }) };" },
    });
    await mkdir(join(tempDir, "plugins"), { recursive: true });
    await symlink(pluginDir, join(tempDir, "plugins", "dev"), process.platform === "win32" ? "junction" : "dir");

    const service = new PiWebPluginService({ roots: [{ path: join(tempDir, "plugins"), source: "test", scope: "local" }], packageProvider: false });

    const manifest = await service.manifest();
    expect(manifest.plugins).toHaveLength(1);
    expect(manifest.plugins[0]).toMatchObject({ id: "dev", source: "test", scope: "local" });
    await expect(service.readAsset("dev", "pi-web-plugin.js")).resolves.toBeDefined();
  });

  it("filters disabled plugins from the manifest while reporting them through plugin status", async () => {
    await writePlugin(join(tempDir, "plugins", "enabled"), {
      packageJson: { piWeb: { plugins: [{ id: "enabled", module: "pi-web-plugin.js" }] } },
      files: { "pi-web-plugin.js": "export default {};" },
    });
    await writePlugin(join(tempDir, "plugins", "disabled"), {
      packageJson: { piWeb: { plugins: [{ id: "disabled", module: "pi-web-plugin.js" }] } },
      files: { "pi-web-plugin.js": "export default {};" },
    });

    const service = new PiWebPluginService({
      roots: [{ path: join(tempDir, "plugins"), source: "test", scope: "local" }],
      packageProvider: false,
      configProvider: () => ({ plugins: { disabled: { enabled: false, settings: { hidden: true } } } }),
    });

    await expect(service.manifest()).resolves.toMatchObject({ plugins: [{ id: "enabled" }] });
    await expect(service.plugins()).resolves.toMatchObject({
      plugins: [
        { id: "disabled", enabled: false },
        { id: "enabled", enabled: true },
      ],
    });
  });

  it("skips duplicate plugin ids", async () => {
    const firstRoot = join(tempDir, "first-root");
    const secondRoot = join(tempDir, "second-root");
    await writePlugin(join(firstRoot, "duplicate"), {
      packageJson: { piWeb: { plugins: [{ id: "duplicate", module: "first.js" }] } },
      files: { "first.js": "export default {};" },
    });
    await writePlugin(join(secondRoot, "duplicate"), {
      packageJson: { piWeb: { plugins: [{ id: "duplicate", module: "second.js", machineSpecific: true }] } },
      files: { "second.js": "export default {};" },
    });

    const service = new PiWebPluginService({
      roots: [
        { path: firstRoot, source: "first", scope: "local" },
        { path: secondRoot, source: "second", scope: "local" },
      ],
      packageProvider: false,
    });

    const manifest = await service.manifest();
    expect(manifest.plugins).toEqual([
      expect.objectContaining({ id: "duplicate", source: "first", machineSpecific: false }),
    ]);
    expect(manifest.plugins[0]?.module).toMatch(/^\/pi-web-plugins\/duplicate\/first\.js\?v=sha256%3A[a-f\d]{64}$/u);
  });

  it("skips legacy metadata shortcuts and unsafe module paths", async () => {
    const legacyRoot = join(tempDir, "legacy-root");
    await writePlugin(join(legacyRoot, "legacy"), {
      packageJson: { piWeb: { id: "legacy", plugin: "pi-web-plugin.js" } },
      files: { "pi-web-plugin.js": "export default {};" },
    });
    const unsafeRoot = join(tempDir, "unsafe-root");
    await writePlugin(join(unsafeRoot, "unsafe"), {
      packageJson: { piWeb: { plugins: [{ id: "unsafe", module: "../escape.js" }] } },
      files: { "pi-web-plugin.js": "export default {};" },
    });

    await expect(new PiWebPluginService({ roots: [{ path: legacyRoot, source: "test", scope: "local" }], packageProvider: false }).manifest()).resolves.toEqual({ lifecycleVersion: 1, plugins: [] });
    await expect(new PiWebPluginService({ roots: [{ path: unsafeRoot, source: "test", scope: "local" }], packageProvider: false }).manifest()).resolves.toEqual({ lifecycleVersion: 1, plugins: [] });
  });

  it("continues discovering valid plugins when another local plugin is invalid", async () => {
    await writePlugin(join(tempDir, "plugins", "valid"), {
      packageJson: { piWeb: { plugins: [{ id: "valid", module: "pi-web-plugin.js" }] } },
      files: { "pi-web-plugin.js": "export default {};" },
    });
    await writePlugin(join(tempDir, "plugins", "legacy"), {
      packageJson: { piWeb: { id: "legacy", plugin: "pi-web-plugin.js" } },
      files: { "pi-web-plugin.js": "export default {};" },
    });

    const service = new PiWebPluginService({ roots: [{ path: join(tempDir, "plugins"), source: "test", scope: "local" }], packageProvider: false });

    const manifest = await service.manifest();
    expect(manifest.plugins.map((plugin) => plugin.id)).toEqual(["valid"]);
  });

  it("rejects unsafe asset traversal", async () => {
    const pluginDir = join(tempDir, "plugins", "safe");
    await writePlugin(pluginDir, {
      packageJson: { piWeb: { plugins: [{ id: "safe", module: "pi-web-plugin.js" }] } },
      files: { "pi-web-plugin.js": "export default {};" },
    });
    await writeFile(join(tempDir, "plugins", "escape.js"), "nope");

    const service = new PiWebPluginService({ roots: [{ path: join(tempDir, "plugins"), source: "test", scope: "local" }], packageProvider: false });

    const manifest = await service.manifest();
    expect(manifest.plugins).toHaveLength(1);
    await expect(service.readAsset("safe", "../escape.js")).resolves.toBeUndefined();
  });
});

async function writePiPackageSettings(agentDir: string, packages: string[]): Promise<void> {
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "settings.json"), `${JSON.stringify({ packages }, null, 2)}\n`);
}

async function writePlugin(root: string, options: { packageJson: unknown; files: Record<string, string> }): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "package.json"), `${JSON.stringify(options.packageJson, null, 2)}\n`);
  for (const [path, content] of Object.entries(options.files)) {
    const filePath = join(root, path);
    await mkdir(join(filePath, ".."), { recursive: true });
    await writeFile(filePath, content);
  }
}

function activeRuntimeProvider(catalog: PiWebPluginCatalog): WorkspaceProviderRuntimeReader {
  const activeSnapshot = catalog.snapshot().then((snapshot) => {
    const records = snapshot.plugins.flatMap((plugin) => plugin.serverModule === undefined ? [] : [{
      pluginId: plugin.id,
      source: plugin.source,
      scope: plugin.scope,
      moduleRevision: plugin.serverModule.revision,
      ...(plugin.browserModule === undefined ? {} : { browserRevision: plugin.browserModule.revision }),
      settingsRevision: plugin.settingsRevision,
      machineSpecific: plugin.machineSpecific,
      state: plugin.enabled ? "active" as const : "disabled" as const,
      ...(plugin.enabled ? { name: plugin.id } : { message: "disabled in PI WEB config" }),
    }]);
    return {
      protocolVersion: 1 as const,
      records,
      health: records.flatMap((record) => record.state === "active" ? [{ pluginId: record.pluginId, health: { status: "healthy" as const } }] : []),
      diagnostics: snapshot.diagnostics,
    };
  });
  return { providerRuntime: () => activeSnapshot };
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) Reflect.deleteProperty(process.env, key);
  else process.env[key] = value;
}
