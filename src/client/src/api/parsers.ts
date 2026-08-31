import { PI_WEB_PLUGIN_LIFECYCLE_VERSION, ASK_USER_ID_MAX_LENGTH, ASK_USER_OPTION_LIMIT, ASK_USER_OTHER_TEXT_MAX_LENGTH, ASK_USER_QUESTION_LIMIT, ASK_USER_TEXT_MAX_LENGTH, EXTENSION_DIALOG_ID_MAX_LENGTH, EXTENSION_DIALOG_INPUT_MAX_LENGTH, EXTENSION_DIALOG_OPTION_LIMIT, EXTENSION_DIALOG_TEXT_MAX_LENGTH, SESSION_NOTIFICATION_LIMIT, SESSION_NOTIFICATION_MESSAGE_BYTES, SESSION_UNREAD_CATALOG_ID_MAX_LENGTH, SESSION_UNREAD_COMPLETED_AT_MAX_LENGTH, SESSION_UNREAD_CWD_MAX_LENGTH, SESSION_UNREAD_LIMIT, SESSION_UNREAD_SESSION_ID_MAX_LENGTH, type ArchiveSessionsResponse, type AskUserCloseReason, type AskUserCloseResponse, type AskUserOutcome, type AskUserQuestion, type AskUserQuestionOption, type AskUserQuestionRecord, type PendingAskUser, type PendingExtensionDialog, type AuthProviderOption, type AuthProviderStatus, type AuthProvidersResponse, type AuthStatusSource, type AuthType, type CommandOption, type CommandResult, type DeleteWorkspaceFileResponse, type ExtensionDialogAnswer, type ExtensionDialogCloseReason, type ExtensionDialogCloseResponse, type ExtensionDialogKind, type ExtensionDialogOutcome, type FileContentResponse, type FileSuggestion, type FileTreeEntry, type FileTreeResponse, type GlobalSessionEvent, type Machine, type MachineHealth, type MachineKind, type MachineRuntime, type MachineStatus, type MessagePage, type ModelSelectionResponse, type MoveWorkspaceFileResponse, type OAuthFlowState, type PiWebCapability, type PiWebComponentStatus, type PiWebConfigEnvOverrides, type PiWebConfigResponse, type PiWebConfigValues, type PiWebDeprecatedAgentInput, type PiWebInstallationInfo, type PiWebPluginConfigMap, type PiWebPluginInfo, type PiWebPluginsResponse, type PiWebPluginScope, type PiWebReleaseStatus, type PiWebRuntimeComponent, type PiWebRuntimeResponse, type PiWebServiceComponent, type PiWebShortcutConfig, type PiWebStatusMessage, type PiWebStatusResponse, type PiWebStatusSeverity, type Project, type QueuedSessionMessage, type SavedPromptAttachment, type SessionBulkArchiveResponse, type SessionBulkDeleteArchivedResponse, type SessionBulkFailure, type SessionCleanupExecuteResponse, type SessionCleanupPreviewResponse, type SessionCleanupProjectSummary, type SessionCleanupThresholds, type SessionCleanupTotals, type SessionInfo, type SessionModel, type SessionModelCatalogEntry, type SessionModelCatalogResponse, type SessionNotification, type SessionNotificationClearReason, type SessionNotificationDismissThrough, type SessionNotificationInboxDelta, type SessionNotificationInboxEvent, type SessionNotificationInboxSnapshot, type SessionNotificationSeverity, type SessionNotificationSummary, type SessionStatus, type SessionStreamSnapshot, type SessionUiEvent, type SessionUnreadCatalogSnapshot, type SessionUnreadEvent, type SessionUnreadSummary, type SessionWarning, type SessionWarningSeverity, type SlashCommand, type TerminalCommandRun, type TerminalCommandRunStatus, type TerminalInfo, type TerminalUiEvent, type ThinkingLevelsResponse, type WriteWorkspaceFileResponse, type Workspace, type WorkspaceEffectiveConfig, type WorkspaceTrustResponse } from "../../../shared/apiTypes";
import { parseMachineStatusSnapshot, type MachineStatusSnapshot, type MachineStatusUiEvent } from "../../../shared/machineStatus";
import type { JsonValue, PiPackageInfo, PiPackageInstallableSuggestion, PiPackageMutationAction, PiPackageMutationResponse, PiPackageScope, PiPackagesResponse, SessionActivity, SessionStartupProgressEvent, SessionTreeForkResult, SessionTreeNavigateResult, SessionTreeNode, SessionTreeNodeKind, SessionTreeSnapshot, WorkspaceProviderDiagnostic, WorkspaceProviderDiagnosticCode, WorkspaceProviderResolution, WorkspaceProviderResolutionStatus, WorkspaceProviderTier } from "../../../shared/apiTypes";

import { parseKnownPiWebCapabilities } from "../../../shared/capabilities";
import { parseDeprecatedAgentInputs } from "../../../shared/piWebStatusParsing";
import { PI_WEB_PLUGIN_RECOVERY_COMMANDS, pluginDisableRecoveryCommand } from "../../../shared/pluginRecoveryCommands";

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
    ...(record["deprecatedAgentInputs"] === undefined ? {} : { deprecatedAgentInputs: parseMachineDeprecatedAgentInputs(record["deprecatedAgentInputs"]) }),
    ...(error === undefined ? {} : { error }),
  };
}

function parseMachineDeprecatedAgentInputs(value: unknown): PiWebDeprecatedAgentInput[] {
  const inputs = parseDeprecatedAgentInputs(value);
  if (inputs === undefined) throw new Error("Invalid PI WEB deprecated agent inputs");
  return inputs;
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
  return Object.freeze({
    id: requireString(record, "id"),
    projectId: requireString(record, "projectId"),
    path: requireString(record, "path"),
    label: requireString(record, "label"),
    isMain: requireBoolean(record, "isMain"),
    ...optionalField("provider", optionalWorkspaceProviderMetadata(record["provider"])),
    ...optionalField("removal", optionalWorkspaceRemovalPresentation(record["removal"])),
    effectiveConfig: requireWorkspaceEffectiveConfig(record["effectiveConfig"]),
  });
}

export function parseWorkspaceProviderResolution(value: unknown): WorkspaceProviderResolution {
  const record = requireRecord(value);
  const status = parseWorkspaceProviderResolutionStatus(record["status"]);
  const projectId = requireString(record, "projectId");
  const ownerPluginId = optionalString(record, "ownerPluginId");
  if (status === "provider" && ownerPluginId === undefined) throw new Error("Provider workspace resolution is missing ownerPluginId");
  if (status === "folder" && ownerPluginId !== undefined) throw new Error("Folder workspace resolution must not include ownerPluginId");

  const workspaces = arrayOf(parseWorkspace)(record["workspaces"]);
  if (workspaces.length === 0 || workspaces.some((workspace) => workspace.projectId !== projectId)) {
    throw new Error("Workspace resolution contains invalid project workspaces");
  }
  const diagnostics = arrayOf(parseWorkspaceProviderDiagnostic)(record["diagnostics"]);
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
  throw new Error("Invalid workspace provider resolution status");
}

function parseWorkspaceProviderDiagnostic(value: unknown): WorkspaceProviderDiagnostic {
  const record = requireRecord(value);
  const pluginId = optionalString(record, "pluginId");
  const pluginIds = record["pluginIds"] === undefined
    ? undefined
    : arrayOfString(record["pluginIds"], "pluginIds");
  return Object.freeze({
    code: parseWorkspaceProviderDiagnosticCode(record["code"]),
    message: requireString(record, "message"),
    tier: parseWorkspaceProviderTier(record["tier"]),
    ...(pluginId === undefined ? {} : { pluginId }),
    ...(pluginIds === undefined ? {} : { pluginIds: Object.freeze(pluginIds) }),
  });
}

function parseWorkspaceProviderDiagnosticCode(value: unknown): WorkspaceProviderDiagnosticCode {
  if (value === "probe-failed" || value === "claim-conflict" || value === "list-failed") return value;
  throw new Error("Invalid workspace provider diagnostic code");
}

function parseWorkspaceProviderTier(value: unknown): WorkspaceProviderTier {
  if (value === "primary" || value === "fallback") return value;
  throw new Error("Invalid workspace provider diagnostic tier");
}

function optionalWorkspaceProviderMetadata(value: unknown): Workspace["provider"] | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || Array.isArray(value)) throw new Error("Invalid workspace provider field");
  const capabilities = value["capabilities"];
  if (!isRecord(capabilities) || Array.isArray(capabilities)) throw new Error("Invalid workspace provider capabilities field");
  const metadata = value["metadata"];
  return Object.freeze({
    pluginId: requireString(value, "pluginId"),
    capabilities: Object.freeze({
      request: requireBoolean(capabilities, "request"),
      remove: requireBoolean(capabilities, "remove"),
    }),
    ...optionalField("metadata", metadata === undefined ? undefined : parseJsonObject(metadata, "workspace provider metadata")),
  });
}

function optionalWorkspaceRemovalPresentation(value: unknown): Workspace["removal"] | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || Array.isArray(value)) throw new Error("Invalid workspace removal field");
  return Object.freeze({
    actionLabel: requireNonEmptyString(value, "actionLabel"),
    confirmation: requireNonEmptyString(value, "confirmation"),
    precondition: requireNonEmptyString(value, "precondition"),
  });
}

function parseJsonObject(value: unknown, field: string): NonNullable<NonNullable<Workspace["provider"]>["metadata"]> {
  if (!isRecord(value) || Array.isArray(value)) throw new Error(`Invalid ${field} field`);
  return Object.freeze(Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, parseJsonValue(item, field)]),
  ));
}

function parseJsonValue(value: unknown, field: string): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return Object.freeze(value.map((item) => parseJsonValue(item, field)));
  if (isRecord(value)) return parseJsonObject(value, field);
  throw new Error(`Invalid ${field} field`);
}

function requireWorkspaceEffectiveConfig(value: unknown): WorkspaceEffectiveConfig {
  if (!isRecord(value) || Array.isArray(value)) throw new Error("Expected workspace effectiveConfig field");
  const uploads = optionalUploads(value["uploads"]);
  const attachments = optionalAttachments(value["attachments"]);
  return Object.freeze({
    ...optionalField("uploads", uploads === undefined ? undefined : Object.freeze({ ...uploads })),
    ...optionalField("attachments", attachments === undefined ? undefined : Object.freeze({ ...attachments })),
  });
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

function parseSessionWarningSeverity(value: unknown): SessionWarningSeverity {
  if (value !== "info" && value !== "warning" && value !== "error") throw new Error("Invalid session warning severity");
  return value;
}

function parseSessionWarningDismiss(value: unknown): { id: string } | undefined {
  if (value === undefined) return undefined;
  const record = requireRecord(value);
  return { id: requireString(record, "id") };
}

function parseSessionWarning(value: unknown): SessionWarning {
  const record = requireRecord(value);
  const dismiss = parseSessionWarningDismiss(record["dismiss"]);
  return {
    severity: parseSessionWarningSeverity(record["severity"]),
    message: requireString(record, "message"),
    ...optionalField("source", optionalString(record, "source")),
    ...optionalField("path", optionalString(record, "path")),
    ...(dismiss === undefined ? {} : { dismiss }),
  };
}

function optionalWarnings(value: unknown): Pick<SessionStatus, "warnings"> | object {
  if (value === undefined) return {};
  return { warnings: arrayOf(parseSessionWarning)(value) };
}

function parseAskUserQuestionOption(value: unknown): AskUserQuestionOption {
  const record = requireRecord(value);
  return {
    value: requireBoundedNonEmptyString(record, "value", ASK_USER_ID_MAX_LENGTH),
    label: requireBoundedNonEmptyString(record, "label", ASK_USER_TEXT_MAX_LENGTH),
    ...optionalField("detail", optionalBoundedNonEmptyString(record, "detail", ASK_USER_TEXT_MAX_LENGTH)),
  };
}

function parseAskUserQuestion(value: unknown): AskUserQuestion {
  const record = requireRecord(value);
  const options = boundedArrayOf(record["options"], parseAskUserQuestionOption, ASK_USER_OPTION_LIMIT, "options");
  assertUniqueStrings(options.map((option) => option.value), "ask option value");
  const multiple = parseOptionalBoolean(record["multiple"], "multiple");
  return {
    id: requireBoundedNonEmptyString(record, "id", ASK_USER_ID_MAX_LENGTH),
    question: requireBoundedNonEmptyString(record, "question", ASK_USER_TEXT_MAX_LENGTH),
    ...optionalField("detail", optionalBoundedNonEmptyString(record, "detail", ASK_USER_TEXT_MAX_LENGTH)),
    options,
    ...(multiple === undefined ? {} : { multiple }),
  };
}

/**
 * Validate the session's open question set. A malformed ask must be dropped
 * rather than rendered: the card asks the user to answer on the model's behalf,
 * so questions or options the daemon did not really send must never appear.
 */
function parsePendingAskUser(value: unknown): PendingAskUser {
  const record = requireRecord(value);
  const questions = boundedArrayOf(record["questions"], parseAskUserQuestion, ASK_USER_QUESTION_LIMIT, "questions");
  if (questions.length === 0) throw new Error("Pending ask has no questions");
  assertUniqueStrings(questions.map((question) => question.id), "ask question id");
  return {
    askId: requireBoundedNonEmptyString(record, "askId", ASK_USER_ID_MAX_LENGTH),
    askedAt: requireNonEmptyString(record, "askedAt"),
    questions,
  };
}

function optionalPendingAsk(value: unknown): Pick<SessionStatus, "pendingAsk"> | object {
  if (value === undefined) return {};
  return { pendingAsk: parsePendingAskUser(value) };
}

export function parseSessionAskOpenedEvent(value: unknown): { type: "ask.opened"; ask: PendingAskUser } {
  const record = requireRecord(value);
  if (record["type"] !== "ask.opened") throw new Error("Invalid ask opened event type");
  return { type: "ask.opened", ask: parsePendingAskUser(record["ask"]) };
}

export function parseSessionAskClosedEvent(value: unknown): { type: "ask.closed"; askId: string; reason: AskUserCloseReason } {
  const record = requireRecord(value);
  if (record["type"] !== "ask.closed") throw new Error("Invalid ask closed event type");
  return {
    type: "ask.closed",
    askId: requireBoundedNonEmptyString(record, "askId", ASK_USER_ID_MAX_LENGTH),
    reason: parseAskUserCloseReason(record["reason"]),
  };
}

function parseAskUserCloseReason(value: unknown): AskUserCloseReason {
  if (value !== "submitted" && value !== "superseded" && value !== "cancelled") throw new Error("Invalid ask close reason");
  return value;
}

function parseAskUserQuestionRecord(value: unknown): AskUserQuestionRecord {
  const record = requireRecord(value);
  const question = parseAskUserQuestion(record["question"]);
  const values = boundedArrayOf(record["values"], parseNonEmptyString, ASK_USER_OPTION_LIMIT, "values");
  const offered = new Set(question.options.map((option) => option.value));
  if (values.some((selected) => !offered.has(selected))) throw new Error("Ask answer selected an option the question never offered");
  const otherText = optionalBoundedNonEmptyString(record, "otherText", ASK_USER_OTHER_TEXT_MAX_LENGTH);
  const answered = requireBoolean(record, "answered");
  // The record is the one thing both the model and the user read, so a flag that
  // disagrees with the answer it describes is rejected rather than displayed.
  if (answered !== (values.length > 0 || otherText !== undefined)) throw new Error("Ask answer contradicts its answered flag");
  return { question, answered, values, ...(otherText === undefined ? {} : { otherText }) };
}

export function parseAskUserOutcome(value: unknown): AskUserOutcome {
  const record = requireRecord(value);
  const questions = boundedArrayOf(record["questions"], parseAskUserQuestionRecord, ASK_USER_QUESTION_LIMIT, "questions");
  const answeredCount = requireNonNegativeSafeInteger(record, "answeredCount");
  const unansweredIds = arrayOfString(record["unansweredIds"], "unansweredIds");
  const unanswered = questions.filter((entry) => !entry.answered).map((entry) => entry.question.id);
  if (answeredCount !== questions.length - unanswered.length) throw new Error("Ask outcome answered count mismatch");
  if (unansweredIds.length !== unanswered.length || unansweredIds.some((id, index) => id !== unanswered[index])) {
    throw new Error("Ask outcome unanswered ids mismatch");
  }
  return {
    askId: requireBoundedNonEmptyString(record, "askId", ASK_USER_ID_MAX_LENGTH),
    reason: parseAskUserCloseReason(record["reason"]),
    askedAt: requireNonEmptyString(record, "askedAt"),
    closedAt: requireNonEmptyString(record, "closedAt"),
    questions,
    answeredCount,
    unansweredIds,
    summary: requireNonEmptyString(record, "summary"),
  };
}

export function parseAskUserCloseResponse(value: unknown): AskUserCloseResponse {
  const record = requireRecord(value);
  const result = record["result"];
  if (result !== "closed" && result !== "stale") throw new Error("Invalid ask close result");
  const outcome = record["outcome"] === undefined ? undefined : parseAskUserOutcome(record["outcome"]);
  // Only the call that actually closed the ask carries an outcome; a stale close
  // reports none and is trusted for the session status alone.
  if ((result === "closed") !== (outcome !== undefined)) throw new Error("Ask close response outcome mismatch");
  return {
    result,
    ...(outcome === undefined ? {} : { outcome }),
    sessionStatus: parseSessionStatus(record["sessionStatus"]),
  };
}

export function parseExtensionDialogCloseResponse(value: unknown): ExtensionDialogCloseResponse {
  const record = requireRecord(value);
  const result = record["result"];
  if (result !== "closed" && result !== "stale") throw new Error("Invalid dialog close result");
  const outcome = record["outcome"] === undefined ? undefined : parseExtensionDialogOutcome(record["outcome"]);
  // Only the call that actually closed the dialog carries an outcome; a stale
  // close reports none and is trusted for the session status alone.
  if ((result === "closed") !== (outcome !== undefined)) throw new Error("Dialog close response outcome mismatch");
  return {
    result,
    ...(outcome === undefined ? {} : { outcome }),
    sessionStatus: parseSessionStatus(record["sessionStatus"]),
  };
}

function assertUniqueStrings(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`Duplicate ${label}`);
}

function parseExtensionDialogKind(value: unknown): ExtensionDialogKind {
  if (value !== "confirm" && value !== "select" && value !== "input") throw new Error("Invalid extension dialog kind");
  return value;
}

function parseExtensionDialogCloseReason(value: unknown): ExtensionDialogCloseReason {
  if (value !== "answered" && value !== "cancelled" && value !== "timeout" && value !== "aborted" && value !== "session-ended") {
    throw new Error("Invalid extension dialog close reason");
  }
  return value;
}

function parseExtensionDialogAnswer(value: unknown): ExtensionDialogAnswer {
  if (typeof value === "boolean") return value;
  if (typeof value === "string" && value.length <= EXTENSION_DIALOG_INPUT_MAX_LENGTH) return value;
  throw new Error("Invalid extension dialog answer");
}

function parseExtensionDialogOption(value: unknown): string {
  const option = parseNonEmptyString(value);
  if (option.length > EXTENSION_DIALOG_TEXT_MAX_LENGTH) throw new Error("String field exceeds limit: option");
  return option;
}

/**
 * Validate one open extension dialog. A malformed dialog must be dropped rather
 * than rendered: the card parks an extension's blocking wait on the user's
 * answer, so a choice list or prompt the daemon did not really send must never
 * appear.
 */
function parsePendingExtensionDialog(value: unknown): PendingExtensionDialog {
  const record = requireRecord(value);
  const kind = parseExtensionDialogKind(record["kind"]);
  const options = record["options"] === undefined
    ? undefined
    : boundedArrayOf(record["options"], parseExtensionDialogOption, EXTENSION_DIALOG_OPTION_LIMIT, "options");
  if (options !== undefined) assertUniqueStrings(options, "dialog option");
  if (kind === "select" && (options === undefined || options.length === 0)) throw new Error("Select dialog has no options");
  return {
    dialogId: requireBoundedNonEmptyString(record, "dialogId", EXTENSION_DIALOG_ID_MAX_LENGTH),
    kind,
    title: requireBoundedNonEmptyString(record, "title", EXTENSION_DIALOG_TEXT_MAX_LENGTH),
    ...optionalField("message", optionalBoundedNonEmptyString(record, "message", EXTENSION_DIALOG_TEXT_MAX_LENGTH)),
    ...(options === undefined ? {} : { options }),
    ...optionalField("placeholder", optionalBoundedNonEmptyString(record, "placeholder", EXTENSION_DIALOG_TEXT_MAX_LENGTH)),
    askedAt: requireNonEmptyString(record, "askedAt"),
    ...optionalField("timeoutAt", optionalNonEmptyString(record, "timeoutAt")),
    runScoped: requireBoolean(record, "runScoped"),
  };
}

function optionalPendingDialogs(value: unknown): Pick<SessionStatus, "pendingDialogs"> | object {
  if (value === undefined) return {};
  const dialogs = arrayOf(parsePendingExtensionDialog)(value);
  assertUniqueStrings(dialogs.map((dialog) => dialog.dialogId), "dialog id");
  return { pendingDialogs: dialogs };
}

export function parseSessionDialogOpenedEvent(value: unknown): { type: "dialog.opened"; dialog: PendingExtensionDialog } {
  const record = requireRecord(value);
  if (record["type"] !== "dialog.opened") throw new Error("Invalid dialog opened event type");
  return { type: "dialog.opened", dialog: parsePendingExtensionDialog(record["dialog"]) };
}

export function parseSessionDialogClosedEvent(value: unknown): { type: "dialog.closed"; dialogId: string; reason: ExtensionDialogCloseReason; answer?: ExtensionDialogAnswer } {
  const record = requireRecord(value);
  if (record["type"] !== "dialog.closed") throw new Error("Invalid dialog closed event type");
  const reason = parseExtensionDialogCloseReason(record["reason"]);
  const answer = record["answer"] === undefined ? undefined : parseExtensionDialogAnswer(record["answer"]);
  // Only an answered close carries a value; any other combination cannot be
  // rendered honestly as the dialog's result.
  if ((reason === "answered") !== (answer !== undefined)) throw new Error("Dialog closed event answer mismatch");
  return {
    type: "dialog.closed",
    dialogId: requireBoundedNonEmptyString(record, "dialogId", EXTENSION_DIALOG_ID_MAX_LENGTH),
    reason,
    ...(answer === undefined ? {} : { answer }),
  };
}

export function parseExtensionDialogOutcome(value: unknown): ExtensionDialogOutcome {
  const record = requireRecord(value);
  const reason = parseExtensionDialogCloseReason(record["reason"]);
  const answer = record["answer"] === undefined ? undefined : parseExtensionDialogAnswer(record["answer"]);
  if ((reason === "answered") !== (answer !== undefined)) throw new Error("Dialog outcome answer mismatch");
  return {
    dialogId: requireBoundedNonEmptyString(record, "dialogId", EXTENSION_DIALOG_ID_MAX_LENGTH),
    reason,
    ...(answer === undefined ? {} : { answer }),
    askedAt: requireNonEmptyString(record, "askedAt"),
    closedAt: requireNonEmptyString(record, "closedAt"),
  };
}

function optionalNonEmptyString(record: Record<string, unknown>, key: string): string | undefined {
  const value = optionalString(record, key);
  if (value === undefined) return undefined;
  if (value === "") throw new Error(`Expected non-empty string field: ${key}`);
  return value;
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
    ...optionalWarnings(record["warnings"]),
    ...optionalPendingAsk(record["pendingAsk"]),
    ...optionalPendingDialogs(record["pendingDialogs"]),
  };
}

export function parseSessionStreamSnapshot(value: unknown): SessionStreamSnapshot {
  const record = requireRecord(value);
  return {
    seq: requireNumber(record, "seq"),
    partial: record["partial"] ?? null,
  };
}

export function parseSessionUnreadCatalogSnapshot(value: unknown): SessionUnreadCatalogSnapshot {
  const record = requireRecord(value);
  const catalogRevision = requireNonNegativeSafeInteger(record, "catalogRevision");
  const sessions = boundedArrayOf(record["sessions"], parseSessionUnreadSummary, SESSION_UNREAD_LIMIT, "sessions");
  assertUniqueUnreadSummaries(sessions);
  assertUnreadNewestFirst(sessions);
  if (sessions.some((summary) => summary.completionOrder > catalogRevision)) {
    throw new Error("Session unread completion order exceeds catalog revision");
  }
  return {
    catalogId: requireBoundedNonEmptyString(record, "catalogId", SESSION_UNREAD_CATALOG_ID_MAX_LENGTH),
    catalogRevision,
    sessions,
  };
}

export function parseSessionUnreadEvent(value: unknown): SessionUnreadEvent {
  const record = requireRecord(value);
  if (record["type"] !== "sessions.unread") throw new Error("Invalid session unread event type");
  const sessionId = requireBoundedNonEmptyString(record, "sessionId", SESSION_UNREAD_SESSION_ID_MAX_LENGTH);
  const cwd = requireBoundedNonEmptyString(record, "cwd", SESSION_UNREAD_CWD_MAX_LENGTH);
  const catalogRevision = requirePositiveSafeInteger(record, "catalogRevision");
  const unread = record["unread"] === null ? null : parseSessionUnreadSummary(record["unread"]);
  if (unread !== null && (unread.sessionId !== sessionId || unread.cwd !== cwd)) {
    throw new Error("Session unread event identity mismatch");
  }
  if (unread !== null && unread.completionOrder > catalogRevision) {
    throw new Error("Session unread completion order exceeds catalog revision");
  }
  return {
    type: "sessions.unread",
    catalogId: requireBoundedNonEmptyString(record, "catalogId", SESSION_UNREAD_CATALOG_ID_MAX_LENGTH),
    catalogRevision,
    sessionId,
    cwd,
    unread,
  };
}

/**
 * Validate a startup progress frame. The browser substitutes its own wording
 * from this event, so a malformed frame must be dropped rather than rendered:
 * `startupToken` is the routing key when present, and an activity missing its
 * phase or label could otherwise blank out or freeze the text a user is reading
 * while they wait. An absent token is valid — an open routes by session id — but
 * a present empty one is not, since it could match no row honestly.
 */
export function parseSessionStartupProgressEvent(value: unknown): SessionStartupProgressEvent {
  const record = requireRecord(value);
  if (record["type"] !== "session.startup") throw new Error("Invalid session startup event type");
  const startupToken = optionalString(record, "startupToken");
  if (startupToken === "") throw new Error("Expected non-empty string field: startupToken");
  return {
    type: "session.startup",
    ...optionalField("startupToken", startupToken),
    activity: parseSessionActivity(record["activity"]),
  };
}

function parseSessionActivity(value: unknown): SessionActivity {
  const record = requireRecord(value);
  return {
    sessionId: requireNonEmptyString(record, "sessionId"),
    phase: requireSessionActivityPhase(record, "phase"),
    label: requireNonEmptyString(record, "label"),
    ...optionalField("detail", optionalString(record, "detail")),
    at: requireNonEmptyString(record, "at"),
    ...optionalField("startup", optionalActivityStartupMarker(record)),
  };
}

/**
 * The startup marker says the activity is a session opening rather than work in
 * progress, which decides whether "Stop Active Work" is offered and whether a
 * reload is blocked. A malformed marker is rejected rather than guessed at.
 */
function optionalActivityStartupMarker(record: Record<string, unknown>): boolean | undefined {
  const value = record["startup"];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error("Expected optional boolean field: startup");
  return value;
}

function requireSessionActivityPhase(record: Record<string, unknown>, key: string): SessionActivity["phase"] {
  const value = requireString(record, key);
  if (value !== "active" && value !== "idle" && value !== "error") throw new Error(`Expected session activity phase field: ${key}`);
  return value;
}

/**
 * Socket stream frame validation. The session and realtime sockets accept only
 * the frame types validated here: these frames render transcript content,
 * status, and workspace state straight into the UI, so a malformed frame must
 * be dropped at the socket boundary rather than trusted on its type name
 * alone. Each validator rebuilds the event from checked fields only, so stray
 * fields do not pass the boundary either.
 */
export function parseSessionStreamEvent(value: unknown): SessionUiEvent {
  const record = requireRecord(value);
  switch (record["type"]) {
    case "message.append":
      // The message payload is a projected Pi message; only its presence is
      // guaranteed at this boundary.
      return { type: "message.append", message: requirePresent(record, "message") };
    case "assistant.delta":
      return { type: "assistant.delta", text: requireString(record, "text") };
    case "assistant.thinking.delta":
      return { type: "assistant.thinking.delta", text: requireString(record, "text") };
    case "tool.start":
      return {
        type: "tool.start",
        toolName: requireString(record, "toolName"),
        toolCallId: requireString(record, "toolCallId"),
        summary: requireString(record, "summary"),
        ...optionalField("args", record["args"]),
      };
    case "tool.update":
      return {
        type: "tool.update",
        toolName: requireString(record, "toolName"),
        toolCallId: requireString(record, "toolCallId"),
        text: requireString(record, "text"),
        ...optionalField("content", record["content"]),
        ...optionalField("details", record["details"]),
      };
    case "tool.end":
      return {
        type: "tool.end",
        toolName: requireString(record, "toolName"),
        toolCallId: requireString(record, "toolCallId"),
        text: requireString(record, "text"),
        isError: requireBoolean(record, "isError"),
        ...optionalField("content", record["content"]),
        ...optionalField("details", record["details"]),
      };
    case "shell.start":
      return {
        type: "shell.start",
        command: requireString(record, "command"),
        ...optionalField("excludeFromContext", parseOptionalBoolean(record["excludeFromContext"], "excludeFromContext")),
      };
    case "shell.chunk":
      return { type: "shell.chunk", chunk: requireString(record, "chunk") };
    case "shell.end":
      return {
        type: "shell.end",
        ...optionalField("output", optionalString(record, "output")),
        ...optionalField("exitCode", optionalNumberOrNull(record, "exitCode")),
        ...optionalField("cancelled", parseOptionalBoolean(record["cancelled"], "cancelled")),
        ...optionalField("truncated", parseOptionalBoolean(record["truncated"], "truncated")),
        ...optionalField("fullOutputPath", optionalString(record, "fullOutputPath")),
        ...optionalField("isError", parseOptionalBoolean(record["isError"], "isError")),
      };
    case "agent.start":
      return { type: "agent.start" };
    case "agent.end":
      return { type: "agent.end" };
    case "message.end":
      return { type: "message.end", ...optionalField("message", record["message"]) };
    case "status.update":
      return { type: "status.update", status: parseSessionStatus(record["status"]) };
    case "activity.update":
      return { type: "activity.update", activity: parseSessionActivity(record["activity"]) };
    case "command.output":
      return parseCommandOutputEvent(record);
    case "session.error":
      return { type: "session.error", message: requireString(record, "message") };
    case "session.name":
      return parseSessionNameEvent(record);
    case "session.created":
      return { type: "session.created", session: parseSessionInfo(record["session"]) };
    case "pi.event":
      return { type: "pi.event", eventType: requireString(record, "eventType") };
    default:
      throw new Error("Unsupported session stream event type");
  }
}

type RealtimeStreamEvent =
  | Extract<GlobalSessionEvent, { type: "status.update" | "activity.update" | "session.name" | "session.created" | "models.changed" }>
  | TerminalUiEvent
  | MachineStatusUiEvent;

export function parseRealtimeStreamEvent(value: unknown): RealtimeStreamEvent {
  const record = requireRecord(value);
  switch (record["type"]) {
    case "status.update":
      return { type: "status.update", status: parseSessionStatus(record["status"]) };
    case "activity.update":
      return { type: "activity.update", activity: parseSessionActivity(record["activity"]) };
    case "session.name":
      return parseSessionNameEvent(record);
    case "session.created":
      return { type: "session.created", session: parseSessionInfo(record["session"]) };
    case "models.changed":
      return { type: "models.changed", revision: requireNonNegativeSafeInteger(record, "revision") };
    case "terminal.created":
      return { type: "terminal.created", terminal: parseTerminalInfo(record["terminal"]) };
    case "terminal.exited":
      return { type: "terminal.exited", terminal: parseTerminalInfo(record["terminal"]) };
    case "terminal.closed":
      return {
        type: "terminal.closed",
        terminalId: requireNonEmptyString(record, "terminalId"),
        cwd: requireNonEmptyString(record, "cwd"),
      };
    case "machine.status":
      return { type: "machine.status", status: requireMachineStatusSnapshot(record["status"]) };
    default:
      throw new Error("Unsupported realtime stream event type");
  }
}

function requirePresent(record: Record<string, unknown>, key: string): unknown {
  const value = record[key];
  if (value === undefined) throw new Error(`Expected field: ${key}`);
  return value;
}

function optionalNumberOrNull(record: Record<string, unknown>, key: string): number | null | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "number") throw new Error(`Expected optional number|null field: ${key}`);
  return value;
}

function parseCommandOutputEvent(record: Record<string, unknown>): Extract<SessionUiEvent, { type: "command.output" }> {
  const level = requireString(record, "level");
  if (level !== "info" && level !== "success" && level !== "error") throw new Error("Invalid command output level");
  return {
    type: "command.output",
    level,
    message: requireString(record, "message"),
  };
}

function parseSessionNameEvent(record: Record<string, unknown>): Extract<SessionUiEvent, { type: "session.name" }> {
  return {
    type: "session.name",
    sessionId: requireNonEmptyString(record, "sessionId"),
    ...optionalField("name", optionalString(record, "name")),
  };
}

function parseSessionUnreadSummary(value: unknown): SessionUnreadSummary {
  const record = requireRecord(value);
  const completedAt = requireBoundedNonEmptyString(
    record,
    "completedAt",
    SESSION_UNREAD_COMPLETED_AT_MAX_LENGTH,
  );
  const completedDate = new Date(completedAt);
  if (!Number.isFinite(completedDate.getTime()) || completedDate.toISOString() !== completedAt) {
    throw new Error("Invalid canonical session unread completion time");
  }
  return {
    sessionId: requireBoundedNonEmptyString(record, "sessionId", SESSION_UNREAD_SESSION_ID_MAX_LENGTH),
    cwd: requireBoundedNonEmptyString(record, "cwd", SESSION_UNREAD_CWD_MAX_LENGTH),
    completionOrder: requirePositiveSafeInteger(record, "completionOrder"),
    completedAt,
  };
}

function assertUniqueUnreadSummaries(summaries: readonly SessionUnreadSummary[]): void {
  const identities = summaries.map((summary) => JSON.stringify([summary.sessionId, summary.cwd]));
  if (new Set(identities).size !== identities.length) throw new Error("Duplicate session unread identity");
  const completionOrders = summaries.map((summary) => summary.completionOrder);
  if (new Set(completionOrders).size !== completionOrders.length) throw new Error("Duplicate session unread completion order");
}

function assertUnreadNewestFirst(summaries: readonly SessionUnreadSummary[]): void {
  for (let index = 1; index < summaries.length; index += 1) {
    const previous = summaries[index - 1];
    const current = summaries[index];
    if (previous === undefined || current === undefined || previous.completionOrder <= current.completionOrder) {
      throw new Error("Session unread summaries are not newest-first");
    }
  }
}

function requireBoundedNonEmptyString(record: Record<string, unknown>, key: string, maxLength: number): string {
  const value = requireNonEmptyString(record, key);
  if (value.length > maxLength) throw new Error(`String field exceeds limit: ${key}`);
  return value;
}

function optionalBoundedNonEmptyString(record: Record<string, unknown>, key: string, maxLength: number): string | undefined {
  const value = optionalString(record, key);
  if (value === undefined) return undefined;
  if (value === "") throw new Error(`Expected non-empty string field: ${key}`);
  if (value.length > maxLength) throw new Error(`String field exceeds limit: ${key}`);
  return value;
}

function requirePositiveSafeInteger(record: Record<string, unknown>, key: string): number {
  const value = requireNonNegativeSafeInteger(record, key);
  if (value === 0) throw new Error(`Expected positive safe integer field: ${key}`);
  return value;
}

export function parseSessionNotificationInboxSnapshot(value: unknown): SessionNotificationInboxSnapshot {
  const record = requireRecord(value);
  const summary = parseSessionNotificationSummary(record["summary"]);
  const notifications = boundedArrayOf(record["notifications"], parseSessionNotification, SESSION_NOTIFICATION_LIMIT, "notifications");
  assertUniqueNotifications(notifications);
  assertNewestFirst(notifications);
  if (summary.retainedCount !== notifications.length) throw new Error("Notification snapshot retained count mismatch");
  if (summary.highestSeverity !== highestNotificationSeverity(notifications)) throw new Error("Notification snapshot severity mismatch");
  const dismissThrough = parseSessionNotificationDismissThrough(record["dismissThrough"]);
  const newestOrder = notifications[0]?.order ?? 0;
  if (dismissThrough.order !== newestOrder) throw new Error("Notification snapshot dismiss cutoff mismatch");
  if (dismissThrough.overflowWatermark < summary.discardedCount) throw new Error("Notification snapshot overflow cutoff mismatch");
  return {
    daemonInstanceId: requireNonEmptyString(record, "daemonInstanceId"),
    catalogRevision: requireNonNegativeSafeInteger(record, "catalogRevision"),
    summary,
    notifications,
    dismissThrough,
  };
}

export function parseSessionNotificationInboxEvent(value: unknown): SessionNotificationInboxEvent {
  const record = requireRecord(value);
  if (record["type"] !== "notifications.inbox") throw new Error("Invalid notification inbox event type");
  const summary = parseSessionNotificationSummary(record["summary"]);
  const dismissThrough = parseSessionNotificationDismissThrough(record["dismissThrough"]);
  if (dismissThrough.overflowWatermark < summary.discardedCount) throw new Error("Notification event overflow cutoff mismatch");
  const delta = parseSessionNotificationInboxDelta(record["delta"]);
  if (delta.kind === "cleared" && !notificationSummaryIsEmpty(summary)) throw new Error("Notification clear event summary mismatch");
  if (delta.kind === "added" && summary.retainedCount === 0) throw new Error("Notification add event summary mismatch");
  return {
    type: "notifications.inbox",
    daemonInstanceId: requireNonEmptyString(record, "daemonInstanceId"),
    catalogRevision: requireNonNegativeSafeInteger(record, "catalogRevision"),
    summary,
    dismissThrough,
    delta,
  };
}

function parseSessionNotificationSummary(value: unknown): SessionNotificationSummary {
  const record = requireRecord(value);
  const retainedCount = requireNonNegativeSafeInteger(record, "retainedCount");
  if (retainedCount > SESSION_NOTIFICATION_LIMIT) throw new Error("Notification retained count exceeds limit");
  const discardedCount = requireNonNegativeSafeInteger(record, "discardedCount");
  const highestSeverity = optionalSessionNotificationSeverity(record["highestSeverity"]);
  if ((retainedCount === 0) !== (highestSeverity === undefined)) throw new Error("Notification summary severity mismatch");
  return {
    sessionId: requireNonEmptyString(record, "sessionId"),
    cwd: requireNonEmptyString(record, "cwd"),
    inboxRevision: requireNonNegativeSafeInteger(record, "inboxRevision"),
    retainedCount,
    discardedCount,
    ...(highestSeverity === undefined ? {} : { highestSeverity }),
  };
}

function parseSessionNotification(value: unknown): SessionNotification {
  const record = requireRecord(value);
  const message = requireString(record, "message");
  if (new TextEncoder().encode(message).byteLength > SESSION_NOTIFICATION_MESSAGE_BYTES) throw new Error("Notification message exceeds byte limit");
  const receivedAt = requireString(record, "receivedAt");
  if (!Number.isFinite(Date.parse(receivedAt))) throw new Error("Invalid notification receive time");
  const order = requireNonNegativeSafeInteger(record, "order");
  if (order === 0) throw new Error("Invalid notification order");
  return {
    id: requireNonEmptyString(record, "id"),
    message,
    truncated: requireBoolean(record, "truncated"),
    severity: parseSessionNotificationSeverity(record["severity"]),
    receivedAt,
    order,
  };
}

function parseSessionNotificationDismissThrough(value: unknown): SessionNotificationDismissThrough {
  const record = requireRecord(value);
  return {
    order: requireNonNegativeSafeInteger(record, "order"),
    overflowWatermark: requireNonNegativeSafeInteger(record, "overflowWatermark"),
  };
}

function parseSessionNotificationInboxDelta(value: unknown): SessionNotificationInboxDelta {
  const record = requireRecord(value);
  switch (record["kind"]) {
    case "added": {
      const evictedNotificationId = optionalString(record, "evictedNotificationId");
      return {
        kind: "added",
        notification: parseSessionNotification(record["notification"]),
        ...(evictedNotificationId === undefined ? {} : { evictedNotificationId }),
      };
    }
    case "dismissed": {
      const notificationIds = boundedArrayOf(record["notificationIds"], parseNonEmptyString, SESSION_NOTIFICATION_LIMIT, "notificationIds");
      if (new Set(notificationIds).size !== notificationIds.length) throw new Error("Duplicate dismissed notification id");
      return { kind: "dismissed", notificationIds };
    }
    case "cleared":
      return { kind: "cleared", reason: parseSessionNotificationClearReason(record["reason"]) };
    case "resync":
      return { kind: "resync" };
    default:
      throw new Error("Invalid notification inbox delta");
  }
}

function parseSessionNotificationSeverity(value: unknown): SessionNotificationSeverity {
  if (value !== "info" && value !== "warning" && value !== "error") throw new Error("Invalid notification severity");
  return value;
}

function optionalSessionNotificationSeverity(value: unknown): SessionNotificationSeverity | undefined {
  return value === undefined ? undefined : parseSessionNotificationSeverity(value);
}

function parseSessionNotificationClearReason(value: unknown): SessionNotificationClearReason {
  switch (value) {
    case "runtime-close":
    case "archive":
    case "delete":
    case "restore":
    case "archive-reconcile":
    case "replacement":
    case "initialization-failed":
    case "service-dispose":
      return value;
    default:
      throw new Error("Invalid notification clear reason");
  }
}

function boundedArrayOf<T>(value: unknown, parse: (item: unknown) => T, limit: number, field: string): T[] {
  if (!Array.isArray(value)) throw new Error(`Expected array field: ${field}`);
  if (value.length > limit) throw new Error(`Array field exceeds limit: ${field}`);
  return value.map(parse);
}

function parseNonEmptyString(value: unknown): string {
  if (typeof value !== "string" || value === "") throw new Error("Expected non-empty string");
  return value;
}

function requireNonEmptyString(record: Record<string, unknown>, key: string): string {
  const value = requireString(record, key);
  if (value === "") throw new Error(`Expected non-empty string field: ${key}`);
  return value;
}

function requireNonNegativeSafeInteger(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`Expected non-negative safe integer field: ${key}`);
  return value;
}

function assertUniqueNotifications(notifications: readonly SessionNotification[]): void {
  if (new Set(notifications.map((notification) => notification.id)).size !== notifications.length) throw new Error("Duplicate notification id");
  if (new Set(notifications.map((notification) => notification.order)).size !== notifications.length) throw new Error("Duplicate notification order");
}

function assertNewestFirst(notifications: readonly SessionNotification[]): void {
  for (let index = 1; index < notifications.length; index += 1) {
    const previous = notifications[index - 1];
    const current = notifications[index];
    if (previous === undefined || current === undefined || previous.order <= current.order) throw new Error("Notifications are not newest-first");
  }
}

function notificationSummaryIsEmpty(summary: SessionNotificationSummary): boolean {
  return summary.retainedCount === 0 && summary.discardedCount === 0;
}

function highestNotificationSeverity(notifications: readonly SessionNotification[]): SessionNotificationSeverity | undefined {
  let highest: SessionNotificationSeverity | undefined;
  for (const notification of notifications) {
    if (notification.severity === "error") return "error";
    if (notification.severity === "warning") highest = "warning";
    else highest ??= "info";
  }
  return highest;
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

function parseSessionModelCatalogEntry(value: unknown): SessionModelCatalogEntry {
  const record = requireRecord(value);
  return {
    provider: requireString(record, "provider"),
    id: requireString(record, "id"),
    ...optionalField("name", optionalString(record, "name")),
    ...optionalField("contextWindow", optionalNumber(record, "contextWindow")),
    ...optionalField("reasoning", record["reasoning"]),
    enabled: requireBoolean(record, "enabled"),
    ...optionalField("editable", optionalBoolean(record, "editable")),
    ...optionalField("catalogIndex", record["catalogIndex"] === undefined ? undefined : requireNonNegativeSafeInteger(record, "catalogIndex")),
  };
}

export function parseSessionModelCatalogResponse(value: unknown): SessionModelCatalogResponse {
  const record = requireRecord(value);
  return { models: arrayOf(parseSessionModelCatalogEntry)(record["models"]) };
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
  const loginFlow = record["loginFlow"];
  if (loginFlow !== undefined && loginFlow !== "interactive") throw new Error("Invalid auth provider login flow");
  return {
    id: requireString(record, "id"),
    name: requireString(record, "name"),
    authType: parseAuthType(record["authType"]),
    status: parseAuthProviderStatus(record["status"]),
    ...(loginFlow === undefined ? {} : { loginFlow }),
  };
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
    ...optionalField("info", optionalOAuthInfo(record["info"])),
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
  return {
    url: requireString(record, "url"),
    ...optionalField("instructions", optionalString(record, "instructions")),
    ...optionalField("deviceCode", optionalOAuthDeviceCode(record["deviceCode"])),
  };
}

function optionalOAuthDeviceCode(value: unknown): NonNullable<OAuthFlowState["auth"]>["deviceCode"] | undefined {
  if (value === undefined) return undefined;
  const record = requireRecord(value);
  return {
    userCode: requireString(record, "userCode"),
    ...optionalField("intervalSeconds", optionalNumber(record, "intervalSeconds")),
    ...optionalField("expiresInSeconds", optionalNumber(record, "expiresInSeconds")),
  };
}

function optionalOAuthPrompt(value: unknown): OAuthFlowState["prompt"] | undefined {
  if (value === undefined) return undefined;
  const record = requireRecord(value);
  return {
    requestId: requireString(record, "requestId"),
    message: requireString(record, "message"),
    promptType: parseOAuthPromptType(record["promptType"]),
    ...optionalField("placeholder", optionalString(record, "placeholder")),
    ...optionalField("allowEmpty", optionalBoolean(record, "allowEmpty")),
  };
}

function parseOAuthPromptType(value: unknown): "text" | "secret" | "manual_code" {
  if (value !== "text" && value !== "secret" && value !== "manual_code") throw new Error("Invalid OAuth prompt type");
  return value;
}

function optionalOAuthSelect(value: unknown): OAuthFlowState["select"] | undefined {
  if (value === undefined) return undefined;
  const record = requireRecord(value);
  return { requestId: requireString(record, "requestId"), message: requireString(record, "message"), options: arrayOf(parseCommandOption)(record["options"]) };
}

function optionalOAuthInfo(value: unknown): OAuthFlowState["info"] | undefined {
  if (value === undefined) return undefined;
  return arrayOf((item) => {
    const record = requireRecord(item);
    return {
      message: requireString(record, "message"),
      ...optionalField("links", record["links"] === undefined ? undefined : arrayOf(parseOAuthInfoLink)(record["links"])),
    };
  })(value);
}

function parseOAuthInfoLink(value: unknown): NonNullable<NonNullable<OAuthFlowState["info"]>[number]["links"]>[number] {
  const record = requireRecord(value);
  return { url: requireString(record, "url"), ...optionalField("label", optionalString(record, "label")) };
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
  if (value !== "image" && value !== "html" && value !== "pdf" && value !== "markdown") throw new Error("Invalid file media type");
  return value;
}

export function parseWorkspaceTrustResponse(value: unknown): WorkspaceTrustResponse {
  const record = requireRecord(value);
  const decision = record["decision"];
  if (decision !== true && decision !== false && decision !== null) throw new Error("Invalid workspace trust decision");
  return { path: requireString(record, "path"), decision, trusted: requireBoolean(record, "trusted") };
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

/**
 * Adapt the tolerant shared snapshot parser to this module's throwing
 * contract, so a malformed payload fails the request or drops the frame
 * exactly like every other parser here.
 */
export function requireMachineStatusSnapshot(value: unknown): MachineStatusSnapshot {
  const snapshot = parseMachineStatusSnapshot(value);
  if (snapshot === undefined) throw new Error("Expected machine status snapshot");
  return snapshot;
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
    ...optionalField("attachments", optionalAttachments(record["attachments"])),
    ...optionalField("maxUploadBytes", optionalNumber(record, "maxUploadBytes")),
    ...optionalField("agent", optionalAgent(record["agent"])),
    ...optionalField("spawnSessions", optionalBoolean(record, "spawnSessions")),
    ...optionalField("subsessions", optionalBoolean(record, "subsessions")),
    ...optionalField("askUser", optionalBoolean(record, "askUser")),
  };
}

function optionalAgent(value: unknown): PiWebConfigValues["agent"] | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || Array.isArray(value)) throw new Error("Invalid PI WEB agent field");
  return {
    ...optionalField("command", optionalString(value, "command")),
    ...optionalField("dir", optionalString(value, "dir")),
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

function optionalAttachments(value: unknown): PiWebConfigValues["attachments"] | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || Array.isArray(value)) throw new Error("Invalid PI WEB attachments field");
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
  return {
    host: requireBoolean(record, "host"),
    port: requireBoolean(record, "port"),
    allowedHosts: requireBoolean(record, "allowedHosts"),
    spawnSessions: requireBoolean(record, "spawnSessions"),
    subsessions: requireBoolean(record, "subsessions"),
    askUser: requireBoolean(record, "askUser"),
  };
}

export function parsePiPackagesResponse(value: unknown): PiPackagesResponse {
  const record = requireRecord(value);
  return {
    packages: arrayOf(parsePiPackageInfo)(record["packages"]),
    ...optionalField("installableKnownPackages", optionalPiPackageInstallableSuggestions(record["installableKnownPackages"])),
  };
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
    ...optionalField("installableKnownPackages", optionalPiPackageInstallableSuggestions(record["installableKnownPackages"])),
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

function optionalPiPackageInstallableSuggestions(value: unknown): PiPackageInstallableSuggestion[] | undefined {
  return value === undefined ? undefined : arrayOf(parsePiPackageInstallableSuggestion)(value);
}

function parsePiPackageInstallableSuggestion(value: unknown): PiPackageInstallableSuggestion {
  const record = requireRecord(value);
  return {
    id: requireString(record, "id"),
    label: requireString(record, "label"),
    description: requireString(record, "description"),
    source: requireString(record, "source"),
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
  const plugins = arrayOf(parsePiWebPluginInfo)(record["plugins"]);
  if (record["lifecycleVersion"] === undefined) {
    return {
      lifecycleVersion: PI_WEB_PLUGIN_LIFECYCLE_VERSION,
      plugins,
      diagnostics: [],
      serverRuntime: {
        status: "incompatible",
        restartRequired: false,
        message: "PI WEB does not support plugin lifecycle diagnostics. Update and restart PI WEB, then try again.",
        recovery: legacyPluginRecoveryCommands(),
      },
    };
  }
  if (record["lifecycleVersion"] !== PI_WEB_PLUGIN_LIFECYCLE_VERSION) throw new Error("Unsupported PI WEB plugin lifecycle version");
  return {
    lifecycleVersion: PI_WEB_PLUGIN_LIFECYCLE_VERSION,
    plugins,
    diagnostics: arrayOf(parsePiWebPluginDiagnostic)(record["diagnostics"]),
    serverRuntime: parsePiWebPluginRuntimeInfo(record["serverRuntime"]),
  };
}

function parsePiWebPluginInfo(value: unknown): PiWebPluginInfo {
  const record = requireRecord(value);
  const id = requireString(record, "id");
  const server = record["server"] === undefined ? undefined : parsePiWebPluginServerInfo(record["server"], id);
  return {
    id,
    ...optionalField("module", optionalString(record, "module")),
    source: requireString(record, "source"),
    scope: parsePiWebPluginScope(record["scope"]),
    machineSpecific: parseOptionalBoolean(record["machineSpecific"], "machineSpecific") ?? false,
    enabled: requireBoolean(record, "enabled"),
    discovered: parseOptionalBoolean(record["discovered"], "discovered") ?? true,
    conflict: parseOptionalBoolean(record["conflict"], "conflict") ?? false,
    ...(server === undefined ? {} : { server }),
  };
}

function parsePiWebPluginServerInfo(value: unknown, pluginId: string): NonNullable<PiWebPluginInfo["server"]> {
  const record = requireRecord(value);
  const state = record["state"];
  const phase = record["phase"];
  if (state !== "active" && state !== "failed" && state !== "incompatible" && state !== "disabled" && state !== "missing" && state !== "unknown") {
    throw new Error("Invalid PI WEB server plugin state");
  }
  if (phase !== undefined && phase !== "import" && phase !== "activate" && phase !== "validate" && phase !== "start" && phase !== "health" && phase !== "stop") {
    throw new Error("Invalid PI WEB server plugin phase");
  }
  const health = record["health"] === undefined ? undefined : parsePiWebPluginHealth(record["health"]);
  const disableCommand = requireString(record, "disableCommand");
  if (disableCommand !== pluginDisableRecoveryCommand(pluginId)) throw new Error("Invalid PI WEB server plugin recovery command");
  return {
    state,
    ...optionalField("desiredRevision", optionalString(record, "desiredRevision")),
    ...optionalField("activeRevision", optionalString(record, "activeRevision")),
    ...(phase === undefined ? {} : { phase }),
    ...optionalField("message", optionalString(record, "message")),
    ...(health === undefined ? {} : { health }),
    staleRevision: requireBoolean(record, "staleRevision"),
    restartRequired: requireBoolean(record, "restartRequired"),
    disableCommand,
  };
}

function parsePiWebPluginHealth(value: unknown): NonNullable<NonNullable<PiWebPluginInfo["server"]>["health"]> {
  const record = requireRecord(value);
  const status = record["status"];
  if (status !== "healthy" && status !== "degraded" && status !== "unhealthy") throw new Error("Invalid PI WEB server plugin health status");
  return { status, ...optionalField("message", optionalString(record, "message")) };
}

function parsePiWebPluginDiagnostic(value: unknown): PiWebPluginsResponse["diagnostics"][number] {
  const record = requireRecord(value);
  const kind = record["kind"];
  const snapshot = record["snapshot"];
  if (kind !== "conflict" && kind !== "discovery") throw new Error("Invalid PI WEB plugin diagnostic kind");
  if (snapshot !== "desired" && snapshot !== "active") throw new Error("Invalid PI WEB plugin diagnostic snapshot");
  return {
    kind,
    snapshot,
    source: requireString(record, "source"),
    message: requireString(record, "message"),
    ...optionalField("pluginId", optionalString(record, "pluginId")),
  };
}

function parsePiWebPluginRuntimeInfo(value: unknown): PiWebPluginsResponse["serverRuntime"] {
  const record = requireRecord(value);
  const status = record["status"];
  const safeStart = record["safeStart"];
  const desiredSafeStart = record["desiredSafeStart"];
  if (status !== "available" && status !== "unavailable" && status !== "incompatible") throw new Error("Invalid PI WEB server-plugin runtime status");
  if (safeStart !== undefined && safeStart !== "bundled-only" && safeStart !== "none") throw new Error("Invalid PI WEB server-plugin safe-start state");
  if (desiredSafeStart !== undefined && desiredSafeStart !== "off" && desiredSafeStart !== "bundled-only" && desiredSafeStart !== "none") {
    throw new Error("Invalid desired PI WEB server-plugin safe-start state");
  }
  return {
    status,
    ...(safeStart === undefined ? {} : { safeStart }),
    ...(desiredSafeStart === undefined ? {} : { desiredSafeStart }),
    restartRequired: requireBoolean(record, "restartRequired"),
    ...optionalField("message", optionalString(record, "message")),
    recovery: parsePiWebPluginRecoveryCommands(record["recovery"]),
  };
}

function parsePiWebPluginRecoveryCommands(value: unknown): PiWebPluginsResponse["serverRuntime"]["recovery"] {
  const record = requireRecord(value);
  const commands = {
    showSafeStart: requireString(record, "showSafeStart"),
    bundledOnly: requireString(record, "bundledOnly"),
    noServerPlugins: requireString(record, "noServerPlugins"),
    clearSafeStart: requireString(record, "clearSafeStart"),
  };
  if (commands.showSafeStart !== PI_WEB_PLUGIN_RECOVERY_COMMANDS.showSafeStart
    || commands.bundledOnly !== PI_WEB_PLUGIN_RECOVERY_COMMANDS.bundledOnly
    || commands.noServerPlugins !== PI_WEB_PLUGIN_RECOVERY_COMMANDS.noServerPlugins
    || commands.clearSafeStart !== PI_WEB_PLUGIN_RECOVERY_COMMANDS.clearSafeStart) {
    throw new Error("Invalid PI WEB server plugin recovery commands");
  }
  return commands;
}

function legacyPluginRecoveryCommands(): PiWebPluginsResponse["serverRuntime"]["recovery"] {
  return { ...PI_WEB_PLUGIN_RECOVERY_COMMANDS };
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
    ...optionalField("piVersion", optionalString(record, "piVersion")),
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
    ...optionalField("piVersion", optionalString(record, "piVersion")),
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
  if (type === "tree") return { type, tree: parseSessionTreeSnapshot(record["tree"]) };
  if (type === "done") return { type, ...optionalField("message", optionalString(record, "message")), ...optionalSession(record["session"]), ...optionalField("promptDraft", optionalString(record, "promptDraft")) };
  throw new Error("Invalid command result type");
}

export function parseSessionTreeSnapshot(value: unknown): SessionTreeSnapshot {
  const record = requireRecord(value);
  const nodes = arrayOf(parseSessionTreeNode)(record["nodes"]);
  const nodeIds = new Set(nodes.map((node) => node.id));
  if (nodeIds.size !== nodes.length) throw new Error("Duplicate session tree node id");
  const activeLeafId = requireNullableString(record, "activeLeafId");
  if (activeLeafId !== null && !nodeIds.has(activeLeafId)) throw new Error("Invalid session tree activeLeafId");
  return {
    nodes,
    activeLeafId,
    activePathIds: arrayOfNonBlankString(record["activePathIds"], "activePathIds"),
  };
}

function parseSessionTreeNode(value: unknown): SessionTreeNode {
  const record = requireRecord(value);
  return {
    id: requireNonBlankString(record, "id"),
    parentId: requireNullableString(record, "parentId"),
    kind: parseSessionTreeNodeKind(record["kind"]),
    summary: requireString(record, "summary"),
    ...optionalField("timestamp", optionalString(record, "timestamp")),
    ...optionalField("label", optionalString(record, "label")),
  };
}

function parseSessionTreeNodeKind(value: unknown): SessionTreeNodeKind {
  switch (value) {
    case "user":
    case "assistant":
    case "tool-result":
    case "bash":
    case "custom-message":
    case "compaction":
    case "branch-summary":
    case "model-change":
    case "thinking-level-change":
    case "session-info":
    case "label":
    case "custom":
    case "other":
      return value;
    default:
      throw new Error("Invalid session tree node kind");
  }
}

export function parseSessionTreeNavigateResult(value: unknown): SessionTreeNavigateResult {
  const record = requireRecord(value);
  const cancelled = requireBoolean(record, "cancelled");
  if (Object.hasOwn(record, "summaryEntry")) throw new Error("Invalid session tree navigation result field: summaryEntry");
  if (cancelled) {
    rejectResponseField(record, "editorText", "session tree cancellation result");
    const aborted = record["aborted"];
    if (aborted !== undefined && typeof aborted !== "boolean") throw new Error("Expected optional boolean field: aborted");
    return { cancelled, ...(aborted === undefined ? {} : { aborted }) };
  }
  rejectResponseField(record, "aborted", "session tree navigation result");
  return { cancelled, ...optionalField("editorText", optionalString(record, "editorText")) };
}

export function parseSessionTreeForkResult(value: unknown): SessionTreeForkResult {
  const record = requireRecord(value);
  const cancelled = requireBoolean(record, "cancelled");
  if (cancelled) {
    rejectResponseField(record, "session", "session tree fork cancellation result");
    rejectResponseField(record, "promptDraft", "session tree fork cancellation result");
    return { cancelled };
  }
  return {
    cancelled,
    session: parseSessionInfo(record["session"]),
    ...optionalField("promptDraft", optionalString(record, "promptDraft")),
  };
}

function rejectResponseField(record: Record<string, unknown>, field: string, label: string): void {
  if (Object.hasOwn(record, field)) throw new Error(`Invalid ${label} field: ${field}`);
}

function requireNullableString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  if (value !== null && typeof value !== "string") throw new Error(`Expected string or null field: ${key}`);
  if (typeof value === "string" && value.trim() === "") throw new Error(`Expected non-blank string or null field: ${key}`);
  return value;
}

function requireNonBlankString(record: Record<string, unknown>, key: string): string {
  const value = requireString(record, key);
  if (value.trim() === "") throw new Error(`Expected non-blank string field: ${key}`);
  return value;
}

function arrayOfNonBlankString(value: unknown, key: string): string[] {
  const strings = arrayOfString(value, key);
  if (strings.some((item) => item.trim() === "")) throw new Error(`Expected non-blank string array field: ${key}`);
  return strings;
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

export function parsePushVapidPublicKey(value: unknown): { publicKey: string } {
  const record = requireRecord(value);
  if (typeof record["publicKey"] !== "string" || record["publicKey"] === "") throw new Error("Expected a VAPID public key");
  return { publicKey: record["publicKey"] };
}

export function parseRemoved(value: unknown): { removed: boolean } {
  const record = requireRecord(value);
  if (record["removed"] !== true && record["removed"] !== false) throw new Error("Expected a push unsubscribe result");
  return { removed: record["removed"] };
}
