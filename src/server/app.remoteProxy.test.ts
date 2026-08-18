import { Readable } from "node:stream";
import { describe, expect, it, vi, type MockedFunction } from "vitest";
import { RemoteMachineRequestError, type MachineClient } from "./machines/machineClient.js";
import { PI_PACKAGE_MUTATION_PROXY_TIMEOUT_MS, PLUGIN_BACKEND_FEDERATION_TIMEOUT_MS, SESSION_TREE_FORK_PROXY_TIMEOUT_MS, SESSION_TREE_NAVIGATION_PROXY_TIMEOUT_MS, WORKSPACE_REMOVAL_FEDERATION_TIMEOUT_MS } from "../shared/federatedRoutes.js";
import { PLUGIN_BACKEND_RESPONSE_BODY_MAX_BYTES } from "../shared/pluginBackendProtocol.js";
import { MAX_INLINE_PREVIEW_BYTES } from "../shared/workspaceFiles.js";
import { appTestContext, fakeRemoteClient, registerAppTestHooks } from "./app.testSupport.js";
import { workspaceFilePreviewErrorResponsePolicy, workspaceFilePreviewResponsePolicy } from "./workspaces/filePreviewResponsePolicy.js";

registerAppTestHooks();

/**
 * Preview proxy calls carry a cancellation signal, so the remaining arguments
 * are asserted positionally against the recorded call.
 */
function proxiedCall(request: MockedFunction<MachineClient["request"]>, index: number): { arguments: unknown[]; signal: unknown } {
  const call = request.mock.calls[index];
  if (call === undefined) throw new Error(`Expected a proxied request at index ${String(index)}`);
  const [method, path, body, options] = call;
  return { arguments: [method, path, body], signal: options?.signal };
}

describe("buildApp remote machine proxy routes", () => {
  it("proxies allowlisted remote HTTP routes through the selected machine", async () => {
    const addResponse = await appTestContext.app.inject({ method: "POST", url: "/api/machines", payload: { name: "Remote", baseUrl: "https://remote.example.test/" } });
    const remote = addResponse.json<{ id: string }>();
    const request = vi.fn(() => Promise.resolve({
      statusCode: 200,
      headers: { "content-type": "application/json", connection: "close" },
      body: Readable.from([JSON.stringify([{ id: "p1", name: "Remote Project", path: "/repo", createdAt: "now" }])]),
    }));
    appTestContext.remoteClient = fakeRemoteClient({ request });

    const response = await appTestContext.app.inject({ method: "GET", url: `/api/machines/${remote.id}/projects?active=true` });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/json");
    expect(response.json()).toEqual([{ id: "p1", name: "Remote Project", path: "/repo", createdAt: "now" }]);
    expect(request).toHaveBeenCalledWith("GET", "/api/projects?active=true", undefined);
  });

  it("preserves the force-refresh query when proxying update checks", async () => {
    const addResponse = await appTestContext.app.inject({ method: "POST", url: "/api/machines", payload: { name: "Remote", baseUrl: "https://remote.example.test/" } });
    const remote = addResponse.json<{ id: string }>();
    const request = vi.fn<MachineClient["request"]>(() => Promise.resolve({
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: Readable.from([JSON.stringify({ ok: true })]),
    }));
    appTestContext.remoteClient = fakeRemoteClient({ request });

    const response = await appTestContext.app.inject({ method: "GET", url: `/api/machines/${remote.id}/pi-web/status?refresh=1` });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    expect(request).toHaveBeenCalledWith("GET", "/api/pi-web/status?refresh=1", undefined);
  });

  it("proxies remote Pi package routes and gives package mutations a longer timeout", async () => {
    const addResponse = await appTestContext.app.inject({ method: "POST", url: "/api/machines", payload: { name: "Remote", baseUrl: "https://remote.example.test/" } });
    const remote = addResponse.json<{ id: string }>();
    const request = vi.fn<MachineClient["request"]>((method, path, body) => Promise.resolve({
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: Readable.from([JSON.stringify({ method, path, body })]),
    }));
    appTestContext.remoteClient = fakeRemoteClient({ request });

    const listResponse = await appTestContext.app.inject({ method: "GET", url: `/api/machines/${remote.id}/pi-packages` });
    const installBody = { source: "npm:@acme/new-tools" };
    const installResponse = await appTestContext.app.inject({ method: "POST", url: `/api/machines/${remote.id}/pi-packages/install`, payload: installBody });

    expect(listResponse.statusCode).toBe(200);
    expect(listResponse.json()).toEqual({ method: "GET", path: "/api/pi-packages" });
    expect(installResponse.statusCode).toBe(200);
    expect(installResponse.json()).toEqual({ method: "POST", path: "/api/pi-packages/install", body: installBody });
    expect(request).toHaveBeenNthCalledWith(1, "GET", "/api/pi-packages", undefined);
    expect(request).toHaveBeenNthCalledWith(2, "POST", "/api/pi-packages/install", installBody, { timeoutMs: PI_PACKAGE_MUTATION_PROXY_TIMEOUT_MS });
  });

  it("forwards remote session tree navigation with the model-operation timeout", async () => {
    const addResponse = await appTestContext.app.inject({ method: "POST", url: "/api/machines", payload: { name: "Remote", baseUrl: "https://remote.example.test/" } });
    const remote = addResponse.json<{ id: string }>();
    const request = vi.fn<MachineClient["request"]>((method, path, body) => Promise.resolve({
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: Readable.from([JSON.stringify({ method, path, body })]),
    }));
    appTestContext.remoteClient = fakeRemoteClient({ request });
    const navigationBody = { cwd: "/repo", targetId: "entry-1", expectedLeafId: "leaf-1", summary: { mode: "default" } };

    const response = await appTestContext.app.inject({
      method: "POST",
      url: `/api/machines/${remote.id}/sessions/s1/tree/navigate`,
      payload: navigationBody,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ method: "POST", path: "/api/sessions/s1/tree/navigate", body: navigationBody });
    expect(request).toHaveBeenCalledWith("POST", "/api/sessions/s1/tree/navigate", navigationBody, { timeoutMs: SESSION_TREE_NAVIGATION_PROXY_TIMEOUT_MS });
  });

  it("forwards remote session tree forks with the model-operation timeout", async () => {
    const addResponse = await appTestContext.app.inject({ method: "POST", url: "/api/machines", payload: { name: "Remote", baseUrl: "https://remote.example.test/" } });
    const remote = addResponse.json<{ id: string }>();
    const request = vi.fn<MachineClient["request"]>((method, path, body) => Promise.resolve({
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: Readable.from([JSON.stringify({ method, path, body })]),
    }));
    appTestContext.remoteClient = fakeRemoteClient({ request });
    const forkBody = { cwd: "/repo", entryId: "entry-1", expectedLeafId: "leaf-1" };

    const response = await appTestContext.app.inject({
      method: "POST",
      url: `/api/machines/${remote.id}/sessions/s1/tree/fork`,
      payload: forkBody,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ method: "POST", path: "/api/sessions/s1/tree/fork", body: forkBody });
    expect(request).toHaveBeenCalledWith("POST", "/api/sessions/s1/tree/fork", forkBody, { timeoutMs: SESSION_TREE_FORK_PROXY_TIMEOUT_MS });
  });

  it("proxies only the allowlisted workspace provider backend shape with its bounded deadline", async () => {
    const addResponse = await appTestContext.app.inject({ method: "POST", url: "/api/machines", payload: { name: "Remote", baseUrl: "https://remote.example.test/" } });
    const remote = addResponse.json<{ id: string }>();
    const request = vi.fn<MachineClient["request"]>((method, path, body) => Promise.resolve({
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: Readable.from([JSON.stringify({ method, path, body })]),
    }));
    appTestContext.remoteClient = fakeRemoteClient({ request });
    const payload = { revision: "server-r1", input: { cards: ["alpha"], includeClosed: false } };

    const response = await appTestContext.app.inject({
      method: "POST",
      url: `/api/machines/${remote.id}/plugin-backends/board-tools/projects/${encodeURIComponent("p 1")}/workspaces/${encodeURIComponent("w 1")}/cards.summary`,
      payload,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      method: "POST",
      path: "/api/plugin-backends/board-tools/projects/p%201/workspaces/w%201/cards.summary",
      body: payload,
    });
    expect(request).toHaveBeenCalledWith(
      "POST",
      "/api/plugin-backends/board-tools/projects/p%201/workspaces/w%201/cards.summary",
      payload,
      { timeoutMs: PLUGIN_BACKEND_FEDERATION_TIMEOUT_MS },
    );
  });

  it("maps an old remote provider-backend route to an explicit lifecycle compatibility error", async () => {
    const addResponse = await appTestContext.app.inject({ method: "POST", url: "/api/machines", payload: { name: "Remote", baseUrl: "https://remote.example.test/" } });
    const remote = addResponse.json<{ id: string }>();
    appTestContext.remoteClient = fakeRemoteClient({
      request: vi.fn<MachineClient["request"]>(() => Promise.resolve({
        statusCode: 404,
        headers: { "content-type": "application/json" },
        body: Readable.from([JSON.stringify({ statusCode: 404, error: "Not Found", message: "Route POST:/api/plugin-backends/tools/projects/p1/workspaces/w1/status not found" })]),
      })),
    });

    const response = await appTestContext.app.inject({
      method: "POST",
      url: `/api/machines/${remote.id}/plugin-backends/tools/projects/p1/workspaces/w1/status`,
      payload: { revision: "server-r1", input: null },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: "Remote machine plugin lifecycle is incompatible",
      code: "plugin-lifecycle-incompatible",
      machineId: remote.id,
    });
  });

  it("preserves a provider backend's legitimate resource 404", async () => {
    const addResponse = await appTestContext.app.inject({ method: "POST", url: "/api/machines", payload: { name: "Remote", baseUrl: "https://remote.example.test/" } });
    const remote = addResponse.json<{ id: string }>();
    appTestContext.remoteClient = fakeRemoteClient({
      request: vi.fn<MachineClient["request"]>(() => Promise.resolve({
        statusCode: 404,
        headers: { "content-type": "application/json" },
        body: Readable.from([JSON.stringify({ error: "Not Found", code: "workspace-resource-not-found", detail: "Card was removed" })]),
      })),
    });

    const response = await appTestContext.app.inject({
      method: "POST",
      url: `/api/machines/${remote.id}/plugin-backends/tools/projects/p1/workspaces/w1/card.get`,
      payload: { revision: "server-r1", input: { cardId: "gone" } },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "Not Found", code: "workspace-resource-not-found", detail: "Card was removed" });
  });

  it("stops oversized federated plugin backend responses at the gateway", async () => {
    const addResponse = await appTestContext.app.inject({ method: "POST", url: "/api/machines", payload: { name: "Remote", baseUrl: "https://remote.example.test/" } });
    const remote = addResponse.json<{ id: string }>();
    const request = vi.fn<MachineClient["request"]>(() => Promise.resolve({
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: Readable.from([Buffer.alloc(PLUGIN_BACKEND_RESPONSE_BODY_MAX_BYTES + 1, "x")]),
    }));
    appTestContext.remoteClient = fakeRemoteClient({ request });

    const response = await appTestContext.app.inject({
      method: "POST",
      url: `/api/machines/${remote.id}/plugin-backends/board-tools/projects/p1/workspaces/w1/cards.summary`,
      payload: { revision: "server-r1", input: null },
    });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({
      error: "Remote machine unavailable",
      machineId: remote.id,
      statusCode: 502,
      detail: `Remote machine response exceeded the ${String(PLUGIN_BACKEND_RESPONSE_BODY_MAX_BYTES)} byte limit`,
    });
  });

  it("proxies remote workspace effective upload config through the existing federated workspace route", async () => {
    const addResponse = await appTestContext.app.inject({ method: "POST", url: "/api/machines", payload: { name: "Remote", baseUrl: "https://remote.example.test/" } });
    const remote = addResponse.json<{ id: string }>();
    const remoteWorkspaces = [{
      id: "w1",
      projectId: "p1",
      path: "/repo",
      label: "main",
      isMain: true,
      effectiveConfig: { uploads: { defaultFolder: "remote-project-uploads" } },
    }];
    const remoteResolution = {
      status: "folder",
      projectId: "p1",
      workspaces: remoteWorkspaces,
      diagnostics: [{ code: "probe-failed", message: "Optional provider unavailable", tier: "primary", pluginId: "optional" }],
    };
    const request = vi.fn(() => Promise.resolve({
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: Readable.from([JSON.stringify(remoteResolution)]),
    }));
    appTestContext.remoteClient = fakeRemoteClient({ request });

    const response = await appTestContext.app.inject({ method: "GET", url: `/api/machines/${remote.id}/projects/p1/workspaces` });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(remoteResolution);
    expect(request).toHaveBeenCalledWith("GET", "/api/projects/p1/workspaces", undefined);
  });

  it("overrides missing or weaker remote HTML preview security headers while preserving safe metadata", async () => {
    const addResponse = await appTestContext.app.inject({ method: "POST", url: "/api/machines", payload: { name: "Remote", baseUrl: "https://remote.example.test/" } });
    const remote = addResponse.json<{ id: string }>();
    const body = "<script>window.opener.location = '/stolen'</script>";
    const request = vi.fn<MachineClient["request"]>(() => Promise.resolve({
      statusCode: 200,
      headers: {
        "content-type": "application/octet-stream",
        "content-length": String(Buffer.byteLength(body)),
        "content-disposition": "inline; filename=\"attacker.html\"",
        "content-security-policy": "default-src * 'unsafe-inline' 'unsafe-eval'",
        "cache-control": "private, max-age=42",
        "last-modified": "Wed, 05 Aug 2026 10:00:00 GMT",
        etag: "\"remote-etag\"",
        "set-cookie": "session=secret",
      },
      body: Readable.from([body]),
    }));
    appTestContext.remoteClient = fakeRemoteClient({ request });

    const response = await appTestContext.app.inject({ method: "GET", url: `/api/machines/${remote.id}/projects/p1/workspaces/w1/file/preview?path=${encodeURIComponent("report.html")}` });
    const policy = workspaceFilePreviewResponsePolicy("report.html");

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe(policy.contentType);
    expect(response.headers["content-disposition"]).toBe(policy.contentDisposition);
    expect(response.headers["content-security-policy"]).toBe(policy.contentSecurityPolicy);
    expect(response.headers["x-content-type-options"]).toBe(policy.contentTypeOptions);
    expect(response.headers["cache-control"]).toBe("private, max-age=42");
    expect(response.headers["last-modified"]).toBe("Wed, 05 Aug 2026 10:00:00 GMT");
    expect(response.headers.etag).toBe("\"remote-etag\"");
    expect(response.headers["content-length"]).toBe(String(Buffer.byteLength(body)));
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(response.body).toBe(body);
    expect(proxiedCall(request, 0).arguments).toEqual(["GET", "/api/projects/p1/workspaces/w1/file/preview?path=report.html", undefined]);
    expect(proxiedCall(request, 0).signal).toBeInstanceOf(AbortSignal);
  });

  it("enforces exact remote SVG and PDF policies instead of upstream active-content headers", async () => {
    const addResponse = await appTestContext.app.inject({ method: "POST", url: "/api/machines", payload: { name: "Remote", baseUrl: "https://remote.example.test/" } });
    const remote = addResponse.json<{ id: string }>();
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(2)</script><image href="https://attacker.test/pixel.png" /></svg>`;
    const pdf = "%PDF-1.4\n%mock\n";
    const request = vi.fn<MachineClient["request"]>((_method, path) => Promise.resolve({
      statusCode: 200,
      headers: {
        "content-type": "text/html",
        "content-disposition": "inline; filename=\"attacker.html\"",
        "content-security-policy": "default-src * 'unsafe-inline' 'unsafe-eval'",
      },
      body: Readable.from([path.includes("spec.pdf") ? pdf : svg]),
    }));
    appTestContext.remoteClient = fakeRemoteClient({ request });

    for (const fixture of [{ path: "diagram.svg", body: svg }, { path: "spec.pdf", body: pdf }]) {
      const response = await appTestContext.app.inject({ method: "GET", url: `/api/machines/${remote.id}/projects/p1/workspaces/w1/file/preview?path=${encodeURIComponent(fixture.path)}` });
      const policy = workspaceFilePreviewResponsePolicy(fixture.path);
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toBe(policy.contentType);
      expect(response.headers["content-disposition"]).toBe(policy.contentDisposition);
      expect(response.headers["content-security-policy"]).toBe(policy.contentSecurityPolicy);
      expect(response.headers["x-content-type-options"]).toBe(policy.contentTypeOptions);
      expect(response.body).toBe(fixture.body);
    }

    expect(proxiedCall(request, 0).arguments).toEqual(["GET", "/api/projects/p1/workspaces/w1/file/preview?path=diagram.svg", undefined]);
    expect(proxiedCall(request, 1).arguments).toEqual(["GET", "/api/projects/p1/workspaces/w1/file/preview?path=spec.pdf", undefined]);
    expect(proxiedCall(request, 1).signal).toBeInstanceOf(AbortSignal);
  });

  it("keeps remote preview errors readable while neutralizing hostile response headers", async () => {
    const addResponse = await appTestContext.app.inject({ method: "POST", url: "/api/machines", payload: { name: "Remote", baseUrl: "https://remote.example.test/" } });
    const remote = addResponse.json<{ id: string }>();
    const body = JSON.stringify({ error: "Missing file <script>alert(1)</script>" });
    const request = vi.fn<MachineClient["request"]>(() => Promise.resolve({
      statusCode: 404,
      headers: {
        "content-type": "text/html",
        "content-disposition": "attachment; filename=\"active.html\"",
        "content-security-policy": "default-src * 'unsafe-inline'",
        "x-content-type-options": "sniff",
      },
      body: Readable.from([body]),
    }));
    appTestContext.remoteClient = fakeRemoteClient({ request });

    const response = await appTestContext.app.inject({ method: "GET", url: `/api/machines/${remote.id}/projects/p1/workspaces/w1/file/preview?path=report.html` });
    const policy = workspaceFilePreviewErrorResponsePolicy();

    expect(response.statusCode).toBe(404);
    expect(response.headers["content-type"]).toBe(policy.contentType);
    expect(response.headers["content-disposition"]).toBe(policy.contentDisposition);
    expect(response.headers["content-security-policy"]).toBe(policy.contentSecurityPolicy);
    expect(response.headers["x-content-type-options"]).toBe(policy.contentTypeOptions);
    expect(response.json()).toEqual({ error: "Missing file <script>alert(1)</script>" });
    expect(proxiedCall(request, 0).arguments).toEqual(["GET", "/api/projects/p1/workspaces/w1/file/preview?path=report.html", undefined]);
  });

  it("hardens preview requests the gateway rejects before contacting the remote", async () => {
    const addResponse = await appTestContext.app.inject({ method: "POST", url: "/api/machines", payload: { name: "Remote", baseUrl: "https://remote.example.test/" } });
    const remote = addResponse.json<{ id: string }>();
    const request = vi.fn<MachineClient["request"]>(() => Promise.reject(new Error("remote must not be contacted")));
    appTestContext.remoteClient = fakeRemoteClient({ request });

    const response = await appTestContext.app.inject({ method: "GET", url: `/api/machines/${remote.id}/projects/p1/workspaces/w1/file/preview` });
    const policy = workspaceFilePreviewErrorResponsePolicy();

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "path query parameter is required" });
    expect(response.headers["content-type"]).toBe(policy.contentType);
    expect(response.headers["content-disposition"]).toBe(policy.contentDisposition);
    expect(response.headers["content-security-policy"]).toBe(policy.contentSecurityPolicy);
    expect(response.headers["x-content-type-options"]).toBe(policy.contentTypeOptions);
    expect(request).not.toHaveBeenCalled();
  });

  it("forces remote downloads to safe attachments with the requested filename", async () => {
    const addResponse = await appTestContext.app.inject({ method: "POST", url: "/api/machines", payload: { name: "Remote", baseUrl: "https://remote.example.test/" } });
    const remote = addResponse.json<{ id: string }>();
    const path = String.raw`C:\reports\résumé's.pdf`;
    const query = new URLSearchParams({ path, download: "1" }).toString();
    const body = "%PDF-1.4\n%mock\n";
    const request = vi.fn<MachineClient["request"]>(() => Promise.resolve({
      statusCode: 200,
      headers: {
        "content-type": "application/pdf",
        "content-disposition": "inline; filename=\"wrong.pdf\"",
        "content-security-policy": "default-src *",
      },
      body: Readable.from([body]),
    }));
    appTestContext.remoteClient = fakeRemoteClient({ request });

    const response = await appTestContext.app.inject({ method: "GET", url: `/api/machines/${remote.id}/projects/p1/workspaces/w1/file/preview?${query}` });
    const policy = workspaceFilePreviewResponsePolicy(path, { download: true });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe(policy.contentType);
    expect(response.headers["content-disposition"]).toBe(policy.contentDisposition);
    expect(response.headers["content-security-policy"]).toBe(policy.contentSecurityPolicy);
    expect(response.headers["x-content-type-options"]).toBe(policy.contentTypeOptions);
    expect(response.body).toBe(body);
    expect(proxiedCall(request, 0).arguments).toEqual(["GET", `/api/projects/p1/workspaces/w1/file/preview?${query}`, undefined]);
    expect(proxiedCall(request, 0).signal).toBeInstanceOf(AbortSignal);
  });

  it("stops oversized remote inline previews at the gateway while leaving downloads uncapped", async () => {
    const addResponse = await appTestContext.app.inject({ method: "POST", url: "/api/machines", payload: { name: "Remote", baseUrl: "https://remote.example.test/" } });
    const remote = addResponse.json<{ id: string }>();
    const chunk = Buffer.alloc(1024 * 1024, 0x61);
    const oversizedChunks = Math.ceil(MAX_INLINE_PREVIEW_BYTES / chunk.byteLength) + 1;
    const request = vi.fn<MachineClient["request"]>(() => Promise.resolve({
      statusCode: 200,
      headers: { "content-type": "image/png", "content-length": "4" },
      body: Readable.from(Array.from({ length: oversizedChunks }, () => chunk)),
    }));
    appTestContext.remoteClient = fakeRemoteClient({ request });

    const inlineResponse = await appTestContext.app.inject({ method: "GET", url: `/api/machines/${remote.id}/projects/p1/workspaces/w1/file/preview?path=huge.png` });
    const downloadResponse = await appTestContext.app.inject({ method: "GET", url: `/api/machines/${remote.id}/projects/p1/workspaces/w1/file/preview?path=huge.png&download=1` });

    expect(inlineResponse.statusCode).toBe(502);
    expect(inlineResponse.headers["content-type"]).toContain("application/json");
    expect(inlineResponse.json<{ detail: string }>().detail).toBe(`Remote machine response exceeded the ${String(MAX_INLINE_PREVIEW_BYTES)} byte limit`);
    // Attachment downloads keep the local no-size-cap contract.
    expect(downloadResponse.statusCode).toBe(200);
    expect(downloadResponse.rawPayload.byteLength).toBe(oversizedChunks * chunk.byteLength);
  });

  it("releases the remote preview connection when the client disconnects", async () => {
    const addResponse = await appTestContext.app.inject({ method: "POST", url: "/api/machines", payload: { name: "Remote", baseUrl: "https://remote.example.test/" } });
    const remote = addResponse.json<{ id: string }>();
    // A remote body that never ends: only inbound cancellation can release it.
    const upstream = new Readable({ read() { /* stays open until destroyed */ } });
    upstream.push(Buffer.alloc(8));
    const request = vi.fn<MachineClient["request"]>(() => Promise.resolve({ statusCode: 200, headers: { "content-type": "image/png" }, body: upstream }));
    appTestContext.remoteClient = fakeRemoteClient({ request });

    const address = await appTestContext.app.listen({ port: 0, host: "127.0.0.1" });
    const controller = new AbortController();
    const pending = fetch(`${address}/api/machines/${remote.id}/projects/p1/workspaces/w1/file/preview?path=diagram.svg`, { signal: controller.signal });
    await vi.waitFor(() => { expect(request).toHaveBeenCalled(); });
    controller.abort();

    await expect(pending).rejects.toThrow();
    await vi.waitFor(() => { expect(upstream.destroyed).toBe(true); });
  });

  it("advertises the bounded preview length instead of a remote content-length claim", async () => {
    const addResponse = await appTestContext.app.inject({ method: "POST", url: "/api/machines", payload: { name: "Remote", baseUrl: "https://remote.example.test/" } });
    const remote = addResponse.json<{ id: string }>();
    const body = "<h1>Report</h1>";
    const request = vi.fn<MachineClient["request"]>(() => Promise.resolve({
      statusCode: 200,
      headers: { "content-type": "text/html", "content-length": "99999" },
      body: Readable.from([body]),
    }));
    appTestContext.remoteClient = fakeRemoteClient({ request });

    const response = await appTestContext.app.inject({ method: "GET", url: `/api/machines/${remote.id}/projects/p1/workspaces/w1/file/preview?path=report.html` });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-length"]).toBe(String(Buffer.byteLength(body)));
    expect(response.rawPayload.byteLength).toBe(Buffer.byteLength(body));
  });

  it("proxies remote workspace file writes as raw request bodies", async () => {
    const addResponse = await appTestContext.app.inject({ method: "POST", url: "/api/machines", payload: { name: "Remote", baseUrl: "https://remote.example.test/" } });
    const remote = addResponse.json<{ id: string }>();
    const payload = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const request = vi.fn(() => Promise.resolve({
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: Readable.from([JSON.stringify({ path: "image.png", size: payload.length, modifiedAt: "now", created: true })]),
    }));
    appTestContext.remoteClient = fakeRemoteClient({ request });

    const response = await appTestContext.app.inject({
      method: "PUT",
      url: `/api/machines/${remote.id}/projects/p1/workspaces/w1/file?path=${encodeURIComponent("image.png")}`,
      payload,
      headers: { "content-type": "application/octet-stream" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ path: "image.png", size: payload.length, modifiedAt: "now", created: true });
    expect(request).toHaveBeenCalledWith("PUT", "/api/projects/p1/workspaces/w1/file?path=image.png", payload, { contentType: "application/octet-stream" });
  });

  it("proxies remote workspace trust reads and writes through the allowlisted route", async () => {
    const addResponse = await appTestContext.app.inject({ method: "POST", url: "/api/machines", payload: { name: "Remote", baseUrl: "https://remote.example.test/" } });
    const remote = addResponse.json<{ id: string }>();
    const request = vi.fn<MachineClient["request"]>((method, path, body) => Promise.resolve({
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: Readable.from([JSON.stringify({ method, path, body })]),
    }));
    appTestContext.remoteClient = fakeRemoteClient({ request });
    const trustBody = { trusted: false };

    const readResponse = await appTestContext.app.inject({ method: "GET", url: `/api/machines/${remote.id}/projects/p1/workspaces/w1/trust` });
    const writeResponse = await appTestContext.app.inject({ method: "PUT", url: `/api/machines/${remote.id}/projects/p1/workspaces/w1/trust`, payload: trustBody });

    expect(readResponse.statusCode).toBe(200);
    expect(readResponse.json()).toEqual({ method: "GET", path: "/api/projects/p1/workspaces/w1/trust" });
    expect(writeResponse.statusCode).toBe(200);
    expect(writeResponse.json()).toEqual({ method: "PUT", path: "/api/projects/p1/workspaces/w1/trust", body: trustBody });
    expect(request).toHaveBeenNthCalledWith(1, "GET", "/api/projects/p1/workspaces/w1/trust", undefined);
    expect(request).toHaveBeenNthCalledWith(2, "PUT", "/api/projects/p1/workspaces/w1/trust", trustBody);
  });

  it("proxies remote terminal command-run and continue routes", async () => {
    const addResponse = await appTestContext.app.inject({ method: "POST", url: "/api/machines", payload: { name: "Remote", baseUrl: "https://remote.example.test/" } });
    const remote = addResponse.json<{ id: string }>();
    const request = vi.fn<MachineClient["request"]>((method, path) => Promise.resolve({
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: Readable.from([JSON.stringify({ method, path })]),
    }));
    appTestContext.remoteClient = fakeRemoteClient({ request });

    const createBody = { origin: "core", title: "Build", command: "npm test", metadata: { "pi.operation": "test" } };
    const deleteBody = { precondition: "v1.confirmed" };
    const deleteWorkspaceResponse = await appTestContext.app.inject({
      method: "DELETE",
      url: `/api/machines/${remote.id}/projects/p1/workspaces/w1`,
      payload: deleteBody,
    });
    const createResponse = await appTestContext.app.inject({ method: "POST", url: `/api/machines/${remote.id}/projects/p1/workspaces/w1/terminal-command-runs`, payload: createBody });
    const listResponse = await appTestContext.app.inject({ method: "GET", url: `/api/machines/${remote.id}/terminal-command-runs?projectId=p1&statuses=running` });
    const getResponse = await appTestContext.app.inject({ method: "GET", url: `/api/machines/${remote.id}/terminal-command-runs/run1` });
    const cancelResponse = await appTestContext.app.inject({ method: "POST", url: `/api/machines/${remote.id}/terminal-command-runs/run1/cancel` });
    const closeWorkspaceTerminalsResponse = await appTestContext.app.inject({ method: "DELETE", url: `/api/machines/${remote.id}/projects/p1/workspaces/w1/terminals` });
    const continueResponse = await appTestContext.app.inject({ method: "POST", url: `/api/machines/${remote.id}/projects/p1/workspaces/w1/terminals/t1/continue` });

    expect(deleteWorkspaceResponse.json()).toEqual({ method: "DELETE", path: "/api/projects/p1/workspaces/w1" });
    expect(createResponse.json()).toEqual({ method: "POST", path: "/api/projects/p1/workspaces/w1/terminal-command-runs" });
    expect(listResponse.json()).toEqual({ method: "GET", path: "/api/terminal-command-runs?projectId=p1&statuses=running" });
    expect(getResponse.json()).toEqual({ method: "GET", path: "/api/terminal-command-runs/run1" });
    expect(cancelResponse.json()).toEqual({ method: "POST", path: "/api/terminal-command-runs/run1/cancel" });
    expect(closeWorkspaceTerminalsResponse.json()).toEqual({ method: "DELETE", path: "/api/projects/p1/workspaces/w1/terminals" });
    expect(continueResponse.json()).toEqual({ method: "POST", path: "/api/projects/p1/workspaces/w1/terminals/t1/continue" });
    const deletionRequest = request.mock.calls.find((call) => call[0] === "DELETE");
    expect(deletionRequest?.slice(0, 3)).toEqual([
      "DELETE",
      "/api/projects/p1/workspaces/w1",
      deleteBody,
    ]);
    expect(deletionRequest?.[3]?.timeoutMs).toBe(WORKSPACE_REMOVAL_FEDERATION_TIMEOUT_MS);
    expect(deletionRequest?.[3]?.signal).toBeInstanceOf(AbortSignal);
    expect(deletionRequest?.[3]?.signal?.aborted).toBe(false);
    expect(request).toHaveBeenCalledWith("POST", "/api/projects/p1/workspaces/w1/terminal-command-runs", createBody);
  });

  it("proxies remote session reloads through the selected machine", async () => {
    const addResponse = await appTestContext.app.inject({ method: "POST", url: "/api/machines", payload: { name: "Remote", baseUrl: "https://remote.example.test/" } });
    const remote = addResponse.json<{ id: string }>();
    const request = vi.fn(() => Promise.resolve({
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: Readable.from([JSON.stringify({ reloaded: true })]),
    }));
    appTestContext.remoteClient = fakeRemoteClient({ request });

    const response = await appTestContext.app.inject({ method: "POST", url: `/api/machines/${remote.id}/sessions/s1/reload`, payload: { cwd: "/repo" } });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ reloaded: true });
    expect(request).toHaveBeenCalledWith("POST", "/api/sessions/s1/reload", { cwd: "/repo" });
  });

  it("proxies only the four allowlisted remote notification HTTP routes", async () => {
    const addResponse = await appTestContext.app.inject({ method: "POST", url: "/api/machines", payload: { name: "Remote", baseUrl: "https://remote.example.test/" } });
    const remote = addResponse.json<{ id: string }>();
    const request = vi.fn<MachineClient["request"]>((method, path, body) => Promise.resolve({
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: Readable.from([JSON.stringify({ method, path, body })]),
    }));
    appTestContext.remoteClient = fakeRemoteClient({ request });

    const catalog = await appTestContext.app.inject({ method: "GET", url: `/api/machines/${remote.id}/sessions/notifications` });
    const inbox = await appTestContext.app.inject({ method: "GET", url: `/api/machines/${remote.id}/sessions/${encodeURIComponent("s 1")}/notifications?cwd=${encodeURIComponent("/repo one")}` });
    const dismissBody = { cwd: "/repo one", daemonInstanceId: "daemon-test", notificationId: "notice-1" };
    const dismiss = await appTestContext.app.inject({ method: "POST", url: `/api/machines/${remote.id}/sessions/${encodeURIComponent("s 1")}/notifications/dismiss`, payload: dismissBody });
    const dismissAllBody = { cwd: "/repo one", daemonInstanceId: "daemon-test", throughOrder: 7, throughOverflowWatermark: 2 };
    const dismissAll = await appTestContext.app.inject({ method: "POST", url: `/api/machines/${remote.id}/sessions/${encodeURIComponent("s 1")}/notifications/dismiss-all`, payload: dismissAllBody });
    const wrongMethod = await appTestContext.app.inject({ method: "DELETE", url: `/api/machines/${remote.id}/sessions/s1/notifications` });

    expect([catalog.statusCode, inbox.statusCode, dismiss.statusCode, dismissAll.statusCode]).toEqual([200, 200, 200, 200]);
    expect(wrongMethod.statusCode).toBe(404);
    expect(request).toHaveBeenNthCalledWith(1, "GET", "/api/sessions/notifications", undefined);
    expect(request).toHaveBeenNthCalledWith(2, "GET", "/api/sessions/s%201/notifications?cwd=%2Frepo%20one", undefined);
    expect(request).toHaveBeenNthCalledWith(3, "POST", "/api/sessions/s%201/notifications/dismiss", dismissBody);
    expect(request).toHaveBeenNthCalledWith(4, "POST", "/api/sessions/s%201/notifications/dismiss-all", dismissAllBody);
    expect(request).toHaveBeenCalledTimes(4);
  });

  it("proxies remote session queue clearing through the allowlisted route", async () => {
    const addResponse = await appTestContext.app.inject({ method: "POST", url: "/api/machines", payload: { name: "Remote", baseUrl: "https://remote.example.test/" } });
    const remote = addResponse.json<{ id: string }>();
    const status = { sessionId: "s1", pendingMessageCount: 0, queuedMessages: [] };
    const request = vi.fn(() => Promise.resolve({
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: Readable.from([JSON.stringify(status)]),
    }));
    appTestContext.remoteClient = fakeRemoteClient({ request });

    const response = await appTestContext.app.inject({ method: "POST", url: `/api/machines/${remote.id}/sessions/s1/queue/clear`, payload: { cwd: "/repo" } });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(status);
    expect(request).toHaveBeenCalledWith("POST", "/api/sessions/s1/queue/clear", { cwd: "/repo" });
  });

  it("forwards remote JSON request bodies and normalizes remote timeouts", async () => {
    const addResponse = await appTestContext.app.inject({ method: "POST", url: "/api/machines", payload: { name: "Remote", baseUrl: "https://remote.example.test/" } });
    const remote = addResponse.json<{ id: string }>();
    const request = vi.fn(() => Promise.reject(new RemoteMachineRequestError("timed out", 504)));
    appTestContext.remoteClient = fakeRemoteClient({ request });

    const response = await appTestContext.app.inject({ method: "POST", url: `/api/machines/${remote.id}/sessions/s1/prompt`, payload: { text: "hello" } });

    expect(response.statusCode).toBe(504);
    expect(response.json()).toMatchObject({ error: "Remote machine timeout", machineId: remote.id, statusCode: 504 });
    expect(request).toHaveBeenCalledWith("POST", "/api/sessions/s1/prompt", { text: "hello" });
  });
});
