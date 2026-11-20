import { PassThrough, Readable } from "node:stream";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionDaemonClient } from "../../sessiond/sessionDaemonClient.js";
import { createHttpServer } from "../httpServer.js";
import { RemoteMachineClient } from "../machines/machineClient.js";
import { registerMachineProxyRoutes } from "../machines/machineProxyRoutes.js";
import { registerPluginBackendResourceRoutes, type PluginBackendResourceDispatcher } from "../sessiond/pluginBackendResourceRoutes.js";
import { registerPluginBackendResourceProxyRoutes } from "./pluginBackendResourceProxyRoutes.js";

const apps: FastifyInstance[] = [];
afterEach(async () => {
  for (const app of apps.reverse()) { app.server.closeAllConnections(); await app.close(); }
  apps.length = 0;
});
function app(): FastifyInstance {
  const result = Fastify({ logger: false }); apps.push(result); return result;
}
const query = "?revision=r1&input=%7B%22id%22%3A1%7D";
const machinePath = "/paired-plugin-backends/viewer/resources/read";

async function chain(resource: PluginBackendResourceDispatcher["resource"]): Promise<string> {
  const daemon = app();
  registerPluginBackendResourceRoutes(daemon, {
    projects: { requireProject: () => Promise.reject(new Error("Project not found")) }, backends: { resource },
  });
  const daemonUrl = await daemon.listen({ port: 0, host: "127.0.0.1" });
  const publicEdge = app();
  registerPluginBackendResourceProxyRoutes(publicEdge, new SessionDaemonClient({ baseUrl: daemonUrl }));
  const edgeUrl = await publicEdge.listen({ port: 0, host: "127.0.0.1" });
  const federation = app();
  registerMachineProxyRoutes(federation, {
    remoteClient: () => Promise.resolve(new RemoteMachineClient({ baseUrl: edgeUrl })), invalidateReportedName: vi.fn(),
  });
  return federation.listen({ port: 0, host: "127.0.0.1" });
}

describe("plugin resource HTTP hops", () => {
  it("streams undecoded bytes and Range/206 metadata through daemon, public API and federation", async () => {
    const bytes = Buffer.from([0xff, 0x00, 0xc3, 0x28]);
    const source = new PassThrough();
    const resource = vi.fn<PluginBackendResourceDispatcher["resource"]>(() => Promise.resolve({
      body: source, contentType: "application/octet-stream", statusCode: 206, contentLength: 4,
      contentRange: "bytes 2-5/8", acceptRanges: "bytes",
    }));
    const url = await chain(resource);
    const pending = fetch(`${url}/api/machines/remote${machinePath}${query}`, { headers: { range: "bytes=2-5", "x-untrusted": "no" } });
    source.write(bytes.subarray(0, 2));
    const response = await pending;
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 2-5/8");
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("content-length")).toBe("4");
    expect(response.headers.get("content-security-policy")).toContain("sandbox;");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(resource.mock.calls[0]?.[0]).toMatchObject({ scope: "machine", range: "bytes=2-5", moduleRevision: "r1", input: { id: 1 } });
    if (response.body === null) throw new Error("Missing response body");
    const reader = response.body.getReader();
    const first = await reader.read();
    expect(Buffer.from(first.value ?? [])).toEqual(bytes.subarray(0, 2));
    source.end(bytes.subarray(2));
    const second = await reader.read();
    expect(Buffer.from(second.value ?? [])).toEqual(bytes.subarray(2));
    expect((await reader.read()).done).toBe(true);
  });

  it.each(["upstream", "browser"])("attributes a mid-body disconnect to the right peer: %s", async (peer) => {
    const lines: string[] = [];
    const edge = createHttpServer("web", {}, { logger: { stream: { write(line: string) { lines.push(line); } } } });
    apps.push(edge);
    const body = new PassThrough();
    registerPluginBackendResourceProxyRoutes(edge, { requestStream: () => Promise.resolve({
      body, statusCode: 200, headers: { "content-type": "application/octet-stream" },
    }) });
    const url = await edge.listen({ port: 0, host: "127.0.0.1" });
    lines.length = 0;
    body.write("partial");
    const response = await fetch(`${url}/api${machinePath}${query}`);
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Missing response body");
    expect((await reader.read()).done).toBe(false);
    if (peer === "browser") {
      const closed = new Promise<void>((resolve) => { body.once("close", resolve); });
      await reader.cancel();
      await closed;
      expect(lines).toEqual([]);
    } else {
      body.destroy(Object.assign(new Error("private-socket"), { code: "ECONNRESET" }));
      await expect(reader.read()).rejects.toThrow();
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0] ?? "")).toMatchObject({ event: "sessiond.proxy.failure", transport: "http", phase: "response",
        reason: "stream-failed", errorCode: "ECONNRESET", reqId: response.headers.get("x-request-id") });
      expect(lines[0]).not.toMatch(/private-socket|stack|revision=/u);
    }
  });

  it("preserves an unsatisfied range through every hop as inert JSON", async () => {
    const resource = vi.fn<PluginBackendResourceDispatcher["resource"]>(() => Promise.resolve({
      body: Readable.from([Buffer.from("unsafe error document")]), contentType: "text/html", statusCode: 416,
      contentRange: "bytes */8", acceptRanges: "bytes",
    }));
    const url = await chain(resource);
    const response = await fetch(`${url}/api/machines/remote${machinePath}${query}`, { headers: { range: "bytes=99-" } });
    expect(response.status).toBe(416);
    expect(response.headers.get("content-range")).toBe("bytes */8");
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({ error: "Resource range not satisfiable" });
    expect(resource.mock.calls[0]?.[0].range).toBe("bytes=99-");
  });

  it("exposes GET only and rejects invalid query or unsafe Range before dispatch", async () => {
    const edge = app();
    const requestStream = vi.fn<SessionDaemonClient["requestStream"]>();
    registerPluginBackendResourceProxyRoutes(edge, { requestStream });
    registerPluginBackendResourceProxyRoutes(edge, { requestStream }, "/api/machines/local");
    for (const prefix of ["/api", "/api/machines/local"]) {
      for (const method of ["POST", "HEAD"] as const) {
        expect((await edge.inject({ method, url: `${prefix}${machinePath}${query}` })).statusCode).toBe(404);
      }
      for (const suffix of ["?revision=r1&input=not-json", "?input=null", `?revision=r1&input=${"x".repeat(4097)}`]) {
        const response = await edge.inject({ url: `${prefix}${machinePath}${suffix}` });
        expect(response.statusCode).toBe(400);
        expect(response.headers["content-type"]).toContain("application/json");
        expect(response.headers["cache-control"]).toBe("no-store");
      }
      const unsafeRange = await edge.inject({ url: `${prefix}${machinePath}${query}`, headers: { range: "x".repeat(257) } });
      expect(unsafeRange.statusCode).toBe(400);
    }
    expect(requestStream).not.toHaveBeenCalled();
  });

  it("cancels the registry signal on a browser disconnect after headers", async () => {
    let cancelled!: () => void;
    const cancellation = new Promise<void>((resolve) => { cancelled = resolve; });
    const source = new PassThrough();
    const url = await chain((_request, signal) => {
      signal?.addEventListener("abort", () => { source.destroy(); cancelled(); }, { once: true });
      source.write(Buffer.from([0xff]));
      return Promise.resolve({ body: source, contentType: "image/png", statusCode: 200 });
    });
    const controller = new AbortController();
    const response = await fetch(`${url}/api/machines/remote${machinePath}${query}`, { signal: controller.signal });
    if (response.body === null) throw new Error("Missing response body");
    const reader = response.body.getReader();
    await reader.read();
    controller.abort();
    await cancellation;
    expect(source.destroyed).toBe(true);
  });

  it.each([
    ["", "machine"], ["/projects/p%2Fone", "project"], ["/projects/p%2Fone/workspaces/w%23two", "workspace"],
  ])("maps nested scope %s without query-supplied authority", async (scopePath, scope) => {
    const daemon = app();
    const resource = vi.fn<PluginBackendResourceDispatcher["resource"]>(() => Promise.resolve({ body: Readable.from([Buffer.from([255])]), contentType: "application/pdf", statusCode: 200 }));
    const requireProject = vi.fn(() => Promise.resolve({ id: "p/one", name: "Project", path: "/repo", createdAt: "2026-07-27T00:00:00.000Z" }));
    registerPluginBackendResourceRoutes(daemon, { projects: { requireProject }, backends: { resource } });
    const edge = app();
    const requestStream = vi.fn<SessionDaemonClient["requestStream"]>(async (path, options) => {
      expect(options?.headers).toEqual({ range: "bytes=0-" });
      const response = await daemon.inject({ url: path, headers: options?.headers ?? {} });
      return { statusCode: response.statusCode, headers: { "content-type": String(response.headers["content-type"]) }, body: Readable.from([response.rawPayload]) };
    });
    registerPluginBackendResourceProxyRoutes(edge, { requestStream });
    const path = `/paired-plugin-backends/viewer${scopePath}/resources/read`;
    const response = await edge.inject({ url: `/api${path}${query}&scope=machine`, headers: { range: "bytes=0-" } });
    expect(requestStream.mock.calls[0]?.[0]).toBe(`${path}?revision=r1&input=%7B%22id%22%3A1%7D`);
    expect(response.statusCode).toBe(200);
    expect(resource.mock.calls[0]?.[0]).toMatchObject({ scope, ...(scope === "workspace" ? { workspaceId: "w#two" } : {}) });
    expect(response.headers["content-security-policy"]).not.toContain("sandbox");
    expect(response.headers["content-security-policy"]).toContain("script-src 'none'");
    if (scope !== "machine") expect(requireProject).toHaveBeenCalledWith("p/one");
  });

  it("strips hostile remote headers", async () => {
    const edge = app();
    registerMachineProxyRoutes(edge, {
      invalidateReportedName: vi.fn(), remoteClient: () => Promise.resolve({
        request: () => Promise.resolve({ statusCode: 200, headers: {
          "content-type": "text/html", "content-security-policy": "script-src *", "set-cookie": "secret=1", location: "https://evil.test", "cache-control": "public", "content-disposition": "attachment",
        }, body: Readable.from([Buffer.from("<script>alert(1)</script>")]) }),
        requestJson: () => Promise.reject(new Error("unused")), connectWebSocket: () => { throw new Error("unused"); },
      }),
    });
    const response = await edge.inject({ url: `/api/machines/remote${machinePath}${query}` });
    expect(response.statusCode).toBe(200);
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(response.headers.location).toBeUndefined();
    expect(response.headers["content-disposition"]).toBe("inline");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["content-security-policy"]).toBe("sandbox; default-src 'none'; frame-ancestors 'self'; form-action 'none'; base-uri 'none'");
  });
});
