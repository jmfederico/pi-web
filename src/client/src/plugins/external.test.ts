import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import gitPlugin from "../../../../pi-web-plugins/git/browser/pi-web-plugin.js";
import { machineScopedPluginId } from "../../../shared/machinePluginIds";
import { loadExternalPlugins, resolvePluginModuleUrl } from "./external";
import { PluginRegistry } from "./registry";

beforeEach(() => {
  vi.stubGlobal("document", { baseURI: "https://pi.example.test/" });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("external plugin manifests", () => {
  it("fetches the default manifest through the application base", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response(null, { status: 404 })));
    vi.stubGlobal("fetch", fetchMock);

    await expect(loadExternalPlugins()).resolves.toEqual({ registrations: [], failures: [] });

    expect(fetchMock).toHaveBeenCalledWith("https://pi.example.test/pi-web-plugins/manifest.json", { cache: "no-store" });
  });

  it("loads manifest-relative modules from a nested deployment", async () => {
    const manifestUrl = "https://pi.example.test/test/ai/pi-web-plugins/manifest.json";
    const fetchMock = vi.fn(() => Promise.resolve(new Response(JSON.stringify({
      plugins: [{ id: "info", module: "./info/pi-web-plugin.js?v=1", backendRevision: "server-r1", machineSpecific: false }],
    }))));
    const moduleLoader = vi.fn(() => Promise.resolve({
      default: { apiVersion: 2, name: "Info", activate: () => ({ contributions: {} }) },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await loadExternalPlugins(manifestUrl, { moduleLoader });

    expect(fetchMock).toHaveBeenCalledWith(manifestUrl, { cache: "no-store" });
    expect(moduleLoader).toHaveBeenCalledWith("https://pi.example.test/test/ai/pi-web-plugins/info/pi-web-plugin.js?v=1");
    expect(result.failures).toEqual([]);
    expect(result.registrations).toMatchObject([{ id: "info", backendRevision: "server-r1", machineSpecific: false, plugin: { apiVersion: 2, name: "Info" } }]);
  });

  it("attributes unsupported browser API versions to the plugin module", async () => {
    const manifestUrl = "https://pi.example.test/pi-web-plugins/manifest.json";
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(JSON.stringify({
      plugins: [{ id: "legacy", module: "./legacy/plugin.js" }],
    })))));

    const result = await loadExternalPlugins(manifestUrl, {
      moduleLoader: () => Promise.resolve({ default: { apiVersion: 1, name: "Legacy", activate: () => ({ contributions: {} }) } }),
    });

    expect(result.registrations).toEqual([]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.entry.id).toBe("legacy");
    expect(result.failures[0]?.error).toEqual(expect.objectContaining({
      message: "Unsupported browser plugin API version for https://pi.example.test/pi-web-plugins/legacy/plugin.js: 1 (expected 2)",
    }));
  });

  it("loads the bundled Git browser entry through the same remote manifest and registry path", async () => {
    const manifestUrl = "https://pi.example.test/api/machines/remote-1/pi-web-plugins/manifest.json";
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(JSON.stringify({
      lifecycleVersion: 1,
      plugins: [{ id: "git", module: "./git/pi-web-plugin.js?v=git-r1", backendRevision: "git-server-r1", machineSpecific: true }],
    })))));
    const moduleLoader = vi.fn(() => Promise.resolve({ default: gitPlugin }));

    const result = await loadExternalPlugins(manifestUrl, { machineId: "remote-1", moduleLoader });
    const registry = new PluginRegistry();
    for (const registration of result.registrations) registry.register(registration);
    const registrationPluginId = machineScopedPluginId("remote-1", "git");

    expect(moduleLoader).toHaveBeenCalledWith("https://pi.example.test/api/machines/remote-1/pi-web-plugins/git/pi-web-plugin.js?v=git-r1");
    expect(result.failures).toEqual([]);
    expect(result.registrations).toMatchObject([{
      id: registrationPluginId,
      sourcePluginId: "git",
      machineId: "remote-1",
      backendRevision: "git-server-r1",
      machineSpecific: true,
    }]);
    expect(registry.getWorkspacePanels().map((panel) => panel.id)).toEqual([`${registrationPluginId}:workspace.git`]);
  });

  it("isolates module failures and lets a later load skip registrations that already succeeded", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(JSON.stringify({
      plugins: [
        { id: "stable", module: "./stable/plugin.js" },
        { id: "retry", module: "./retry/plugin.js" },
      ],
    })))));
    let retryAttempts = 0;
    const moduleLoader = vi.fn((moduleUrl: string) => {
      const id = moduleUrl.includes("/retry/") ? "retry" : "stable";
      if (id === "retry" && retryAttempts++ === 0) return Promise.reject(new Error("temporary module failure"));
      return Promise.resolve({
        default: { apiVersion: 2, name: id, activate: () => ({ contributions: {} }) },
      });
    });
    const registry = new PluginRegistry();

    const first = await loadExternalPlugins(undefined, { moduleLoader });
    for (const registration of first.registrations) registry.register(registration);
    const second = await loadExternalPlugins(undefined, {
      moduleLoader,
      shouldLoadPlugin: (entry) => !registry.hasPlugin(entry.id),
    });

    expect(first.registrations.map(({ id }) => id)).toEqual(["stable"]);
    expect(first.failures).toMatchObject([{ entry: { id: "retry" }, error: new Error("temporary module failure") }]);
    expect(second.failures).toEqual([]);
    expect(second.registrations.map(({ id }) => id)).toEqual(["retry"]);
    expect(moduleLoader.mock.calls.map(([moduleUrl]) => moduleUrl)).toEqual([
      "https://pi.example.test/pi-web-plugins/stable/plugin.js",
      "https://pi.example.test/pi-web-plugins/retry/plugin.js",
      "https://pi.example.test/pi-web-plugins/retry/plugin.js",
    ]);
  });

  it("rejects duplicate manifest ids before importing either module", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(JSON.stringify({
      plugins: [
        { id: "duplicate", module: "./duplicate/one.js" },
        { id: "duplicate", module: "./duplicate/two.js" },
      ],
    })))));
    const moduleLoader = vi.fn(() => Promise.resolve({ default: { apiVersion: 2, name: "Duplicate", activate: () => ({ contributions: {} }) } }));

    await expect(loadExternalPlugins(undefined, { moduleLoader })).rejects.toThrow("Duplicate plugin manifest id: duplicate");
    expect(moduleLoader).not.toHaveBeenCalled();
  });

  it.each(["core", "themes", "machine.remote.plugin"])('rejects reserved manifest id "%s" before importing modules', async (id) => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(JSON.stringify({
      plugins: [{ id, module: `./${id}/plugin.js` }],
    })))));
    const moduleLoader = vi.fn(() => Promise.resolve({ default: { apiVersion: 2, name: id, activate: () => ({ contributions: {} }) } }));

    await expect(loadExternalPlugins(undefined, { moduleLoader })).rejects.toThrow(`Reserved plugin manifest id: ${id}`);
    expect(moduleLoader).not.toHaveBeenCalled();
  });

  it("preserves structured gateway lifecycle errors", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(JSON.stringify({
      error: "Remote machine plugin lifecycle is incompatible",
      detail: "Update and restart PI WEB on the remote machine.",
    }), { status: 409, statusText: "Conflict" }))));

    await expect(loadExternalPlugins("api/machines/remote-1/pi-web-plugins/manifest.json")).rejects.toThrow(
      "Failed to load plugin manifest (409 Conflict): Remote machine plugin lifecycle is incompatible: Update and restart PI WEB on the remote machine.",
    );
  });

  it("treats root-style modules from existing manifests as application-root paths", () => {
    const rootManifestUrl = "https://pi.example.test/pi-web-plugins/manifest.json";
    const nestedManifestUrl = "https://pi.example.test/test/ai/pi-web-plugins/manifest.json";

    expect(resolvePluginModuleUrl("/pi-web-plugins/info/pi-web-plugin.js?v=1", rootManifestUrl, {
      viteBaseUrl: "/",
      documentBaseUrl: "https://pi.example.test/",
    })).toBe("https://pi.example.test/pi-web-plugins/info/pi-web-plugin.js?v=1");
    expect(resolvePluginModuleUrl("/pi-web-plugins/info/pi-web-plugin.js?v=1", nestedManifestUrl, {
      viteBaseUrl: "./",
      documentBaseUrl: "https://pi.example.test/test/ai/",
    })).toBe("https://pi.example.test/test/ai/pi-web-plugins/info/pi-web-plugin.js?v=1");
  });
});
