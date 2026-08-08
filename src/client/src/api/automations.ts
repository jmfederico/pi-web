import type {
  AutomationAttempt,
  AutomationAttemptStatus,
  AutomationDefinition,
  AutomationDraft,
  AutomationModelPolicy,
  AutomationModelsResponse,
  AutomationResponse,
  AutomationRun,
  AutomationRunResponse,
  AutomationRunsResponse,
  AutomationsResponse,
  AutomationRunStatus,
  AutomationScopeRequest,
  AutomationThinkingPolicy,
  AutomationTrigger,
  AutomationUsageSnapshot,
  SessionModel,
  UpdateAutomationRequest,
} from "../../../shared/apiTypes";
import { request } from "./http";

export const automationsApi = {
  definitions: (scope: AutomationScopeRequest, machineId = "local") => request(automationListPath(scope, machineId), parseAutomationsResponse),
  runs: (scope: AutomationScopeRequest, options?: { automationId?: string; limit?: number }, machineId = "local") => request(automationRunsPath(scope, options, machineId), parseAutomationRunsResponse),
  models: (machineId = "local") => request(`${machinePrefix(machineId)}/automation-models`, parseAutomationModelsResponse),
  create: (draft: AutomationDraft, machineId = "local") => request(`${machinePrefix(machineId)}/automations`, parseAutomationResponse, { method: "POST", body: JSON.stringify(draft) }),
  update: (automationId: string, input: UpdateAutomationRequest, machineId = "local") => request(`${machinePrefix(machineId)}/automations/${encodeURIComponent(automationId)}`, parseAutomationResponse, { method: "PATCH", body: JSON.stringify(input) }),
  delete: (automationId: string, scope: AutomationScopeRequest, machineId = "local") => request(`${machinePrefix(machineId)}/automations/${encodeURIComponent(automationId)}?${scopeQuery(scope)}`, parseDeleted, { method: "DELETE" }),
  runNow: (automationId: string, scope: AutomationScopeRequest, machineId = "local") => request(`${machinePrefix(machineId)}/automations/${encodeURIComponent(automationId)}/run`, parseAutomationRunResponse, { method: "POST", body: JSON.stringify(scope) }),
  cancel: (runId: string, scope: AutomationScopeRequest, machineId = "local") => request(`${machinePrefix(machineId)}/automation-runs/${encodeURIComponent(runId)}/cancel`, parseAutomationRunResponse, { method: "POST", body: JSON.stringify(scope) }),
};

function machinePrefix(machineId: string): string {
  return `api/machines/${encodeURIComponent(machineId)}`;
}

function automationListPath(scope: AutomationScopeRequest, machineId: string): string {
  return `${machinePrefix(machineId)}/automations?${scopeQuery(scope)}`;
}

function automationRunsPath(scope: AutomationScopeRequest, options: { automationId?: string; limit?: number } | undefined, machineId: string): string {
  const params = new URLSearchParams({ projectId: scope.projectId, workspaceId: scope.workspaceId });
  if (options?.automationId !== undefined) params.set("automationId", options.automationId);
  if (options?.limit !== undefined) params.set("limit", String(options.limit));
  return `${machinePrefix(machineId)}/automation-runs?${params.toString()}`;
}

function scopeQuery(scope: AutomationScopeRequest): string {
  return new URLSearchParams({ projectId: scope.projectId, workspaceId: scope.workspaceId }).toString();
}

export function parseAutomationsResponse(value: unknown): AutomationsResponse {
  const record = requireRecord(value);
  return { automations: requireArray(record["automations"], parseAutomationDefinition), generatedAt: requireString(record, "generatedAt") };
}

export function parseAutomationResponse(value: unknown): AutomationResponse {
  return { automation: parseAutomationDefinition(requireRecord(value)["automation"]) };
}

export function parseAutomationRunResponse(value: unknown): AutomationRunResponse {
  return { run: parseAutomationRun(requireRecord(value)["run"]) };
}

export function parseAutomationRunsResponse(value: unknown): AutomationRunsResponse {
  const record = requireRecord(value);
  const nextCursor = optionalString(record, "nextCursor");
  return {
    runs: requireArray(record["runs"], parseAutomationRun),
    ...(nextCursor === undefined ? {} : { nextCursor }),
    generatedAt: requireString(record, "generatedAt"),
  };
}

export function parseAutomationModelsResponse(value: unknown): AutomationModelsResponse {
  const record = requireRecord(value);
  const defaultModel = record["defaultModel"] === undefined ? undefined : parseSelectableModel(record["defaultModel"]);
  return {
    models: requireArray(record["models"], parseSelectableModel),
    ...(defaultModel === undefined ? {} : { defaultModel }),
    thinkingLevels: requireArray(record["thinkingLevels"], (entry) => requireStringValue(entry, "thinking level")),
    defaultTimeoutMs: requireInteger(record, "defaultTimeoutMs", 1),
    minTimeoutMs: requireInteger(record, "minTimeoutMs", 1),
    maxTimeoutMs: requireInteger(record, "maxTimeoutMs", 1),
  };
}

export function parseAutomationDefinition(value: unknown): AutomationDefinition {
  const record = requireRecord(value);
  const description = optionalString(record, "description");
  const testedRevision = optionalInteger(record, "testedRevision", 1);
  const nextRunAt = optionalString(record, "nextRunAt");
  return {
    id: requireString(record, "id"),
    projectId: requireString(record, "projectId"),
    workspaceId: requireString(record, "workspaceId"),
    workspacePath: requireString(record, "workspacePath"),
    name: requireString(record, "name"),
    ...(description === undefined ? {} : { description }),
    prompt: requireString(record, "prompt"),
    enabled: requireBoolean(record, "enabled"),
    revision: requireInteger(record, "revision", 1),
    ...(testedRevision === undefined ? {} : { testedRevision }),
    trigger: parseTrigger(record["trigger"]),
    model: parseModelPolicy(record["model"]),
    thinking: parseThinkingPolicy(record["thinking"]),
    timeoutMs: requireInteger(record, "timeoutMs", 1),
    abortGraceMs: requireInteger(record, "abortGraceMs", 0),
    ...(nextRunAt === undefined ? {} : { nextRunAt }),
    createdAt: requireString(record, "createdAt"),
    updatedAt: requireString(record, "updatedAt"),
  };
}

export function parseAutomationRun(value: unknown): AutomationRun {
  const record = requireRecord(value);
  const actualModel = record["actualModel"] === undefined ? undefined : parseSessionModel(record["actualModel"]);
  const actualThinkingLevel = optionalString(record, "actualThinkingLevel");
  const startedAt = optionalString(record, "startedAt");
  const completedAt = optionalString(record, "completedAt");
  const deadlineAt = optionalString(record, "deadlineAt");
  const cancelRequestedAt = optionalString(record, "cancelRequestedAt");
  const sessionId = optionalString(record, "sessionId");
  const reason = optionalString(record, "reason");
  const error = optionalString(record, "error");
  const usage = record["usage"] === undefined ? undefined : parseUsage(record["usage"]);
  const attempt = record["attempt"] === undefined ? undefined : parseAttempt(record["attempt"]);
  const cancellationKind = record["cancellationKind"];
  if (cancellationKind !== undefined && cancellationKind !== "user" && cancellationKind !== "timeout") throw new Error("Invalid automation cancellation kind");
  const source = record["source"];
  if (source !== "manual" && source !== "scheduled") throw new Error("Invalid automation run source");
  return {
    id: requireString(record, "id"),
    automationId: requireString(record, "automationId"),
    automationRevision: requireInteger(record, "automationRevision", 1),
    automationName: requireString(record, "automationName"),
    projectId: requireString(record, "projectId"),
    workspaceId: requireString(record, "workspaceId"),
    workspacePath: requireString(record, "workspacePath"),
    source,
    scheduledFor: requireString(record, "scheduledFor"),
    status: requireRunStatus(record["status"]),
    prompt: requireString(record, "prompt"),
    trigger: parseTrigger(record["trigger"]),
    configuredModel: parseModelPolicy(record["configuredModel"]),
    configuredThinking: parseThinkingPolicy(record["configuredThinking"]),
    ...(actualModel === undefined ? {} : { actualModel }),
    ...(actualThinkingLevel === undefined ? {} : { actualThinkingLevel }),
    timeoutMs: requireInteger(record, "timeoutMs", 1),
    queuedAt: requireString(record, "queuedAt"),
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(completedAt === undefined ? {} : { completedAt }),
    ...(deadlineAt === undefined ? {} : { deadlineAt }),
    ...(cancelRequestedAt === undefined ? {} : { cancelRequestedAt }),
    ...(cancellationKind === undefined ? {} : { cancellationKind }),
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(reason === undefined ? {} : { reason }),
    ...(error === undefined ? {} : { error }),
    ...(usage === undefined ? {} : { usage }),
    ...(attempt === undefined ? {} : { attempt }),
  };
}

function parseAttempt(value: unknown): AutomationAttempt {
  const record = requireRecord(value);
  const sessionId = optionalString(record, "sessionId");
  const startedAt = optionalString(record, "startedAt");
  const completedAt = optionalString(record, "completedAt");
  const error = optionalString(record, "error");
  const usage = record["usage"] === undefined ? undefined : parseUsage(record["usage"]);
  return {
    id: requireString(record, "id"),
    runId: requireString(record, "runId"),
    attemptNumber: requireInteger(record, "attemptNumber", 1),
    status: requireAttemptStatus(record["status"]),
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(completedAt === undefined ? {} : { completedAt }),
    ...(error === undefined ? {} : { error }),
    forceStopped: requireBoolean(record, "forceStopped"),
    ...(usage === undefined ? {} : { usage }),
  };
}

function parseUsage(value: unknown): AutomationUsageSnapshot {
  const record = requireRecord(value);
  const quality = record["quality"];
  if (quality !== "estimated" && quality !== "partial" && quality !== "provider_reported" && quality !== "unknown") throw new Error("Invalid automation usage quality");
  const scope = record["scope"];
  if (scope !== "root_session") throw new Error("Invalid automation usage scope");
  const tokens = requireRecord(record["tokens"]);
  const estimatedCostMicros = optionalInteger(record, "estimatedCostMicros", 0);
  return {
    scope,
    quality,
    tokens: {
      input: requireInteger(tokens, "input", 0),
      output: requireInteger(tokens, "output", 0),
      cacheRead: requireInteger(tokens, "cacheRead", 0),
      cacheWrite: requireInteger(tokens, "cacheWrite", 0),
      total: requireInteger(tokens, "total", 0),
    },
    ...(estimatedCostMicros === undefined ? {} : { estimatedCostMicros }),
    capturedAt: requireString(record, "capturedAt"),
  };
}

function parseTrigger(value: unknown): AutomationTrigger {
  const record = requireRecord(value);
  const type = requireString(record, "type");
  if (type === "manual") return { type };
  if (type === "once") return { type, at: requireString(record, "at") };
  if (type === "interval") return { type, intervalMs: requireInteger(record, "intervalMs", 1) };
  if (type === "cron") return { type, expression: requireString(record, "expression"), timeZone: requireString(record, "timeZone") };
  throw new Error("Invalid automation trigger");
}

function parseModelPolicy(value: unknown): AutomationModelPolicy {
  const record = requireRecord(value);
  const mode = requireString(record, "mode");
  if (mode === "default") return { mode };
  if (mode !== "fixed") throw new Error("Invalid automation model policy");
  const name = optionalString(record, "name");
  return {
    mode,
    provider: requireString(record, "provider"),
    id: requireString(record, "id"),
    ...(name === undefined ? {} : { name }),
  };
}

function parseThinkingPolicy(value: unknown): AutomationThinkingPolicy {
  const record = requireRecord(value);
  const mode = requireString(record, "mode");
  if (mode === "default") return { mode };
  if (mode === "fixed") return { mode, level: requireString(record, "level") };
  throw new Error("Invalid automation thinking policy");
}

function parseSessionModel(value: unknown): SessionModel {
  const record = requireRecord(value);
  const provider = optionalString(record, "provider");
  const id = optionalString(record, "id");
  const name = optionalString(record, "name");
  const contextWindow = optionalInteger(record, "contextWindow", 1);
  const reasoning = record["reasoning"];
  if (reasoning !== undefined && typeof reasoning !== "boolean") throw new Error("Expected reasoning to be a boolean");
  return {
    ...(provider === undefined ? {} : { provider }),
    ...(id === undefined ? {} : { id }),
    ...(name === undefined ? {} : { name }),
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(reasoning === undefined ? {} : { reasoning }),
  };
}

function parseSelectableModel(value: unknown): SessionModel {
  const model = parseSessionModel(value);
  if (model.provider === undefined || model.id === undefined) throw new Error("Automation model options require provider and id");
  const record = requireRecord(value);
  if (record["thinkingLevels"] === undefined) return model;
  return { ...model, thinkingLevels: requireArray(record["thinkingLevels"], (entry) => requireStringValue(entry, "thinking level")) };
}

function requireRunStatus(value: unknown): AutomationRunStatus {
  const statuses: readonly AutomationRunStatus[] = ["queued", "starting", "running", "cancelling", "completed", "failed", "cancelled", "timed_out", "skipped", "unknown"];
  const status = statuses.find((candidate) => candidate === value);
  if (status === undefined) throw new Error("Invalid automation run status");
  return status;
}

function requireAttemptStatus(value: unknown): AutomationAttemptStatus {
  const statuses: readonly AutomationAttemptStatus[] = ["starting", "running", "aborting", "completed", "failed", "cancelled", "timed_out", "unknown"];
  const status = statuses.find((candidate) => candidate === value);
  if (status === undefined) throw new Error("Invalid automation attempt status");
  return status;
}

function parseDeleted(value: unknown): { deleted: true } {
  if (requireRecord(value)["deleted"] !== true) throw new Error("Expected deleted response");
  return { deleted: true };
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Expected an object");
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireArray<T>(value: unknown, parse: (entry: unknown) => T): T[] {
  if (!Array.isArray(value)) throw new Error("Expected an array");
  return value.map(parse);
}

function requireString(record: Record<string, unknown>, key: string): string {
  return requireStringValue(record[key], key);
}

function requireStringValue(value: unknown, key: string): string {
  if (typeof value !== "string") throw new Error(`Expected ${key} to be a string`);
  return value;
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  return requireStringValue(value, key);
}

function requireNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Expected ${key} to be a number`);
  return value;
}

function requireInteger(record: Record<string, unknown>, key: string, minimum: number): number {
  const value = requireNumber(record, key);
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`Expected ${key} to be an integer of at least ${String(minimum)}`);
  return value;
}

function optionalInteger(record: Record<string, unknown>, key: string, minimum: number): number | undefined {
  return record[key] === undefined ? undefined : requireInteger(record, key, minimum);
}

function requireBoolean(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  if (typeof value !== "boolean") throw new Error(`Expected ${key} to be a boolean`);
  return value;
}
