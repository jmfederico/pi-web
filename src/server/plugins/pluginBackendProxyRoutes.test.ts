import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionDaemonRequestClient } from "../../sessiond/sessionDaemonClient.js";
import { registerPairedPluginBackendProxyRoutes } from "./pluginBackendProxyRoutes.js";

let app: FastifyInstance;
let request: ReturnType<typeof vi.fn<SessionDaemonRequestClient["request"]>>;

beforeEach(() => {
  app = Fastify({ logger: false });
  request = vi.fn<SessionDaemonRequestClient["request"]>(() => Promise.resolve({
    statusCode: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ counts: { open: 2 } }),
  }));
  registerPairedPluginBackendProxyRoutes(app, { request });
});

afterEach(async () => {
  await app.close();
});

describe("local paired plugin backend proxy route", () => {
  it("encodes every daemon path segment and forwards the JSON envelope once", async () => {
    const payload = { revision: "server-r1", input: { cards: ["alpha", "beta"] } };
    const response = await app.inject({
      method: "POST",
      url: "/api/paired-plugin-backends/board/projects/project%20one/workspaces/workspace%231/cards.summary",
      payload,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/json");
    expect(response.json()).toEqual({ counts: { open: 2 } });
    expect(request.mock.calls[0]?.slice(0, 3)).toEqual([
      "POST",
      "/paired-plugin-backends/board/projects/project%20one/workspaces/workspace%231/cards.summary",
      payload,
    ]);
    expect(request.mock.calls[0]?.[3]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("preserves JSON primitives and attributable upstream failures", async () => {
    request
      .mockResolvedValueOnce({ statusCode: 200, headers: { "content-type": "application/json" }, body: JSON.stringify("ready") })
      .mockResolvedValueOnce({
        statusCode: 501,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ error: "operation unavailable", code: "operation-unavailable", pluginId: "board", operation: "cards.summary" }),
      });

    const success = await app.inject({ method: "POST", url: "/api/paired-plugin-backends/board/projects/p1/workspaces/w1/cards.summary", payload: { revision: "r1", input: null } });
    const failure = await app.inject({ method: "POST", url: "/api/paired-plugin-backends/board/projects/p1/workspaces/w1/cards.summary", payload: { revision: "r1", input: null } });

    expect(success.json()).toBe("ready");
    expect(failure.statusCode).toBe(501);
    expect(failure.json()).toEqual({ error: "operation unavailable", code: "operation-unavailable", pluginId: "board", operation: "cards.summary" });
  });

  it("does not register the retired owner-backed route", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/plugin-backends/board/projects/p1/workspaces/w1/cards.summary",
      payload: { revision: "r1", input: null },
    });

    expect(response.statusCode).toBe(404);
    expect(request).not.toHaveBeenCalled();
  });

  it("maps daemon transport loss and an old daemon route to explicit gateway errors", async () => {
    request
      .mockRejectedValueOnce(new Error("connect ECONNREFUSED"))
      .mockResolvedValueOnce({
        statusCode: 404,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "Route POST:/paired-plugin-backends/board not found", error: "Not Found", statusCode: 404 }),
      });

    const unavailable = await app.inject({ method: "POST", url: "/api/paired-plugin-backends/board/projects/p1/workspaces/w1/cards.summary", payload: { revision: "r1", input: null } });
    const unsupported = await app.inject({ method: "POST", url: "/api/paired-plugin-backends/board/projects/p1/workspaces/w1/cards.summary", payload: { revision: "r1", input: null } });

    expect(unavailable.statusCode).toBe(502);
    expect(unavailable.json()).toMatchObject({ code: "daemon-unavailable", pluginId: "board", operation: "cards.summary" });
    expect(unsupported.statusCode).toBe(502);
    expect(unsupported.json()).toMatchObject({ code: "daemon-protocol-error" });
    expect(unsupported.json<{ error: string }>().error).toContain("restart or upgrade");
  });
});
