import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { machineScopedPluginId } from "../shared/machinePluginIds.js";
import { buildApp } from "./app.js";
import { appTestContext, fakeRemoteClient, registerAppTestHooks } from "./app.testSupport.js";
import { PiWebPluginService } from "./piWebPluginService.js";

registerAppTestHooks();

describe("buildApp PI WEB plugin routes", () => {
  it("serves application-root plugin modules through the manifest and plugin-list APIs", async () => {
    const manifestResponse = await appTestContext.app.inject({ method: "GET", url: "/pi-web-plugins/manifest.json" });
    expect(manifestResponse.statusCode).toBe(200);
    expect(manifestResponse.json()).toEqual({ lifecycleVersion: 1, plugins: [{ id: "fake", module: "/pi-web-plugins/fake/plugin.js?v=1", source: "test", scope: "local", machineSpecific: false }] });

    const pluginsResponse = await appTestContext.app.inject({ method: "GET", url: "/api/plugins" });
    expect(pluginsResponse.statusCode).toBe(200);
    expect(pluginsResponse.json()).toMatchObject({
      lifecycleVersion: 1,
      plugins: [{ id: "fake", module: "/pi-web-plugins/fake/plugin.js?v=1", source: "test", scope: "local", machineSpecific: false, enabled: true, discovered: true, conflict: false }],
      diagnostics: [],
      serverRuntime: { status: "available", restartRequired: false },
    });

    const localMachinePluginsResponse = await appTestContext.app.inject({ method: "GET", url: "/api/machines/local/plugins" });
    expect(localMachinePluginsResponse.statusCode).toBe(200);
    expect(localMachinePluginsResponse.json()).toEqual(pluginsResponse.json());

    const assetResponse = await appTestContext.app.inject({ method: "GET", url: "/pi-web-plugins/fake/plugin.js?v=1" });
    expect(assetResponse.statusCode).toBe(200);
    expect(assetResponse.headers["content-type"]).toContain("application/javascript");
    expect(assetResponse.body).toBe("export default {};");

    const svgResponse = await appTestContext.app.inject({ method: "GET", url: "/pi-web-plugins/fake/assets/icon.svg" });
    expect(svgResponse.statusCode).toBe(200);
    expect(svgResponse.headers["content-type"]).toContain("image/svg+xml");
    expect(svgResponse.body).toContain("<svg");

    const missingResponse = await appTestContext.app.inject({ method: "GET", url: "/pi-web-plugins/fake/missing.js" });
    expect(missingResponse.statusCode).toBe(404);
  });

  it("does not serve newer entry bytes through stale noncanonical asset URLs", async () => {
    const pluginsRoot = join(appTestContext.tempDir, "route-plugins");
    const pluginRoot = join(pluginsRoot, "route-revision");
    const browserPath = join(pluginRoot, "public", "browser.js");
    await mkdir(join(pluginRoot, "public"), { recursive: true });
    await writeFile(join(pluginRoot, "package.json"), `${JSON.stringify({
      piWeb: { plugins: [{ id: "route-revision", browserRoot: "public", module: "public/browser.js" }] },
    }, null, 2)}\n`);
    await writeFile(browserPath, "export const version = 'old';\n");
    const service = new PiWebPluginService({
      roots: [{ path: pluginsRoot, source: "test", scope: "local" }],
      packageProvider: false,
    });
    const routeApp = await buildApp({ piWebPlugins: service, clientDist: false, logger: false });

    try {
      const firstManifest = await routeApp.inject({ method: "GET", url: "/pi-web-plugins/manifest.json" });
      const firstModule = firstManifest.json<{ plugins: { module: string }[] }>().plugins[0]?.module;
      if (firstModule === undefined) throw new Error("Expected initial plugin module URL");
      const firstUrl = new URL(firstModule, "http://pi-web.test");
      const dottedOldUrl = `${firstUrl.pathname.replace("/public/browser.js", "/public/./browser.js")}${firstUrl.search}`;

      const initialAsset = await routeApp.inject({ method: "GET", url: dottedOldUrl });
      expect(initialAsset.statusCode).toBe(200);
      expect(initialAsset.body).toContain("'old'");

      await writeFile(browserPath, "export const version = 'new';\n");
      const secondManifest = await routeApp.inject({ method: "GET", url: "/pi-web-plugins/manifest.json" });
      const secondModule = secondManifest.json<{ plugins: { module: string }[] }>().plugins[0]?.module;
      if (secondModule === undefined) throw new Error("Expected updated plugin module URL");
      expect(secondModule).not.toBe(firstModule);

      const freshAsset = await routeApp.inject({ method: "GET", url: secondModule });
      expect(freshAsset.statusCode).toBe(200);
      expect(freshAsset.body).toContain("'new'");

      const staleDottedAsset = await routeApp.inject({ method: "GET", url: dottedOldUrl });
      expect(staleDottedAsset.statusCode).toBe(404);
      const repeatedSeparatorOldUrl = `${firstUrl.pathname.replace("/public/browser.js", "/public//browser.js")}${firstUrl.search}`;
      const staleRepeatedSeparatorAsset = await routeApp.inject({ method: "GET", url: repeatedSeparatorOldUrl });
      expect(staleRepeatedSeparatorAsset.statusCode).toBe(404);
    } finally {
      await routeApp.close();
    }
  });

  it("proxies remote machine plugin lists for settings", async () => {
    const addResponse = await appTestContext.app.inject({ method: "POST", url: "/api/machines", payload: { name: "Remote", baseUrl: "https://remote.example.test/" } });
    const remote = addResponse.json<{ id: string }>();
    const request = vi.fn(() => Promise.resolve({
      statusCode: 200,
      headers: { "content-type": "application/json", "set-cookie": "secret=1" },
      body: Readable.from([JSON.stringify({ plugins: [{ id: "remote-tools", module: "/pi-web-plugins/remote-tools/plugin.js", source: "local", scope: "local", machineSpecific: false, enabled: false }] })]),
    }));
    appTestContext.remoteClient = fakeRemoteClient({ request });

    const response = await appTestContext.app.inject({ method: "GET", url: `/api/machines/${remote.id}/plugins` });

    expect(response.statusCode).toBe(200);
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(response.json()).toEqual({ plugins: [{ id: "remote-tools", module: "/pi-web-plugins/remote-tools/plugin.js", source: "local", scope: "local", machineSpecific: false, enabled: false }] });
    expect(request).toHaveBeenCalledWith("GET", "/api/plugins", undefined);
  });

  it("rewrites existing root-style remote plugin manifests and proxies their assets", async () => {
    const addResponse = await appTestContext.app.inject({ method: "POST", url: "/api/machines", payload: { name: "Remote", baseUrl: "https://remote.example.test/" } });
    const remote = addResponse.json<{ id: string }>();
    const requestJson = vi.fn(() => Promise.resolve({
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: { lifecycleVersion: 1, plugins: [{ id: "remote-tools", module: "/pi-web-plugins/remote-tools/pi-web-plugin.js?v=123", backendRevision: "server-r7", source: "local", scope: "local", machineSpecific: true }] },
    }));
    const request = vi.fn(() => Promise.resolve({
      statusCode: 200,
      headers: { "content-type": "application/javascript", "set-cookie": "secret=1" },
      body: Readable.from(["export default {};"]),
    }));
    appTestContext.remoteClient = fakeRemoteClient({ requestJson, request });

    const manifestResponse = await appTestContext.app.inject({ method: "GET", url: `/api/machines/${remote.id}/pi-web-plugins/manifest.json` });
    const scopedPluginId = machineScopedPluginId(remote.id, "remote-tools");
    const rewrittenModule = `../../../../pi-web-plugins/${scopedPluginId}/pi-web-plugin.js?v=123`;
    expect(manifestResponse.statusCode).toBe(200);
    expect(manifestResponse.json()).toEqual({
      lifecycleVersion: 1,
      plugins: [{ id: "remote-tools", module: rewrittenModule, backendRevision: "server-r7", source: "local", scope: "local", machineSpecific: true }],
    });
    expect(new URL(rewrittenModule, `https://gateway.example.test/api/machines/${remote.id}/pi-web-plugins/manifest.json`).toString())
      .toBe(`https://gateway.example.test/pi-web-plugins/${scopedPluginId}/pi-web-plugin.js?v=123`);
    expect(new URL(rewrittenModule, `https://gateway.example.test/test/ai/api/machines/${remote.id}/pi-web-plugins/manifest.json`).toString())
      .toBe(`https://gateway.example.test/test/ai/pi-web-plugins/${scopedPluginId}/pi-web-plugin.js?v=123`);
    expect(requestJson).toHaveBeenCalledWith("GET", "/pi-web-plugins/manifest.json", undefined, { timeoutMs: 10000 });

    const assetResponse = await appTestContext.app.inject({ method: "GET", url: `/pi-web-plugins/${scopedPluginId}/pi-web-plugin.js?v=123` });
    expect(assetResponse.statusCode).toBe(200);
    expect(assetResponse.headers["content-type"]).toContain("application/javascript");
    expect(assetResponse.headers["set-cookie"]).toBeUndefined();
    expect(assetResponse.body).toBe("export default {};");
    expect(request).toHaveBeenCalledWith("GET", "/pi-web-plugins/remote-tools/pi-web-plugin.js?v=123");
  });

  it("returns an explicit mixed-version error instead of pairing a remote browser module with an unverified backend", async () => {
    const addResponse = await appTestContext.app.inject({ method: "POST", url: "/api/machines", payload: { name: "Remote", baseUrl: "https://remote.example.test/" } });
    const remote = addResponse.json<{ id: string }>();
    appTestContext.remoteClient = fakeRemoteClient({
      requestJson: vi.fn(() => Promise.resolve({
        statusCode: 200,
        headers: { "content-type": "application/json" },
        body: { plugins: [{ id: "old-provider", module: "/pi-web-plugins/old-provider/plugin.js?v=1", backendRevision: "server-r1", machineSpecific: true }] },
      })),
    });

    const response = await appTestContext.app.inject({ method: "GET", url: `/api/machines/${remote.id}/pi-web-plugins/manifest.json` });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: "Remote machine plugin lifecycle is incompatible",
      code: "plugin-lifecycle-incompatible",
      machineId: remote.id,
    });
    expect(response.json<{ detail: string }>().detail).toContain("Update and restart PI WEB on the remote machine");
  });

  it.each([
    { label: "missing", body: { plugins: [{ id: "browser-only", module: "/pi-web-plugins/browser-only/plugin.js" }] } },
    { label: "future", body: { lifecycleVersion: 2, plugins: [] } },
  ])("returns an explicit compatibility error for a $label remote lifecycle version", async ({ body }) => {
    const addResponse = await appTestContext.app.inject({ method: "POST", url: "/api/machines", payload: { name: "Remote", baseUrl: "https://remote.example.test/" } });
    const remote = addResponse.json<{ id: string }>();
    appTestContext.remoteClient = fakeRemoteClient({
      requestJson: vi.fn(() => Promise.resolve({ statusCode: 200, headers: {}, body })),
    });

    const response = await appTestContext.app.inject({ method: "GET", url: `/api/machines/${remote.id}/pi-web-plugins/manifest.json` });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: "plugin-lifecycle-incompatible", machineId: remote.id });
  });

  it("reports a missing remote manifest as a lifecycle compatibility error", async () => {
    const addResponse = await appTestContext.app.inject({ method: "POST", url: "/api/machines", payload: { name: "Remote", baseUrl: "https://remote.example.test/" } });
    const remote = addResponse.json<{ id: string }>();
    appTestContext.remoteClient = fakeRemoteClient({
      requestJson: vi.fn(() => Promise.resolve({ statusCode: 404, headers: {}, body: { error: "Not Found" } })),
    });

    const response = await appTestContext.app.inject({ method: "GET", url: `/api/machines/${remote.id}/pi-web-plugins/manifest.json` });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: "plugin-lifecycle-incompatible", machineId: remote.id });
  });

  it("rejects duplicate remote manifest ids before exposing either module", async () => {
    const addResponse = await appTestContext.app.inject({ method: "POST", url: "/api/machines", payload: { name: "Remote", baseUrl: "https://remote.example.test/" } });
    const remote = addResponse.json<{ id: string }>();
    appTestContext.remoteClient = fakeRemoteClient({
      requestJson: vi.fn(() => Promise.resolve({
        statusCode: 200,
        headers: {},
        body: {
          lifecycleVersion: 1,
          plugins: [
            { id: "duplicate", module: "/pi-web-plugins/duplicate/one.js" },
            { id: "duplicate", module: "/pi-web-plugins/duplicate/two.js" },
          ],
        },
      })),
    });

    const response = await appTestContext.app.inject({ method: "GET", url: `/api/machines/${remote.id}/pi-web-plugins/manifest.json` });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({ machineId: remote.id, detail: "Duplicate remote PI WEB plugin id: duplicate" });
  });

  it("accepts manifest-relative and legacy plugin-root-relative modules while dropping unsafe remote modules", async () => {
    const addResponse = await appTestContext.app.inject({ method: "POST", url: "/api/machines", payload: { name: "Remote", baseUrl: "https://remote.example.test/" } });
    const remote = addResponse.json<{ id: string }>();
    appTestContext.remoteClient = fakeRemoteClient({
      requestJson: vi.fn(() => Promise.resolve({
        statusCode: 200,
        headers: { "content-type": "application/json" },
        body: {
          lifecycleVersion: 1,
          plugins: [
            { id: "safe-tools", module: "./safe-tools/nested/pi-web-plugin.js?v=1", source: "local", scope: "local" },
            { id: "legacy-tools", module: "nested/pi-web-plugin.js?v=2", source: "local", scope: "local" },
            { id: "traversal-tools", module: "./traversal-tools/..%2F..%2Fapi%2Fconfig", source: "local", scope: "local" },
            { id: "wrong-root", module: "/pi-web-plugins/other/pi-web-plugin.js", source: "local", scope: "local" },
            { id: "cross-origin", module: "https://plugins.example.test/pi-web-plugin.js", source: "local", scope: "local" },
            { id: "malformed", module: "nested/%E0%A4%A.js", source: "local", scope: "local" },
          ],
        },
      })),
    });

    const manifestResponse = await appTestContext.app.inject({ method: "GET", url: `/api/machines/${remote.id}/pi-web-plugins/manifest.json` });

    expect(manifestResponse.statusCode).toBe(200);
    expect(manifestResponse.json()).toEqual({
      lifecycleVersion: 1,
      plugins: [
        { id: "safe-tools", module: `../../../../pi-web-plugins/${machineScopedPluginId(remote.id, "safe-tools")}/nested/pi-web-plugin.js?v=1`, source: "local", scope: "local" },
        { id: "legacy-tools", module: `../../../../pi-web-plugins/${machineScopedPluginId(remote.id, "legacy-tools")}/nested/pi-web-plugin.js?v=2`, source: "local", scope: "local" },
      ],
    });
  });

  it("rejects remote machine plugin asset traversal before proxying", async () => {
    const addResponse = await appTestContext.app.inject({ method: "POST", url: "/api/machines", payload: { name: "Remote", baseUrl: "https://remote.example.test/" } });
    const remote = addResponse.json<{ id: string }>();
    const request = vi.fn(() => Promise.resolve({ statusCode: 200, headers: {}, body: Readable.from([]) }));
    appTestContext.remoteClient = fakeRemoteClient({ request });
    const scopedPluginId = machineScopedPluginId(remote.id, "remote-tools");

    const response = await appTestContext.app.inject({ method: "GET", url: `/pi-web-plugins/${scopedPluginId}/..%2F..%2Fapi%2Fconfig` });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "Invalid remote PI WEB plugin asset path" });
    expect(request).not.toHaveBeenCalled();
  });
});
