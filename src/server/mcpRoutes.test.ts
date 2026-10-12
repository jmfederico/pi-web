import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpCheckResponse, McpServersResponse } from "../shared/apiTypes.js";
import { McpConfigError, type McpConfigService } from "./mcpConfigService.js";
import { registerMcpRoutes, type McpRouteDependencies } from "./mcpRoutes.js";

const listing: McpServersResponse = { servers: [], errors: [], userConfigPath: "/active-agent/mcp.json" };
const checkResult: McpCheckResponse = { checkedAt: "2026-01-01T00:00:00.000Z", servers: [], errors: [] };
const workspaceRoute = "/projects/project%20one/workspaces/workspace%20one/mcp";
const cwd = "/managed/workspace";

let app: FastifyInstance;
let list: ReturnType<typeof vi.fn<McpConfigService["list"]>>;
let setEnabled: ReturnType<typeof vi.fn<McpConfigService["setEnabled"]>>;
let check: ReturnType<typeof vi.fn<McpRouteDependencies["check"]>>;
let resolveWorkspace: ReturnType<typeof vi.fn<McpRouteDependencies["resolveWorkspace"]>>;

beforeEach(() => {
  app = Fastify({ logger: false });
  list = vi.fn(() => Promise.resolve(listing));
  setEnabled = vi.fn(() => Promise.resolve(listing));
  check = vi.fn(() => Promise.resolve(checkResult));
  resolveWorkspace = vi.fn(() => Promise.resolve(cwd));
  registerMcpRoutes(app, { list, setEnabled }, { check, resolveWorkspace });
});

afterEach(async () => {
  await app.close();
});

describe("MCP route scope and workspace resolution", () => {
  it("lists/toggles only user configuration on machine routes", async () => {
    const get = await app.inject({ method: "GET", url: "/mcp" });
    const put = await app.inject({ method: "PUT", url: "/mcp/servers/server-one", payload: { enabled: false } });

    expect(get.statusCode).toBe(200);
    expect(get.json<McpServersResponse>()).toEqual(listing);
    expect(put.statusCode).toBe(200);
    expect(put.json<McpServersResponse>()).toEqual(listing);
    expect(list).toHaveBeenCalledWith(undefined);
    expect(setEnabled).toHaveBeenCalledWith("server-one", "user", false, undefined);
    expect(resolveWorkspace).not.toHaveBeenCalled();
    expect(check).not.toHaveBeenCalled();
  });

  it("resolves workspace ids for listing and either toggle scope", async () => {
    const get = await app.inject({ method: "GET", url: workspaceRoute });
    const project = await app.inject({ method: "PUT", url: `${workspaceRoute}/servers/server-one`, payload: { scope: "project", enabled: false } });
    const user = await app.inject({ method: "PUT", url: `${workspaceRoute}/servers/server-one`, payload: { scope: "user", enabled: true } });

    expect([get.statusCode, project.statusCode, user.statusCode]).toEqual([200, 200, 200]);
    expect(resolveWorkspace.mock.calls).toEqual(Array.from({ length: 3 }, () => ["project one", "workspace one"]));
    expect(list).toHaveBeenCalledWith(cwd);
    expect(setEnabled.mock.calls).toEqual([["server-one", "project", false, cwd], ["server-one", "user", true, cwd]]);
    expect(check).not.toHaveBeenCalled();
  });

  it("checks explicitly with neutral or resolved workspace cwd and a cancellation signal", async () => {
    const user = await app.inject({ method: "POST", url: "/mcp/check" });
    const project = await app.inject({ method: "POST", url: `${workspaceRoute}/check`, payload: {} });

    expect(user.statusCode).toBe(200);
    expect(project.statusCode).toBe(200);
    expect(project.json<McpCheckResponse>()).toEqual(checkResult);
    expect(check.mock.calls.map(([directory]) => directory)).toEqual([undefined, cwd]);
    expect(check.mock.calls.every(([, signal]) => signal instanceof AbortSignal && !signal.aborted)).toBe(true);
    expect(resolveWorkspace).toHaveBeenCalledWith("project one", "workspace one");
    expect(list).not.toHaveBeenCalled();
    expect(setEnabled).not.toHaveBeenCalled();
  });

  it("supports the injected route prefix without forcing /api", async () => {
    registerMcpRoutes(app, { list, setEnabled }, { check, resolveWorkspace }, "/internal/");

    expect((await app.inject({ method: "GET", url: "/internal/mcp" })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: `/internal${workspaceRoute}/check` })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/mcp" })).statusCode).toBe(404);
  });
});

describe("MCP route validation", () => {
  it.each([
    { route: "/mcp", body: {} },
    { route: "/mcp", body: { enabled: "false" } },
    { route: "/mcp", body: { enabled: false, scope: "user" } },
    { route: "/mcp", body: { enabled: false, scope: "project" } },
    { route: "/mcp", body: { enabled: false, cwd: "/arbitrary" } },
    { route: "/mcp", body: { enabled: false, path: "/arbitrary/mcp.json" } },
    { route: workspaceRoute, body: { enabled: true } },
    { route: workspaceRoute, body: { enabled: true, scope: "global" } },
    { route: workspaceRoute, body: { enabled: 1, scope: "project" } },
    { route: workspaceRoute, body: { enabled: true, scope: "project", cwd: "/arbitrary" } },
    { route: workspaceRoute, body: { enabled: true, scope: "project", path: "/arbitrary/mcp.json" } },
  ])("rejects invalid toggle body $body on $route before resolving or persisting", async ({ route, body }) => {
    const response = await app.inject({ method: "PUT", url: `${route}/servers/target`, payload: body });

    expect(response.statusCode).toBe(400);
    expect(setEnabled).not.toHaveBeenCalled();
    expect(resolveWorkspace).not.toHaveBeenCalled();
  });

  it.each([undefined, "null", "[]", '"false"'])("rejects missing/non-object toggle body %s", async (payload) => {
    const response = await app.inject({
      method: "PUT", url: "/mcp/servers/target",
      ...(payload === undefined ? {} : { payload, headers: { "content-type": "application/json" } }),
    });
    expect(response.statusCode).toBe(400);
    expect(setEnabled).not.toHaveBeenCalled();
  });

  it.each(["__proto__", "constructor", "bad.name", "..%2Ftarget"])("rejects unsafe route server name %s", async (name) => {
    const response = await app.inject({ method: "PUT", url: `${workspaceRoute}/servers/${name}`, payload: { enabled: true, scope: "project" } });
    expect(response.statusCode).toBe(400);
    expect(setEnabled).not.toHaveBeenCalled();
    expect(resolveWorkspace).not.toHaveBeenCalled();
  });

  it.each([
    { method: "GET", route: "/mcp" },
    { method: "GET", route: workspaceRoute },
    { method: "PUT", route: "/mcp/servers/target" },
    { method: "PUT", route: `${workspaceRoute}/servers/target` },
    { method: "POST", route: "/mcp/check" },
    { method: "POST", route: `${workspaceRoute}/check` },
  ] as const)("does not accept a cwd query on $method $route", async ({ method, route }) => {
    const response = await app.inject({ method, url: `${route}?cwd=%2Farbitrary`, ...(method === "PUT" ? { payload: { enabled: true, scope: "project" } } : {}) });
    expect(response.statusCode).toBe(400);
    expect(list).not.toHaveBeenCalled();
    expect(setEnabled).not.toHaveBeenCalled();
    expect(check).not.toHaveBeenCalled();
    expect(resolveWorkspace).not.toHaveBeenCalled();
  });

  it.each(["/mcp/check", `${workspaceRoute}/check`])("rejects client-selected check configuration at %s", async (route) => {
    const response = await app.inject({ method: "POST", url: route, payload: { scope: "project", cwd: "/arbitrary", path: "/arbitrary/mcp.json" } });
    expect(response.statusCode).toBe(400);
    expect(check).not.toHaveBeenCalled();
    expect(resolveWorkspace).not.toHaveBeenCalled();
  });
});

describe("MCP route errors and cancellation", () => {
  it("preserves validation/missing/conflict/IO service failures with safe messages", async () => {
    setEnabled.mockRejectedValueOnce(new McpConfigError("project MCP configuration contains invalid JSON", 400));
    setEnabled.mockRejectedValueOnce(new McpConfigError("MCP server not found in the requested scope", 404));
    setEnabled.mockRejectedValueOnce(new McpConfigError("user MCP configuration changed during the update; refresh configuration and retry", 409));
    setEnabled.mockRejectedValueOnce(new McpConfigError("user MCP configuration could not be written (EACCES)", 500));

    for (const status of [400, 404, 409, 500]) {
      const response = await app.inject({ method: "PUT", url: "/mcp/servers/target", payload: { enabled: false } });
      expect(response.statusCode).toBe(status);
      expect(response.json<{ error: string }>().error).toContain("MCP");
      expect(response.body).not.toContain("stack");
    }
  });

  it("returns 404 for an unknown managed workspace without calling the service/checker", async () => {
    resolveWorkspace.mockRejectedValue(new Error("Workspace not found"));

    const response = await app.inject({ method: "POST", url: `${workspaceRoute}/check` });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "Workspace not found" });
    expect(check).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
  });

  it("does not return secret-bearing unexpected service/checker errors", async () => {
    list.mockRejectedValue(new Error("JSON secret-config-value"));
    check.mockRejectedValue(new Error("https://user:secret-token@example.test"));

    for (const response of [await app.inject({ method: "GET", url: "/mcp" }), await app.inject({ method: "POST", url: "/mcp/check" })]) {
      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({ error: "MCP operation failed. Run pi mcp list on this machine for detailed diagnostics." });
      expect(response.body).not.toContain("secret");
    }
  });

  it("cancels disconnected checks and disposes cancellation listeners even on failure", async () => {
    let request: FastifyRequest | undefined;
    let reply: FastifyReply | undefined;
    app.addHook("preHandler", (incoming, outgoing, done) => {
      request = incoming;
      reply = outgoing;
      done();
    });
    check.mockImplementation((_cwd, signal) => {
      request?.raw.emit("aborted");
      expect(signal?.aborted).toBe(true);
      return Promise.reject(new Error("Check cancelled"));
    });

    const response = await app.inject({ method: "POST", url: `${workspaceRoute}/check` });

    expect(response.statusCode).toBe(500);
    expect(request?.raw.listenerCount("aborted")).toBe(0);
    expect(reply?.raw.listenerCount("close")).toBe(0);
  });
});
