import type { ConnectorConfig, ConnectorMachineCredentials } from "./config-storage.js";
import type { FetchLike } from "./connector-runtime.js";

export const connectorLoginClientVersion = "pi-web-tunnel/0.0.0";

export interface OutputSink {
  write(chunk: string): void;
}

export interface ConnectorLoginArgs {
  readonly controlApiBaseUrl: string;
  readonly machineName: string;
  readonly machineSlug: string;
  readonly localPiWebUrl?: string;
  readonly frpcPath?: string;
}

export interface ConnectorLoginFlowInput {
  readonly controlApiBaseUrl: string;
  readonly machineName: string;
  readonly machineSlug: string;
  readonly localPiWebUrl: string;
  readonly connectorVersion?: string;
}

export interface ConnectorLoginFlowDependencies extends ConnectorLoginFlowInput {
  readonly fetch: FetchLike;
  readonly now: () => Date;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly stdout: OutputSink;
}

export interface StartedConnectorDeviceAuthResponse {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly verificationUri: string;
  readonly verificationUriComplete: string;
  readonly expiresAt: string;
  readonly intervalSeconds: number;
}

export interface CompletedConnectorDeviceAuthResponse {
  readonly accessToken: string;
  readonly tokenType: "Bearer";
  readonly expiresAt: string;
  readonly account: {
    readonly id: string;
    readonly publicNamespace: string;
  };
}

export interface RegisteredConnectorMachineResponse {
  readonly machine: {
    readonly id: string;
    readonly accountId: string;
    readonly name: string;
    readonly slug: string;
  };
  readonly publicHostname: string;
  readonly publicUrl: string;
  readonly machineToken: string;
  readonly tunnelConfigUrl: string;
}

export interface ConnectorLoginResult {
  readonly machineCredentials: ConnectorMachineCredentials;
  readonly registeredMachine: RegisteredConnectorMachineResponse;
}

type DeviceAuthCompletionResult =
  | { readonly kind: "approved"; readonly completed: CompletedConnectorDeviceAuthResponse }
  | { readonly kind: "pending" };

interface ConnectorApiErrorDetails {
  readonly code?: string;
  readonly message?: string;
}

/**
 * Drives the connector device-code login flow against the Control API: start a
 * device authorization, show the browser approval URL/user code, poll until the
 * browser approves it, then register this machine with the short-lived connector
 * access token returned by completion.
 */
export async function runConnectorLoginFlow(
  dependencies: ConnectorLoginFlowDependencies,
): Promise<ConnectorLoginResult> {
  const started = await startConnectorDeviceAuth(dependencies);
  const expiresAtMilliseconds = parseExpiresAtMilliseconds(started.expiresAt);

  writeLine(dependencies.stdout, "Starting PI WEB Safe Tunnel login.");
  writeLine(dependencies.stdout, "Open this URL to authorize the connector:");
  writeLine(dependencies.stdout, started.verificationUriComplete);
  writeLine(dependencies.stdout, `User code: ${started.userCode}`);
  writeLine(dependencies.stdout, `Waiting for approval until ${started.expiresAt}...`);

  const completed = await pollConnectorDeviceAuthCompletion({
    ...dependencies,
    deviceCode: started.deviceCode,
    expiresAtMilliseconds,
    intervalSeconds: started.intervalSeconds,
  });

  writeLine(dependencies.stdout, "Connector authorization approved.");
  writeLine(dependencies.stdout, `Account namespace: ${completed.account.publicNamespace}`);
  writeLine(dependencies.stdout, "Registering this machine...");

  const registeredMachine = await registerConnectorMachine({
    ...dependencies,
    connectorAccessToken: completed.accessToken,
  });

  return {
    registeredMachine,
    machineCredentials: {
      controlApiBaseUrl: dependencies.controlApiBaseUrl,
      machineId: registeredMachine.machine.id,
      machineToken: registeredMachine.machineToken,
      machineSlug: registeredMachine.machine.slug,
      publicUrl: registeredMachine.publicUrl,
    },
  };
}

export function applyConnectorLoginResultToConfig(
  existing: ConnectorConfig,
  args: ConnectorLoginArgs,
  result: ConnectorLoginResult,
): ConnectorConfig {
  const next: ConnectorConfig = {
    localPiWebUrl: args.localPiWebUrl ?? existing.localPiWebUrl,
    schemaVersion: existing.schemaVersion,
    machine: result.machineCredentials,
  };
  const frpcPath = args.frpcPath ?? existing.frpcPath;

  if (frpcPath === undefined) {
    return next;
  }

  return { ...next, frpcPath };
}

async function startConnectorDeviceAuth(
  input: ConnectorLoginFlowInput & { readonly fetch: FetchLike },
): Promise<StartedConnectorDeviceAuthResponse> {
  const response = await postConnectorJson({
    baseUrl: input.controlApiBaseUrl,
    fetch: input.fetch,
    path: "/v1/device/start",
    body: optionalConnectorVersionBody(input.connectorVersion),
  });

  if (!response.ok) {
    throw await createConnectorApiRequestError("Device authorization start", response);
  }

  return parseStartedDeviceAuthResponse(await response.json());
}

async function pollConnectorDeviceAuthCompletion(
  input: ConnectorLoginFlowDependencies & {
    readonly deviceCode: string;
    readonly expiresAtMilliseconds: number;
    readonly intervalSeconds: number;
  },
): Promise<CompletedConnectorDeviceAuthResponse> {
  for (;;) {
    const completion = await completeConnectorDeviceAuth(input);

    if (completion.kind === "approved") {
      return completion.completed;
    }

    const remainingMilliseconds = input.expiresAtMilliseconds - input.now().getTime();

    if (remainingMilliseconds <= 0) {
      throw new Error("Connector device authorization expired before approval.");
    }

    const pollDelayMilliseconds = Math.min(
      normalizePollIntervalMilliseconds(input.intervalSeconds),
      remainingMilliseconds,
    );
    await input.sleep(pollDelayMilliseconds);
  }
}

async function completeConnectorDeviceAuth(
  input: ConnectorLoginFlowInput & {
    readonly deviceCode: string;
    readonly fetch: FetchLike;
  },
): Promise<DeviceAuthCompletionResult> {
  const response = await postConnectorJson({
    baseUrl: input.controlApiBaseUrl,
    fetch: input.fetch,
    path: "/v1/device/complete",
    body: { deviceCode: input.deviceCode },
  });

  if (response.ok) {
    return {
      kind: "approved",
      completed: parseCompletedDeviceAuthResponse(await response.json()),
    };
  }

  const errorDetails = await readConnectorApiErrorDetails(response);

  if (response.status === 409 && errorDetails.code === "authorization_pending") {
    return { kind: "pending" };
  }

  throw createConnectorApiError(
    "Device authorization completion",
    response.status,
    errorDetails,
  );
}

async function registerConnectorMachine(
  input: ConnectorLoginFlowInput & {
    readonly connectorAccessToken: string;
    readonly fetch: FetchLike;
  },
): Promise<RegisteredConnectorMachineResponse> {
  const response = await postConnectorJson({
    authorizationBearerToken: input.connectorAccessToken,
    baseUrl: input.controlApiBaseUrl,
    fetch: input.fetch,
    path: "/v1/machines",
    body: {
      name: input.machineName,
      slug: input.machineSlug,
      localPiWebUrl: input.localPiWebUrl,
      ...optionalConnectorVersionBody(input.connectorVersion),
    },
  });

  if (!response.ok) {
    throw await createConnectorApiRequestError("Machine registration", response);
  }

  return parseRegisteredMachineResponse(await response.json());
}

function postConnectorJson(input: {
  readonly authorizationBearerToken?: string;
  readonly baseUrl: string;
  readonly body: Readonly<Record<string, string>>;
  readonly fetch: FetchLike;
  readonly path: string;
}): ReturnType<FetchLike> {
  const headers: Record<string, string> = {
    accept: "application/json",
    "content-type": "application/json",
  };

  if (input.authorizationBearerToken !== undefined) {
    headers["authorization"] = `Bearer ${input.authorizationBearerToken}`;
  }

  return input.fetch(`${normalizeBaseUrl(input.baseUrl)}${input.path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(input.body),
  });
}

function optionalConnectorVersionBody(
  connectorVersion: string | undefined,
): Readonly<Record<string, string>> {
  if (connectorVersion === undefined) {
    return {};
  }

  return { connectorVersion };
}

function parseStartedDeviceAuthResponse(body: unknown): StartedConnectorDeviceAuthResponse {
  if (!isRecord(body)) {
    throw new Error("Control API device authorization response must be a JSON object.");
  }

  return {
    deviceCode: requireResponseString(body["deviceCode"], "deviceCode"),
    userCode: requireResponseString(body["userCode"], "userCode"),
    verificationUri: requireResponseString(body["verificationUri"], "verificationUri"),
    verificationUriComplete: requireResponseString(
      body["verificationUriComplete"],
      "verificationUriComplete",
    ),
    expiresAt: requireResponseString(body["expiresAt"], "expiresAt"),
    intervalSeconds: requirePositiveInteger(body["intervalSeconds"], "intervalSeconds"),
  };
}

function parseCompletedDeviceAuthResponse(body: unknown): CompletedConnectorDeviceAuthResponse {
  if (!isRecord(body)) {
    throw new Error("Control API device completion response must be a JSON object.");
  }

  const account = body["account"];

  if (!isRecord(account)) {
    throw new Error("Control API device completion response account must be a JSON object.");
  }

  const tokenType = requireResponseString(body["tokenType"], "tokenType");

  if (tokenType !== "Bearer") {
    throw new Error("Control API device completion response tokenType must be Bearer.");
  }

  return {
    accessToken: requireResponseString(body["accessToken"], "accessToken"),
    tokenType,
    expiresAt: requireResponseString(body["expiresAt"], "expiresAt"),
    account: {
      id: requireResponseString(account["id"], "account.id"),
      publicNamespace: requireResponseString(account["publicNamespace"], "account.publicNamespace"),
    },
  };
}

function parseRegisteredMachineResponse(body: unknown): RegisteredConnectorMachineResponse {
  if (!isRecord(body)) {
    throw new Error("Control API machine registration response must be a JSON object.");
  }

  const machine = body["machine"];

  if (!isRecord(machine)) {
    throw new Error("Control API machine registration response machine must be a JSON object.");
  }

  return {
    machine: {
      id: requireResponseString(machine["id"], "machine.id"),
      accountId: requireResponseString(machine["accountId"], "machine.accountId"),
      name: requireResponseString(machine["name"], "machine.name"),
      slug: requireResponseString(machine["slug"], "machine.slug"),
    },
    publicHostname: requireResponseString(body["publicHostname"], "publicHostname"),
    publicUrl: requireResponseString(body["publicUrl"], "publicUrl"),
    machineToken: requireResponseString(body["machineToken"], "machineToken"),
    tunnelConfigUrl: requireResponseString(body["tunnelConfigUrl"], "tunnelConfigUrl"),
  };
}

function requireResponseString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Control API response ${fieldName} must be a non-empty string.`);
  }

  return value;
}

function requirePositiveInteger(value: unknown, fieldName: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`Control API response ${fieldName} must be a positive integer.`);
  }

  return value;
}

async function createConnectorApiRequestError(
  operation: string,
  response: Awaited<ReturnType<FetchLike>>,
): Promise<Error> {
  return createConnectorApiError(
    operation,
    response.status,
    await readConnectorApiErrorDetails(response),
  );
}

function createConnectorApiError(
  operation: string,
  status: number,
  errorDetails: ConnectorApiErrorDetails,
): Error {
  const codeSuffix = errorDetails.code === undefined ? "" : ` (${errorDetails.code})`;
  const messageSuffix = errorDetails.message === undefined ? "" : `: ${errorDetails.message}`;

  return new Error(
    `${operation} failed with status ${status.toString()}${codeSuffix}${messageSuffix}.`,
  );
}

async function readConnectorApiErrorDetails(
  response: Awaited<ReturnType<FetchLike>>,
): Promise<ConnectorApiErrorDetails> {
  let body: unknown;

  try {
    body = await response.json();
  } catch {
    return {};
  }

  if (!isRecord(body)) {
    return {};
  }

  return readConnectorApiErrorDetailsFromRecord(
    isRecord(body["error"]) ? body["error"] : body,
  );
}

function readConnectorApiErrorDetailsFromRecord(
  body: Readonly<Record<string, unknown>>,
): ConnectorApiErrorDetails {
  const code = body["code"];
  const message = body["message"];

  if (typeof code === "string" && code.trim().length > 0) {
    return typeof message === "string" && message.trim().length > 0
      ? { code, message }
      : { code };
  }

  if (typeof message === "string" && message.trim().length > 0) {
    return { message };
  }

  return {};
}

function parseExpiresAtMilliseconds(expiresAt: string): number {
  const milliseconds = Date.parse(expiresAt);

  if (!Number.isFinite(milliseconds)) {
    throw new Error("Control API device authorization expiresAt must be a valid date-time string.");
  }

  return milliseconds;
}

function normalizePollIntervalMilliseconds(intervalSeconds: number): number {
  return Math.max(1, intervalSeconds) * 1000;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/u, "");
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function writeLine(sink: OutputSink, line: string): void {
  sink.write(`${line}\n`);
}
