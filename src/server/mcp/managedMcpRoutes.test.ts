import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, expect, it, vi } from "vitest";
import type { ManagedMcpView } from "../../shared/managedMcp.js";
import { FEDERATED_HTTP_ROUTES } from "../../shared/federatedRoutes.js";
import { registerManagedMcpRoutes } from "./managedMcpRoutes.js";

const apps: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });
const view: ManagedMcpView = { globalConfigPath: "/config.json", projectTrusted: false, globalWritable: true, projectWritable: false, sessionWritable: true, servers: [], issues: [], revision: "revision" };
function fixture() {
  const app = Fastify(); apps.push(app);
  const managedMcpView = vi.fn(() => Promise.resolve(view));
  const updateManagedMcp = vi.fn(() => Promise.resolve(view));
  registerManagedMcpRoutes(app, { managedMcpView, updateManagedMcp });
  return { app, managedMcpView, updateManagedMcp };
}

it("routes global and session context explicitly and publishes both federated operations", async () => {
  const f = fixture();
  expect((await f.app.inject("/mcp/managed")).json()).toEqual(view);
  expect(f.managedMcpView).toHaveBeenLastCalledWith({});
  await f.app.inject("/mcp/managed?cwd=%2Fwork%20repo&sessionId=session");
  expect(f.managedMcpView).toHaveBeenLastCalledWith({ cwd: "/work repo", sessionId: "session" });
  const payload = { cwd: "/work repo", sessionId: "session", scope: "session", serverName: "docs", enabled: true, revision: "revision" };
  expect((await f.app.inject({ method: "POST", url: "/mcp/managed", payload })).json()).toEqual(view);
  expect(f.updateManagedMcp).toHaveBeenCalledWith(payload);
  expect(FEDERATED_HTTP_ROUTES).toEqual(expect.arrayContaining([
    expect.objectContaining({ method: "GET", path: "/mcp/managed" }), expect.objectContaining({ method: "POST", path: "/mcp/managed" }),
  ]));
});

it("rejects ambiguous context and definition writes before invoking the service", async () => {
  const f = fixture();
  expect((await f.app.inject("/mcp/managed?sessionId=session")).statusCode).toBe(400);
  for (const patch of [{ enabled: "true" }, { scope: "unknown" }, { serverName: "bad:name" }, { config: { command: "execute" } }, { revision: "" }]) {
    const response = await f.app.inject({ method: "POST", url: "/mcp/managed", payload: { scope: "global", serverName: "docs", enabled: true, revision: "r", ...patch } });
    expect(response.statusCode).toBe(400);
  }
  expect(f.updateManagedMcp).not.toHaveBeenCalled();
  expect(f.managedMcpView).not.toHaveBeenCalled();
});
