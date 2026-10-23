import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { MCP_HTTP_ROUTES } from "../shared/federatedRoutes.js";
import type { MachineClient } from "./machines/machineClient.js";
import { appTestContext, fakeRemoteClient, registerAppTestHooks } from "./app.testSupport.js";

registerAppTestHooks();

describe.each(["/api", "/api/machines/local"])("MCP daemon proxy at %s", (prefix) => {
  it.each(MCP_HTTP_ROUTES)("forwards $method $path to the owner", async (spec) => {
    const path = spec.path.replace(":projectId", "project%20one").replace(":workspaceId", "workspace%20one").replace(":name", "docs");
    const body = spec.method === "PUT" ? { scope: "project", enabled: false } : undefined;
    const response = await appTestContext.app.inject({ method: spec.method, url: `${prefix}${path}`, ...(body === undefined ? {} : { payload: body }) });
    expect(response.statusCode).toBe(200);
    expect(appTestContext.sessionDaemonRequests).toEqual([{ method: spec.method, path, body }]);
  });
});

describe("MCP federation", () => {
  it("bounds an incomplete connection-check response after headers", async () => {
    const add = await appTestContext.app.inject({ method: "POST", url: "/api/machines", payload: { name: "Remote", baseUrl: "https://remote.example.test/" } });
    const remote = add.json<{ id: string }>();
    const body = new Readable({ read() { /* deliberately never completes */ } });
    body.push("{");
    const request = vi.fn<MachineClient["request"]>(() => Promise.resolve({ statusCode: 200, headers: { "content-type": "application/json" }, body }));
    appTestContext.remoteClient = fakeRemoteClient({ request });
    vi.useFakeTimers();
    try {
      const pending = appTestContext.app.inject({ method: "POST", url: `/api/machines/${remote.id}/mcp/check` });
      await vi.waitFor(() => { expect(request).toHaveBeenCalledOnce(); });
      await vi.advanceTimersByTimeAsync(100_000);
      const response = await pending;
      expect(response.statusCode).toBe(504);
      expect(response.json()).toMatchObject({ error: "Remote machine timeout", detail: "Remote machine response body timed out" });
      expect(body.destroyed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("targets the remote config and bounds connection checks instead of falling back locally", async () => {
    const add = await appTestContext.app.inject({ method: "POST", url: "/api/machines", payload: { name: "Remote", baseUrl: "https://remote.example.test/" } });
    const remote = add.json<{ id: string }>();
    const request = vi.fn<MachineClient["request"]>(() => Promise.resolve({
      statusCode: 404,
      headers: { "content-type": "application/json" },
      body: Readable.from([JSON.stringify({ error: "Not supported" })]),
    }));
    appTestContext.remoteClient = fakeRemoteClient({ request });
    const prefix = `/api/machines/${remote.id}`;
    const list = await appTestContext.app.inject({ method: "GET", url: `${prefix}/mcp` });
    const toggle = await appTestContext.app.inject({ method: "PUT", url: `${prefix}/mcp/servers/docs`, payload: { enabled: false } });
    const check = await appTestContext.app.inject({ method: "POST", url: `${prefix}/projects/p1/workspaces/w1/mcp/check` });
    expect([list.statusCode, toggle.statusCode, check.statusCode]).toEqual([404, 404, 404]);
    expect(request).toHaveBeenNthCalledWith(1, "GET", "/api/mcp", undefined);
    expect(request).toHaveBeenNthCalledWith(2, "PUT", "/api/mcp/servers/docs", { enabled: false });
    const checkCall = request.mock.calls[2];
    expect(checkCall?.slice(0, 3)).toEqual(["POST", "/api/projects/p1/workspaces/w1/mcp/check", undefined]);
    expect(checkCall?.[3]?.timeoutMs).toBe(100_000);
    expect(checkCall?.[3]?.signal).toBeInstanceOf(AbortSignal);
    expect(appTestContext.sessionDaemonRequests).toEqual([]);
  });
});
