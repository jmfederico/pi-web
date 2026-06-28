import { mkdtemp, rm, writeFile, mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PiWebPluginService, type PiPackageProvider } from "./piWebPluginService.js";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "pi-web-plugin-service-test-"));
});

afterEach(async () => {
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
      plugins: [expect.objectContaining({ id: "info", source: "test", scope: "local", machineSpecific: false })],
    });
    const manifest = await service.manifest();
    expect(manifest.plugins[0]?.module).toMatch(/^\/pi-web-plugins\/info\/pi-web-plugin\.js\?v=\d+$/u);

    const asset = await service.readAsset("info", "pi-web-plugin.js");
    expect(asset?.contentType).toBe("application/javascript; charset=utf-8");
    expect(asset?.content.toString("utf8")).toContain("export default");
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
    expect(manifest.plugins[0]?.module).toMatch(/^\/pi-web-plugins\/review\/dist\/review\.js\?v=\d+$/u);
  });

  it("uses the current config provider for Pi package plugin discovery", async () => {
    const packageDir = join(tempDir, "pkg");
    const initialAgentDir = join(tempDir, "initial-agent");
    const updatedAgentDir = join(tempDir, "updated-agent");
    let currentConfig = { agent: { dir: initialAgentDir } };
    await writePlugin(packageDir, {
      packageJson: { piWeb: { plugins: [{ id: "agent-package", module: "dist/plugin.js" }] } },
      files: { "dist/plugin.js": "export default {};" },
    });
    await mkdir(initialAgentDir, { recursive: true });
    await mkdir(updatedAgentDir, { recursive: true });
    await writeFile(join(updatedAgentDir, "settings.json"), `${JSON.stringify({ packages: [packageDir] }, null, 2)}\n`, "utf8");
    const service = new PiWebPluginService({ roots: [], cwd: tempDir, configProvider: () => currentConfig });

    await expect(service.manifest()).resolves.toEqual({ plugins: [] });

    currentConfig = { agent: { dir: updatedAgentDir } };

    await expect(service.manifest()).resolves.toMatchObject({ plugins: [{ id: "agent-package", source: packageDir, scope: "user" }] });
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
    await writePlugin(join(tempDir, "plugins", "one"), {
      packageJson: { piWeb: { plugins: [{ id: "duplicate", module: "pi-web-plugin.js" }] } },
      files: { "pi-web-plugin.js": "export default {};" },
    });
    await writePlugin(join(tempDir, "plugins", "two"), {
      packageJson: { piWeb: { plugins: [{ id: "duplicate", module: "pi-web-plugin.js" }] } },
      files: { "pi-web-plugin.js": "export default {};" },
    });

    const service = new PiWebPluginService({ roots: [{ path: join(tempDir, "plugins"), source: "test", scope: "local" }], packageProvider: false });

    const manifest = await service.manifest();
    expect(manifest.plugins.map((plugin) => plugin.id)).toEqual(["duplicate"]);
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

    await expect(new PiWebPluginService({ roots: [{ path: legacyRoot, source: "test", scope: "local" }], packageProvider: false }).manifest()).resolves.toEqual({ plugins: [] });
    await expect(new PiWebPluginService({ roots: [{ path: unsafeRoot, source: "test", scope: "local" }], packageProvider: false }).manifest()).resolves.toEqual({ plugins: [] });
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

async function writePlugin(root: string, options: { packageJson: unknown; files: Record<string, string> }): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "package.json"), `${JSON.stringify(options.packageJson, null, 2)}\n`);
  for (const [path, content] of Object.entries(options.files)) {
    const filePath = join(root, path);
    await mkdir(join(filePath, ".."), { recursive: true });
    await writeFile(filePath, content);
  }
}
