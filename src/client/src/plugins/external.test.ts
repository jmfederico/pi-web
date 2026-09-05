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
  it("treats a missing default manifest as an explicit required-load failure", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response(null, { status: 404, statusText: "Not Found" })));
    vi.stubGlobal("fetch", fetchMock);

    await expect(loadExternalPlugins()).rejects.toThrow("Failed to load plugin manifest (404 Not Found)");

    expect(fetchMock).toHaveBeenCalledWith("https://pi.example.test/pi-web-plugins/manifest.json", { cache: "no-store" });
  });

  it("fails closed for network, parse, and required-entry manifest failures", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("manifest network unavailable"))));
    await expect(loadExternalPlugins()).rejects.toThrow("manifest network unavailable");

    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response("{not-json", {
      status: 200,
      headers: { "content-type": "application/json" },
    }))));
    await expect(loadExternalPlugins()).rejects.toThrow();

    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(JSON.stringify({
      lifecycleVersion: 2,
      terminalMode: "required",
      plugins: [{ id: "info", module: "./info/plugin.js", machineSpecific: false }],
    })))));
    await expect(loadExternalPlugins(undefined, { moduleLoader: vi.fn() }))
      .rejects.toThrow("Required Terminal plugin manifest entry is unavailable or out of order");
  });

  it("rejects a Terminal entry in a recovery-disabled manifest before module import", async () => {
    const moduleLoader = vi.fn();
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(JSON.stringify({
      lifecycleVersion: 2,
      terminalMode: "recovery-disabled",
      plugins: [{ id: "terminal", module: "./terminal/pi-web-plugin.js", machineSpecific: true }],
    })))));

    await expect(loadExternalPlugins(undefined, { moduleLoader }))
      .rejects.toThrow("Recovery-disabled plugin manifest must not publish Terminal");
    expect(moduleLoader).not.toHaveBeenCalled();
  });

  it("loads manifest-relative modules from a nested deployment", async () => {
    const manifestUrl = "https://pi.example.test/test/ai/pi-web-plugins/manifest.json";
    const fetchMock = vi.fn(() => Promise.resolve(new Response(JSON.stringify({
      lifecycleVersion: 2,
      terminalMode: "recovery-disabled",
      plugins: [{ id: "info", module: "./info/pi-web-plugin.js?v=1", backendRevision: "server-r1", backendCapabilityVersion: 1, channelVersion: 1, machineSpecific: false }],
    }))));
    const moduleLoader = vi.fn(() => Promise.resolve({
      default: { apiVersion: 2, name: "Info", activate: () => ({ contributions: {} }) },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await loadExternalPlugins(manifestUrl, { moduleLoader });

    expect(fetchMock).toHaveBeenCalledWith(manifestUrl, { cache: "no-store" });
    expect(moduleLoader).toHaveBeenCalledWith("https://pi.example.test/test/ai/pi-web-plugins/info/pi-web-plugin.js?v=1");
    expect(result.failures).toEqual([]);
    expect(result.registrations).toMatchObject([{ id: "info", backendRevision: "server-r1", backendCapabilityVersion: 1, channelVersion: 1, machineSpecific: false, plugin: { apiVersion: 2, name: "Info" } }]);
  });

  it.each([
    { backendCapabilityVersion: 2, backendRevision: "server-r1" },
    { backendCapabilityVersion: 1 },
    { channelVersion: 2, backendRevision: "server-r1" },
    { channelVersion: 1 },
    { channelVersion: 1, backendRevision: "server-r1" },
  ])("rejects invalid paired backend capability metadata before module import", async (backend) => {
    const moduleLoader = vi.fn(() => Promise.resolve({
      default: { apiVersion: 2, name: "Info", activate: () => ({ contributions: {} }) },
    }));
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(JSON.stringify({
      lifecycleVersion: 2,
      terminalMode: "recovery-disabled",
      plugins: [{ id: "info", module: "./info/plugin.js", ...backend }],
    })))));

    await expect(loadExternalPlugins(undefined, { moduleLoader })).rejects.toThrow("Invalid plugin manifest entry");
    expect(moduleLoader).not.toHaveBeenCalled();
  });

  it("loads required Terminal first and stops before ordinary modules when it fails", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(JSON.stringify({
      lifecycleVersion: 2,
      terminalMode: "required",
      plugins: [
        {
          id: "terminal",
          module: "./terminal/pi-web-plugin.js",
          backendRevision: "terminal-r1",
          backendCapabilityVersion: 1,
          channelVersion: 1,
          machineSpecific: true,
        },
        { id: "info", module: "./info/pi-web-plugin.js", machineSpecific: false },
      ],
    })))));
    const failure = new Error("Terminal module failed");
    const moduleLoader = vi.fn((moduleUrl: string) => moduleUrl.includes("/terminal/")
      ? Promise.reject(failure)
      : Promise.resolve({ default: { apiVersion: 2, name: "Info", activate: () => ({ contributions: {} }) } }));

    const result = await loadExternalPlugins(undefined, { moduleLoader });

    expect(result).toMatchObject({
      terminalMode: "required",
      registrations: [],
      failures: [{ entry: { id: "terminal" }, error: failure }],
    });
    expect(moduleLoader).toHaveBeenCalledOnce();
    expect(moduleLoader.mock.calls[0]?.[0]).toContain("/terminal/");
  });

  it("attributes unsupported browser API versions to the plugin module", async () => {
    const manifestUrl = "https://pi.example.test/pi-web-plugins/manifest.json";
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(JSON.stringify({
      lifecycleVersion: 2,
      terminalMode: "recovery-disabled",
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
      lifecycleVersion: 2,
      terminalMode: "recovery-disabled",
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
      lifecycleVersion: 2,
      terminalMode: "recovery-disabled",
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
      lifecycleVersion: 2,
      terminalMode: "recovery-disabled",
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
      lifecycleVersion: 2,
      terminalMode: "recovery-disabled",
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

  it("preserves Fastify messages for required Terminal recovery guidance", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(JSON.stringify({
      statusCode: 503,
      error: "Service Unavailable",
      message: "Required Terminal browser artifact is stale. Restart the web/API process.",
    }), { status: 503, statusText: "Service Unavailable" }))));

    await expect(loadExternalPlugins()).rejects.toThrow(
      "Failed to load plugin manifest (503 Service Unavailable): Required Terminal browser artifact is stale. Restart the web/API process.",
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
