import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionDaemonClient } from "./sessionDaemonClient.js";

const activeAgentProfile = {
  schemaVersion: 2,
  dir: "/opt/pi/state",
};

describe("SessionDaemonClient active agent profile protocol", () => {
  it("returns the validated immutable profile from the daemon runtime endpoint", async () => {
    const client = new SessionDaemonClient();
    const request = vi.spyOn(client, "request").mockResolvedValue(runtimeResponse(activeAgentProfile));

    const result = await client.getActiveAgentProfile();

    expect(request).toHaveBeenCalledWith("GET", "/runtime");
    expect(result).toEqual({ status: "available", profile: activeAgentProfile });
    if (result.status === "available") {
      expect(Object.isFrozen(result.profile)).toBe(true);
    }
  });

  it("distinguishes invalid protocol responses from daemon unavailability", async () => {
    const invalidClient = new SessionDaemonClient();
    vi.spyOn(invalidClient, "request").mockResolvedValue(runtimeResponse({
      ...activeAgentProfile,
      token: "must-not-cross-the-protocol",
    }));
    const unavailableClient = new SessionDaemonClient();
    vi.spyOn(unavailableClient, "request").mockRejectedValue(new Error("connect ECONNREFUSED"));

    await expect(invalidClient.getActiveAgentProfile()).resolves.toEqual({
      status: "invalid",
      error: "session daemon runtime response was invalid",
    });
    await expect(unavailableClient.getActiveAgentProfile()).resolves.toEqual({
      status: "unavailable",
      error: "connect ECONNREFUSED",
    });
  });

  it.skipIf(process.platform === "win32")("rejects foreign-platform active state paths before local consumers use them", async () => {
    const client = new SessionDaemonClient();
    vi.spyOn(client, "request").mockResolvedValue(runtimeResponse({
      ...activeAgentProfile,
      dir: "C:\\pi-profiles\\work",
    }));

    await expect(client.getActiveAgentProfile()).resolves.toEqual({
      status: "invalid",
      error: "session daemon active agent profile was not valid for this host",
    });
  });

  it("treats a legacy runtime response without a profile as invalid for profile-dependent work", async () => {
    const client = new SessionDaemonClient();
    vi.spyOn(client, "request").mockResolvedValue(runtimeResponse(undefined));

    await expect(client.getActiveAgentProfile()).resolves.toEqual({
      status: "invalid",
      error: "session daemon runtime response did not include an active agent profile",
    });
  });
});

function runtimeResponse(profile: unknown) {
  return {
    statusCode: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      component: "sessiond",
      label: "Session daemon",
      available: true,
      capabilities: [],
      ...(profile === undefined ? {} : { activeAgentProfile: profile }),
    }),
  };
}

describe("SessionDaemonClient raw binary transport", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("sends the raw body with its headers over the HTTP URL transport", async () => {
    const { server, nextRequest } = captureDaemonRequest();
    await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Expected TCP server address");
    vi.stubEnv("PI_WEB_SESSIOND_URL", `http://127.0.0.1:${String(address.port)}`);

    try {
      const client = new SessionDaemonClient();
      const [result, captured] = await Promise.all([
        client.requestRaw(
          "POST",
          "/plugin-backends/board/projects/p1/workspaces/w1/secrets.store/binary",
          Buffer.from([0x00, 0xff, 0x73]),
          { headers: { "x-pi-web-plugin-backend-revision": "server-r1" } },
        ),
        nextRequest(),
      ]);

      expect(result.statusCode).toBe(200);
      expect(result.body).toBe(JSON.stringify({ ok: true }));
      expect(captured.method).toBe("POST");
      expect(captured.path).toBe("/plugin-backends/board/projects/p1/workspaces/w1/secrets.store/binary");
      expect(captured.headers["content-type"]).toBe("application/octet-stream");
      expect(captured.headers["x-pi-web-plugin-backend-revision"]).toBe("server-r1");
      expect(Array.from(captured.body)).toEqual([0x00, 0xff, 0x73]);
    } finally {
      await closeServer(server);
    }
  });

  it.skipIf(process.platform === "win32")("sends the raw body with its headers over the unix socket transport", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-web-sessiond-client-"));
    const socketPath = join(dir, "sessiond.sock");
    const { server, nextRequest } = captureDaemonRequest();
    await new Promise<void>((resolve) => { server.listen(socketPath, resolve); });
    vi.stubEnv("PI_WEB_SESSIOND_URL", undefined);
    vi.stubEnv("PI_WEB_SESSIOND_SOCKET", socketPath);

    try {
      const client = new SessionDaemonClient();
      const [result, captured] = await Promise.all([
        client.requestRaw(
          "POST",
          "/plugin-backends/board/projects/p1/workspaces/w1/secrets.store/binary",
          Buffer.from([0x73, 0x65, 0x63]),
          { headers: { "x-pi-web-plugin-backend-revision": "server-r1" } },
        ),
        nextRequest(),
      ]);

      expect(result.statusCode).toBe(200);
      expect(captured.headers["content-type"]).toBe("application/octet-stream");
      expect(captured.headers["x-pi-web-plugin-backend-revision"]).toBe("server-r1");
      expect(Array.from(captured.body)).toEqual([0x73, 0x65, 0x63]);
    } finally {
      await closeServer(server);
      await rm(dir, { recursive: true, force: true });
    }
  });
});

interface CapturedDaemonRequest {
  method: string | undefined;
  path: string | undefined;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

/** HTTP server that answers each request with a JSON body and records one request. */
function captureDaemonRequest(): { server: http.Server; nextRequest: () => Promise<CapturedDaemonRequest> } {
  let pending: ((captured: CapturedDaemonRequest) => void) | undefined;
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer | string) => { chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); });
    request.on("end", () => {
      pending?.({
        method: request.method,
        path: request.url,
        headers: request.headers,
        body: Buffer.concat(chunks),
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
    });
  });
  return {
    server,
    nextRequest: () => new Promise((resolve) => { pending = resolve; }),
  };
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve();
      else reject(error);
    });
  });
}
