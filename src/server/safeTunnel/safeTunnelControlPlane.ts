import { isSafeTunnelControlApiTransportAllowed } from "../../shared/safeTunnelUrlPolicy.js";
import {
  normalizeSafeTunnelControlApiBaseUrl,
  normalizeSafeTunnelLocalPiWebUrl,
  normalizeSafeTunnelPublicUrl,
  requireSafeTunnelBearerCredential,
  type SafeTunnelMachineCredentials,
} from "./safeTunnelState.js";

export const safeTunnelClientVersion = "pi-web-safe-tunnel/1";

const defaultControlApiRequestTimeoutMs = 15_000;
const maximumControlApiResponseBytes = 128 * 1_024;
const maximumIdentifierCharacters = 256;
const maximumNameCharacters = 256;
const maximumOpaqueTokenCharacters = 4_096;
const maximumUrlCharacters = 2_048;
const maximumFrpcConfigCharacters = 32_000;

export type SafeTunnelControlPlaneErrorCode =
  | "authentication_failed"
  | "authorization_denied"
  | "authorization_expired"
  | "conflict"
  | "invalid_response"
  | "rate_limited"
  | "request_rejected"
  | "service_unavailable"
  | "transport_failed";

export type SafeTunnelControlPlaneOperation =
  | "complete_device_authorization"
  | "get_tunnel_config"
  | "record_heartbeat"
  | "register_machine"
  | "start_device_authorization";

export class SafeTunnelControlPlaneError extends Error {
  constructor(
    readonly code: SafeTunnelControlPlaneErrorCode,
    readonly operation: SafeTunnelControlPlaneOperation,
    readonly retryAfterSeconds?: number,
  ) {
    super(controlPlaneErrorMessage(code, operation));
  }
}

export interface SafeTunnelDeviceAuthorization {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly verificationUri: string;
  readonly verificationUriComplete: string;
  readonly expiresAt: string;
  readonly intervalSeconds: number;
}

export interface SafeTunnelApprovedDeviceAuthorization {
  readonly accessToken: string;
  readonly expiresAt: string;
  readonly account: {
    readonly id: string;
    readonly publicNamespace: string;
  };
}

export type SafeTunnelDeviceAuthorizationCompletion =
  | { readonly kind: "approved"; readonly authorization: SafeTunnelApprovedDeviceAuthorization }
  | { readonly kind: "pending" }
  | { readonly kind: "slow_down"; readonly retryAfterSeconds: number };

export interface SafeTunnelRegisteredMachine {
  readonly machine: {
    readonly id: string;
    readonly accountId: string;
    readonly name: string;
    readonly slug: string;
  };
  readonly publicHostname: string;
  readonly publicUrl: string;
  readonly machineToken: string;
}

export interface SafeTunnelMachineTunnelConfig {
  readonly machineId: string;
  readonly publicHostname: string;
  readonly publicUrl: string;
  readonly localPiWebUrl: string;
  readonly proxyName: string;
  readonly frpcConfigToml: string;
}

export type SafeTunnelHeartbeatTunnelStatus =
  | "error"
  | "running"
  | "starting"
  | "stopping";

export interface SafeTunnelMachineHeartbeat {
  readonly machineId: string;
  readonly lastSeenAt: string;
  readonly nextHeartbeatSeconds: number;
}

export interface SafeTunnelControlPlane {
  startDeviceAuthorization(input: {
    readonly controlApiBaseUrl: string;
    readonly clientVersion: string;
  }, options?: { readonly signal?: AbortSignal }): Promise<SafeTunnelDeviceAuthorization>;
  completeDeviceAuthorization(input: {
    readonly controlApiBaseUrl: string;
    readonly deviceCode: string;
  }, options?: { readonly signal?: AbortSignal }): Promise<SafeTunnelDeviceAuthorizationCompletion>;
  registerMachine(input: {
    readonly controlApiBaseUrl: string;
    readonly connectorAccessToken: string;
    readonly machineName: string;
    readonly machineSlug: string;
    readonly localPiWebUrl: string;
    readonly clientVersion: string;
  }, options?: { readonly signal?: AbortSignal }): Promise<SafeTunnelRegisteredMachine>;
  getMachineTunnelConfig(
    credentials: SafeTunnelMachineCredentials,
    options?: { readonly signal?: AbortSignal },
  ): Promise<SafeTunnelMachineTunnelConfig>;
  recordMachineHeartbeat(
    credentials: SafeTunnelMachineCredentials,
    input: {
      readonly clientVersion: string;
      readonly tunnelStatus: SafeTunnelHeartbeatTunnelStatus;
      readonly errorMessage?: string;
    },
    options?: { readonly signal?: AbortSignal },
  ): Promise<SafeTunnelMachineHeartbeat>;
}

export type SafeTunnelFetch = (input: string, init: RequestInit) => Promise<Response>;

export interface SafeTunnelControlPlaneScheduledTimeout {
  cancel(): void;
}

export type SafeTunnelControlPlaneTimeoutScheduler = (
  callback: () => void,
  delayMs: number,
) => SafeTunnelControlPlaneScheduledTimeout;

export interface HttpSafeTunnelControlPlaneOptions {
  readonly fetch?: SafeTunnelFetch;
  readonly requestTimeoutMs?: number;
  readonly scheduleTimeout?: SafeTunnelControlPlaneTimeoutScheduler;
}

/**
 * Concrete Control API adapter. HTTP paths, headers, status handling, and DTO
 * parsing terminate here; callers receive only PI WEB-owned results/errors.
 */
export class HttpSafeTunnelControlPlane implements SafeTunnelControlPlane {
  private readonly fetch: SafeTunnelFetch;
  private readonly requestTimeoutMs: number;
  private readonly scheduleTimeout: SafeTunnelControlPlaneTimeoutScheduler;

  constructor(options: HttpSafeTunnelControlPlaneOptions = {}) {
    this.fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.requestTimeoutMs = positiveInteger(
      options.requestTimeoutMs ?? defaultControlApiRequestTimeoutMs,
    );
    this.scheduleTimeout = options.scheduleTimeout ?? scheduleNodeTimeout;
  }

  async startDeviceAuthorization(input: {
    readonly controlApiBaseUrl: string;
    readonly clientVersion: string;
  }, options: { readonly signal?: AbortSignal } = {}): Promise<SafeTunnelDeviceAuthorization> {
    const operation = "start_device_authorization";
    return this.request(
      endpoint(input.controlApiBaseUrl, "/v1/device/start"),
      {
        ...jsonPostRequest({ connectorVersion: input.clientVersion }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
      operation,
      async (response) => {
        requireExpectedResponse(response, 202, operation);
        return parseControlPlaneResponse(
          await readSuccessJson(response, operation),
          operation,
          parseDeviceAuthorization,
        );
      },
    );
  }

  async completeDeviceAuthorization(input: {
    readonly controlApiBaseUrl: string;
    readonly deviceCode: string;
  }, options: { readonly signal?: AbortSignal } = {}): Promise<SafeTunnelDeviceAuthorizationCompletion> {
    const operation = "complete_device_authorization";
    return this.request(
      endpoint(input.controlApiBaseUrl, "/v1/device/complete"),
      {
        ...jsonPostRequest({ deviceCode: input.deviceCode }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
      operation,
      async (response) => {
        if (response.status === 200) {
          return {
            kind: "approved",
            authorization: parseControlPlaneResponse(
              await readSuccessJson(response, operation),
              operation,
              parseApprovedDeviceAuthorization,
            ),
          };
        }

        // Completion errors are part of the device-poll protocol: parse the
        // hosted error envelope and Retry-After before generic status mapping.
        const applicationCode = await readApplicationErrorCode(response);
        if (response.status === 409 && applicationCode === "authorization_pending") {
          return { kind: "pending" };
        }
        if (response.status === 429) {
          const retryAfterSeconds = parseRetryAfterSeconds(response.headers.get("retry-after"));
          if (applicationCode === "slow_down" && retryAfterSeconds !== undefined) {
            return { kind: "slow_down", retryAfterSeconds };
          }
          // rate_limit_exceeded and untrusted slow_down envelopes stay
          // retryable-or-terminal errors; without a usable Retry-After the
          // owner must not guess a delay.
          throw new SafeTunnelControlPlaneError("rate_limited", operation, retryAfterSeconds);
        }
        if (applicationCode === "authorization_denied") {
          throw new SafeTunnelControlPlaneError("authorization_denied", operation);
        }
        if (applicationCode === "device_code_expired") {
          throw new SafeTunnelControlPlaneError("authorization_expired", operation);
        }
        if (response.ok) throw new SafeTunnelControlPlaneError("invalid_response", operation);
        throw mappedHttpError(response.status, operation);
      },
    );
  }

  async registerMachine(input: {
    readonly controlApiBaseUrl: string;
    readonly connectorAccessToken: string;
    readonly machineName: string;
    readonly machineSlug: string;
    readonly localPiWebUrl: string;
    readonly clientVersion: string;
  }, options: { readonly signal?: AbortSignal } = {}): Promise<SafeTunnelRegisteredMachine> {
    const operation = "register_machine";
    return this.request(
      endpoint(input.controlApiBaseUrl, "/v1/machines"),
      {
        ...jsonPostRequest({
          name: input.machineName,
          slug: input.machineSlug,
          localPiWebUrl: input.localPiWebUrl,
          connectorVersion: input.clientVersion,
        }, input.connectorAccessToken),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
      operation,
      async (response) => {
        requireExpectedResponse(response, 201, operation);
        return parseControlPlaneResponse(
          await readSuccessJson(response, operation),
          operation,
          parseRegisteredMachine,
        );
      },
    );
  }

  async getMachineTunnelConfig(
    credentials: SafeTunnelMachineCredentials,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<SafeTunnelMachineTunnelConfig> {
    const operation = "get_tunnel_config";
    return this.request(
      endpoint(
        credentials.controlApiBaseUrl,
        `/v1/machines/${encodeURIComponent(credentials.machineId)}/tunnel-config`,
      ),
      {
        method: "GET",
        headers: {
          accept: "application/json",
          authorization: bearerAuthorization(credentials.machineToken),
        },
        redirect: "error",
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
      operation,
      async (response) => {
        requireExpectedResponse(response, 200, operation);
        return parseControlPlaneResponse(
          await readSuccessJson(response, operation),
          operation,
          parseMachineTunnelConfig,
        );
      },
    );
  }

  async recordMachineHeartbeat(
    credentials: SafeTunnelMachineCredentials,
    input: {
      readonly clientVersion: string;
      readonly tunnelStatus: SafeTunnelHeartbeatTunnelStatus;
      readonly errorMessage?: string;
    },
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<SafeTunnelMachineHeartbeat> {
    const operation = "record_heartbeat";
    return this.request(
      endpoint(
        credentials.controlApiBaseUrl,
        `/v1/machines/${encodeURIComponent(credentials.machineId)}/heartbeat`,
      ),
      {
        ...jsonPostRequest({
          connectorVersion: input.clientVersion,
          tunnelStatus: input.tunnelStatus,
          ...(input.errorMessage === undefined ? {} : { errorMessage: input.errorMessage }),
        }, credentials.machineToken),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
      operation,
      async (response) => {
        requireExpectedResponse(response, 202, operation);
        return parseControlPlaneResponse(
          await readSuccessJson(response, operation),
          operation,
          parseMachineHeartbeat,
        );
      },
    );
  }

  private async request<T>(
    url: string,
    init: RequestInit,
    operation: SafeTunnelControlPlaneOperation,
    consume: (response: Response) => Promise<T>,
  ): Promise<T> {
    const callerSignal = init.signal ?? undefined;
    const controller = new AbortController();
    const abortFromCaller = (): void => { controller.abort(); };
    callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
    if (callerSignal?.aborted === true) controller.abort();
    const timeout = this.scheduleTimeout(() => { controller.abort(); }, this.requestTimeoutMs);

    try {
      if (controller.signal.aborted) {
        throw new Error("Safe Tunnel Control API request cancelled.");
      }
      const response = await abortable(
        this.fetch(url, { ...init, signal: controller.signal }),
        controller.signal,
      );
      return await abortable(consume(response), controller.signal);
    } catch (error: unknown) {
      if (error instanceof SafeTunnelControlPlaneError) throw error;
      throw new SafeTunnelControlPlaneError("transport_failed", operation);
    } finally {
      timeout.cancel();
      callerSignal?.removeEventListener("abort", abortFromCaller);
    }
  }
}

function jsonPostRequest(
  body: Readonly<Record<string, string>>,
  bearerToken?: string,
): RequestInit {
  return {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      ...(bearerToken === undefined ? {} : {
        authorization: bearerAuthorization(bearerToken),
      }),
    },
    body: JSON.stringify(body),
    redirect: "error",
  };
}

function bearerAuthorization(credential: string): string {
  return `Bearer ${requireSafeTunnelBearerCredential(credential, "bearer credential")}`;
}

function endpoint(baseUrl: string, path: string): string {
  return `${normalizeSafeTunnelControlApiBaseUrl(baseUrl)}${path}`;
}

function requireExpectedResponse(
  response: Response,
  expectedStatus: number,
  operation: SafeTunnelControlPlaneOperation,
): void {
  if (response.status === expectedStatus) return;
  void response.body?.cancel().catch(() => undefined);
  if (response.ok) throw new SafeTunnelControlPlaneError("invalid_response", operation);
  throw mappedHttpError(response.status, operation);
}

function mappedHttpError(
  status: number,
  operation: SafeTunnelControlPlaneOperation,
): SafeTunnelControlPlaneError {
  if (status === 401 || status === 403) {
    return new SafeTunnelControlPlaneError("authentication_failed", operation);
  }
  if (status === 409) return new SafeTunnelControlPlaneError("conflict", operation);
  if (status === 429) return new SafeTunnelControlPlaneError("rate_limited", operation);
  if (status >= 500) return new SafeTunnelControlPlaneError("service_unavailable", operation);
  return new SafeTunnelControlPlaneError("request_rejected", operation);
}

function parseRetryAfterSeconds(value: string | null): number | undefined {
  // Hosted 429 responses carry a positive integer delta-seconds Retry-After;
  // anything else (HTTP-date, fraction, zero) is not trustworthy cadence.
  if (value === null || !/^\d+$/u.test(value.trim())) return undefined;
  const seconds = Number(value.trim());
  return Number.isSafeInteger(seconds) && seconds > 0 ? seconds : undefined;
}

async function readSuccessJson(
  response: Response,
  operation: SafeTunnelControlPlaneOperation,
): Promise<unknown> {
  try {
    return await readBoundedJson(response);
  } catch {
    throw new SafeTunnelControlPlaneError("invalid_response", operation);
  }
}

async function readApplicationErrorCode(response: Response): Promise<string | undefined> {
  let body: unknown;
  try {
    body = await readBoundedJson(response);
  } catch {
    return undefined;
  }
  if (!isRecord(body)) return undefined;
  const envelope = body["error"];
  const errorRecord = isRecord(envelope) ? envelope : body;
  const code = errorRecord["code"];
  return typeof code === "string"
    && code.length <= maximumIdentifierCharacters
    && code.trim() !== ""
    ? code
    : undefined;
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (!Number.isSafeInteger(parsedLength)
      || parsedLength < 0
      || parsedLength > maximumControlApiResponseBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error("Invalid Safe Tunnel response body length.");
    }
  }
  if (response.body === null) throw new Error("Missing Safe Tunnel response body.");

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      totalBytes += chunk.value.byteLength;
      if (totalBytes > maximumControlApiResponseBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error("Safe Tunnel response body is too large.");
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const source = new TextDecoder("utf-8", { fatal: true }).decode(body);
  const parsed: unknown = JSON.parse(source);
  return parsed;
}

class InvalidSafeTunnelControlPlaneResponseError extends Error {}

function parseControlPlaneResponse<T>(
  body: unknown,
  operation: SafeTunnelControlPlaneOperation,
  parse: (value: unknown) => T,
): T {
  try {
    return parse(body);
  } catch (error: unknown) {
    if (error instanceof InvalidSafeTunnelControlPlaneResponseError) {
      throw new SafeTunnelControlPlaneError("invalid_response", operation);
    }
    throw error;
  }
}

function parseDeviceAuthorization(body: unknown): SafeTunnelDeviceAuthorization {
  const record = requireResponseRecord(body);
  return {
    deviceCode: requireResponseString(record["deviceCode"], maximumOpaqueTokenCharacters),
    userCode: requireResponseString(record["userCode"], maximumIdentifierCharacters),
    verificationUri: requireExternalHttpUrl(record["verificationUri"]),
    verificationUriComplete: requireExternalHttpUrl(record["verificationUriComplete"]),
    expiresAt: requireCanonicalIsoDateTime(record["expiresAt"]),
    intervalSeconds: requirePositiveInteger(record["intervalSeconds"]),
  };
}

function parseApprovedDeviceAuthorization(body: unknown): SafeTunnelApprovedDeviceAuthorization {
  const record = requireResponseRecord(body);
  const account = requireResponseRecord(record["account"]);
  if (record["tokenType"] !== "Bearer") throw invalidResponse();
  return {
    accessToken: requireResponseBearerCredential(record["accessToken"], "accessToken"),
    expiresAt: requireCanonicalIsoDateTime(record["expiresAt"]),
    account: {
      id: requireResponseString(account["id"]),
      publicNamespace: requireResponseString(account["publicNamespace"]),
    },
  };
}

function parseRegisteredMachine(body: unknown): SafeTunnelRegisteredMachine {
  const record = requireResponseRecord(body);
  const machine = requireResponseRecord(record["machine"]);
  requireResponseString(record["tunnelConfigUrl"], maximumUrlCharacters);
  const publicHostname = requireResponseString(
    record["publicHostname"],
    maximumNameCharacters,
  );
  const publicUrl = normalizeResponsePublicUrl(record["publicUrl"]);
  requireMatchingPublicHostname(publicHostname, publicUrl);
  return {
    machine: {
      id: requireResponseString(machine["id"]),
      accountId: requireResponseString(machine["accountId"]),
      name: requireResponseString(machine["name"]),
      slug: requireResponseString(machine["slug"]),
    },
    publicHostname,
    publicUrl,
    machineToken: requireResponseBearerCredential(record["machineToken"], "machineToken"),
  };
}

function parseMachineTunnelConfig(body: unknown): SafeTunnelMachineTunnelConfig {
  const record = requireResponseRecord(body);
  const machine = requireResponseRecord(record["machine"]);
  const frp = requireResponseRecord(record["frp"]);
  if (frp["configFormat"] !== "toml") throw invalidResponse();
  const publicHostname = requireResponseString(
    record["publicHostname"],
    maximumNameCharacters,
  );
  const publicUrl = normalizeResponsePublicUrl(record["publicUrl"]);
  requireMatchingPublicHostname(publicHostname, publicUrl);
  return {
    machineId: requireResponseString(machine["id"]),
    publicHostname,
    publicUrl,
    localPiWebUrl: normalizeResponseLocalPiWebUrl(record["localPiWebUrl"]),
    proxyName: requireResponseString(frp["proxyName"]),
    frpcConfigToml: requireResponseString(
      frp["frpcConfigToml"],
      maximumFrpcConfigCharacters,
    ),
  };
}

function parseMachineHeartbeat(body: unknown): SafeTunnelMachineHeartbeat {
  const record = requireResponseRecord(body);
  const machine = requireResponseRecord(record["machine"]);
  if (record["accepted"] !== true) throw invalidResponse();
  return {
    machineId: requireResponseString(machine["id"]),
    lastSeenAt: requireCanonicalIsoDateTime(machine["lastSeenAt"]),
    nextHeartbeatSeconds: requirePositiveInteger(record["nextHeartbeatSeconds"]),
  };
}

function normalizeResponsePublicUrl(value: unknown): string {
  try {
    return normalizeSafeTunnelPublicUrl(value);
  } catch {
    throw invalidResponse();
  }
}

function normalizeResponseLocalPiWebUrl(value: unknown): string {
  try {
    return normalizeSafeTunnelLocalPiWebUrl(value);
  } catch {
    throw invalidResponse();
  }
}

function requireMatchingPublicHostname(publicHostname: string, publicUrl: string): void {
  if (new URL(publicUrl).hostname !== publicHostname) throw invalidResponse();
}

function requireExternalHttpUrl(value: unknown): string {
  const source = requireResponseString(value, maximumUrlCharacters);
  try {
    const url = new URL(source);
    if (!isSafeTunnelControlApiTransportAllowed(url)
      || url.username !== "" || url.password !== "") throw invalidResponse();
    return source;
  } catch (error: unknown) {
    if (error instanceof InvalidSafeTunnelControlPlaneResponseError) throw error;
    throw invalidResponse();
  }
}

function requireCanonicalIsoDateTime(value: unknown): string {
  const source = requireResponseString(value);
  const parsed = new Date(source);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== source) {
    throw invalidResponse();
  }
  return source;
}

function requirePositiveInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw invalidResponse();
  }
  return value;
}

function requireResponseBearerCredential(value: unknown, fieldName: string): string {
  try {
    return requireSafeTunnelBearerCredential(value, fieldName);
  } catch {
    throw invalidResponse();
  }
}

function requireResponseString(
  value: unknown,
  maximumCharacters = maximumNameCharacters,
): string {
  if (typeof value !== "string"
    || value.trim() === ""
    || value.length > maximumCharacters) throw invalidResponse();
  return value;
}

function requireResponseRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) throw invalidResponse();
  return value;
}

function invalidResponse(): InvalidSafeTunnelControlPlaneResponseError {
  return new InvalidSafeTunnelControlPlaneResponseError();
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function scheduleNodeTimeout(
  callback: () => void,
  delayMs: number,
): SafeTunnelControlPlaneScheduledTimeout {
  const timeout = setTimeout(callback, delayMs);
  return { cancel: () => { clearTimeout(timeout); } };
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (complete: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      complete();
    };
    const onAbort = (): void => {
      finish(() => { reject(new Error("Safe Tunnel Control API request cancelled.")); });
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    void operation.then(
      (value) => { finish(() => { resolve(value); }); },
      (error: unknown) => {
        finish(() => {
          reject(error instanceof Error
            ? error
            : new Error("Unexpected Safe Tunnel Control API failure."));
        });
      },
    );
  });
}

function positiveInteger(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("Safe Tunnel Control API request timeout must be a positive integer.");
  }
  return value;
}

function controlPlaneErrorMessage(
  code: SafeTunnelControlPlaneErrorCode,
  operation: SafeTunnelControlPlaneOperation,
): string {
  const label = operationLabel(operation);
  switch (code) {
    case "authentication_failed":
      return `${label} was not authorized by the Safe Tunnel service.`;
    case "authorization_denied":
      return "Safe Tunnel device authorization was denied.";
    case "authorization_expired":
      return "Safe Tunnel device authorization expired.";
    case "conflict":
      return `${label} conflicted with current Safe Tunnel service state.`;
    case "invalid_response":
      return `The Safe Tunnel service returned an invalid response for ${label.toLowerCase()}.`;
    case "rate_limited":
      return `${label} was rate limited by the Safe Tunnel service.`;
    case "request_rejected":
      return `${label} was rejected by the Safe Tunnel service.`;
    case "service_unavailable":
      return `The Safe Tunnel service is unavailable during ${label.toLowerCase()}.`;
    case "transport_failed":
      return `Unable to reach the Safe Tunnel service for ${label.toLowerCase()}.`;
  }
}

function operationLabel(operation: SafeTunnelControlPlaneOperation): string {
  switch (operation) {
    case "complete_device_authorization":
      return "Device authorization completion";
    case "get_tunnel_config":
      return "Tunnel configuration";
    case "record_heartbeat":
      return "Machine heartbeat";
    case "register_machine":
      return "Machine registration";
    case "start_device_authorization":
      return "Device authorization start";
  }
}
