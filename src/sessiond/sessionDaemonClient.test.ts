import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionDaemonClient } from "./sessionDaemonClient.js";

const activeAgentProfile = {
  schemaVersion: 2,
  dir: join(tmpdir(), "pi", "state"),
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("SessionDaemonClient transport configuration", () => {
  it("keeps no-argument construction compatible and captures the inherited URL", async () => {
    vi.stubEnv("PI_WEB_SESSIOND_URL", "https://daemon.example:8510/");
    const client = new SessionDaemonClient();
    vi.stubEnv("PI_WEB_SESSIOND_URL", "https://another.example/");
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok", { status: 202 }));

    await expect(client.request("POST", "/notify", { pluginId: "provider" })).resolves.toMatchObject({ statusCode: 202, body: "ok" });
    expect(fetch).toHaveBeenCalledWith(new URL("https://daemon.example:8510/notify"), {
      method: "POST", headers: { "content-type": "application/json" }, body: '{"pluginId":"provider"}',
    });
  });

  it("uses an explicit URL instead of inherited daemon addressing and forwards cancellation", async () => {
    vi.stubEnv("PI_WEB_SESSIOND_URL", "https://gateway.invalid/pi-web/");
    vi.stubEnv("PI_WEB_SESSIOND_SOCKET", join(tmpdir(), "wrong.sock"));
    const options = { baseUrl: "http://127.0.0.1:8510/" };
    const client = new SessionDaemonClient(options);
    options.baseUrl = "http://another.invalid/";
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"));
    const controller = new AbortController();

    await client.request("GET", "/runtime", undefined, { signal: controller.signal });

    expect(fetch).toHaveBeenCalledWith(new URL("http://127.0.0.1:8510/runtime"), { method: "GET", signal: controller.signal });
    expect(process.env["PI_WEB_SESSIOND_URL"]).toBe("https://gateway.invalid/pi-web/");
  });

  it("uses an explicit socket instead of an inherited gateway URL on the native platform", async () => {
    const socketPath = process.platform === "win32"
      ? `\\\\.\\pipe\\pi-client-${randomUUID()}`
      : join(tmpdir(), `${randomUUID()}.sock`);
    vi.stubEnv("PI_WEB_SESSIOND_URL", "http://gateway.invalid:8999/");
    vi.stubEnv("PI_WEB_SESSIOND_SOCKET", join(tmpdir(), "wrong.sock"));
    const fetch = vi.spyOn(globalThis, "fetch");
    const received: string[] = [];
    const server = createServer((request, reply) => {
      received.push(`${request.method ?? ""} ${request.url ?? ""}`);
      reply.writeHead(202, { "content-type": "application/json" });
      reply.end("{}");
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, resolve);
      });
      const response = await new SessionDaemonClient({ socketPath }).request("POST", "/notify", { pluginId: "provider" });

      expect(response.statusCode).toBe(202);
      expect(response.body).toBe("{}");
      expect(received).toEqual(["POST /notify"]);
      expect(fetch).not.toHaveBeenCalled();
      expect(process.env["PI_WEB_SESSIOND_URL"]).toBe("http://gateway.invalid:8999/");
    } finally {
      if (server.listening) {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => { server.close((error) => { if (error === undefined) resolve(); else reject(error); }); });
      }
    }
  });
});

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
