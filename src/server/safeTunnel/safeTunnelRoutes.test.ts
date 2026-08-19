import { gunzipSync } from "node:zlib";
import fastifyCompress from "@fastify/compress";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  SafeTunnelDisableResponse,
  SafeTunnelEnableRequest,
  SafeTunnelEnableResponse,
  SafeTunnelOperationResponse,
  SafeTunnelStatusResponse,
} from "../../shared/apiTypes.js";
import {
  SAFE_TUNNEL_MUTATION_HEADER_NAME,
  SAFE_TUNNEL_MUTATION_HEADER_VALUE,
} from "../../shared/safeTunnelHttp.js";
import type { SafeTunnelMutationHostConfig } from "./safeTunnelMutationHosts.js";
import {
  SafeTunnelOperationConflictError,
  registerSafeTunnelRoutes,
  type SafeTunnelRouteService,
} from "./safeTunnelRoutes.js";

const acceptedMutationHeaders = {
  [SAFE_TUNNEL_MUTATION_HEADER_NAME]: SAFE_TUNNEL_MUTATION_HEADER_VALUE,
  host: "localhost",
  origin: "http://localhost",
  "sec-fetch-site": "same-origin",
} as const;

let app: FastifyInstance;
let service: FakeSafeTunnelRouteService;

beforeEach(async () => {
  service = new FakeSafeTunnelRouteService();
  app = await createRouteApp();
});

afterEach(async () => {
  await app.close();
});

describe("registerSafeTunnelRoutes", () => {
  it("remains inert until an explicitly registered route is requested", () => {
    expect(service.status).not.toHaveBeenCalled();
    expect(service.enable).not.toHaveBeenCalled();
    expect(service.disable).not.toHaveBeenCalled();
    expect(service.operation).not.toHaveBeenCalled();
  });

  it("marks status, mutation, operation, and error responses no-store", async () => {
    const responses = await Promise.all([
      app.inject({ method: "GET", url: "/api/safe-tunnel/status" }),
      app.inject({
        method: "POST",
        url: "/api/safe-tunnel/enable",
        headers: acceptedMutationHeaders,
        payload: {},
      }),
      app.inject({
        method: "POST",
        url: "/api/safe-tunnel/disable",
        headers: acceptedMutationHeaders,
        payload: {},
      }),
      app.inject({ method: "GET", url: "/api/safe-tunnel/operations/op_1" }),
      app.inject({ method: "GET", url: "/api/safe-tunnel/operations/missing" }),
      app.inject({
        method: "POST",
        url: "/api/safe-tunnel/enable",
        headers: acceptedMutationHeaders,
        payload: [],
      }),
    ]);

    for (const response of responses) {
      expect(response.headers["cache-control"]).toBe("no-store");
    }
  });

  it("serves the browser-safe status contract", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/safe-tunnel/status",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<SafeTunnelStatusResponse>()).toEqual(service.statusResponse);
    expect(service.status).toHaveBeenCalledOnce();
  });

  it("accepts the marked same-origin JSON enable contract", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/safe-tunnel/enable",
      headers: acceptedMutationHeaders,
      payload: {},
    });

    expect(response.statusCode).toBe(202);
    expect(response.json<SafeTunnelEnableResponse>()).toEqual(service.enableResponse);
    expect(service.enable).toHaveBeenCalledWith({});
  });

  it("rejects an exact DNS-rebinding Enable/Disable probe despite same-origin metadata and the public marker", async () => {
    await replaceRouteApp({ allowedHosts: true });
    const reboundAuthority = "rebind.attacker.example:8504";
    const headers = {
      ...acceptedMutationHeaders,
      host: reboundAuthority,
      origin: `http://${reboundAuthority}`,
    };

    const enable = await app.inject({
      method: "POST",
      url: "/api/safe-tunnel/enable",
      headers,
      payload: {
        advanced: { controlApiUrl: "https://control.attacker.example" },
      },
    });
    const disable = await app.inject({
      method: "POST",
      url: "/api/safe-tunnel/disable",
      headers,
      payload: {},
    });

    for (const response of [enable, disable]) {
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ error: "Request forbidden." });
      expect(response.headers["cache-control"]).toBe("no-store");
    }
    expect(service.enable).not.toHaveBeenCalled();
    expect(service.disable).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "localhost",
      config: {},
      authority: "localhost:8504",
    },
    {
      label: "a literal LAN address",
      config: {},
      authority: "192.168.50.12:8504",
    },
    {
      label: "the configured listener name",
      config: { listenerHost: "pi-web.internal" },
      authority: "pi-web.internal:8504",
    },
    {
      label: "an explicitly trusted reverse-proxy Host rewrite",
      config: {
        allowedHosts: ["gateway.example.test", "pi-web-upstream.internal"],
      },
      authority: "pi-web-upstream.internal",
      origin: "https://gateway.example.test",
    },
  ] satisfies {
    label: string;
    config: SafeTunnelMutationHostConfig;
    authority: string;
    origin?: string;
  }[])("accepts a mutation through $label", async ({ config, authority, origin }) => {
    await replaceRouteApp(config);

    const response = await app.inject({
      method: "POST",
      url: "/api/safe-tunnel/enable",
      headers: {
        ...acceptedMutationHeaders,
        host: authority,
        origin: origin ?? `http://${authority}`,
      },
      payload: {},
    });

    expect(response.statusCode).toBe(202);
    expect(service.enable).toHaveBeenCalledWith({});
  });

  it("accepts the exact registered Origin with a direct or configured proxy-rewritten Host", async () => {
    service.registeredPublicOriginValue = "https://registered.tunnels.pi-web.dev:9443";
    await replaceRouteApp({ allowedHosts: ["pi-web-upstream.internal"] });

    const responses = await Promise.all([
      app.inject({
        method: "POST",
        url: "/api/safe-tunnel/disable",
        headers: {
          ...acceptedMutationHeaders,
          host: "registered.tunnels.pi-web.dev:9443",
          origin: "https://registered.tunnels.pi-web.dev:9443",
        },
        payload: {},
      }),
      app.inject({
        method: "POST",
        url: "/api/safe-tunnel/disable",
        headers: {
          ...acceptedMutationHeaders,
          host: "pi-web-upstream.internal:8504",
          origin: "https://registered.tunnels.pi-web.dev:9443",
        },
        payload: {},
      }),
    ]);

    expect(responses.map(({ statusCode }) => statusCode)).toEqual([200, 200]);
    expect(service.disable).toHaveBeenCalledTimes(2);
    expect(service.status).not.toHaveBeenCalled();
  });

  it.each([
    ["an HTTP downgrade", "registered.tunnels.pi-web.dev:9443", "http://registered.tunnels.pi-web.dev:9443"],
    ["an alternate effective port", "registered.tunnels.pi-web.dev:9443", "https://registered.tunnels.pi-web.dev"],
    ["an independently untrusted Host", "rebind.attacker.example:8504", "https://registered.tunnels.pi-web.dev:9443"],
  ])("rejects registered-ingress mutation trust with %s", async (
    _label,
    host,
    origin,
  ) => {
    service.registeredPublicOriginValue = "https://registered.tunnels.pi-web.dev:9443";

    const response = await app.inject({
      method: "POST",
      url: "/api/safe-tunnel/disable",
      headers: { ...acceptedMutationHeaders, host, origin },
      payload: {},
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: "Request forbidden." });
    expect(service.disable).not.toHaveBeenCalled();
  });

  it("does not combine automatic registered-Host trust with a different configured Origin", async () => {
    service.registeredPublicOriginValue = "https://registered.tunnels.pi-web.dev:9443";
    await replaceRouteApp({ allowedHosts: ["operator.example.test"] });

    const response = await app.inject({
      method: "POST",
      url: "/api/safe-tunnel/disable",
      headers: {
        ...acceptedMutationHeaders,
        host: "registered.tunnels.pi-web.dev:9443",
        origin: "https://operator.example.test",
      },
      payload: {},
    });

    expect(response.statusCode).toBe(403);
    expect(service.disable).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "localhost",
      config: {},
      host: "localhost:8504",
    },
    {
      label: "a literal LAN address",
      config: {},
      host: "192.168.50.12:8504",
    },
    {
      label: "the configured listener name",
      config: { listenerHost: "pi-web.internal" },
      host: "pi-web.internal:8504",
    },
    {
      label: "a configured reverse-proxy Host rewrite",
      config: { allowedHosts: ["pi-web-upstream.internal"] },
      host: "pi-web-upstream.internal:8504",
    },
    {
      label: "the persisted registered ingress",
      config: {},
      host: "registered.tunnels.pi-web.dev:9443",
      registeredPublicOrigin: "https://registered.tunnels.pi-web.dev:9443",
    },
  ] satisfies {
    label: string;
    config: SafeTunnelMutationHostConfig;
    host: string;
    registeredPublicOrigin?: string;
  }[])("serves protected reads through $label", async ({
    config,
    host,
    registeredPublicOrigin,
  }) => {
    service.registeredPublicOriginValue = registeredPublicOrigin;
    await replaceRouteApp(config);

    const [status, operation] = await Promise.all([
      app.inject({
        method: "GET",
        url: "/api/safe-tunnel/status",
        headers: { host },
      }),
      app.inject({
        method: "GET",
        url: "/api/safe-tunnel/operations/op_1",
        headers: { host },
      }),
    ]);

    expect(status.statusCode).toBe(200);
    expect(operation.statusCode).toBe(200);
    expect(service.status).toHaveBeenCalledOnce();
    expect(service.operation).toHaveBeenCalledOnce();
  });

  it("rejects DNS-rebound status and operation reads before private service calls", async () => {
    await replaceRouteApp({ allowedHosts: true });
    const headers = { host: "rebind.attacker.example:8504" };

    const responses = await Promise.all([
      app.inject({ method: "GET", url: "/api/safe-tunnel/status", headers }),
      app.inject({
        method: "GET",
        url: "/api/safe-tunnel/operations/op_1",
        headers,
      }),
    ]);

    for (const response of responses) {
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ error: "Request forbidden." });
      expect(response.headers["cache-control"]).toBe("no-store");
    }
    expect(service.status).not.toHaveBeenCalled();
    expect(service.operation).not.toHaveBeenCalled();
  });

  it("fails read trust closed when persisted registration lookup fails", async () => {
    service.registeredPublicOrigin.mockRejectedValueOnce(
      new Error("private persisted-state failure"),
    );

    const response = await app.inject({
      method: "GET",
      url: "/api/safe-tunnel/status",
      headers: { host: "registered.tunnels.pi-web.dev" },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: "Request forbidden." });
    expect(response.body).not.toContain("private persisted-state failure");
    expect(service.status).not.toHaveBeenCalled();
  });

  it("rejects a trusted Host paired with an untrusted Origin", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/safe-tunnel/enable",
      headers: {
        ...acceptedMutationHeaders,
        host: "127.0.0.1:8504",
        origin: "http://rebind.attacker.example:8504",
      },
      payload: {},
    });

    expect(response.statusCode).toBe(403);
    expect(service.enable).not.toHaveBeenCalled();
  });

  it("rejects cross-site, originless, simple, and bodyless mutations before service calls", async () => {
    const hostileOrigin = "https://hostile.example.test";
    const responses = await Promise.all([
      app.inject({
        method: "POST",
        url: "/api/safe-tunnel/enable",
        headers: {
          "content-type": "text/plain",
          origin: hostileOrigin,
          "sec-fetch-site": "cross-site",
        },
        payload: "{}",
      }),
      app.inject({
        method: "POST",
        url: "/api/safe-tunnel/disable",
        headers: {
          [SAFE_TUNNEL_MUTATION_HEADER_NAME]: SAFE_TUNNEL_MUTATION_HEADER_VALUE,
          "content-type": "application/json",
          origin: hostileOrigin,
          "sec-fetch-site": "cross-site",
        },
        payload: {},
      }),
      app.inject({
        method: "POST",
        url: "/api/safe-tunnel/disable",
        headers: {
          [SAFE_TUNNEL_MUTATION_HEADER_NAME]: SAFE_TUNNEL_MUTATION_HEADER_VALUE,
          "sec-fetch-site": "same-origin",
        },
        payload: {},
      }),
      app.inject({
        method: "POST",
        url: "/api/safe-tunnel/disable",
        headers: acceptedMutationHeaders,
      }),
      app.inject({
        method: "POST",
        url: "/api/safe-tunnel/disable",
        headers: {
          "content-type": "text/plain",
          origin: "http://localhost",
          "sec-fetch-site": "same-origin",
        },
        payload: "{}",
      }),
    ]);

    for (const response of responses) {
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ error: "Request forbidden." });
      expect(response.headers["cache-control"]).toBe("no-store");
    }
    expect(service.enable).not.toHaveBeenCalled();
    expect(service.disable).not.toHaveBeenCalled();
  });

  it("returns the complete enable response when HTTP compression is negotiated", async () => {
    const enableResponse: SafeTunnelEnableResponse = {
      ...service.enableResponse,
      operation: {
        ...service.enableResponse.operation,
        error: "Safe Tunnel progress\n".repeat(100),
      },
    };
    service.enable.mockResolvedValueOnce(enableResponse);

    const response = await app.inject({
      method: "POST",
      url: "/api/safe-tunnel/enable",
      headers: { ...acceptedMutationHeaders, "accept-encoding": "gzip" },
      payload: {},
    });

    expect(response.statusCode).toBe(202);
    expect(response.headers["content-encoding"]).toBe("gzip");
    expect(JSON.parse(gunzipSync(response.rawPayload).toString("utf8"))).toEqual(
      enableResponse,
    );
  });

  it("accepts only explicit advanced development and self-hosting overrides", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/safe-tunnel/enable",
      headers: acceptedMutationHeaders,
      payload: {
        advanced: {
          controlApiUrl: " http://127.0.0.1:8787 ",
          machineName: " Dev Box ",
          machineSlug: " dev-box ",
          localPiWebUrl: " http://127.0.0.1:8504 ",
          frpcPath: " /opt/frpc ",
        },
      },
    });

    expect(response.statusCode).toBe(202);
    expect(service.enable).toHaveBeenCalledWith({
      advanced: {
        controlApiUrl: "http://127.0.0.1:8787",
        machineName: "Dev Box",
        machineSlug: "dev-box",
        localPiWebUrl: "http://127.0.0.1:8504",
        frpcPath: "/opt/frpc",
      },
    });
  });

  it("rejects legacy fields, malformed bodies, and malformed overrides", async () => {
    const legacy = await app.inject({
      method: "POST",
      url: "/api/safe-tunnel/enable",
      headers: acceptedMutationHeaders,
      payload: { controlApiUrl: "https://control.example.test" },
    });
    const malformedBody = await app.inject({
      method: "POST",
      url: "/api/safe-tunnel/enable",
      headers: acceptedMutationHeaders,
      payload: [],
    });
    const malformedOverride = await app.inject({
      method: "POST",
      url: "/api/safe-tunnel/enable",
      headers: acceptedMutationHeaders,
      payload: { advanced: { machineSlug: "" } },
    });
    const oversizedOverride = await app.inject({
      method: "POST",
      url: "/api/safe-tunnel/enable",
      headers: acceptedMutationHeaders,
      payload: { advanced: { machineName: "x".repeat(81) } },
    });

    expect(legacy.statusCode).toBe(400);
    expect(legacy.json()).toEqual({
      error: "Safe Tunnel enable request contains an unsupported field",
    });
    expect(malformedBody.statusCode).toBe(400);
    expect(malformedBody.json()).toEqual({
      error: "Safe Tunnel enable request body must be an object",
    });
    expect(malformedOverride.statusCode).toBe(400);
    expect(malformedOverride.json()).toEqual({
      error: "Safe Tunnel advanced machineSlug must be a non-empty string",
    });
    expect(oversizedOverride.statusCode).toBe(400);
    expect(oversizedOverride.json()).toEqual({
      error: "Safe Tunnel advanced machineName is too long",
    });
    expect(service.enable).not.toHaveBeenCalled();
  });

  it("disables the flow and looks up tracked operation progress", async () => {
    const disabled = await app.inject({
      method: "POST",
      url: "/api/safe-tunnel/disable",
      headers: acceptedMutationHeaders,
      payload: {},
    });
    const operation = await app.inject({
      method: "GET",
      url: "/api/safe-tunnel/operations/op_1",
    });
    const missing = await app.inject({
      method: "GET",
      url: "/api/safe-tunnel/operations/missing",
    });

    expect(disabled.statusCode).toBe(200);
    expect(disabled.json<SafeTunnelDisableResponse>()).toEqual(
      service.disableResponse,
    );
    expect(service.disable).toHaveBeenCalledOnce();
    expect(operation.json<SafeTunnelOperationResponse>()).toEqual(
      service.operationResponse,
    );
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: "Safe Tunnel operation not found" });
  });

  it("does not expose legacy or machine-scoped routes", async () => {
    const probes = [
      { method: "POST", url: "/api/safe-tunnel/login" },
      { method: "POST", url: "/api/safe-tunnel/start" },
      { method: "POST", url: "/api/safe-tunnel/stop" },
      { method: "GET", url: "/api/machines/local/safe-tunnel/status" },
    ] as const;

    for (const probe of probes) {
      const response = await app.inject(probe);
      expect(response.statusCode).toBe(404);
    }
  });

  it("maps explicit operation conflicts to a bounded public response", async () => {
    service.enable.mockRejectedValueOnce(
      new SafeTunnelOperationConflictError("already_enabled"),
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/safe-tunnel/enable",
      headers: acceptedMutationHeaders,
      payload: {},
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: "Safe Tunnel is already enabled." });
  });

  it("does not expose unexpected transport or provider failures", async () => {
    const secret = "machineToken=piwt_mtok_v1_private provider-body=private";
    service.status.mockRejectedValueOnce(new Error(secret));
    service.enable.mockRejectedValueOnce(new Error(secret));
    service.disable.mockRejectedValueOnce(new Error(secret));
    service.operation.mockImplementationOnce(() => {
      throw new Error(secret);
    });

    const responses = await Promise.all([
      app.inject({ method: "GET", url: "/api/safe-tunnel/status" }),
      app.inject({
        method: "POST",
        url: "/api/safe-tunnel/enable",
        headers: acceptedMutationHeaders,
        payload: {},
      }),
      app.inject({
        method: "POST",
        url: "/api/safe-tunnel/disable",
        headers: acceptedMutationHeaders,
        payload: {},
      }),
      app.inject({ method: "GET", url: "/api/safe-tunnel/operations/op_1" }),
    ]);

    for (const response of responses) {
      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({ error: "Safe Tunnel request failed." });
      expect(response.body).not.toContain(secret);
    }
  });
});

async function createRouteApp(
  mutationHostConfig: SafeTunnelMutationHostConfig = {},
): Promise<FastifyInstance> {
  const routeApp = Fastify({ logger: false });
  await routeApp.register(fastifyCompress, {
    globalCompression: true,
    globalDecompression: false,
    threshold: 1024,
  });
  registerSafeTunnelRoutes(routeApp, service, mutationHostConfig);
  await routeApp.ready();
  return routeApp;
}

async function replaceRouteApp(
  mutationHostConfig: SafeTunnelMutationHostConfig,
): Promise<void> {
  await app.close();
  app = await createRouteApp(mutationHostConfig);
}

class FakeSafeTunnelRouteService implements SafeTunnelRouteService {
  registeredPublicOriginValue: string | undefined;

  readonly operationResponse: SafeTunnelOperationResponse = {
    id: "op_1",
    kind: "enable",
    phase: "awaiting_approval",
    status: "running",
    userCode: "ABCD-EFGH",
    verificationUriComplete:
      "https://control.example.test/device?user_code=ABCD-EFGH",
  };

  readonly statusResponse: SafeTunnelStatusResponse = {
    config: {
      exists: false,
      state: "missing",
    },
    desiredState: "disabled",
    runtime: { state: "stopped" },
  };

  readonly enableResponse: SafeTunnelEnableResponse = {
    accepted: true,
    operation: this.operationResponse,
    status: { ...this.statusResponse, activeOperation: this.operationResponse },
  };

  readonly disableResponse: SafeTunnelDisableResponse = {
    status: this.statusResponse,
  };

  readonly disable = vi.fn<() => Promise<SafeTunnelDisableResponse>>(() =>
    Promise.resolve(this.disableResponse));
  readonly enable = vi.fn<
    (request: SafeTunnelEnableRequest) => Promise<SafeTunnelEnableResponse>
  >(() => Promise.resolve(this.enableResponse));
  readonly operation = vi.fn<
    (operationId: string) => SafeTunnelOperationResponse | undefined
  >((operationId) => operationId === "op_1" ? this.operationResponse : undefined);
  readonly registeredPublicOrigin = vi.fn<() => Promise<string | undefined>>(() =>
    Promise.resolve(this.registeredPublicOriginValue));
  readonly status = vi.fn<() => Promise<SafeTunnelStatusResponse>>(() =>
    Promise.resolve(this.statusResponse));
}
