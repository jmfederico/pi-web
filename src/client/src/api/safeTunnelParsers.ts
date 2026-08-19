import type {
  SafeTunnelConfigState,
  SafeTunnelConfigStatus,
  SafeTunnelDisableResponse,
  SafeTunnelEnableResponse,
  SafeTunnelOperationPhase,
  SafeTunnelOperationResponse,
  SafeTunnelOperationStatus,
  SafeTunnelRuntimeDiagnosticCode,
  SafeTunnelRuntimeState,
  SafeTunnelRuntimeStatus,
  SafeTunnelStatusResponse,
} from "../../../shared/apiTypes";
import type { SafeTunnelDesiredState } from "../../../shared/safeTunnelTypes";
import { isSafeTunnelControlApiTransportAllowed } from "../../../shared/safeTunnelUrlPolicy";

const maximumDiagnosticCharacters = 2_000;
const maximumIdentifierCharacters = 256;
const maximumUrlCharacters = 2_048;

export function parseSafeTunnelStatusResponse(value: unknown): SafeTunnelStatusResponse {
  const record = requireRecord(value);
  const activeOperation = record["activeOperation"] === undefined
    ? undefined
    : parseSafeTunnelOperationResponse(record["activeOperation"]);
  return {
    config: parseSafeTunnelConfigStatus(record["config"]),
    desiredState: requireSafeTunnelDesiredState(record, "desiredState"),
    runtime: parseSafeTunnelRuntimeStatus(record["runtime"]),
    ...(activeOperation === undefined ? {} : { activeOperation }),
  };
}

export function parseSafeTunnelEnableResponse(value: unknown): SafeTunnelEnableResponse {
  const record = requireRecord(value);
  if (record["accepted"] !== true) throw new Error("Expected Safe Tunnel enable accepted response");
  return {
    accepted: true,
    operation: parseSafeTunnelOperationResponse(record["operation"]),
    status: parseSafeTunnelStatusResponse(record["status"]),
  };
}

export function parseSafeTunnelOperationResponse(value: unknown): SafeTunnelOperationResponse {
  const record = requireRecord(value);
  const error = optionalString(record, "error", maximumDiagnosticCharacters);
  const publicUrl = optionalHttpUrl(record, "publicUrl");
  const userCode = optionalString(record, "userCode", maximumIdentifierCharacters);
  const verificationUriComplete = optionalSafeControlApiUrl(
    record,
    "verificationUriComplete",
  );
  return {
    id: requireString(record, "id", maximumIdentifierCharacters),
    kind: requireSafeTunnelOperationKind(record, "kind"),
    phase: requireSafeTunnelOperationPhase(record, "phase"),
    status: requireSafeTunnelOperationStatus(record, "status"),
    ...(error === undefined ? {} : { error }),
    ...(publicUrl === undefined ? {} : { publicUrl }),
    ...(userCode === undefined ? {} : { userCode }),
    ...(verificationUriComplete === undefined ? {} : { verificationUriComplete }),
  };
}

export function parseSafeTunnelDisableResponse(value: unknown): SafeTunnelDisableResponse {
  const record = requireRecord(value);
  return { status: parseSafeTunnelStatusResponse(record["status"]) };
}

function parseSafeTunnelConfigStatus(value: unknown): SafeTunnelConfigStatus {
  const record = requireRecord(value);
  const localPiWebUrl = optionalHttpUrl(record, "localPiWebUrl");
  const frpcPathConfigured = optionalBoolean(record, "frpcPathConfigured");
  const machine = record["machine"] === undefined
    ? undefined
    : parseSafeTunnelConfigMachine(record["machine"]);
  const error = optionalString(record, "error", maximumDiagnosticCharacters);
  return {
    exists: requireBoolean(record, "exists"),
    state: requireSafeTunnelConfigState(record, "state"),
    ...(localPiWebUrl === undefined ? {} : { localPiWebUrl }),
    ...(frpcPathConfigured === undefined ? {} : { frpcPathConfigured }),
    ...(machine === undefined ? {} : { machine }),
    ...(error === undefined ? {} : { error }),
  };
}

function parseSafeTunnelConfigMachine(value: unknown): NonNullable<SafeTunnelConfigStatus["machine"]> {
  const record = requireRecord(value);
  const machineSlug = optionalString(record, "machineSlug", maximumIdentifierCharacters);
  const publicHostname = optionalString(record, "publicHostname", maximumIdentifierCharacters);
  const publicUrl = optionalHttpUrl(record, "publicUrl");
  return {
    controlApiBaseUrl: requireSafeControlApiUrl(record, "controlApiBaseUrl"),
    machineId: requireString(record, "machineId", maximumIdentifierCharacters),
    ...(machineSlug === undefined ? {} : { machineSlug }),
    ...(publicHostname === undefined ? {} : { publicHostname }),
    ...(publicUrl === undefined ? {} : { publicUrl }),
  };
}

function parseSafeTunnelRuntimeStatus(value: unknown): SafeTunnelRuntimeStatus {
  const record = requireRecord(value);
  const diagnosticCode = optionalSafeTunnelRuntimeDiagnosticCode(record, "diagnosticCode");
  const error = optionalString(record, "error", maximumDiagnosticCharacters);
  return {
    state: requireSafeTunnelRuntimeState(record, "state"),
    ...(diagnosticCode === undefined ? {} : { diagnosticCode }),
    ...(error === undefined ? {} : { error }),
  };
}

function requireSafeTunnelConfigState(record: Record<string, unknown>, key: string): SafeTunnelConfigState {
  const value = requireString(record, key);
  if (value !== "missing" && value !== "unregistered" && value !== "registered" && value !== "rejected" && value !== "invalid") {
    throw new Error(`Expected Safe Tunnel config state field: ${key}`);
  }
  return value;
}

function requireSafeTunnelDesiredState(record: Record<string, unknown>, key: string): SafeTunnelDesiredState {
  const value = requireString(record, key);
  if (value !== "enabled" && value !== "disabled") throw new Error(`Expected Safe Tunnel desired state field: ${key}`);
  return value;
}

function requireSafeTunnelRuntimeState(record: Record<string, unknown>, key: string): SafeTunnelRuntimeState {
  const value = requireString(record, key);
  if (value !== "stopped" && value !== "running" && value !== "unknown") throw new Error(`Expected Safe Tunnel runtime state field: ${key}`);
  return value;
}

function optionalSafeTunnelRuntimeDiagnosticCode(
  record: Record<string, unknown>,
  key: string,
): SafeTunnelRuntimeDiagnosticCode | undefined {
  const value = optionalString(record, key);
  if (value === undefined) return undefined;
  if (value !== "credentials_rejected"
    && value !== "heartbeat_failed"
    && value !== "registration_required"
    && value !== "runtime_failed"
    && value !== "state_invalid") {
    throw new Error(`Expected Safe Tunnel runtime diagnostic field: ${key}`);
  }
  return value;
}

function requireSafeTunnelOperationKind(record: Record<string, unknown>, key: string): "enable" {
  const value = requireString(record, key);
  if (value !== "enable") throw new Error(`Expected Safe Tunnel operation kind field: ${key}`);
  return value;
}

function requireSafeTunnelOperationPhase(record: Record<string, unknown>, key: string): SafeTunnelOperationPhase {
  const value = requireString(record, key);
  if (value !== "preparing"
    && value !== "awaiting_approval"
    && value !== "registering"
    && value !== "starting"
    && value !== "enabled") {
    throw new Error(`Expected Safe Tunnel operation phase field: ${key}`);
  }
  return value;
}

function requireSafeTunnelOperationStatus(record: Record<string, unknown>, key: string): SafeTunnelOperationStatus {
  const value = requireString(record, key);
  if (value !== "running" && value !== "succeeded" && value !== "failed" && value !== "cancelled") {
    throw new Error(`Expected Safe Tunnel operation status field: ${key}`);
  }
  return value;
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Expected object response");
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(
  record: Record<string, unknown>,
  key: string,
  maximumCharacters = maximumIdentifierCharacters,
): string {
  const value = record[key];
  if (typeof value !== "string" || value.length > maximumCharacters) {
    throw new Error(`Expected bounded string field: ${key}`);
  }
  return value;
}

function optionalString(
  record: Record<string, unknown>,
  key: string,
  maximumCharacters = maximumIdentifierCharacters,
): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > maximumCharacters) {
    throw new Error(`Expected bounded optional string field: ${key}`);
  }
  return value;
}

function requireHttpUrl(record: Record<string, unknown>, key: string): string {
  return requireSafeBrowserUrl(requireString(record, key, maximumUrlCharacters), key);
}

function optionalHttpUrl(record: Record<string, unknown>, key: string): string | undefined {
  const value = optionalString(record, key, maximumUrlCharacters);
  return value === undefined ? undefined : requireSafeBrowserUrl(value, key);
}

function requireSafeControlApiUrl(record: Record<string, unknown>, key: string): string {
  return requireSafeControlApiTransport(requireHttpUrl(record, key), key);
}

function optionalSafeControlApiUrl(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = optionalHttpUrl(record, key);
  return value === undefined ? undefined : requireSafeControlApiTransport(value, key);
}

function requireSafeControlApiTransport(value: string, key: string): string {
  if (!isSafeTunnelControlApiTransportAllowed(new URL(value))) {
    throw new Error(`Expected secure Control API URL field: ${key}`);
  }
  return value;
}

function requireSafeBrowserUrl(value: string, key: string): string {
  if (value.length > maximumUrlCharacters) {
    throw new Error(`Expected bounded HTTP(S) URL field: ${key}`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Expected HTTP(S) URL field: ${key}`);
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:")
    || url.username !== ""
    || url.password !== "") {
    throw new Error(`Expected HTTP(S) URL field: ${key}`);
  }
  return value;
}

function requireBoolean(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  if (typeof value !== "boolean") throw new Error(`Expected boolean field: ${key}`);
  return value;
}

function optionalBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`Expected optional boolean field: ${key}`);
  return value;
}
