import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TerminalCommandRun } from "../../shared/apiTypes.js";
import type { SessionProxyDaemon } from "../sessiond/sessionProxyRoutes.js";
import { registerWorkspaceDeletionRoutes } from "./workspaceDeletionRoutes.js";

let app: FastifyInstance;
let daemonRequests: DaemonRequest[];
let daemonResponse: Awaited<ReturnType<SessionProxyDaemon["request"]>>;
let daemonFailure: Error | undefined;

const run: TerminalCommandRun = {
  id: "run1",
  origin: "core",
  projectId: "project one",
  workspaceId: "main",
  terminalId: "terminal1",
  title: "Disconnect board view",
  command: "boardctl view disconnect roadmap --keep-files",
  status: "running",
  createdAt: "2026-07-27T00:00:00.000Z",
  metadata: {
    "pi.operation": "workspace.delete",
    "target.workspaceId": "view/one",
    "target.workspacePath": "/views/roadmap",
  },
};

beforeEach(() => {
  app = Fastify({ logger: false });
  daemonRequests = [];
  daemonFailure = undefined;
  daemonResponse = {
    statusCode: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(run),
  };
  registerWorkspaceDeletionRoutes(app, fakeDaemon(), "/api");
});

afterEach(async () => {
  await app.close();
});

describe("workspace deletion routes", () => {
  it("is a thin encoded proxy to sessiond and preserves the command-run response", async () => {
    const response = await app.inject({
      method: "DELETE",
      url: "/api/projects/project%20one/workspaces/view%2Fone",
      payload: { precondition: "v1.confirmed" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/json");
    expect(response.json<TerminalCommandRun>()).toEqual(run);
    expect(daemonRequests).toHaveLength(1);
    expect(daemonRequests[0]).toMatchObject({
      method: "DELETE",
      path: "/workspace-removals/projects/project%20one/workspaces/view%2Fone",
      body: { precondition: "v1.confirmed" },
    });
    expect(daemonRequests[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(daemonRequests[0]?.signal?.aborted).toBe(false);
  });

  it("preserves attributable sessiond rejection status and body", async () => {
    daemonResponse = {
      statusCode: 409,
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ error: "Workspace owner is no longer current" }),
    };

    const response = await app.inject({
      method: "DELETE",
      url: "/api/projects/p1/workspaces/w1",
      payload: { precondition: "v1.confirmed" },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: "Workspace owner is no longer current" });
  });

  it("contains daemon availability and protocol failures at the web boundary", async () => {
    daemonResponse = { statusCode: 200, headers: {}, body: "not json" };
    const payload = { precondition: "v1.confirmed" };
    const malformed = await app.inject({ method: "DELETE", url: "/api/projects/p1/workspaces/w1", payload });

    daemonFailure = new Error("socket unavailable");
    const unavailable = await app.inject({ method: "DELETE", url: "/api/projects/p1/workspaces/w1", payload });

    expect(malformed.statusCode).toBe(502);
    expect(malformed.json<{ error: string }>().error).toContain("Invalid session daemon workspace removal response");
    expect(unavailable.statusCode).toBe(502);
    expect(unavailable.json()).toEqual({ error: "Session daemon unavailable: socket unavailable" });
  });

  it("requires the host confirmation precondition before contacting sessiond", async () => {
    const response = await app.inject({
      method: "DELETE",
      url: "/api/projects/p1/workspaces/w1",
      payload: {},
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: string }>().error).toContain("precondition");
    expect(daemonRequests).toEqual([]);
  });
});

interface DaemonRequest {
  method: string;
  path: string;
  body?: unknown;
  signal?: AbortSignal;
}

function fakeDaemon(): SessionProxyDaemon {
  return {
    request: (method, path, body, options) => {
      daemonRequests.push({
        method,
        path,
        ...(body === undefined ? {} : { body }),
        ...(options?.signal === undefined ? {} : { signal: options.signal }),
      });
      return daemonFailure === undefined ? Promise.resolve(daemonResponse) : Promise.reject(daemonFailure);
    },
    connectWebSocket: () => { throw new Error("WebSocket not configured for test"); },
  };
}
