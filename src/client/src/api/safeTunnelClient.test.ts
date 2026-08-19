import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SAFE_TUNNEL_MUTATION_HEADER_NAME,
  SAFE_TUNNEL_MUTATION_HEADER_VALUE,
} from "../../../shared/safeTunnelHttp";
import { safeTunnelApi } from "./safeTunnelClient";

beforeEach(() => {
  vi.stubGlobal("document", { baseURI: "https://pi.example.test/nested/" });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Safe Tunnel browser API", () => {
  it("uses only gateway-local application-relative routes", async () => {
    const status = statusResponse();
    const operation = operationResponse();
    const enabled = { accepted: true, operation, status: { ...status, activeOperation: operation } };
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(jsonResponse(status))
      .mockResolvedValueOnce(jsonResponse(enabled))
      .mockResolvedValueOnce(jsonResponse({ status }))
      .mockResolvedValueOnce(jsonResponse(operation));
    vi.stubGlobal("fetch", fetchMock);

    await expect(safeTunnelApi.status()).resolves.toEqual(status);
    await expect(safeTunnelApi.enable({
      advanced: { controlApiUrl: "http://127.0.0.1:8787", frpcPath: "/opt/frpc" },
    })).resolves.toEqual(enabled);
    await expect(safeTunnelApi.disable()).resolves.toEqual({ status });
    await expect(safeTunnelApi.operation("op / 1")).resolves.toEqual(operation);

    expect(fetchMock.mock.calls.map(fetchUrl)).toEqual([
      "https://pi.example.test/api/safe-tunnel/status",
      "https://pi.example.test/api/safe-tunnel/enable",
      "https://pi.example.test/api/safe-tunnel/disable",
      "https://pi.example.test/api/safe-tunnel/operations/op%20%2F%201",
    ]);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ cache: "no-store" });
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: "POST" });
    expect(requestHeaders(fetchMock.mock.calls[1]?.[1]).get("content-type"))
      .toBe("application/json");
    expect(
      requestHeaders(fetchMock.mock.calls[1]?.[1]).get(
        SAFE_TUNNEL_MUTATION_HEADER_NAME,
      ),
    ).toBe(SAFE_TUNNEL_MUTATION_HEADER_VALUE);
    expect(JSON.parse(requestBody(fetchMock.mock.calls[1]?.[1]))).toEqual({
      advanced: { controlApiUrl: "http://127.0.0.1:8787", frpcPath: "/opt/frpc" },
    });
    expect(fetchMock.mock.calls[2]?.[1]).toMatchObject({ method: "POST" });
    expect(requestHeaders(fetchMock.mock.calls[2]?.[1]).get("content-type"))
      .toBe("application/json");
    expect(
      requestHeaders(fetchMock.mock.calls[2]?.[1]).get(
        SAFE_TUNNEL_MUTATION_HEADER_NAME,
      ),
    ).toBe(SAFE_TUNNEL_MUTATION_HEADER_VALUE);
    expect(JSON.parse(requestBody(fetchMock.mock.calls[2]?.[1]))).toEqual({});
    expect(fetchMock.mock.calls[3]?.[1]).toMatchObject({ cache: "no-store" });
  });
});

function statusResponse() {
  return {
    config: {
      exists: false,
      state: "missing",
      frpcPathConfigured: false,
    },
    desiredState: "disabled",
    runtime: { state: "stopped" },
  };
}

function operationResponse() {
  return {
    id: "op / 1",
    kind: "enable",
    phase: "starting",
    status: "running",
  };
}

function fetchUrl([input]: [input: RequestInfo | URL, init?: RequestInit | undefined]): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

function requestHeaders(init: RequestInit | undefined): Headers {
  return new Headers(init?.headers);
}

function requestBody(init: RequestInit | undefined): string {
  const body = init?.body;
  if (typeof body !== "string") throw new Error("Expected JSON request body");
  return body;
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
