import { describe, expect, it, vi } from "vitest";
import {
  HttpSafeTunnelControlPlane,
  SafeTunnelControlPlaneError,
  safeTunnelClientVersion,
  type SafeTunnelFetch,
} from "./safeTunnelControlPlane.js";

const controlApiBaseUrl = "https://control.example.test";
const connectorAccessToken = "piwt_ctok_v1_connector";
const machineToken = "piwt_mtok_v1_machine";

describe("HttpSafeTunnelControlPlane", () => {
  it("starts and completes the ordinary device approval flow", async () => {
    const transport = sequencedFetch([
      jsonResponse(202, startedAuthorization()),
      jsonResponse(409, { error: { code: "authorization_pending" } }),
      jsonResponse(200, approvedAuthorization()),
    ]);
    const controlPlane = new HttpSafeTunnelControlPlane({ fetch: transport.fetch });

    await expect(controlPlane.startDeviceAuthorization({
      controlApiBaseUrl,
      clientVersion: safeTunnelClientVersion,
    })).resolves.toEqual(startedAuthorization());
    await expect(controlPlane.completeDeviceAuthorization({
      controlApiBaseUrl,
      deviceCode: "device-code-private",
    })).resolves.toEqual({ kind: "pending" });
    await expect(controlPlane.completeDeviceAuthorization({
      controlApiBaseUrl,
      deviceCode: "device-code-private",
    })).resolves.toEqual({
      kind: "approved",
      authorization: {
        accessToken: connectorAccessToken,
        expiresAt: "2030-01-01T01:00:00.000Z",
        account: { id: "account_123", publicNamespace: "account" },
      },
    });

    expect(transport.requests.map((request) => request.input)).toEqual([
      `${controlApiBaseUrl}/v1/device/start`,
      `${controlApiBaseUrl}/v1/device/complete`,
      `${controlApiBaseUrl}/v1/device/complete`,
    ]);
    expect(transport.requests[0]?.init.body).toBe(JSON.stringify({
      connectorVersion: safeTunnelClientVersion,
    }));
    expect(transport.requests[1]?.init.body).toBe(JSON.stringify({
      deviceCode: "device-code-private",
    }));
  });

  it("parses device-completion 429 envelopes as polling control flow before generic mapping", async () => {
    const secret = "raw-provider-secret";
    const transport = sequencedFetch([
      jsonResponse(429, { error: { code: "slow_down", message: secret } }, { "retry-after": "7" }),
      jsonResponse(429, { error: { code: "rate_limit_exceeded", message: secret } }, { "retry-after": "4" }),
      jsonResponse(429, { error: { code: "slow_down", message: secret } }),
      jsonResponse(429, { error: { code: "slow_down", message: secret } }, { "retry-after": "soon" }),
    ]);
    const controlPlane = new HttpSafeTunnelControlPlane({ fetch: transport.fetch });
    const complete = () => controlPlane.completeDeviceAuthorization({
      controlApiBaseUrl,
      deviceCode: "device-code-private",
    });

    await expect(complete()).resolves.toEqual({ kind: "slow_down", retryAfterSeconds: 7 });

    const rateLimited = await complete().then(
      () => { throw new Error("expected rate_limit_exceeded rejection"); },
      (error: unknown) => error,
    );
    expect(rateLimited).toBeInstanceOf(SafeTunnelControlPlaneError);
    expect(rateLimited).toMatchObject({
      code: "rate_limited",
      operation: "complete_device_authorization",
      retryAfterSeconds: 4,
    });
    expect(String(rateLimited) + JSON.stringify(rateLimited)).not.toContain(secret);

    // A slow_down without a trustworthy positive-integer Retry-After is not
    // control flow; the owner must not guess a delay.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const untrusted = await complete().then(
        () => { throw new Error("expected slow_down rejection"); },
        (error: unknown) => error,
      );
      if (!(untrusted instanceof SafeTunnelControlPlaneError)) {
        throw new Error("expected SafeTunnelControlPlaneError");
      }
      expect(untrusted.code).toBe("rate_limited");
      expect(untrusted.retryAfterSeconds).toBeUndefined();
    }
  });

  it("maps hosted device-completion terminal codes before generic HTTP mapping", async () => {
    const transport = sequencedFetch([
      jsonResponse(400, { error: { code: "device_code_expired" } }),
      jsonResponse(403, { error: { code: "authorization_denied" } }),
      jsonResponse(400, { error: { code: "invalid_device_code" } }),
      jsonResponse(409, { error: { code: "device_authorization_completed" } }),
    ]);
    const controlPlane = new HttpSafeTunnelControlPlane({ fetch: transport.fetch });
    const complete = () => controlPlane.completeDeviceAuthorization({
      controlApiBaseUrl,
      deviceCode: "device-code-private",
    });

    await expect(complete()).rejects.toMatchObject({
      code: "authorization_expired",
      operation: "complete_device_authorization",
    });
    await expect(complete()).rejects.toMatchObject({ code: "authorization_denied" });
    await expect(complete()).rejects.toMatchObject({ code: "request_rejected" });
    await expect(complete()).rejects.toMatchObject({ code: "conflict" });
  });

  it("registers one machine and preserves bearer credentials exactly in the request", async () => {
    const transport = sequencedFetch([jsonResponse(201, registeredMachine())]);
    const controlPlane = new HttpSafeTunnelControlPlane({ fetch: transport.fetch });

    await expect(controlPlane.registerMachine({
      controlApiBaseUrl,
      connectorAccessToken,
      machineName: "Dev Box",
      machineSlug: "dev-box",
      localPiWebUrl: "http://127.0.0.1:8504",
      clientVersion: safeTunnelClientVersion,
    })).resolves.toEqual({
      machine: {
        id: "machine_123",
        accountId: "account_123",
        name: "Dev Box",
        slug: "dev-box",
      },
      publicHostname: "dev-box.example.test",
      publicUrl: "https://dev-box.example.test",
      machineToken,
    });
    expect(transport.requests[0]).toMatchObject({
      input: `${controlApiBaseUrl}/v1/machines`,
      init: {
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${connectorAccessToken}`,
          "content-type": "application/json",
        },
        redirect: "error",
      },
    });
  });

  it("fetches tunnel config and records sustained heartbeat inputs", async () => {
    const transport = sequencedFetch([
      jsonResponse(200, tunnelConfigResponse()),
      jsonResponse(202, heartbeatResponse()),
    ]);
    const controlPlane = new HttpSafeTunnelControlPlane({ fetch: transport.fetch });
    const credentials = {
      controlApiBaseUrl,
      machineId: "machine_123",
      machineToken,
    };

    await expect(controlPlane.getMachineTunnelConfig(credentials)).resolves.toEqual({
      machineId: "machine_123",
      publicHostname: "dev-box.example.test",
      publicUrl: "https://dev-box.example.test",
      localPiWebUrl: "http://127.0.0.1:8504",
      proxyName: "account-machine",
      frpcConfigToml: "[[proxies]]\n",
    });
    await expect(controlPlane.recordMachineHeartbeat(credentials, {
      clientVersion: safeTunnelClientVersion,
      tunnelStatus: "error",
      errorMessage: "PI WEB Safe Tunnel runtime is unavailable.",
    })).resolves.toEqual({
      machineId: "machine_123",
      lastSeenAt: "2030-01-01T00:00:00.000Z",
      nextHeartbeatSeconds: 30,
    });

    expect(transport.requests[0]?.init.headers).toMatchObject({
      authorization: `Bearer ${machineToken}`,
    });
    expect(transport.requests[1]?.init.body).toBe(JSON.stringify({
      connectorVersion: safeTunnelClientVersion,
      tunnelStatus: "error",
      errorMessage: "PI WEB Safe Tunnel runtime is unavailable.",
    }));
  });

  it("rejects malformed response shape, insecure public URLs, and oversized bodies", async () => {
    const malformed = new HttpSafeTunnelControlPlane({
      fetch: () => Promise.resolve(jsonResponse(202, {
        ...startedAuthorization(),
        intervalSeconds: 0,
      })),
    });
    await expect(malformed.startDeviceAuthorization({
      controlApiBaseUrl,
      clientVersion: safeTunnelClientVersion,
    })).rejects.toMatchObject({ code: "invalid_response" });

    const insecure = new HttpSafeTunnelControlPlane({
      fetch: () => Promise.resolve(jsonResponse(201, {
        ...registeredMachine(),
        publicHostname: "dev-box.example.test",
        publicUrl: "http://dev-box.example.test",
      })),
    });
    await expect(insecure.registerMachine({
      controlApiBaseUrl,
      connectorAccessToken,
      machineName: "Dev Box",
      machineSlug: "dev-box",
      localPiWebUrl: "http://127.0.0.1:8504",
      clientVersion: safeTunnelClientVersion,
    })).rejects.toMatchObject({ code: "invalid_response" });

    const oversized = new HttpSafeTunnelControlPlane({
      fetch: () => Promise.resolve(new Response("x", {
        status: 202,
        headers: { "content-length": (128 * 1_024 + 1).toString() },
      })),
    });
    await expect(oversized.startDeviceAuthorization({
      controlApiBaseUrl,
      clientVersion: safeTunnelClientVersion,
    })).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("requires HTTPS except literal-loopback development before sending credentials", async () => {
    const fetch = vi.fn<SafeTunnelFetch>();
    const controlPlane = new HttpSafeTunnelControlPlane({ fetch });

    await expect(controlPlane.getMachineTunnelConfig({
      controlApiBaseUrl: "http://control.example.test",
      machineId: "machine_123",
      machineToken,
    })).rejects.toThrow("controlApiBaseUrl must use https");
    expect(fetch).not.toHaveBeenCalled();

    const loopback = new HttpSafeTunnelControlPlane({
      fetch: () => Promise.resolve(jsonResponse(200, tunnelConfigResponse({
        publicHostname: "127.0.0.1",
        publicUrl: "http://127.0.0.1:9443",
      }))),
    });
    await expect(loopback.getMachineTunnelConfig({
      controlApiBaseUrl: "http://127.0.0.1:9000",
      machineId: "machine_123",
      machineToken,
    })).resolves.toMatchObject({ publicUrl: "http://127.0.0.1:9443" });
  });

  it.each([
    [401, "authentication_failed"],
    [409, "conflict"],
    [429, "rate_limited"],
    [503, "service_unavailable"],
    [400, "request_rejected"],
  ] as const)("maps HTTP %i to %s without returning provider bodies", async (status, code) => {
    const secret = "raw-provider-secret";
    const controlPlane = new HttpSafeTunnelControlPlane({
      fetch: () => Promise.resolve(jsonResponse(status, {
        error: { code: "provider_internal", message: secret },
      })),
    });

    let observed: unknown;
    try {
      await controlPlane.startDeviceAuthorization({
        controlApiBaseUrl,
        clientVersion: safeTunnelClientVersion,
      });
    } catch (error: unknown) {
      observed = error;
    }
    expect(observed).toMatchObject({ code, operation: "start_device_authorization" });
    expect(String(observed) + JSON.stringify(observed)).not.toContain(secret);
  });

  it("times out and honours caller cancellation with a bounded transport error", async () => {
    let timeoutCallback = (): void => undefined;
    const pending = new HttpSafeTunnelControlPlane({
      fetch: () => new Promise<Response>(() => undefined),
      requestTimeoutMs: 10,
      scheduleTimeout: (callback) => {
        timeoutCallback = callback;
        return { cancel: () => undefined };
      },
    });
    const timedOut = pending.startDeviceAuthorization({
      controlApiBaseUrl,
      clientVersion: safeTunnelClientVersion,
    });
    timeoutCallback();
    await expect(timedOut).rejects.toMatchObject({ code: "transport_failed" });

    const controller = new AbortController();
    const cancelled = pending.startDeviceAuthorization({
      controlApiBaseUrl,
      clientVersion: safeTunnelClientVersion,
    }, { signal: controller.signal });
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ code: "transport_failed" });
  });

  it("rejects header-unsafe bearer credentials before constructing a request", async () => {
    const fetch = vi.fn<SafeTunnelFetch>();
    const controlPlane = new HttpSafeTunnelControlPlane({ fetch });

    await expect(controlPlane.getMachineTunnelConfig({
      controlApiBaseUrl,
      machineId: "machine_123",
      machineToken: "bad token\nvalue",
    })).rejects.toThrow("HTTP-header-safe bearer credential");
    expect(fetch).not.toHaveBeenCalled();
  });
});

function startedAuthorization() {
  return {
    deviceCode: "device-code-private",
    userCode: "ABCD-EFGH",
    verificationUri: "https://control.example.test/device",
    verificationUriComplete: "https://control.example.test/device?user_code=ABCD-EFGH",
    expiresAt: "2030-01-01T00:10:00.000Z",
    intervalSeconds: 5,
  };
}

function approvedAuthorization() {
  return {
    tokenType: "Bearer",
    accessToken: connectorAccessToken,
    expiresAt: "2030-01-01T01:00:00.000Z",
    account: { id: "account_123", publicNamespace: "account" },
  };
}

function registeredMachine() {
  return {
    machine: {
      id: "machine_123",
      accountId: "account_123",
      name: "Dev Box",
      slug: "dev-box",
    },
    publicHostname: "dev-box.example.test",
    publicUrl: "https://dev-box.example.test",
    tunnelConfigUrl: `${controlApiBaseUrl}/v1/machines/machine_123/tunnel-config`,
    machineToken,
  };
}

function tunnelConfigResponse(overrides: Record<string, unknown> = {}) {
  return {
    machine: { id: "machine_123" },
    publicHostname: "dev-box.example.test",
    publicUrl: "https://dev-box.example.test",
    localPiWebUrl: "http://127.0.0.1:8504",
    frp: {
      proxyName: "account-machine",
      configFormat: "toml",
      frpcConfigToml: "[[proxies]]\n",
    },
    ...overrides,
  };
}

function heartbeatResponse() {
  return {
    accepted: true,
    machine: {
      id: "machine_123",
      lastSeenAt: "2030-01-01T00:00:00.000Z",
    },
    nextHeartbeatSeconds: 30,
  };
}

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function sequencedFetch(responses: Response[]): {
  readonly fetch: SafeTunnelFetch;
  readonly requests: { readonly input: string; readonly init: RequestInit }[];
} {
  const requests: { input: string; init: RequestInit }[] = [];
  return {
    requests,
    fetch: (input, init) => {
      requests.push({ input, init });
      const response = responses.shift();
      return response === undefined
        ? Promise.reject(new Error("No fake response queued"))
        : Promise.resolve(response);
    },
  };
}
