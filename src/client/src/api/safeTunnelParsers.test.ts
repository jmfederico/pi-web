import { describe, expect, it } from "vitest";
import {
  parseSafeTunnelDisableResponse,
  parseSafeTunnelEnableResponse,
  parseSafeTunnelOperationResponse,
  parseSafeTunnelStatusResponse,
} from "./safeTunnelParsers";

describe("Safe Tunnel API parsers", () => {
  it("parses only the allowlisted status and approval fields", () => {
    const operation = operationResponse();
    const status = statusResponse(operation);

    expect(parseSafeTunnelStatusResponse({
      ...status,
      rawProviderBody: "not exposed",
      runtime: {
        ...status.runtime,
        logTail: "raw child output",
        frpcConfigPath: "/private/frpc.toml",
      },
    })).toEqual(status);
    expect(parseSafeTunnelEnableResponse({ accepted: true, operation, status })).toEqual({
      accepted: true,
      operation,
      status,
    });
    expect(parseSafeTunnelDisableResponse({ status })).toEqual({ status });
  });

  it("rejects malformed state, operation, and diagnostic enums", () => {
    expect(() => parseSafeTunnelStatusResponse({
      config: { exists: false, state: "missing" },
      desiredState: "disabled",
      runtime: { state: "stale" },
    })).toThrow("Expected Safe Tunnel runtime state field: state");
    expect(() => parseSafeTunnelStatusResponse({
      config: { exists: false, state: "missing" },
      desiredState: "sometimes",
      runtime: { state: "stopped" },
    })).toThrow("Expected Safe Tunnel desired state field: desiredState");
    expect(() => parseSafeTunnelOperationResponse({
      ...operationResponse(),
      phase: "future",
    })).toThrow("Expected Safe Tunnel operation phase field: phase");
    expect(() => parseSafeTunnelStatusResponse({
      ...statusResponse(),
      runtime: { state: "stopped", diagnosticCode: "provider_secret" },
    })).toThrow("Expected Safe Tunnel runtime diagnostic field: diagnosticCode");
  });

  it("bounds authored diagnostics, identifiers, and browser URLs", () => {
    const longApprovalUrl = httpUrlWithLength(320);
    expect(parseSafeTunnelOperationResponse({
      ...operationResponse(),
      verificationUriComplete: longApprovalUrl,
    }).verificationUriComplete).toBe(longApprovalUrl);

    expect(() => parseSafeTunnelStatusResponse({
      ...statusResponse(),
      runtime: { state: "stopped", error: "x".repeat(2_001) },
    })).toThrow("bounded optional string field: error");
    expect(() => parseSafeTunnelOperationResponse({
      ...operationResponse(),
      id: "x".repeat(257),
    })).toThrow("bounded string field: id");
    expect(() => parseSafeTunnelOperationResponse({
      ...operationResponse(),
      verificationUriComplete: httpUrlWithLength(2_049),
    })).toThrow("bounded optional string field: verificationUriComplete");
    expect(() => parseSafeTunnelOperationResponse({
      ...operationResponse(),
      verificationUriComplete: "http://approval.example.test/device",
    })).toThrow("secure Control API URL field");
  });

  it("requires accepted responses and typed optional fields", () => {
    expect(() => parseSafeTunnelEnableResponse({ accepted: false }))
      .toThrow("Expected Safe Tunnel enable accepted response");
    expect(() => parseSafeTunnelStatusResponse({
      config: { exists: false, state: "missing", frpcPathConfigured: "no" },
      desiredState: "disabled",
      runtime: { state: "stopped" },
    })).toThrow("Expected optional boolean field: frpcPathConfigured");
    expect(() => parseSafeTunnelOperationResponse({
      ...operationResponse(),
      verificationUriComplete: "javascript:alert(1)",
    })).toThrow("Expected HTTP(S) URL field: verificationUriComplete");
  });
});

function httpUrlWithLength(length: number): string {
  const prefix = "https://control.example.test/device?token=";
  return `${prefix}${"x".repeat(length - prefix.length)}`;
}

function operationResponse() {
  return {
    id: "op_1",
    kind: "enable",
    phase: "awaiting_approval",
    status: "running",
    userCode: "ABCD-EFGH",
    verificationUriComplete: "https://control.example.test/device?user_code=ABCD-EFGH",
  };
}

function statusResponse(activeOperation = operationResponse()) {
  return {
    config: {
      exists: true,
      state: "registered",
      localPiWebUrl: "http://127.0.0.1:8504",
      frpcPathConfigured: false,
      machine: {
        controlApiBaseUrl: "https://control.example.test",
        machineId: "machine_1",
        machineSlug: "dev-box",
        publicHostname: "dev-box.example.test",
        publicUrl: "https://dev-box.example.test",
      },
    },
    desiredState: "enabled",
    runtime: {
      state: "stopped",
      diagnosticCode: "credentials_rejected",
      error: "Safe Tunnel approval was rejected or revoked.",
    },
    activeOperation,
  };
}
