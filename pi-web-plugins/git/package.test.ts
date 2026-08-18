import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PiWebPluginCatalog } from "../../src/server/piWebPluginCatalog.js";
import { createServerPluginRuntime } from "../../src/server/plugins/serverPluginRuntime.js";
import { WorkspaceProviderRegistry } from "../../src/server/workspaces/workspaceProviderRegistry.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("bundled Git package metadata", () => {
  it("declares its generated browser and server JavaScript as ES modules", async () => {
    const metadata: unknown = JSON.parse(await readFile("pi-web-plugins/git/package.json", "utf8"));

    expect(metadata).toMatchObject({
      private: true,
      type: "module",
      piWeb: { plugins: [{ id: "git", browserRoot: "browser", module: "browser/pi-web-plugin.js", serverModule: "server-plugin.js" }] },
    });
  });

  it("is discovered as one bundled, machine-specific dual-entry plugin", async () => {
    const { catalog } = await gitCatalogFixture(true);

    await expect(catalog.snapshot()).resolves.toMatchObject({
      plugins: [{
        id: "git",
        source: "bundled",
        scope: "bundled",
        machineSpecific: true,
        enabled: true,
        browserRoot: { path: "browser" },
        browserModule: { path: "browser/pi-web-plugin.js" },
        serverModule: { path: "server-plugin.js" },
      }],
      diagnostics: [],
    });
  });

  it("keeps Git workspace and changes implementations out of host production code", async () => {
    const violations: string[] = [];
    for (const file of await productionTypeScriptFiles("src/server")) {
      if (/(?:^|\/)(?:gitService|gitRoutes|gitWorktreeDiscovery|workspaceService)\.ts$/u.test(file)) {
        violations.push(`${file}: retains a host Git workspace or changes implementation`);
      }
      const source = await readFile(file, "utf8");
      if (/from\s+["'][^"']*(?:gitService|gitRoutes|gitWorktreeDiscovery|workspaceService)\.js["']/u.test(source)) {
        violations.push(`${file}: imports a host Git workspace or changes implementation`);
      }
      if (/\/git\/(?:status|diff)/u.test(source)) violations.push(`${file}: declares a private Git changes route`);
    }
    const federatedRoutes = await readFile("src/shared/federatedRoutes.ts", "utf8");
    if (/\/git\/(?:status|diff)/u.test(federatedRoutes)) {
      violations.push("src/shared/federatedRoutes.ts: allowlists a private Git changes route");
    }

    expect(violations).toEqual([]);
  });

  it("keeps Git UI registration, state, and provider policy out of the client host", async () => {
    const violations: string[] = [];
    for (const file of await productionTypeScriptFiles("src/client/src")) {
      const source = await readFile(file, "utf8");
      if (/(?:^|\/)(?:WorkspaceGitPanel|gitController|gitFile(?:Tree|List|Shared|ViewPreference))\.ts$/u.test(file)) {
        violations.push(`${file}: retains a host Git UI implementation`);
      }
      if (source.includes("core:workspace.git")) violations.push(`${file}: retains the core Git panel id`);
      if (source.includes("renderBuiltinTabIcon(\"git\")") || source.includes("renderBuiltinTabIcon('git')")) violations.push(`${file}: retains the host Git panel icon`);
      if (/\.pluginId\s*===\s*["']git["']/u.test(source)) violations.push(`${file}: branches on the Git provider id`);
    }

    expect(violations).toEqual([]);
  });

  it("leaves the kernel folder workspace when Git is disabled before import", async () => {
    const { catalog, root } = await gitCatalogFixture(false);
    const importer = vi.fn(() => Promise.reject(new Error("disabled Git module was imported")));
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const runtime = await createServerPluginRuntime({ catalog, importer, logger });
    const registry = new WorkspaceProviderRegistry({ contributions: runtime.providerContributions(), logger });

    const resolution = await registry.resolve({
      id: "project-1",
      name: "Project",
      path: root,
      createdAt: "2026-07-27T00:00:00.000Z",
    });

    expect(importer).not.toHaveBeenCalled();
    expect(runtime.healthRecords()).toEqual([expect.objectContaining({
      pluginId: "git",
      state: "disabled",
      message: "disabled in PI WEB config",
    })]);
    expect(resolution).toMatchObject({
      status: "folder",
      workspaces: [{ path: root, isMain: true }],
    });
    expect(resolution.workspaces[0]).not.toHaveProperty("provider");
    await expect(registry.request({
      pluginId: "git",
      moduleRevision: "disabled-revision",
      project: {
        id: "project-1",
        name: "Project",
        path: root,
        createdAt: "2026-07-27T00:00:00.000Z",
      },
      workspaceId: resolution.workspaces[0]?.id ?? "missing",
      operation: "status",
      input: null,
    })).rejects.toMatchObject({ code: "inactive-plugin", statusCode: 409 });
    expect(importer).not.toHaveBeenCalled();
    await runtime.stop();
  });
});

async function productionTypeScriptFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...await productionTypeScriptFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") && !entry.name.includes(".testSupport.")) files.push(path);
  }
  return files;
}

async function gitCatalogFixture(enabled: boolean): Promise<{ catalog: PiWebPluginCatalog; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "pi-web-git-package-"));
  tempRoots.push(root);
  const pluginsRoot = join(root, "plugins");
  const pluginRoot = join(pluginsRoot, "git");
  await mkdir(join(pluginRoot, "browser"), { recursive: true });
  await Promise.all([
    writeFile(join(pluginRoot, "package.json"), await readFile("pi-web-plugins/git/package.json", "utf8"), "utf8"),
    writeFile(join(pluginRoot, "browser", "pi-web-plugin.js"), "export default {};\n", "utf8"),
    writeFile(join(pluginRoot, "server-plugin.js"), "export default {};\n", "utf8"),
  ]);
  return {
    root,
    catalog: new PiWebPluginCatalog({
      roots: [{ path: pluginsRoot, source: "bundled", scope: "bundled" }],
      packageProvider: false,
      configProvider: () => ({ plugins: { git: { enabled } } }),
    }),
  };
}
