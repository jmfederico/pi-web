import type { ArchiveSessionsResponse, AuthProviderOption, AuthProviderStatus, AuthProvidersResponse, AuthStatusSource, AuthType, CommandOption, CommandResult, DeleteWorkspaceFileResponse, FileContentResponse, FileSuggestion, FileTreeEntry, FileTreeResponse, GitDiffResponse, GitFileState, GitStatusFile, GitStatusResponse, Machine, MachineHealth, MachineKind, MachineRuntime, MachineStatus, MessagePage, ModelSelectionResponse, MoveWorkspaceFileResponse, OAuthFlowState, PiWebCapability, PiWebComponentStatus, PiWebConfigEnvOverrides, PiWebConfigResponse, PiWebConfigValues, PiWebInstallationInfo, PiWebPluginConfigMap, PiWebPluginInfo, PiWebPluginsResponse, PiWebPluginScope, PiWebReleaseStatus, PiWebRuntimeComponent, PiWebRuntimeResponse, PiWebServiceComponent, PiWebShortcutConfig, PiWebStatusMessage, PiWebStatusResponse, PiWebStatusSeverity, Project, QueuedSessionMessage, SavedPromptAttachment, SessionBulkArchiveResponse, SessionBulkDeleteArchivedResponse, SessionBulkFailure, SessionCleanupExecuteResponse, SessionCleanupPreviewResponse, SessionCleanupProjectSummary, SessionCleanupThresholds, SessionCleanupTotals, SessionInfo, SessionModel, SessionStatus, SlashCommand, TerminalCommandRun, TerminalCommandRunStatus, TerminalInfo, ThinkingLevelsResponse, WriteWorkspaceFileResponse, Workspace, WorkspaceActivity, WorkspaceActivityResponse } from "../../../shared/apiTypes";
import type { PiPackageInfo, PiPackageMutationAction, PiPackageMutationResponse, PiPackageScope, PiPackagesResponse } from "../../../shared/apiTypes";
import { parseKnownPiWebCapabilities } from "../../../shared/capabilities";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Expected object response");
  return value;
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") throw new Error(`Expected string field: ${key}`);
  return value;
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`Expected optional string field: ${key}`);
  return value;
}

function requireNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number") throw new Error(`Expected number field: ${key}`);
  return value;
}

function requireBoolean(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  if (typeof value !== "boolean") throw new Error(`Expected boolean field: ${key}`);
  return value;
}

export function arrayOf<T>(parse: (value: unknown) => T): (value: unknown) => T[] {
  return (value) => {
    if (!Array.isArray(value)) throw new Error("Expected array response");
    return value.map(parse);
  };
}

function parseUnknownArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("Expected array response");
  return value;
}

function arrayOfString(value: unknown, key: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) throw new Error(`Expected string array field: ${key}`);
  return value;
}

export function parseMessagePage(value: unknown): MessagePage {
  if (Array.isArray(value)) return { messages: value, start: 0, total: value.length };
  const record = requireRecord(value);
  return { messages: parseUnknownArray(record["messages"]), start: requireNumber(record, "start"), total: requireNumber(record, "total") };
}

export function parseMachinesResponse(value: unknown): Machine[] {
  const record = requireRecord(value);
  return arrayOf(parseMachine)(record["machines"]);
}

export function parseMachine(value: unknown): Machine {
  const record = requireRecord(value);
  const kind = requireMachineKind(record, "kind");
  const baseUrl = optionalString(record, "baseUrl");
  const status = optionalMachineStatus(record, "status");
  const statusMessage = optionalString(record, "statusMessage");
  return {
    id: requireString(record, "id"),
    name: requireString(record, "name"),
    kind,
    ...(baseUrl === undefined ? {} : { baseUrl }),
    createdAt: requireString(record, "createdAt"),
    updatedAt: requireString(record, "updatedAt"),
    ...(status === undefined ? {} : { status }),
    ...(statusMessage === undefined ? {} : { statusMessage }),
  };
}

export function parseMachineHealth(value: unknown): MachineHealth {
  const record = requireRecord(value);
  const status = optionalMachineStatus(record, "status");
  const error = optionalString(record, "error");
  return {
    machineId: requireString(record, "machineId"),
    ok: requireBoolean(record, "ok"),
    checkedAt: requireString(record, "checkedAt"),
    ...(status === undefined ? {} : { status }),
    ...(record["web"] === undefined ? {} : { web: parsePiWebComponentStatus(record["web"]) }),
    ...(record["sessiond"] === undefined ? {} : { sessiond: parsePiWebComponentStatus(record["sessiond"]) }),
    ...(error === undefined ? {} : { error }),
  };
}

export function parseMachineRuntime(value: unknown): MachineRuntime {
  const record = requireRecord(value);
  const error = optionalString(record, "error");
  return {
    machineId: requireString(record, "machineId"),
    ok: requireBoolean(record, "ok"),
    checkedAt: requireString(record, "checkedAt"),
    ...optionalField("packageName", optionalString(record, "packageName")),
    ...optionalField("generatedAt", optionalString(record, "generatedAt")),
    ...(record["components"] === undefined ? {} : { components: parsePiWebRuntimeComponents(record["components"]) }),
    ...(record["capabilities"] === undefined ? {} : { capabilities: parsePiWebCapabilities(record["capabilities"]) }),
    ...(error === undefined ? {} : { error }),
  };
}

function requireMachineKind(record: Record<string, unknown>, key: string): MachineKind {
  const value = requireString(record, key);
  if (value !== "local" && value !== "remote") throw new Error(`Expected machine kind field: ${key}`);
  return value;
}

function optionalMachineStatus(record: Record<string, unknown>, key: string): MachineStatus | undefined {
  const value = optionalString(record, key);
  if (value === undefined) return undefined;
  if (value !== "unknown" && value !== "online" && value !== "offline" && value !== "error") throw new Error(`Expected machine status field: ${key}`);
  return value;
}

export function parseProject(value: unknown): Project {
  const record = requireRecord(value);
  return { id: requireString(record, "id"), name: requireString(record, "name"), path: requireString(record, "path"), createdAt: requireString(record, "createdAt") };
}

export function parseWorkspace(value: unknown): Workspace {
  const record = requireRecord(value);
  const branch = optionalString(record, "branch");
  return {
    id: requireString(record, "id"),
    projectId: requireString(record, "projectId"),
    path: requireString(record, "path"),
    label: requireString(record, "label"),
    ...(branch === undefined ? {} : { branch }),
    isMain: requireBoolean(record, "isMain"),
    isGitRepo: requireBoolean(record, "isGitRepo"),
    isGitWorktree: requireBoolean(record, "isGitWorktree"),
    ...optionalField("effectiveConfig", optionalWorkspaceEffectiveConfig(record["effectiveConfig"])),
  };
}

function optionalWorkspaceEffectiveConfig(value: unknown): Workspace["effectiveConfig"] | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || Array.isArray(value)) throw new Error("Invalid workspace effectiveConfig field");
  return {
    ...optionalField("uploads", optionalUploads(value["uploads"])),
  };
}

export function parseSessionInfo(value: unknown): SessionInfo {
  const record = requireRecord(value);
  const name = optionalString(record, "name");
  const persisted = parseOptionalBoolean(record["persisted"], "persisted");
  const parentSessionPath = optionalString(record, "parentSessionPath");
  const archivedAt = optionalString(record, "archivedAt");
  return {
    id: requireString(record, "id"),
    path: requireString(record, "path"),
    cwd: requireString(record, "cwd"),
    ...(persisted === undefined ? {} : { persisted }),
    ...(name === undefined ? {} : { name }),
    created: requireString(record, "created"),
    modified: requireString(record, "modified"),
    messageCount: requireNumber(record, "messageCount"),
    firstMessage: requireString(record, "firstMessage"),
    ...(parentSessionPath === undefined ? {} : { parentSessionPath }),
    ...(record["archived"] === true ? { archived: true } : {}),
    ...(archivedAt === undefined ? {} : { archivedAt }),
  };
}

export function parseSessionStatus(value: unknown): SessionStatus {
  const record = requireRecord(value);
  return {
    sessionId: requireString(record, "sessionId"),
    ...optionalField("persisted", parseOptionalBoolean(record["persisted"], "persisted")),
    isStreaming: requireBoolean(record, "isStreaming"),
    isCompacting: requireBoolean(record, "isCompacting"),
    isBashRunning: requireBoolean(record, "isBashRunning"),
    pendingMessageCount: requireNumber(record, "pendingMessageCount"),
    queuedMessages: record["queuedMessages"] === undefined ? [] : arrayOf(parseQueuedSessionMessage)(record["queuedMessages"]),
    ...optionalField("messageCount", optionalNumber(record, "messageCount")),
    tokens: parseTokens(record["tokens"]),
    cost: requireNumber(record, "cost"),
    ...optionalModel(record["model"]),
    ...optionalContextUsage(record["contextUsage"]),
    ...optionalField("thinkingLevel", optionalString(record, "thinkingLevel")),
  };
}

export function parseSessionCleanupPreviewResponse(value: unknown): SessionCleanupPreviewResponse {
  const record = requireRecord(value);
  const skippedBusySessionIds = record["skippedBusySessionIds"] === undefined ? undefined : arrayOfString(record["skippedBusySessionIds"], "skippedBusySessionIds");
  return {
    generatedAt: requireString(record, "generatedAt"),
    thresholds: parseSessionCleanupThresholds(record["thresholds"]),
    projects: arrayOf(parseSessionCleanupProjectSummary)(record["projects"]),
    totals: parseSessionCleanupTotals(record["totals"]),
    ...(skippedBusySessionIds === undefined ? {} : { skippedBusySessionIds }),
  };
}

export function parseSessionCleanupExecuteResponse(value: unknown): SessionCleanupExecuteResponse {
  const record = requireRecord(value);
  return {
    ...parseSessionCleanupPreviewResponse(record),
    archivedSessionIds: arrayOfString(record["archivedSessionIds"], "archivedSessionIds"),
    deletedSessionIds: arrayOfString(record["deletedSessionIds"], "deletedSessionIds"),
  };
}

export function parseSessionBulkArchiveResponse(value: unknown): SessionBulkArchiveResponse {
  const record = requireRecord(value);
  if (record["archived"] !== true) throw new Error("Expected bulk archived response");
  return {
    archived: true,
    archivedSessionIds: arrayOfString(record["archivedSessionIds"], "archivedSessionIds"),
    failures: arrayOf(parseSessionBulkFailure)(record["failures"]),
    generatedAt: requireString(record, "generatedAt"),
  };
}

export function parseSessionBulkDeleteArchivedResponse(value: unknown): SessionBulkDeleteArchivedResponse {
  const record = requireRecord(value);
  if (record["deleted"] !== true) throw new Error("Expected bulk deleted response");
  return {
    deleted: true,
    deletedSessionIds: arrayOfString(record["deletedSessionIds"], "deletedSessionIds"),
    failures: arrayOf(parseSessionBulkFailure)(record["failures"]),
    generatedAt: requireString(record, "generatedAt"),
  };
}

function parseSessionBulkFailure(value: unknown): SessionBulkFailure {
  const record = requireRecord(value);
  return { sessionId: requireString(record, "sessionId"), error: requireString(record, "error") };
}

function parseSessionCleanupThresholds(value: unknown): SessionCleanupThresholds {
  const record = requireRecord(value);
  return {
    ...optionalField("archiveIdleDays", optionalNumber(record, "archiveIdleDays")),
    ...optionalField("deleteArchivedDays", optionalNumber(record, "deleteArchivedDays")),
  };
}

function parseSessionCleanupProjectSummary(value: unknown): SessionCleanupProjectSummary {
  const record = requireRecord(value);
  return {
    cwd: requireString(record, "cwd"),
    archiveCount: requireNumber(record, "archiveCount"),
    deleteCount: requireNumber(record, "deleteCount"),
  };
}

function parseSessionCleanupTotals(value: unknown): SessionCleanupTotals {
  const record = requireRecord(value);
  return {
    archiveCount: requireNumber(record, "archiveCount"),
    deleteCount: requireNumber(record, "deleteCount"),
  };
}

function parseQueuedSessionMessage(value: unknown): QueuedSessionMessage {
  const record = requireRecord(value);
  const kind = requireString(record, "kind");
  if (kind !== "steer" && kind !== "followUp") throw new Error("Invalid queued message kind");
  return { kind, text: requireString(record, "text") };
}

function parseTokens(value: unknown): SessionStatus["tokens"] {
  const record = requireRecord(value);
  return {
    input: requireNumber(record, "input"),
    output: requireNumber(record, "output"),
    cacheRead: requireNumber(record, "cacheRead"),
    cacheWrite: requireNumber(record, "cacheWrite"),
    total: requireNumber(record, "total"),
  };
}

function parseSessionModel(value: unknown): SessionModel {
  const record = requireRecord(value);
  return { ...optionalField("provider", optionalString(record, "provider")), ...optionalField("id", optionalString(record, "id")), ...optionalField("name", optionalString(record, "name")), ...optionalField("contextWindow", optionalNumber(record, "contextWindow")), ...optionalField("reasoning", record["reasoning"]) };
}

function optionalModel(value: unknown): Pick<SessionStatus, "model"> | object {
  if (value === undefined) return {};
  return { model: parseSessionModel(value) };
}

export function parseModelSelectionResponse(value: unknown): ModelSelectionResponse {
  const record = requireRecord(value);
  return { models: arrayOf(parseSessionModel)(record["models"]) };
}

function parseThinkingLevel(value: unknown): string {
  // pi owns the level set; accept any string so a newer pi runtime reporting an
  // unknown level degrades gracefully instead of failing the whole response.
  if (typeof value !== "string") throw new Error("Invalid thinking level");
  return value;
}

export function parseThinkingLevelsResponse(value: unknown): ThinkingLevelsResponse {
  const record = requireRecord(value);
  return { levels: arrayOf(parseThinkingLevel)(record["levels"]) };
}

function parseAuthType(value: unknown): AuthType {
  if (value !== "oauth" && value !== "api_key") throw new Error("Invalid auth type");
  return value;
}

function parseAuthStatusSource(value: unknown): AuthStatusSource {
  if (value !== "stored" && value !== "runtime" && value !== "environment" && value !== "fallback" && value !== "models_json_key" && value !== "models_json_command") throw new Error("Invalid auth status source");
  return value;
}

function parseAuthProviderStatus(value: unknown): AuthProviderStatus {
  const record = requireRecord(value);
  const source = record["source"] === undefined ? undefined : parseAuthStatusSource(record["source"]);
  return { configured: requireBoolean(record, "configured"), ...optionalField("source", source), ...optionalField("label", optionalString(record, "label")) };
}

function parseAuthProviderOption(value: unknown): AuthProviderOption {
  const record = requireRecord(value);
  return { id: requireString(record, "id"), name: requireString(record, "name"), authType: parseAuthType(record["authType"]), status: parseAuthProviderStatus(record["status"]) };
}

export function parseAuthProvidersResponse(value: unknown): AuthProvidersResponse {
  const record = requireRecord(value);
  return { providers: arrayOf(parseAuthProviderOption)(record["providers"]) };
}

export function parseOAuthFlowState(value: unknown): OAuthFlowState {
  const record = requireRecord(value);
  const flow = {
    flowId: requireString(record, "flowId"),
    providerId: requireString(record, "providerId"),
    providerName: requireString(record, "providerName"),
    status: parseOAuthFlowStatus(record["status"]),
    progress: arrayOf((item) => {
      if (typeof item !== "string") throw new Error("Expected progress item string");
      return item;
    })(record["progress"]),
    ...optionalField("error", optionalString(record, "error")),
    ...optionalField("auth", optionalOAuthAuth(record["auth"])),
    ...optionalField("prompt", optionalOAuthPrompt(record["prompt"])),
    ...optionalField("select", optionalOAuthSelect(record["select"])),
  };
  return flow;
}

function parseOAuthFlowStatus(value: unknown): OAuthFlowState["status"] {
  if (value !== "running" && value !== "complete" && value !== "error" && value !== "cancelled") throw new Error("Invalid OAuth flow status");
  return value;
}

function optionalOAuthAuth(value: unknown): OAuthFlowState["auth"] | undefined {
  if (value === undefined) return undefined;
  const record = requireRecord(value);
  return { url: requireString(record, "url"), ...optionalField("instructions", optionalString(record, "instructions")) };
}

function optionalOAuthPrompt(value: unknown): OAuthFlowState["prompt"] | undefined {
  if (value === undefined) return undefined;
  const record = requireRecord(value);
  const kind = requireString(record, "kind");
  if (kind !== "prompt" && kind !== "manual") throw new Error("Invalid OAuth prompt kind");
  return { requestId: requireString(record, "requestId"), message: requireString(record, "message"), kind, ...optionalField("placeholder", optionalString(record, "placeholder")), ...(record["allowEmpty"] === true ? { allowEmpty: true } : {}) };
}

function optionalOAuthSelect(value: unknown): OAuthFlowState["select"] | undefined {
  if (value === undefined) return undefined;
  const record = requireRecord(value);
  return { requestId: requireString(record, "requestId"), message: requireString(record, "message"), options: arrayOf(parseCommandOption)(record["options"]) };
}

function optionalContextUsage(value: unknown): Pick<SessionStatus, "contextUsage"> | object {
  if (value === undefined) return {};
  const record = requireRecord(value);
  return { contextUsage: { tokens: numberOrNull(record, "tokens"), contextWindow: requireNumber(record, "contextWindow"), percent: numberOrNull(record, "percent") } };
}

export function parseSlashCommand(value: unknown): SlashCommand {
  const record = requireRecord(value);
  const source = requireString(record, "source");
  if (source !== "extension" && source !== "prompt" && source !== "skill" && source !== "builtin") throw new Error("Invalid command source");
  return { name: requireString(record, "name"), source, ...optionalField("description", optionalString(record, "description")) };
}

export function parseFileSuggestion(value: unknown): FileSuggestion {
  const record = requireRecord(value);
  const kind = requireString(record, "kind");
  if (kind !== "tracked" && kind !== "untracked" && kind !== "other") throw new Error("Invalid file kind");
  return { path: requireString(record, "path"), kind };
}

export function parseFileTreeResponse(value: unknown): FileTreeResponse {
  const record = requireRecord(value);
  return { path: requireString(record, "path"), entries: arrayOf(parseFileTreeEntry)(record["entries"]), scannedAt: requireString(record, "scannedAt"), truncated: requireBoolean(record, "truncated") };
}

function parseFileTreeEntry(value: unknown): FileTreeEntry {
  const record = requireRecord(value);
  const type = requireString(record, "type");
  if (type !== "file" && type !== "directory" && type !== "symlink") throw new Error("Invalid file tree entry type");
  return { name: requireString(record, "name"), path: requireString(record, "path"), type, ...optionalField("size", optionalNumber(record, "size")), ...optionalField("modifiedAt", optionalString(record, "modifiedAt")) };
}

export function parseFileContentResponse(value: unknown): FileContentResponse {
  const record = requireRecord(value);
  const encoding = requireString(record, "encoding");
  if (encoding !== "utf8") throw new Error("Invalid file encoding");
  return { path: requireString(record, "path"), ...optionalField("language", optionalString(record, "language")), ...optionalField("mediaType", optionalFileMediaType(record["mediaType"])), ...optionalField("mimeType", optionalString(record, "mimeType")), encoding, size: requireNumber(record, "size"), modifiedAt: requireString(record, "modifiedAt"), content: requireString(record, "content"), truncated: requireBoolean(record, "truncated"), binary: requireBoolean(record, "binary") };
}

export function parseWriteWorkspaceFileResponse(value: unknown): WriteWorkspaceFileResponse {
  const record = requireRecord(value);
  return {
    path: requireString(record, "path"),
    size: requireNumber(record, "size"),
    modifiedAt: requireString(record, "modifiedAt"),
    created: requireBoolean(record, "created"),
  };
}

export function parseDeleteWorkspaceFileResponse(value: unknown): DeleteWorkspaceFileResponse {
  const record = requireRecord(value);
  return {
    path: requireString(record, "path"),
    existed: requireBoolean(record, "existed"),
  };
}

export function parseMoveWorkspaceFileResponse(value: unknown): MoveWorkspaceFileResponse {
  const record = requireRecord(value);
  return {
    fromPath: requireString(record, "fromPath"),
    toPath: requireString(record, "toPath"),
    size: requireNumber(record, "size"),
    modifiedAt: requireString(record, "modifiedAt"),
  };
}

function optionalFileMediaType(value: unknown): FileContentResponse["mediaType"] | undefined {
  if (value === undefined) return undefined;
  if (value !== "image") throw new Error("Invalid file media type");
  return value;
}

export function parseGitStatusResponse(value: unknown): GitStatusResponse {
  const record = requireRecord(value);
  return { isGitRepo: requireBoolean(record, "isGitRepo"), hash: requireString(record, "hash"), ...optionalField("branch", optionalString(record, "branch")), ...optionalField("upstream", optionalString(record, "upstream")), ...optionalField("ahead", optionalNumber(record, "ahead")), ...optionalField("behind", optionalNumber(record, "behind")), files: arrayOf(parseGitStatusFile)(record["files"]) };
}

function parseGitStatusFile(value: unknown): GitStatusFile {
  const record = requireRecord(value);
  return { path: requireString(record, "path"), ...optionalField("oldPath", optionalString(record, "oldPath")), index: parseGitFileState(record["index"]), workingTree: parseGitFileState(record["workingTree"]) };
}

function parseGitFileState(value: unknown): GitFileState {
  switch (value) {
    case "unmodified":
    case "modified":
    case "added":
    case "deleted":
    case "renamed":
    case "copied":
    case "untracked":
    case "ignored":
    case "conflicted":
      return value;
    default:
      throw new Error("Invalid git file state");
  }
}

export function parseGitDiffResponse(value: unknown): GitDiffResponse {
  const record = requireRecord(value);
  return { ...optionalField("path", optionalString(record, "path")), staged: requireBoolean(record, "staged"), hash: requireString(record, "hash"), diff: requireString(record, "diff"), truncated: requireBoolean(record, "truncated") };
}

export function parseTerminalInfo(value: unknown): TerminalInfo {
  const record = requireRecord(value);
  return { id: requireString(record, "id"), cwd: requireString(record, "cwd"), name: requireString(record, "name"), createdAt: requireString(record, "createdAt"), exited: requireBoolean(record, "exited"), ...optionalField("exitCode", optionalNumber(record, "exitCode")), ...optionalField("commandRunId", optionalString(record, "commandRunId")) };
}

export function parseTerminalCommandRun(value: unknown): TerminalCommandRun {
  const record = requireRecord(value);
  return {
    id: requireString(record, "id"),
    origin: requireString(record, "origin"),
    projectId: requireString(record, "projectId"),
    workspaceId: requireString(record, "workspaceId"),
    terminalId: requireString(record, "terminalId"),
    title: requireString(record, "title"),
    command: requireString(record, "command"),
    status: parseTerminalCommandRunStatus(record["status"]),
    ...optionalField("exitCode", optionalNumber(record, "exitCode")),
    createdAt: requireString(record, "createdAt"),
    ...optionalField("startedAt", optionalString(record, "startedAt")),
    ...optionalField("completedAt", optionalString(record, "completedAt")),
    metadata: parseStringRecord(record["metadata"], "metadata"),
  };
}

function parseTerminalCommandRunStatus(value: unknown): TerminalCommandRunStatus {
  if (value !== "queued" && value !== "running" && value !== "succeeded" && value !== "failed") throw new Error("Invalid terminal command run status");
  return value;
}

function parseStringRecord(value: unknown, key: string): Record<string, string> {
  const record = requireRecord(value);
  return Object.fromEntries(Object.entries(record).map(([field, fieldValue]) => {
    if (typeof fieldValue !== "string") throw new Error(`Expected string record field: ${key}.${field}`);
    return [field, fieldValue];
  }));
}

export function parseWorkspaceActivity(value: unknown): WorkspaceActivity {
  const record = requireRecord(value);
  return {
    cwd: requireString(record, "cwd"),
    hasSessionActivity: requireBoolean(record, "hasSessionActivity"),
    hasTerminalActivity: requireBoolean(record, "hasTerminalActivity"),
    updatedAt: requireString(record, "updatedAt"),
  };
}

export function parseWorkspaceActivityResponse(value: unknown): WorkspaceActivityResponse {
  const record = requireRecord(value);
  return { workspaces: arrayOf(parseWorkspaceActivity)(record["workspaces"]), generatedAt: requireString(record, "generatedAt") };
}

export function parsePiWebConfigResponse(value: unknown): PiWebConfigResponse {
  const record = requireRecord(value);
  return {
    path: requireString(record, "path"),
    exists: requireBoolean(record, "exists"),
    config: parsePiWebConfigValues(record["config"]),
    effectiveConfig: parsePiWebConfigValues(record["effectiveConfig"]),
    envOverrides: parsePiWebConfigEnvOverrides(record["envOverrides"]),
  };
}

function parsePiWebConfigValues(value: unknown): PiWebConfigValues {
  const record = requireRecord(value);
  return {
    ...optionalField("host", optionalString(record, "host")),
    ...optionalField("port", optionalNumber(record, "port")),
    ...optionalField("allowedHosts", optionalAllowedHosts(record["allowedHosts"])),
    ...optionalField("shortcuts", optionalShortcuts(record["shortcuts"])),
    ...optionalField("plugins", optionalPlugins(record["plugins"])),
    ...optionalField("pathAccess", optionalPathAccess(record["pathAccess"])),
    ...optionalField("uploads", optionalUploads(record["uploads"])),
    ...optionalField("maxUploadBytes", optionalNumber(record, "maxUploadBytes")),
    ...optionalField("spawnSessions", optionalBoolean(record, "spawnSessions")),
    ...optionalField("subsessions", optionalBoolean(record, "subsessions")),
  };
}

function optionalAllowedHosts(value: unknown): PiWebConfigValues["allowedHosts"] | undefined {
  if (value === undefined) return undefined;
  if (value === true) return true;
  if (isStringArray(value)) return value;
  throw new Error("Invalid PI WEB allowedHosts field");
}

function optionalPathAccess(value: unknown): PiWebConfigValues["pathAccess"] | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("Invalid PI WEB pathAccess field");
  const allowedPaths = value["allowedPaths"];
  return {
    ...optionalField("allowedPaths", optionalStringArray(allowedPaths, "pathAccess.allowedPaths")),
  };
}

function optionalStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (isNonEmptyStringArray(value)) return value;
  throw new Error(`Invalid PI WEB ${field} field`);
}

function optionalUploads(value: unknown): PiWebConfigValues["uploads"] | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || Array.isArray(value)) throw new Error("Invalid PI WEB uploads field");
  return {
    ...optionalField("defaultFolder", optionalString(value, "defaultFolder")),
  };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isNonEmptyStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item !== "");
}

function optionalShortcuts(value: unknown): PiWebShortcutConfig | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || Array.isArray(value)) throw new Error("Invalid PI WEB shortcuts field");
  return Object.fromEntries(Object.entries(value).map(([actionId, shortcut]) => {
    if (shortcut !== null && (typeof shortcut !== "string" || shortcut === "")) throw new Error("Invalid PI WEB shortcut field");
    return [actionId, shortcut];
  }));
}

function optionalPlugins(value: unknown): PiWebPluginConfigMap | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || Array.isArray(value)) throw new Error("Invalid PI WEB plugins field");
  return Object.fromEntries(Object.entries(value).map(([pluginId, config]) => {
    if (!isRecord(config) || Array.isArray(config)) throw new Error("Invalid PI WEB plugin config field");
    const enabled = config["enabled"];
    if (enabled !== undefined && typeof enabled !== "boolean") throw new Error("Invalid PI WEB plugin enabled field");
    const settings = config["settings"];
    if (settings !== undefined && (!isRecord(settings) || Array.isArray(settings))) throw new Error("Invalid PI WEB plugin settings field");
    return [pluginId, config];
  }));
}

function parsePiWebConfigEnvOverrides(value: unknown): PiWebConfigEnvOverrides {
  const record = requireRecord(value);
  return { host: requireBoolean(record, "host"), port: requireBoolean(record, "port"), allowedHosts: requireBoolean(record, "allowedHosts"), spawnSessions: requireBoolean(record, "spawnSessions"), subsessions: requireBoolean(record, "subsessions") };
}

export function parsePiPackagesResponse(value: unknown): PiPackagesResponse {
  const record = requireRecord(value);
  return { packages: arrayOf(parsePiPackageInfo)(record["packages"]) };
}

export function parsePiPackageMutationResponse(value: unknown): PiPackageMutationResponse {
  const record = requireRecord(value);
  const source = optionalString(record, "source");
  const scope = record["scope"] === undefined ? undefined : parsePiPackageScope(record["scope"]);
  const removed = parseOptionalBoolean(record["removed"], "removed");
  return {
    action: parsePiPackageMutationAction(record["action"]),
    ...optionalField("source", source),
    ...optionalField("scope", scope),
    ...optionalField("removed", removed),
    packages: arrayOf(parsePiPackageInfo)(record["packages"]),
  };
}

function parsePiPackageInfo(value: unknown): PiPackageInfo {
  const record = requireRecord(value);
  return {
    source: requireString(record, "source"),
    scope: parsePiPackageScope(record["scope"]),
    filtered: requireBoolean(record, "filtered"),
    ...optionalField("installedPath", optionalString(record, "installedPath")),
  };
}

function parsePiPackageScope(value: unknown): PiPackageScope {
  if (value !== "user" && value !== "project") throw new Error("Invalid Pi package scope");
  return value;
}

function parsePiPackageMutationAction(value: unknown): PiPackageMutationAction {
  if (value !== "install" && value !== "remove" && value !== "update") throw new Error("Invalid Pi package mutation action");
  return value;
}

export function parsePiWebPluginsResponse(value: unknown): PiWebPluginsResponse {
  const record = requireRecord(value);
  return { plugins: arrayOf(parsePiWebPluginInfo)(record["plugins"]) };
}

function parsePiWebPluginInfo(value: unknown): PiWebPluginInfo {
  const record = requireRecord(value);
  return {
    id: requireString(record, "id"),
    module: requireString(record, "module"),
    source: requireString(record, "source"),
    scope: parsePiWebPluginScope(record["scope"]),
    machineSpecific: parseOptionalBoolean(record["machineSpecific"], "machineSpecific") ?? false,
    enabled: requireBoolean(record, "enabled"),
  };
}

function parsePiWebPluginScope(value: unknown): PiWebPluginScope {
  if (value !== "bundled" && value !== "local" && value !== "user" && value !== "project") throw new Error("Invalid PI WEB plugin scope");
  return value;
}

function parseOptionalBoolean(value: unknown, key: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`Expected optional boolean field: ${key}`);
  return value;
}

export function parsePiWebStatusResponse(value: unknown): PiWebStatusResponse {
  const record = requireRecord(value);
  return {
    packageName: requireString(record, "packageName"),
    generatedAt: requireString(record, "generatedAt"),
    components: parsePiWebComponents(record["components"]),
    release: parsePiWebReleaseStatus(record["release"]),
    commands: parsePiWebCommands(record["commands"]),
    messages: arrayOf(parsePiWebStatusMessage)(record["messages"]),
  };
}

export function parsePiWebRuntimeResponse(value: unknown): PiWebRuntimeResponse {
  const record = requireRecord(value);
  return {
    packageName: requireString(record, "packageName"),
    generatedAt: requireString(record, "generatedAt"),
    components: parsePiWebRuntimeComponents(record["components"]),
    capabilities: parsePiWebCapabilities(record["capabilities"]),
  };
}

function parsePiWebComponents(value: unknown): PiWebStatusResponse["components"] {
  const record = requireRecord(value);
  return { web: parsePiWebComponentStatus(record["web"]), sessiond: parsePiWebComponentStatus(record["sessiond"]) };
}

function parsePiWebRuntimeComponents(value: unknown): PiWebRuntimeResponse["components"] {
  const record = requireRecord(value);
  return { web: parsePiWebRuntimeComponent(record["web"]), sessiond: parsePiWebRuntimeComponent(record["sessiond"]) };
}

function parsePiWebRuntimeComponent(value: unknown): PiWebRuntimeComponent {
  const record = requireRecord(value);
  return {
    component: parsePiWebServiceComponent(record["component"]),
    label: requireString(record, "label"),
    ...optionalField("runtimeVersion", optionalString(record, "runtimeVersion")),
    available: requireBoolean(record, "available"),
    capabilities: parsePiWebCapabilities(record["capabilities"]),
    ...optionalField("error", optionalString(record, "error")),
  };
}

function parsePiWebComponentStatus(value: unknown): PiWebComponentStatus {
  const record = requireRecord(value);
  return {
    component: parsePiWebServiceComponent(record["component"]),
    label: requireString(record, "label"),
    ...optionalField("runtimeVersion", optionalString(record, "runtimeVersion")),
    ...optionalField("installedVersion", optionalString(record, "installedVersion")),
    stale: requireBoolean(record, "stale"),
    available: requireBoolean(record, "available"),
    ...optionalField("installation", optionalPiWebInstallationInfo(record["installation"])),
    ...optionalField("error", optionalString(record, "error")),
  };
}

function optionalPiWebInstallationInfo(value: unknown): PiWebInstallationInfo | undefined {
  if (value === undefined) return undefined;
  const record = requireRecord(value);
  const kind = requireString(record, "kind");
  if (kind !== "pi-package" && kind !== "npm-global" && kind !== "local" && kind !== "docker" && kind !== "unknown") throw new Error("Invalid PI WEB installation kind");
  const scope = record["scope"];
  if (scope !== undefined && scope !== "user" && scope !== "project") throw new Error("Invalid PI WEB installation scope");
  const dockerMode = record["dockerMode"];
  if (dockerMode !== undefined && dockerMode !== "runtime" && dockerMode !== "dev") throw new Error("Invalid PI WEB Docker mode");
  return {
    kind,
    ...optionalField("path", optionalString(record, "path")),
    ...optionalField("source", optionalString(record, "source")),
    ...(scope === undefined ? {} : { scope }),
    ...optionalField("npmRoot", optionalString(record, "npmRoot")),
    ...(dockerMode === undefined ? {} : { dockerMode }),
  };
}

function parsePiWebReleaseStatus(value: unknown): PiWebReleaseStatus {
  const record = requireRecord(value);
  return {
    packageName: requireString(record, "packageName"),
    ...optionalField("latestVersion", optionalString(record, "latestVersion")),
    updateAvailable: requireBoolean(record, "updateAvailable"),
    ...optionalField("checkedAt", optionalString(record, "checkedAt")),
    ...(record["skipped"] === true ? { skipped: true } : {}),
    ...optionalField("error", optionalString(record, "error")),
  };
}

function parsePiWebCommands(value: unknown): PiWebStatusResponse["commands"] {
  const record = requireRecord(value);
  return {
    ...optionalField("update", optionalString(record, "update")),
    ...optionalField("restart", optionalString(record, "restart")),
    ...optionalField("restartWeb", optionalString(record, "restartWeb")),
    ...optionalField("restartSessiond", optionalString(record, "restartSessiond")),
    ...optionalField("status", optionalString(record, "status")),
  };
}

function parsePiWebStatusMessage(value: unknown): PiWebStatusMessage {
  const record = requireRecord(value);
  return {
    id: requireString(record, "id"),
    severity: parsePiWebStatusSeverity(record["severity"]),
    title: requireString(record, "title"),
    body: requireString(record, "body"),
    ...optionalField("command", optionalString(record, "command")),
  };
}

function parsePiWebServiceComponent(value: unknown): PiWebServiceComponent {
  if (value !== "web" && value !== "sessiond") throw new Error("Invalid PI WEB service component");
  return value;
}

function parsePiWebCapabilities(value: unknown): PiWebCapability[] {
  const capabilities = parseKnownPiWebCapabilities(value);
  if (capabilities === undefined) throw new Error("Invalid PI WEB capabilities");
  return capabilities;
}

function parsePiWebStatusSeverity(value: unknown): PiWebStatusSeverity {
  if (value !== "info" && value !== "warning" && value !== "error") throw new Error("Invalid PI WEB status severity");
  return value;
}

export function parseCommandResult(value: unknown): CommandResult {
  const record = requireRecord(value);
  const type = requireString(record, "type");
  if (type === "unsupported") return { type, message: requireString(record, "message") };
  if (type === "select") return { type, requestId: requireString(record, "requestId"), title: requireString(record, "title"), options: arrayOf(parseCommandOption)(record["options"]) };
  if (type === "done") return { type, ...optionalField("message", optionalString(record, "message")), ...optionalSession(record["session"]), ...optionalField("promptDraft", optionalString(record, "promptDraft")) };
  throw new Error("Invalid command result type");
}

function parseCommandOption(value: unknown): CommandOption {
  const record = requireRecord(value);
  return { value: requireString(record, "value"), label: requireString(record, "label"), ...optionalField("description", optionalString(record, "description")) };
}

function optionalSession(value: unknown): Pick<Extract<CommandResult, { type: "done" }>, "session"> | object {
  return value === undefined ? {} : { session: parseSessionInfo(value) };
}

export function parseAccepted(value: unknown): { accepted: true } {
  const record = requireRecord(value);
  if (record["accepted"] !== true) throw new Error("Expected accepted response");
  return { accepted: true };
}

export function parseSavedAttachments(value: unknown): SavedPromptAttachment[] {
  const record = requireRecord(value);
  return arrayOf(parseSavedAttachment)(record["attachments"]);
}

function parseSavedAttachment(value: unknown): SavedPromptAttachment {
  const record = requireRecord(value);
  return { path: requireString(record, "path"), mimeType: requireString(record, "mimeType"), size: requireNumber(record, "size") };
}

export function parseClosed(value: unknown): { closed: true } {
  const record = requireRecord(value);
  if (record["closed"] !== true) throw new Error("Expected closed response");
  return { closed: true };
}

export function parseAborted(value: unknown): { aborted: true } {
  const record = requireRecord(value);
  if (record["aborted"] !== true) throw new Error("Expected aborted response");
  return { aborted: true };
}

export function parseStopped(value: unknown): { stopped: true } {
  const record = requireRecord(value);
  if (record["stopped"] !== true) throw new Error("Expected stopped response");
  return { stopped: true };
}

export function parseArchived(value: unknown): ArchiveSessionsResponse {
  const record = requireRecord(value);
  if (record["archived"] !== true) throw new Error("Expected archived response");
  const sessionIds = record["sessionIds"] === undefined ? undefined : arrayOfString(record["sessionIds"], "sessionIds");
  const archivedCount = optionalNumber(record, "archivedCount");
  const skippedAlreadyArchivedCount = optionalNumber(record, "skippedAlreadyArchivedCount");
  return {
    archived: true,
    ...(sessionIds === undefined ? {} : { sessionIds }),
    ...(archivedCount === undefined ? {} : { archivedCount }),
    ...(skippedAlreadyArchivedCount === undefined ? {} : { skippedAlreadyArchivedCount }),
  };
}

export function parseRestored(value: unknown): { restored: true } {
  const record = requireRecord(value);
  if (record["restored"] !== true) throw new Error("Expected restored response");
  return { restored: true };
}

export function parseDeleted(value: unknown): { deleted: true } {
  const record = requireRecord(value);
  if (record["deleted"] !== true) throw new Error("Expected deleted response");
  return { deleted: true };
}

export function parseSubscribed(value: unknown): { subscribed: true } {
  const record = requireRecord(value);
  if (record["subscribed"] !== true) throw new Error("Expected subscribed response");
  return { subscribed: true };
}

export function parseUnsubscribed(value: unknown): { unsubscribed: true } {
  const record = requireRecord(value);
  if (record["unsubscribed"] !== true) throw new Error("Expected unsubscribed response");
  return { unsubscribed: true };
}

export function parseVapidPublicKeyResponse(value: unknown): { publicKey: string } {
  const record = requireRecord(value);
  return { publicKey: requireString(record, "publicKey") };
}

export function parseDetached(value: unknown): { detached: true } {
  const record = requireRecord(value);
  if (record["detached"] !== true) throw new Error("Expected detached response");
  return { detached: true };
}

export function parseReloaded(value: unknown): { reloaded: true } {
  const record = requireRecord(value);
  if (record["reloaded"] !== true) throw new Error("Expected reloaded response");
  return { reloaded: true };
}

function optionalBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`Invalid PI WEB ${key} field`);
  return value;
}

function optionalNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number") throw new Error(`Expected optional number field: ${key}`);
  return value;
}

function numberOrNull(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  if (value === null) return null;
  if (typeof value !== "number") throw new Error(`Expected number|null field: ${key}`);
  return value;
}

function optionalField(key: string, value: unknown): object {
  return value === undefined ? {} : { [key]: value };
}
