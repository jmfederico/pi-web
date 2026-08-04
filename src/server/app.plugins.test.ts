import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { machineScopedPluginId } from "../shared/machinePluginIds.js";
import { appTestContext, fakeRemoteClient, registerAppTestHooks } from "./app.testSupport.js";

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
