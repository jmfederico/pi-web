import { resolve } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import type { OAuthFlowState } from "../../shared/apiTypes.js";
import { afterEach, expect, it, vi } from "vitest";
import { FEDERATED_HTTP_ROUTES } from "../../shared/federatedRoutes.js";
import { McpAuthFlowService } from "./mcpAuthFlowService.js";
import { registerMcpAuthRoutes } from "./mcpAuthRoutes.js";

const apps: FastifyInstance[] = [];
const services: McpAuthFlowService[] = [];
afterEach(async () => { for (const service of services.splice(0)) service.dispose(); await Promise.all(apps.splice(0).map((app) => app.close())); });

function fixture() {
  const app = Fastify(); apps.push(app);
  const flows = new McpAuthFlowService(); services.push(flows);
  const startMcpAuth = vi.fn((ref: { id: string; cwd: string }, mode: "login" | "logout") => Promise.resolve(flows.start({
    sessionId: ref.id, identity: {}, isCurrent: () => true,
    run: async () => { await required(McpAuthFlowService.current()).input(`Pi ${mode}`); },
  })));
  const mcpAuthServers = vi.fn(() => Promise.resolve({ servers: [{ name: "alpha", description: "verbatim" }] }));
  registerMcpAuthRoutes(app, { mcpAuthFlows: flows, startMcpAuth, mcpAuthServers }, "/api");
  return { app, flows, startMcpAuth, mcpAuthServers };
}

it("wires session start, poll, response and cancel through the machine-owned MCP transport", async () => {
  const { app, flows, startMcpAuth } = fixture();
  const response = await app.inject({ method: "POST", url: "/api/sessions/session-1/mcp/auth", payload: { cwd: "/workspace", mode: "login" } });
  expect(response.statusCode).toBe(200);
  const flow = response.json<OAuthFlowState>();
  expect(flow).toMatchObject({ target: "mcp", providerId: "mcp", status: "running", prompt: { message: "Pi login" } });
  expect(startMcpAuth).toHaveBeenCalledWith({ id: "session-1", cwd: resolve("/workspace") }, "login", undefined);
  const poll = await app.inject(`/api/auth/mcp/${flow.flowId}`);
  expect(poll.json()).toEqual(flow);
  const answer = await app.inject({ method: "POST", url: `/api/auth/mcp/${flow.flowId}/respond`, payload: { requestId: required(flow.prompt).requestId, value: "redirect" } });
  expect(answer.statusCode).toBe(200);
  await vi.waitFor(() => { expect(flows.get(flow.flowId).status).toBe("complete"); });
  const logout = await app.inject({ method: "POST", url: "/api/sessions/session-1/mcp/auth", payload: { cwd: "/workspace", mode: "logout" } });
  const cancel = await app.inject({ method: "POST", url: `/api/auth/mcp/${logout.json<OAuthFlowState>().flowId}/cancel` });
  expect(cancel.json()).toMatchObject({ status: "running", cancelRequested: true });
  expect((await app.inject("/api/auth/mcp/unknown")).statusCode).toBe(404);
  expect((await app.inject({ method: "POST", url: "/api/auth/mcp/unknown/respond", payload: { requestId: "old", value: "x" } })).statusCode).toBe(400);
});

it.each([
  {}, { cwd: "", mode: "login" }, { cwd: "/workspace", mode: "arbitrary" },
  { cwd: "/workspace", mode: "login", url: "https://untrusted.test" },
  { cwd: "/workspace", mode: "login", config: {} },
])("rejects invalid starts and client-supplied configuration: %j", async (payload) => {
  const { app, startMcpAuth } = fixture();
  expect((await app.inject({ method: "POST", url: "/api/sessions/session-1/mcp/auth", payload })).statusCode).toBe(400);
  expect(startMcpAuth).not.toHaveBeenCalled();
});

it("allowlists all MCP flow routes for federation", () => {
  for (const route of [
    { method: "GET", path: "/sessions/:sessionId/mcp/auth/servers" },
    { method: "POST", path: "/sessions/:sessionId/mcp/auth" },
    { method: "GET", path: "/auth/mcp/:flowId" },
    { method: "POST", path: "/auth/mcp/:flowId/respond" },
    { method: "POST", path: "/auth/mcp/:flowId/cancel" },
  ]) expect(FEDERATED_HTTP_ROUTES).toContainEqual(route);
});

it("passes explicit targets and list workspace through federation-compatible routes", async () => {
  const { app, startMcpAuth, mcpAuthServers } = fixture();
  const list = await app.inject("/api/sessions/session-1/mcp/auth/servers?cwd=%2Fworkspace");
  expect(list.statusCode).toBe(200);
  expect(list.json()).toEqual({ servers: [{ name: "alpha", description: "verbatim" }] });
  expect(mcpAuthServers).toHaveBeenCalledWith({ id: "session-1", cwd: resolve("/workspace") });
  expect((await app.inject("/api/sessions/session-1/mcp/auth/servers")).statusCode).toBe(400);
  const auth = await app.inject({ method: "POST", url: "/api/sessions/session-1/mcp/auth", payload: { cwd: "/workspace", mode: "logout", serverName: "alpha" } });
  expect(auth.statusCode).toBe(200);
  expect(startMcpAuth).toHaveBeenCalledWith({ id: "session-1", cwd: resolve("/workspace") }, "logout", "alpha");
});

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected value");
  return value;
}
