import { Readable } from "node:stream";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import { afterEach, beforeEach, describe, expect, it, vi, type MockedFunction } from "vitest";
import { PI_WEB_CAPABILITIES } from "../../shared/capabilities.js";
import type { PiWebRuntimeResponse } from "../../shared/apiTypes.js";
import { DEFAULT_REMOTE_HEALTH_TIMEOUT_MS, type MachineClient } from "./machineClient.js";
import { registerMachineProxyRoutes } from "./machineProxyRoutes.js";

let app: FastifyInstance;
let request: MockedFunction<MachineClient["request"]>;
let requestJson: MockedFunction<MachineClient["requestJson"]>;

function supportedRuntime(): PiWebRuntimeResponse {
  const capabilities = [PI_WEB_CAPABILITIES.sessionCleanupPinnedExclusions];
  return {
    packageName: "@jmfederico/pi-web", generatedAt: "2026-06-25T00:00:00.000Z", capabilities,
    components: {
      web: { component: "web", label: "PI WEB", available: true, capabilities },
      sessiond: { component: "sessiond", label: "Session daemon", available: true, capabilities },
    },
  };
}

beforeEach(async () => {
  app = Fastify({ logger: false });
  await app.register(fastifyWebsocket);
  request = vi.fn<MachineClient["request"]>(() => Promise.resolve({ statusCode: 200, headers: { "content-type": "application/json" }, body: Readable.from(['{"ok":true}']) }));
  requestJson = vi.fn<MachineClient["requestJson"]>(() => Promise.resolve({ statusCode: 200, headers: {}, body: supportedRuntime() }));
  const client: MachineClient = {
    request, requestJson,
    connectWebSocket: () => { throw new Error("WebSockets are not expected"); },
  };
  registerMachineProxyRoutes(app, { remoteClient: () => Promise.resolve(client), invalidateReportedName: vi.fn() });
});

afterEach(async () => { await app.close(); });

describe("federated pinned-session cleanup protection", () => {
  it.each(["/sessions/cleanup/preview", "/sessions/cleanup"])("checks remote support before forwarding %s unchanged", async (path) => {
    const body = { skipPinned: true, archiveIdleDays: 30, projectCwds: ["/repo"] };
    const response = await app.inject({ method: "POST", url: `/api/machines/remote${path}`, payload: body });
    expect(response.statusCode).toBe(200);
    expect(requestJson).toHaveBeenCalledWith("GET", "/api/pi-web/runtime", undefined, { timeoutMs: DEFAULT_REMOTE_HEALTH_TIMEOUT_MS });
    expect(request).toHaveBeenCalledWith("POST", `/api${path}`, body);
  });

  it.each(["web", "sessiond"] as const)("blocks an old remote %s even if aggregate capabilities claim support", async (owner) => {
    const runtime = supportedRuntime();
    runtime.components[owner].capabilities = [];
    requestJson.mockResolvedValue({ statusCode: 200, headers: {}, body: runtime });
    const response = await app.inject({ method: "POST", url: "/api/machines/remote/sessions/cleanup", payload: { skipPinned: true } });
    expect(response.statusCode).toBe(503);
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    { statusCode: 200, body: { capabilities: [PI_WEB_CAPABILITIES.sessionCleanupPinnedExclusions] } },
    { statusCode: 500, body: supportedRuntime() },
  ])("blocks cleanup when runtime verification is invalid (%j)", async (runtime) => {
    requestJson.mockResolvedValue({ ...runtime, headers: {} });
    expect((await app.inject({ method: "POST", url: "/api/machines/remote/sessions/cleanup", payload: { skipPinned: true } })).statusCode).toBe(503);
    expect(request).not.toHaveBeenCalled();
  });

  it("does not forward cleanup on runtime transport failure", async () => {
    requestJson.mockRejectedValue(new Error("offline"));
    expect((await app.inject({ method: "POST", url: "/api/machines/remote/sessions/cleanup", payload: { skipPinned: true } })).statusCode).toBe(502);
    expect(request).not.toHaveBeenCalled();
  });

  it("refreshes capability verification between preview and execution", async () => {
    await app.inject({ method: "POST", url: "/api/machines/remote/sessions/cleanup/preview", payload: { skipPinned: true } });
    const runtime = supportedRuntime();
    runtime.components.sessiond.available = false;
    requestJson.mockResolvedValue({ statusCode: 200, headers: {}, body: runtime });
    expect((await app.inject({ method: "POST", url: "/api/machines/remote/sessions/cleanup", payload: { skipPinned: true } })).statusCode).toBe(503);
    expect(requestJson).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("preserves omitted/false behavior without runtime requests and rejects malformed flags", async () => {
    for (const body of [{}, { skipPinned: false }]) {
      expect((await app.inject({ method: "POST", url: "/api/machines/remote/sessions/cleanup", payload: body })).statusCode).toBe(200);
    }
    expect(requestJson).not.toHaveBeenCalled();
    for (const skipPinned of [null, "true", 1]) {
      expect((await app.inject({ method: "POST", url: "/api/machines/remote/sessions/cleanup", payload: { skipPinned } })).statusCode).toBe(400);
    }
    expect(request).toHaveBeenCalledTimes(2);
  });
});
