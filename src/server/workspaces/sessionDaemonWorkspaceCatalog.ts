import { isAbsolute } from "node:path";
import type { ServerPluginHealth } from "../../server-plugin-api.js";
import type { ServerPluginSafeStart } from "../../serverPluginRecovery.js";
import type {
  JsonObject,
  JsonValue,
  WorkspaceListing,
  WorkspaceProviderAuthorityResolution,
  WorkspaceProviderDiagnostic,
  WorkspaceProviderDiagnosticCode,
  WorkspaceProviderResolutionStatus,
  WorkspaceProviderTier,
} from "../../shared/apiTypes.js";
import { isPiWebPluginId } from "../../shared/pluginIds.js";
import type { SessionDaemonRequestClient } from "../../sessiond/sessionDaemonClient.js";
import type {
  ServerPluginHealthInspection,
  ServerPluginLifecyclePhase,
  ServerPluginRuntimeRecord,
  ServerPluginRuntimeState,
} from "../plugins/serverPluginRuntime.js";
import type { PiWebPluginCatalogDiagnostic, PiWebPluginCatalogDiagnosticCode } from "../piWebPluginCatalog.js";
import {
  WorkspaceCatalogProtocolError,
  WorkspaceCatalogRequestError,
  WorkspaceCatalogUnavailableError,
  WORKSPACE_PROVIDER_RUNTIME_PROTOCOL_VERSION,
  type WorkspaceCatalog,
  type WorkspaceProviderRuntimeSnapshot,
} from "./workspaceCatalog.js";

const WORKSPACE_CATALOG_PATH = "/workspace-catalog";

/** Narrow web adapter over sessiond's internal workspace-authority protocol. */
export class SessionDaemonWorkspaceCatalog implements WorkspaceCatalog {
  constructor(private readonly daemon: SessionDaemonRequestClient) {}

  async resolveProject(projectId: string): Promise<WorkspaceProviderAuthorityResolution> {
    const value = await this.requestJson(`${WORKSPACE_CATALOG_PATH}/projects/${encodedId(projectId, "project")}/workspaces`);
    return parseWorkspaceProviderResolution(value, projectId);
  }

  async list(projectId: string): Promise<WorkspaceListing[]> {
    return [...(await this.resolveProject(projectId)).workspaces];
  }

  async resolve(projectId: string, workspaceId: string): Promise<WorkspaceListing> {
    const value = await this.requestJson(
      `${WORKSPACE_CATALOG_PATH}/projects/${encodedId(projectId, "project")}/workspaces/${encodedId(workspaceId, "workspace")}`,
    );
    const workspace = parseWorkspace(value, "workspace resolution response");
    if (workspace.projectId !== projectId || workspace.id !== workspaceId) {
      throw protocolError("workspace resolution response did not match the requested project and workspace");
    }
    return workspace;
  }

  async providerRuntime(): Promise<WorkspaceProviderRuntimeSnapshot> {
    return parseProviderRuntimeSnapshot(await this.requestJson(`${WORKSPACE_CATALOG_PATH}/provider-runtime`));
  }

  private async requestJson(path: string): Promise<unknown> {
    let response: Awaited<ReturnType<SessionDaemonRequestClient["request"]>>;
    try {
      response = await this.daemon.request("GET", path);
    } catch (error) {
      throw new WorkspaceCatalogUnavailableError(
        `Session daemon workspace authority unavailable: ${errorMessage(error)}`,
        { cause: error },
      );
    }

    if (response.statusCode < 200 || response.statusCode >= 300) {
      if (isUnknownWorkspaceCatalogRoute(response.statusCode, response.body)) {
        throw new WorkspaceCatalogProtocolError(
          "Session daemon does not support workspace authority operations; restart or upgrade the session daemon",
        );
      }
      throw new WorkspaceCatalogRequestError(
        workspaceCatalogRequestMessage(response.statusCode, response.body),
        response.statusCode,
      );
    }

    try {
      if (response.body === "") return undefined;
      const value: unknown = JSON.parse(response.body);
      return value;
    } catch (error) {
      throw new WorkspaceCatalogProtocolError("Session daemon workspace authority returned invalid JSON", { cause: error });
    }
  }
}

function parseWorkspaceProviderResolution(value: unknown, expectedProjectId: string): WorkspaceProviderAuthorityResolution {
  if (!isRecord(value)) throw protocolError("workspace resolution response must be an object");
  const status = parseWorkspaceProviderResolutionStatus(value["status"]);
  const projectId = requireString(value, "projectId", "workspace resolution response");
  if (projectId !== expectedProjectId) throw protocolError("workspace resolution response did not match the requested project");
  const ownerPluginId = optionalPluginId(value, "ownerPluginId", "workspace resolution response");
  if (status === "provider" && ownerPluginId === undefined) {
    throw protocolError("provider workspace resolution must identify its owner");
  }
  if (status === "folder" && ownerPluginId !== undefined) {
    throw protocolError("folder workspace resolution must not identify a provider owner");
  }

  const workspaces = parseWorkspaceList(value["workspaces"], projectId);
  const diagnostics = parseArray(
    value["diagnostics"],
    "workspace provider diagnostics",
    parseWorkspaceProviderDiagnostic,
  );
  return Object.freeze({
    status,
    projectId,
    ...(ownerPluginId === undefined ? {} : { ownerPluginId }),
    workspaces: Object.freeze(workspaces),
    diagnostics: Object.freeze(diagnostics),
  });
}

function parseWorkspaceProviderResolutionStatus(value: unknown): WorkspaceProviderResolutionStatus {
  if (value === "provider" || value === "folder" || value === "degraded") return value;
  throw protocolError("workspace resolution status is invalid");
}

function parseWorkspaceProviderDiagnostic(value: unknown, index: number): WorkspaceProviderDiagnostic {
  const label = `workspace provider diagnostic ${String(index + 1)}`;
  if (!isRecord(value)) throw protocolError(`${label} must be an object`);
  const code = parseWorkspaceProviderDiagnosticCode(value["code"], label);
  const tier = parseWorkspaceProviderTier(value["tier"], label);
  const pluginId = optionalPluginId(value, "pluginId", label);
  const pluginIds = value["pluginIds"] === undefined
    ? undefined
    : parsePluginIds(value["pluginIds"], `${label} pluginIds`);
  return Object.freeze({
    code,
    message: requireString(value, "message", label),
    tier,
    ...(pluginId === undefined ? {} : { pluginId }),
    ...(pluginIds === undefined ? {} : { pluginIds: Object.freeze(pluginIds) }),
  });
}

function parseWorkspaceProviderDiagnosticCode(value: unknown, label: string): WorkspaceProviderDiagnosticCode {
  if (value === "probe-failed" || value === "claim-conflict" || value === "list-failed") return value;
  throw protocolError(`${label} code is invalid`);
}

function parseWorkspaceProviderTier(value: unknown, label: string): WorkspaceProviderTier {
  if (value === "primary" || value === "fallback") return value;
  throw protocolError(`${label} tier is invalid`);
}

function parsePluginIds(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw protocolError(`${label} must be an array`);
  return value.map((pluginId, index) => {
    if (typeof pluginId !== "string" || !isPiWebPluginId(pluginId)) {
      throw protocolError(`${label} item ${String(index + 1)} is invalid`);
    }
    return pluginId;
  });
}

function parseWorkspaceList(value: unknown, projectId: string): WorkspaceListing[] {
  if (!Array.isArray(value) || value.length === 0) throw protocolError("workspace list must be a non-empty array");
  const ids = new Set<string>();
  const paths = new Set<string>();
  const workspaces = value.map((item, index) => parseWorkspace(item, `workspace list item ${String(index + 1)}`));
  let mainCount = 0;
  for (const workspace of workspaces) {
    if (workspace.projectId !== projectId) throw protocolError("workspace list contained a workspace for another project");
    if (ids.has(workspace.id)) throw protocolError(`workspace list contained duplicate id: ${workspace.id}`);
    if (paths.has(workspace.path)) throw protocolError(`workspace list contained duplicate path: ${workspace.path}`);
    ids.add(workspace.id);
    paths.add(workspace.path);
    if (workspace.isMain) mainCount += 1;
  }
  if (mainCount !== 1) throw protocolError("workspace list must contain exactly one main workspace");
  return workspaces;
}

function parseWorkspace(value: unknown, label: string): WorkspaceListing {
  if (!isRecord(value)) throw protocolError(`${label} must be an object`);
  const path = requireString(value, "path", label);
  if (!isAbsolute(path)) throw protocolError(`${label} path must be absolute`);
  const provider = value["provider"] === undefined ? undefined : parseProvider(value["provider"], label);
  const removal = value["removal"] === undefined ? undefined : parseRemoval(value["removal"], label);
  return Object.freeze({
    id: requireString(value, "id", label),
    projectId: requireString(value, "projectId", label),
    path,
    label: requireString(value, "label", label),
    isMain: requireBoolean(value, "isMain", label),
    ...(provider === undefined ? {} : { provider }),
    ...(removal === undefined ? {} : { removal }),
  });
}

function parseProvider(value: unknown, workspaceLabel: string): NonNullable<WorkspaceListing["provider"]> {
  const label = `${workspaceLabel} provider`;
  if (!isRecord(value)) throw protocolError(`${label} must be an object`);
  const capabilities = value["capabilities"];
  if (!isRecord(capabilities)) throw protocolError(`${label} capabilities must be an object`);
  const metadata = value["metadata"] === undefined ? undefined : parseJsonObject(value["metadata"], `${label} metadata`);
  return Object.freeze({
    pluginId: requirePluginId(value, "pluginId", label),
    capabilities: Object.freeze({
      request: requireBoolean(capabilities, "request", `${label} capabilities`),
      remove: requireBoolean(capabilities, "remove", `${label} capabilities`),
    }),
    ...(metadata === undefined ? {} : { metadata }),
  });
}

function parseRemoval(value: unknown, workspaceLabel: string): NonNullable<WorkspaceListing["removal"]> {
  const label = `${workspaceLabel} removal`;
  if (!isRecord(value)) throw protocolError(`${label} must be an object`);
  return Object.freeze({
    actionLabel: requireString(value, "actionLabel", label),
    confirmation: requireString(value, "confirmation", label),
    precondition: requireString(value, "precondition", label),
  });
}

function parseProviderRuntimeSnapshot(value: unknown): WorkspaceProviderRuntimeSnapshot {
  if (!isRecord(value)) throw protocolError("provider runtime response must be an object");
  if (value["protocolVersion"] !== WORKSPACE_PROVIDER_RUNTIME_PROTOCOL_VERSION) {
    throw protocolError("provider runtime protocol is unsupported; restart or upgrade the session daemon");
  }
  const safeStart = parseSafeStart(value["safeStart"]);
  const records = parseArray(value["records"], "provider runtime records", parseRuntimeRecord);
  const health = parseArray(value["health"], "provider runtime health", parseHealthInspection);
  const diagnostics = parseArray(value["diagnostics"], "provider runtime diagnostics", parseCatalogDiagnostic);
  return Object.freeze({
    protocolVersion: WORKSPACE_PROVIDER_RUNTIME_PROTOCOL_VERSION,
    ...(safeStart === undefined ? {} : { safeStart }),
    records: Object.freeze(records),
    health: Object.freeze(health),
    diagnostics: Object.freeze(diagnostics),
  });
}

function parseRuntimeRecord(value: unknown, index: number): ServerPluginRuntimeRecord {
  const label = `provider runtime record ${String(index + 1)}`;
  if (!isRecord(value)) throw protocolError(`${label} must be an object`);
  const state = value["state"];
  const scope = value["scope"];
  const phase = value["phase"];
  if (!isRuntimeState(state)) throw protocolError(`${label} state is invalid`);
  if (scope !== "bundled" && scope !== "local" && scope !== "user" && scope !== "project") {
    throw protocolError(`${label} scope is invalid`);
  }
  if (phase !== undefined && !isLifecyclePhase(phase)) throw protocolError(`${label} phase is invalid`);
  const name = optionalString(value, "name", label);
  const message = optionalString(value, "message", label);
  const browserRevision = optionalString(value, "browserRevision", label);
  return Object.freeze({
    pluginId: requirePluginId(value, "pluginId", label),
    source: requireString(value, "source", label),
    scope,
    moduleRevision: requireString(value, "moduleRevision", label),
    ...(browserRevision === undefined ? {} : { browserRevision }),
    settingsRevision: requireString(value, "settingsRevision", label),
    machineSpecific: requireBoolean(value, "machineSpecific", label),
    state,
    ...(name === undefined ? {} : { name }),
    ...(phase === undefined ? {} : { phase }),
    ...(message === undefined ? {} : { message }),
  });
}

function parseCatalogDiagnostic(value: unknown, index: number): PiWebPluginCatalogDiagnostic {
  const label = `provider runtime diagnostic ${String(index + 1)}`;
  if (!isRecord(value)) throw protocolError(`${label} must be an object`);
  const code = value["code"];
  if (!isCatalogDiagnosticCode(code)) throw protocolError(`${label} code is invalid`);
  const pluginId = optionalPluginId(value, "pluginId", label);
  return Object.freeze({
    code,
    source: requireString(value, "source", label),
    message: requireString(value, "message", label),
    ...(pluginId === undefined ? {} : { pluginId }),
  });
}

function parseHealthInspection(value: unknown, index: number): ServerPluginHealthInspection {
  const label = `provider runtime health item ${String(index + 1)}`;
  if (!isRecord(value)) throw protocolError(`${label} must be an object`);
  const phase = value["phase"];
  if (phase !== undefined && phase !== "health") throw protocolError(`${label} phase is invalid`);
  const error = optionalString(value, "error", label);
  return Object.freeze({
    pluginId: requirePluginId(value, "pluginId", label),
    health: parseHealth(value["health"], label),
    ...(phase === undefined ? {} : { phase }),
    ...(error === undefined ? {} : { error }),
  });
}

function parseHealth(value: unknown, inspectionLabel: string): ServerPluginHealth {
  const label = `${inspectionLabel} health`;
  if (!isRecord(value)) throw protocolError(`${label} must be an object`);
  const status = value["status"];
  if (status !== "healthy" && status !== "degraded" && status !== "unhealthy") {
    throw protocolError(`${label} status is invalid`);
  }
  const message = optionalString(value, "message", label);
  const details = value["details"] === undefined ? undefined : parseJsonObject(value["details"], `${label} details`);
  return Object.freeze({
    status,
    ...(message === undefined ? {} : { message }),
    ...(details === undefined ? {} : { details }),
  });
}

function parseSafeStart(value: unknown): ServerPluginSafeStart | undefined {
  if (value === undefined) return undefined;
  if (value === "bundled-only" || value === "none") return value;
  throw protocolError("provider runtime safeStart is invalid");
}

function parseArray<T>(value: unknown, label: string, parse: (item: unknown, index: number) => T): T[] {
  if (!Array.isArray(value)) throw protocolError(`${label} must be an array`);
  return value.map(parse);
}

function parseJsonObject(value: unknown, label: string): JsonObject {
  if (!isRecord(value)) throw protocolError(`${label} must be a JSON object`);
  const output = Object.fromEntries(
    Object.entries(value).map(([key, child]): [string, JsonValue] => [key, parseJsonValue(child, label)]),
  );
  Object.freeze(output);
  return output;
}

function parseJsonValue(value: unknown, label: string): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    const output = value.map((item) => parseJsonValue(item, label));
    Object.freeze(output);
    return output;
  }
  if (isRecord(value)) return parseJsonObject(value, label);
  throw protocolError(`${label} must contain only JSON values`);
}

function requireString(record: Record<string, unknown>, field: string, label: string): string {
  const value = record[field];
  if (typeof value !== "string" || value === "") throw protocolError(`${label} ${field} must be a non-empty string`);
  return value;
}

function optionalString(record: Record<string, unknown>, field: string, label: string): string | undefined {
  const value = record[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw protocolError(`${label} ${field} must be a string`);
  return value;
}

function requirePluginId(record: Record<string, unknown>, field: string, label: string): string {
  const value = requireString(record, field, label);
  if (!isPiWebPluginId(value)) throw protocolError(`${label} ${field} is invalid`);
  return value;
}

function optionalPluginId(record: Record<string, unknown>, field: string, label: string): string | undefined {
  const value = optionalString(record, field, label);
  if (value !== undefined && !isPiWebPluginId(value)) throw protocolError(`${label} ${field} is invalid`);
  return value;
}

function requireBoolean(record: Record<string, unknown>, field: string, label: string): boolean {
  const value = record[field];
  if (typeof value !== "boolean") throw protocolError(`${label} ${field} must be a boolean`);
  return value;
}

function isRuntimeState(value: unknown): value is ServerPluginRuntimeState {
  return value === "active" || value === "failed" || value === "incompatible" || value === "disabled";
}

function isLifecyclePhase(value: unknown): value is ServerPluginLifecyclePhase {
  return value === "import" || value === "activate" || value === "validate" || value === "start" || value === "health" || value === "stop";
}

function isCatalogDiagnosticCode(value: unknown): value is PiWebPluginCatalogDiagnosticCode {
  return value === "invalid-package" || value === "duplicate-id";
}

function encodedId(value: string, label: string): string {
  if (value === "") throw new Error(`${label} id must be a non-empty string`);
  return encodeURIComponent(value);
}

function workspaceCatalogRequestMessage(statusCode: number, body: string): string {
  const detail = responseError(body);
  if (statusCode < 500 && detail !== undefined) return detail;
  return `Session daemon workspace authority returned HTTP ${String(statusCode)}${detail === undefined ? "" : `: ${detail}`}`;
}

function responseError(body: string): string | undefined {
  const value = parseResponseBody(body);
  return isRecord(value) && typeof value["error"] === "string" ? value["error"] : undefined;
}

function isUnknownWorkspaceCatalogRoute(statusCode: number, body: string): boolean {
  if (statusCode !== 404) return false;
  const value = parseResponseBody(body);
  if (!isRecord(value)) return true;
  const error = value["error"];
  const message = value["message"];
  return error === "Not Found" || (typeof message === "string" && /^Route .* not found$/u.test(message));
}

function parseResponseBody(body: string): unknown {
  try {
    if (body === "") return undefined;
    const value: unknown = JSON.parse(body);
    return value;
  } catch {
    return undefined;
  }
}

function protocolError(message: string): WorkspaceCatalogProtocolError {
  return new WorkspaceCatalogProtocolError(`Invalid session daemon workspace authority response: ${message}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
