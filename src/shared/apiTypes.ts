import type { MachineStatusUiEvent } from "./machineStatus.js";
import type {
  DeleteWorkspaceFileResponse,
  FileContentMediaType,
  FileContentResponse,
  FileTreeEntry,
  FileTreeResponse,
  JsonObject,
  JsonPrimitive,
  JsonValue,
  MachineKind,
  MoveWorkspaceFileOptions,
  MoveWorkspaceFileResponse,
  PiWebComponentStatus,
  PiWebDockerMode,
  PiWebInstallationInfo,
  PiWebInstallationKind,
  PiWebReleaseStatus,
  PiWebServiceComponent,
  PiWebStatusMessage,
  PiWebStatusResponse,
  PiWebStatusSeverity,
  PiWebVersionResponse,
  TerminalCommandRun,
  TerminalCommandRunHandle,
  TerminalCommandRunStatus,
  WorkspaceProviderCapabilities,
  WorkspaceProviderMetadata,
  WorkspaceRemovalPresentation,
  WriteWorkspaceFileOptions,
  WriteWorkspaceFileResponse,
} from "./pluginApiTypes.js";

export type {
  DeleteWorkspaceFileResponse,
  FileContentMediaType,
  FileContentResponse,
  FileTreeEntry,
  FileTreeResponse,
  JsonObject,
  JsonPrimitive,
  JsonValue,
  MachineKind,
  MoveWorkspaceFileOptions,
  MoveWorkspaceFileResponse,
  PiWebComponentStatus,
  PiWebDockerMode,
  PiWebInstallationInfo,
  PiWebInstallationKind,
  PiWebReleaseStatus,
  PiWebServiceComponent,
  PiWebStatusMessage,
  PiWebStatusResponse,
  PiWebStatusSeverity,
  PiWebVersionResponse,
  TerminalCommandRun,
  TerminalCommandRunHandle,
  TerminalCommandRunStatus,
  WorkspaceProviderCapabilities,
  WorkspaceProviderMetadata,
  WorkspaceRemovalPresentation,
  WriteWorkspaceFileOptions,
  WriteWorkspaceFileResponse,
};

/** Internal query shape for PI WEB's terminal-command-runs host protocol. */
export interface TerminalCommandRunFilter {
  projectId?: string;
  workspaceId?: string;
  terminalId?: string;
  statuses?: TerminalCommandRunStatus[];
  metadata?: Record<string, string>;
}

export type MachineStatus = "unknown" | "online" | "offline" | "error";

/**
 * Registry of feature-gating capabilities. Add an entry here (plus the
 * runtime/requirements entries in `capabilities.ts`) when a feature needs
 * rolling-version gating.
 */
export const PI_WEB_CAPABILITIES = {
  pluginLifecycle: "plugins.lifecycle",
} as const;

export type PiWebCapability = typeof PI_WEB_CAPABILITIES[keyof typeof PI_WEB_CAPABILITIES];

export interface Machine {
  id: string;
  name: string;
  kind: MachineKind;
  baseUrl?: string;
  createdAt: string;
  updatedAt: string;
  status?: MachineStatus;
  statusMessage?: string;
}

export interface MachineHealth {
  machineId: string;
  ok: boolean;
  checkedAt: string;
  status?: MachineStatus;
  web?: PiWebComponentStatus;
  sessiond?: PiWebComponentStatus;
  error?: string;
}

export interface MachineRuntime {
  machineId: string;
  ok: boolean;
  checkedAt: string;
  packageName?: string;
  generatedAt?: string;
  components?: PiWebRuntimeResponse["components"];
  capabilities?: PiWebCapability[];
  /** Deprecated agent-configuration inputs detected on this machine (union of the web and session daemon reports, deduplicated); omitted when none. */
  deprecatedAgentInputs?: readonly PiWebDeprecatedAgentInput[];
  error?: string;
}

export type PiWebShortcutConfig = Record<string, string | null>;
export type PiWebPluginSettings = Record<string, unknown>;
export type PiWebPluginConfigMap = Record<string, PiWebPluginConfig>;

export interface PiWebPluginConfig {
  enabled?: boolean;
  settings?: PiWebPluginSettings;
  [key: string]: unknown;
}

export interface PiWebPathAccessConfig {
  allowedPaths?: string[];
}

export interface PiWebUploadsConfig {
  defaultFolder?: string;
}

export interface PiWebAttachmentsConfig {
  defaultFolder?: string;
}

export interface PiWebAgentConfig {
  /** Deprecated and ignored: the multi-implementation CLI abstraction was removed; sessions always run on the bundled pi SDK. Detected for the deprecation warning. */
  command?: string;
  /** Deprecated alias for the PI_CODING_AGENT_DIR env var: pi agent state directory containing auth.json, models.json, settings.json, and sessions/. */
  dir?: string;
}

/**
 * A deprecated agent-configuration input detected on one machine, as reported
 * over the runtime/status pipeline. Values from the legacy PI_WEB_AGENT_* env
 * vars and the agent.* config keys are still honored (or, for the removed
 * command concept, ignored) during the deprecation window; every detected
 * input is surfaced as a non-dismissable UI warning until the input is removed.
 */
export interface PiWebDeprecatedAgentInput {
  /** Where the input was found: the process environment or the config file. */
  readonly source: "environment" | "config";
  /** The deprecated input as the user set it: an env var name or a config key path. */
  readonly name: string;
  /** The replacement input; absent when the concept was removed and the input should simply be deleted. */
  readonly replacement?: string;
}

/**
 * Web Push (VAPID) credentials for server-side push delivery. All three fields must be
 * present and non-empty for push to be enabled; without them the endpoints report that
 * push is not configured instead of failing per request.
 */
export interface PiWebPushConfig {
  /** Base64url VAPID public key handed to clients for `pushManager.subscribe`. */
  vapidPublicKey?: string;
  /** Base64url VAPID private key used by the server when sending notifications. Never sent to browsers. */
  vapidPrivateKey?: string;
  /** Contact (email or URL) embedded in every VAPID authorization header, e.g. "mailto:admin@example.com". */
  subjectEmail?: string;
}

export interface PiWebConfigValues {
  host?: string;
  port?: number;
  allowedHosts?: string[] | true;
  shortcuts?: PiWebShortcutConfig;
  plugins?: PiWebPluginConfigMap;
  /** External filesystem roots PI WEB may expose outside a workspace. */
  pathAccess?: PiWebPathAccessConfig;
  /** Workspace-relative defaults for manual file uploads. */
  uploads?: PiWebUploadsConfig;
  /** Workspace-relative defaults for prompt attachments saved into the workspace. */
  attachments?: PiWebAttachmentsConfig;
  /** Maximum accepted HTTP request body size in bytes (uploads/attachments). */
  maxUploadBytes?: number;
  /** When true, LLMs can start new sessions via the spawn_session tool. */
  spawnSessions?: boolean;
  /**
   * When true, LLMs can start tracked child sessions via the
   * spawn_subsession / list_subsessions / check_subsession / read_subsession
   * tools. On by default; set to `false` to disable. Requires spawnSessions
   * to be enabled.
   */
  subsessions?: boolean;
  /**
   * When true, LLMs can post a question set to the browser via the ask_user
   * tool. On by default; set to `false` to remove the tool from the runtime.
   */
  askUser?: boolean;
  /**
   * When true, PI WEB appends environment facts to session system prompts:
   * the pi-web session nesting every session runs in, plus container facts in
   * Docker deployments. On by default.
   */
  environmentFacts?: boolean;
  /**
   * How long an extension dialog may wait for an answer before the daemon
   * auto-cancels it, in milliseconds. Applies only when the extension set no
   * `timeout` of its own (the sooner of the two wins); `0` waits forever.
   * Tuning knob only — extension dialogs are always enabled.
   */
  extensionDialogsTimeoutMs?: number;
  /** Deprecated agent-configuration keys, still honored as aliases during the deprecation window and detected for the deprecation warning (see PiWebAgentConfig). */
  agent?: PiWebAgentConfig;
  /** Web Push delivery credentials; push stays disabled until all three fields are set. */
  push?: PiWebPushConfig;
}

export type PiWebPluginScope = "bundled" | "local" | "user" | "project";

export const PI_WEB_PLUGIN_LIFECYCLE_VERSION = 1;

export type PiWebPluginServerState = "active" | "failed" | "incompatible" | "disabled" | "missing" | "unknown";
export type PiWebPluginLifecyclePhase = "import" | "activate" | "validate" | "start" | "health" | "stop";
export type PiWebPluginHealthStatus = "healthy" | "degraded" | "unhealthy";
export type PiWebPluginRuntimeStatus = "available" | "unavailable" | "incompatible";
export type PiWebPluginSafeStart = "bundled-only" | "none";

export interface PiWebPluginServerInfo {
  state: PiWebPluginServerState;
  desiredRevision?: string;
  activeRevision?: string;
  phase?: PiWebPluginLifecyclePhase;
  message?: string;
  health?: {
    status: PiWebPluginHealthStatus;
    message?: string;
  };
  staleRevision: boolean;
  restartRequired: boolean;
  /** Exact offline command; plugin ids are restricted to shell-safe bare ids. */
  disableCommand: string;
}

export interface PiWebPluginInfo {
  id: string;
  /** Browser module URL for the currently discovered package, if any. */
  module?: string;
  source: string;
  scope: PiWebPluginScope;
  machineSpecific: boolean;
  /** Desired config state; the active server snapshot may intentionally differ. */
  enabled: boolean;
  /** False when only the still-active sessiond snapshot knows this plugin. */
  discovered: boolean;
  /** A duplicate id was diagnosed in either the desired or active catalog. */
  conflict: boolean;
  server?: PiWebPluginServerInfo;
}

export interface PiWebPluginDiagnostic {
  kind: "conflict" | "discovery";
  snapshot: "desired" | "active";
  source: string;
  message: string;
  pluginId?: string;
}

export interface PiWebPluginRecoveryCommands {
  showSafeStart: string;
  bundledOnly: string;
  noServerPlugins: string;
  clearSafeStart: string;
}

export interface PiWebPluginRuntimeInfo {
  status: PiWebPluginRuntimeStatus;
  /** Safe-start level active in sessiond; absence means sessiond started normally. */
  safeStart?: PiWebPluginSafeStart;
  /** Current offline recovery config, including explicit `off` when known. */
  desiredSafeStart?: PiWebPluginSafeStart | "off";
  restartRequired: boolean;
  message?: string;
  recovery: PiWebPluginRecoveryCommands;
}

export interface PiWebPluginsResponse {
  lifecycleVersion: typeof PI_WEB_PLUGIN_LIFECYCLE_VERSION;
  plugins: PiWebPluginInfo[];
  diagnostics: PiWebPluginDiagnostic[];
  serverRuntime: PiWebPluginRuntimeInfo;
}

export type PiPackageScope = "user" | "project";

export interface PiPackageInfo {
  source: string;
  scope: PiPackageScope;
  filtered: boolean;
  installedPath?: string;
}

export interface PiPackagesResponse {
  packages: PiPackageInfo[];
  /**
   * Known Pi packages PI WEB ships and can auto-install (see the
   * `relay-pi-package-autoinstall` relay) that are not currently configured
   * for the active profile — omitted or empty once every known package is
   * configured. Lets the Settings UI offer a one-click (re)install with no
   * path typing for a package the user dismissed or never installed.
   */
  installableKnownPackages?: PiPackageInstallableSuggestion[];
}

export interface PiPackageInstallableSuggestion {
  /** The package's own declared `name` (e.g. `@jmfederico/pi-relay`). */
  id: string;
  /** Short human-friendly name for display. */
  label: string;
  /** Short human-friendly description for display. */
  description: string;
  /** Shipped local install source for a one-click install; installs at Pi's default (`user`) scope, same as the free-text install form. */
  source: string;
}

export interface PiPackageInstallRequest {
  source: string;
}

export interface PiPackageRemoveRequest {
  source: string;
  /** Optional known scope from a listed package; not an install-location picker. */
  scope?: PiPackageScope;
}

export interface PiPackageUpdateRequest {
  /** Omit to update all configured Pi packages. */
  source?: string;
}

export type PiPackageMutationAction = "install" | "remove" | "update";

export interface PiPackageMutationResponse extends PiPackagesResponse {
  action: PiPackageMutationAction;
  source?: string;
  scope?: PiPackageScope;
  removed?: boolean;
}

export interface PiWebConfigEnvOverrides {
  host: boolean;
  port: boolean;
  allowedHosts: boolean;
  spawnSessions: boolean;
  subsessions: boolean;
  askUser: boolean;
}

export interface PiWebConfigResponse {
  path: string;
  exists: boolean;
  config: PiWebConfigValues;
  effectiveConfig: PiWebConfigValues;
  envOverrides: PiWebConfigEnvOverrides;
}

export interface Project {
  id: string;
  name: string;
  path: string;
  createdAt: string;
}

export interface WorkspaceEffectiveConfig {
  readonly uploads?: Readonly<PiWebUploadsConfig>;
  readonly attachments?: Readonly<PiWebAttachmentsConfig>;
}

/** Host-only removal state carried by PI WEB's browser/sessiond protocol. */
export interface WorkspaceRemovalHostState extends WorkspaceRemovalPresentation {
  /** Opaque token binding a removal confirmation to this exact owner snapshot. */
  readonly precondition: string;
}

/**
 * Per-project Pi trust state for a workspace path, as stored in the agent
 * directory's `trust.json` (shared with the Pi CLI).
 */
export interface WorkspaceTrustResponse {
  /** The workspace path the decision is keyed on. */
  path: string;
  /** Raw stored decision: `true`/`false` for an explicit entry, `null` when unset. */
  decision: boolean | null;
  /** Effective trust the toggle reflects: the stored decision, else `defaultProjectTrust === "always"`. */
  trusted: boolean;
}

export interface WorkspaceRemovalRequest {
  precondition: string;
}

export type WorkspaceProviderResolutionStatus = "provider" | "folder" | "degraded";
export type WorkspaceProviderTier = "primary" | "fallback";
export type WorkspaceProviderDiagnosticCode = "probe-failed" | "claim-conflict" | "list-failed";

export interface WorkspaceProviderDiagnostic {
  readonly code: WorkspaceProviderDiagnosticCode;
  readonly message: string;
  readonly tier: WorkspaceProviderTier;
  readonly pluginId?: string;
  readonly pluginIds?: readonly string[];
}

/** Provider-neutral result of resolving one project's current workspace owner. */
export interface WorkspaceProviderResolution {
  readonly status: WorkspaceProviderResolutionStatus;
  readonly projectId: string;
  readonly ownerPluginId?: string;
  readonly workspaces: readonly Workspace[];
  readonly diagnostics: readonly WorkspaceProviderDiagnostic[];
}

/** Host-resolved workspace snapshot. */
export interface Workspace {
  readonly id: string;
  readonly projectId: string;
  readonly path: string;
  readonly label: string;
  readonly isMain: boolean;
  readonly provider?: WorkspaceProviderMetadata;
  readonly removal?: WorkspaceRemovalHostState;
  /** Workspace-effective project/global settings needed by workspace UI features. Always present on current server workspace responses. */
  readonly effectiveConfig: WorkspaceEffectiveConfig;
}

/** Workspace as listed by the workspace authority, before the browser route layer attaches the wire-required effectiveConfig. */
export type WorkspaceListing = Omit<Workspace, "effectiveConfig">;

/** Provider resolution as served by the sessiond workspace authority; the browser route layer attaches effectiveConfig to every workspace before responding. */
export type WorkspaceProviderAuthorityResolution = Omit<WorkspaceProviderResolution, "workspaces"> & {
  workspaces: readonly WorkspaceListing[];
};

export interface SessionRef {
  id: string;
  cwd: string;
}

export const SESSION_UNREAD_LIMIT = 1_000;
export const SESSION_UNREAD_SESSION_ID_MAX_LENGTH = 512;
export const SESSION_UNREAD_CWD_MAX_LENGTH = 32 * 1024;
export const SESSION_UNREAD_CATALOG_ID_MAX_LENGTH = 512;
export const SESSION_UNREAD_COMPLETED_AT_MAX_LENGTH = 64;

export interface SessionUnreadSummary {
  sessionId: string;
  cwd: string;
  /** Monotonic within a catalog and never greater than its containing revision. */
  completionOrder: number;
  completedAt: string;
}

export interface SessionUnreadCatalogSnapshot {
  /** Stable for one persisted catalog epoch; changes when unread state is reset. */
  catalogId: string;
  /** Monotonic catalog mutation revision; at least every contained completion order. */
  catalogRevision: number;
  /** Bounded by `SESSION_UNREAD_LIMIT` and ordered newest completion first. */
  sessions: SessionUnreadSummary[];
}

export interface SessionUnreadAcknowledgeRequest {
  cwd: string;
  /** The catalog epoch in which `throughCompletionOrder` was observed. */
  catalogId: string;
  throughCompletionOrder: number;
}

/** Authoritative delta for one session in the daemon-owned unread catalog. */
export interface SessionUnreadEvent {
  type: "sessions.unread";
  catalogId: string;
  /** At least `unread.completionOrder` when carrying an unread summary. */
  catalogRevision: number;
  sessionId: string;
  cwd: string;
  unread: SessionUnreadSummary | null;
}

export const SESSION_NOTIFICATION_LIMIT = 100;
export const SESSION_NOTIFICATION_MESSAGE_BYTES = 8 * 1024;

export type SessionNotificationSeverity = "info" | "warning" | "error";

export interface SessionNotification {
  id: string;
  message: string;
  truncated: boolean;
  severity: SessionNotificationSeverity;
  receivedAt: string;
  order: number;
}

export interface SessionNotificationSummary {
  sessionId: string;
  cwd: string;
  inboxRevision: number;
  retainedCount: number;
  discardedCount: number;
  highestSeverity?: SessionNotificationSeverity;
}

export interface SessionNotificationDismissThrough {
  order: number;
  overflowWatermark: number;
}

export interface SessionNotificationInboxSnapshot {
  daemonInstanceId: string;
  catalogRevision: number;
  summary: SessionNotificationSummary;
  notifications: SessionNotification[];
  dismissThrough: SessionNotificationDismissThrough;
}

export interface SessionNotificationCatalogSnapshot {
  daemonInstanceId: string;
  catalogRevision: number;
  sessions: SessionNotificationSummary[];
}

export interface SessionNotificationDismissRequest {
  cwd: string;
  daemonInstanceId: string;
  notificationId: string;
}

export interface SessionNotificationDismissAllRequest {
  cwd: string;
  daemonInstanceId: string;
  throughOrder: number;
  throughOverflowWatermark: number;
}

export type SessionNotificationClearReason =
  | "runtime-close"
  | "archive"
  | "delete"
  | "restore"
  | "archive-reconcile"
  | "replacement"
  | "initialization-failed"
  | "service-dispose";

export type SessionNotificationInboxDelta =
  | { kind: "added"; notification: SessionNotification; evictedNotificationId?: string }
  | { kind: "dismissed"; notificationIds: string[] }
  | { kind: "cleared"; reason: SessionNotificationClearReason }
  | { kind: "resync" };

export interface SessionNotificationInboxEvent {
  type: "notifications.inbox";
  daemonInstanceId: string;
  catalogRevision: number;
  summary: SessionNotificationSummary;
  dismissThrough: SessionNotificationDismissThrough;
  delta: SessionNotificationInboxDelta;
}

export interface SessionNotificationSummaryEvent {
  type: "notifications.summary";
  daemonInstanceId: string;
  catalogRevision: number;
  summary: SessionNotificationSummary;
}

export interface SessionInfo extends SessionRef {
  path: string;
  /** True when the server has verified a backing session file exists; false when known transient. */
  persisted?: boolean;
  name?: string;
  created: string;
  modified: string;
  messageCount: number;
  firstMessage: string;
  parentSessionPath?: string;
  archived?: boolean;
  archivedAt?: string;
}

export interface ArchiveSessionsResponse {
  archived: true;
  sessionIds?: string[];
  archivedCount?: number;
  skippedAlreadyArchivedCount?: number;
}

export interface SessionBulkMutationRef {
  id: string;
  cwd: string;
}

export interface SessionBulkMutationRequest {
  sessions: SessionBulkMutationRef[];
}

export interface SessionBulkFailure {
  sessionId: string;
  error: string;
}

export interface SessionBulkArchiveResponse {
  archived: true;
  archivedSessionIds: string[];
  failures: SessionBulkFailure[];
  generatedAt: string;
}

export interface SessionBulkDeleteArchivedResponse {
  deleted: true;
  deletedSessionIds: string[];
  failures: SessionBulkFailure[];
  generatedAt: string;
}

export interface SessionCleanupRequest {
  /** Archive non-archived sessions whose modified time is older than this many days. Omit/null to disable. */
  archiveIdleDays?: number | null;
  /** Permanently delete archived sessions whose archivedAt time is older than this many days. Omit/null to disable. */
  deleteArchivedDays?: number | null;
  /** Stored cwd paths selected from a preview. Omit/null to include all discovered project/workspace paths. */
  projectCwds?: string[] | null;
}

export interface SessionCleanupThresholds {
  archiveIdleDays?: number;
  deleteArchivedDays?: number;
}

export interface SessionCleanupProjectSummary {
  cwd: string;
  archiveCount: number;
  deleteCount: number;
}

export interface SessionCleanupTotals {
  archiveCount: number;
  deleteCount: number;
}

export interface SessionCleanupPreviewResponse {
  generatedAt: string;
  thresholds: SessionCleanupThresholds;
  projects: SessionCleanupProjectSummary[];
  totals: SessionCleanupTotals;
  skippedBusySessionIds?: string[];
}

export interface SessionCleanupExecuteResponse extends SessionCleanupPreviewResponse {
  archivedSessionIds: string[];
  deletedSessionIds: string[];
}

export interface SessionActivity {
  sessionId: string;
  phase: "active" | "idle" | "error";
  label: string;
  detail?: string;
  at: string;
  /**
   * Set only on the startup window's own reports. A startup phase is genuinely
   * in progress, so it is published as `active` and rendered like any other
   * activity, but *starting* a session is not *working* in it: there is nothing
   * to stop, nothing that blocks reloading from disk, and no workspace-level
   * work to report. `isSessionActive()` reads this to keep the two apart.
   */
  startup?: boolean;
}

export interface QueuedSessionMessage {
  kind: "steer" | "followUp";
  text: string;
}

/**
 * `customType` of the follow-up custom message that carries a closed ask back to
 * the model and into the transcript. Its `details` are an {@link AskUserOutcome}.
 */
export const ASK_USER_ANSWERS_CUSTOM_TYPE = "pi-web.ask.answers";

/** Largest question set one `ask_user` call may post. */
export const ASK_USER_QUESTION_LIMIT = 20;
/** Largest option list one question may offer. */
export const ASK_USER_OPTION_LIMIT = 12;
/** Length bound for ids: the ask id, question ids, and option values. */
export const ASK_USER_ID_MAX_LENGTH = 128;
/** Length bound for model-authored prose: questions, details, and option labels. */
export const ASK_USER_TEXT_MAX_LENGTH = 1_000;
/** Length bound for the free text a user types as a custom answer. */
export const ASK_USER_OTHER_TEXT_MAX_LENGTH = 4_000;

/** One selectable option of an {@link AskUserQuestion}. */
export interface AskUserQuestionOption {
  /** Stable machine value reported back to the model. */
  value: string;
  /** Short human label rendered in the browser. */
  label: string;
  /** Optional clarifying line rendered under the label. */
  detail?: string;
}

/**
 * One question of an `ask_user` set. Questions are never required: the user may
 * submit while leaving any of them untouched, and unanswered questions are
 * reported to the model as such.
 */
export interface AskUserQuestion {
  /** Unique within the ask; used as the answer key. */
  id: string;
  /** The question itself, as one plain-text line. */
  question: string;
  /** Optional supporting context rendered under the question. */
  detail?: string;
  /** Offered options; may be empty when only free text makes sense. */
  options: AskUserQuestionOption[];
  /** When true, several options may be selected at once. */
  multiple?: boolean;
}

/**
 * The open, unanswered question set of a session. Daemon-owned and reported in
 * {@link SessionStatus}, so a reconnecting or reloading browser rehydrates it
 * without depending on having seen the `ask.opened` event.
 */
export interface PendingAskUser {
  askId: string;
  askedAt: string;
  questions: AskUserQuestion[];
}

/** Why an ask stopped being the session's open ask. */
export type AskUserCloseReason = "submitted" | "superseded" | "cancelled";

/**
 * What the user replied to one question. Absent from a submission means the
 * question was left untouched; an empty `values` with no `otherText` means the
 * same thing.
 */
export interface AskUserAnswer {
  /** Matches an {@link AskUserQuestion.id} of the open ask. */
  id: string;
  /** Selected {@link AskUserQuestionOption.value} entries; several only when the question allows it. */
  values: string[];
  /** Free text typed as the question's custom answer. */
  otherText?: string;
}

/** One submit of the open ask: answers for some or all of its questions. */
export interface AskUserSubmission {
  answers: AskUserAnswer[];
}

/**
 * One question of a closed ask paired with what came back for it. Carries the
 * question itself so the record renders without the original ask still existing.
 */
export interface AskUserQuestionRecord {
  question: AskUserQuestion;
  /** True when at least one option was selected or custom text was given. */
  answered: boolean;
  values: string[];
  otherText?: string;
}

/**
 * The complete result of an ask, computed when it closes. Shared by the
 * model-facing follow-up message and the browser's read-only record, so both
 * report the same answered and unanswered questions.
 */
export interface AskUserOutcome {
  askId: string;
  reason: AskUserCloseReason;
  askedAt: string;
  closedAt: string;
  questions: AskUserQuestionRecord[];
  answeredCount: number;
  /** Ids of the questions left unanswered, in the order they were asked. */
  unansweredIds: string[];
  /** One line, for example `Answered 3 of 5; unanswered: q2, q5`. */
  summary: string;
}

/**
 * Result of the browser closing an ask by submitting or cancelling it.
 *
 * `"stale"` is an ordinary race rather than an error: the named ask was already
 * submitted, superseded by a newer one, or gone with its session runtime. The
 * browser drops its card and trusts `sessionStatus`, which is returned in both
 * cases so closing an ask needs no follow-up status request.
 */
export interface AskUserCloseResponse {
  result: "closed" | "stale";
  /** Present only when this call is the one that closed the ask. */
  outcome?: AskUserOutcome;
  sessionStatus: SessionStatus;
}

/** Length bound for extension-dialog ids. */
export const EXTENSION_DIALOG_ID_MAX_LENGTH = 128;
/** Length bound for extension-authored dialog prose: titles, messages, options, placeholders. */
export const EXTENSION_DIALOG_TEXT_MAX_LENGTH = 1_000;
/** Largest option list one `select` dialog may offer. */
export const EXTENSION_DIALOG_OPTION_LIMIT = 24;
/** Length bound for the text a user types into an `input` dialog. */
export const EXTENSION_DIALOG_INPUT_MAX_LENGTH = 4_000;

/** Which extension UI dialog primitive a pending dialog belongs to. */
export type ExtensionDialogKind = "confirm" | "select" | "input";

/**
 * The value a user gave in an extension dialog: a boolean for `confirm`, the
 * chosen option for `select`, the typed text for `input`. Absent when the
 * dialog closed without an answer.
 */
export type ExtensionDialogAnswer = boolean | string;

/**
 * Why a dialog stopped being open. `"answered"` carries an
 * {@link ExtensionDialogAnswer}; every other reason is a close without one.
 */
export type ExtensionDialogCloseReason = "answered" | "cancelled" | "timeout" | "aborted" | "session-ended";

/**
 * One open extension dialog of a session, opened by `ctx.ui.confirm()`,
 * `ctx.ui.select()`, or `ctx.ui.input()`. Daemon-owned and reported in
 * {@link SessionStatus.pendingDialogs}, so a reconnecting or reloading browser
 * rehydrates it without depending on having seen the `dialog.opened` event.
 *
 * Unlike asks, several dialogs may be open per session at once: each dialog is
 * an independent blocking wait inside extension code, so opening never
 * supersedes an existing one.
 */
export interface PendingExtensionDialog {
  dialogId: string;
  kind: ExtensionDialogKind;
  title: string;
  /** Supporting line of a `confirm` dialog. */
  message?: string;
  /** Offered choices of a `select` dialog. */
  options?: string[];
  /** Placeholder text of an `input` dialog. */
  placeholder?: string;
  askedAt: string;
  /**
   * When the dialog auto-cancels, as ISO: the sooner of the extension's own
   * `timeout` and the daemon's `extensionDialogsTimeoutMs` default. Absent
   * when the dialog waits forever.
   */
  timeoutAt?: string;
  /** Opened while a run was in flight, so `agent_end` settles it as `"aborted"`. */
  runScoped: boolean;
}

/**
 * The complete result of a closed extension dialog. Unlike an ask outcome it
 * stays small — the dialog itself is not embedded, because a settled card is a
 * browser-local record that stays until the user dismisses it; reloads
 * rehydrate open dialogs from {@link SessionStatus.pendingDialogs} alone.
 */
export interface ExtensionDialogOutcome {
  dialogId: string;
  reason: ExtensionDialogCloseReason;
  /** Present only when `reason` is `"answered"`. */
  answer?: ExtensionDialogAnswer;
  askedAt: string;
  closedAt: string;
}

/**
 * Browser request to answer an open extension dialog with the user's value.
 * `cwd` rides along as the standard session-lookup field, as on every other
 * session route; whether the value fits the dialog's kind is the store's call,
 * so an ill-fitting answer is a 400 that leaves the dialog open.
 */
export interface ExtensionDialogAnswerRequest {
  cwd?: string;
  dialogId: string;
  value: ExtensionDialogAnswer;
}

/** Browser request to dismiss an open extension dialog without an answer. */
export interface ExtensionDialogCancelRequest {
  cwd?: string;
  dialogId: string;
}

/**
 * Result of the browser answering or cancelling an extension dialog. Mirrors
 * {@link AskUserCloseResponse}: `"stale"` is an ordinary lost race — another
 * browser, a timeout, or a teardown closed the dialog first — not an error.
 * The browser drops its card and trusts `sessionStatus`, which is returned in
 * both cases so closing a dialog needs no follow-up status request.
 */
export interface ExtensionDialogCloseResponse {
  result: "closed" | "stale";
  /** Present only when this call is the one that closed the dialog. */
  outcome?: ExtensionDialogOutcome;
  sessionStatus: SessionStatus;
}

/**
 * Progress of the session startup window, where the daemon is still
 * constructing the agent session and no `PiAgentSession` exists yet, so
 * `activity.update` cannot be published for it.
 *
 * `startupToken` is the opaque label a create request supplied, echoed back so a
 * browser row still waiting for a session id recognises its own construction.
 * The daemon never interprets it and it never becomes the session id:
 * `activity.sessionId` always carries the real id, which is how an *open* of a
 * session the browser already knows is routed instead.
 *
 * `activity.phase === "idle"` means the startup window ended with nothing left
 * to report, so a browser that substituted its own text should restore it.
 */
export interface SessionStartupProgressEvent {
  type: "session.startup";
  startupToken?: string;
  activity: SessionActivity;
}

/**
 * A pi-native image attachment carried with a prompt. The wire format mirrors
 * pi's own `ImageContent` shape (`{ type: "image", data, mimeType }`) so these
 * attachments are compatible with native multimodal delivery after validation.
 */
export interface PromptImageAttachment {
  kind: "image";
  /** Supported image MIME type (image/png, image/jpeg, image/gif, or image/webp). */
  mimeType: string;
  /** Base64-encoded binary payload (no data: URL prefix). */
  data: string;
  /** Optional original filename, used for previews and folder-mode filenames. */
  name?: string;
}

/** A general file attachment that must be saved into the workspace before use. */
export interface PromptFileAttachment {
  kind: "file";
  /** Non-empty IANA MIME type (for example "application/pdf"). */
  mimeType: string;
  /** Base64-encoded binary payload (no data: URL prefix). Empty for zero-byte files. */
  data: string;
  /** Optional original filename, used for previews and folder-mode filenames. */
  name?: string;
}

export type PromptAttachment = PromptImageAttachment | PromptFileAttachment;

/**
 * How prompt attachments should be delivered to the session.
 * - "inline": send the binary to pi as native image content (multimodal input).
 * - "folder": save the file into the workspace and reference it from the prompt
 *   text so the agent reads it with its own tools.
 */
export type PromptAttachmentDelivery = "inline" | "folder";

export interface SavedPromptAttachment {
  /** Workspace-relative path the attachment was written to. */
  path: string;
  mimeType: string;
  size: number;
}

export interface SessionModel {
  provider?: string;
  id?: string;
  name?: string;
  contextWindow?: number;
  reasoning?: unknown;
}

/**
 * One row of a session machine's full available-model catalog: the model plus
 * its membership in pi's effective enabled-models scope (`enabledModels`
 * setting). Model scope is selection UX for picking/cycling, never an
 * authorization boundary. Workspace overrides mark rows non-editable because
 * PI WEB's picker writes only the global setting.
 */
export interface SessionModelCatalogEntry {
  provider: string;
  id: string;
  name?: string;
  contextWindow?: number;
  reasoning?: unknown;
  enabled: boolean;
  /** False when a workspace `.pi/settings.json` override controls membership and the global picker is read-only. */
  editable?: boolean;
  /** Stable zero-based position in the machine's unscoped catalog. Optional for compatibility with older servers. */
  catalogIndex?: number;
}

/**
 * The session machine's full available model catalog with per-model enabled
 * state. Enabled models come first — in the same set and order as the
 * session's pickable ("Enabled") model list — followed by the remaining
 * models in catalog order. Each row's `catalogIndex` preserves its natural
 * unscoped position independently of this enabled-first response order.
 */
export interface SessionModelCatalogResponse {
  models: SessionModelCatalogEntry[];
}

/** Canonical model-scope presets exposed by the model picker's bulk toggle. */
export type SessionModelScopeMode = "all" | "current";

// Domain type is owned by pi and re-exported from the shared thinking-levels
// module. Wire/data fields below intentionally use `string` so an unknown level
// from a newer pi runtime parses and renders gracefully instead of failing.
export type { ThinkingLevel } from "./thinkingLevels.js";

export type AuthType = "oauth" | "api_key";
export type AuthStatusSource = "stored" | "runtime" | "environment" | "fallback" | "models_json_key" | "models_json_command";

export interface AuthProviderStatus {
  configured: boolean;
  source?: AuthStatusSource;
  label?: string;
}

export interface AuthProviderOption {
  id: string;
  name: string;
  authType: AuthType;
  status: AuthProviderStatus;
  /** Present when the provider logs in through the generic AuthInteraction flow. */
  loginFlow?: "interactive";
}

export interface AuthProvidersResponse {
  providers: AuthProviderOption[];
}

export interface OAuthFlowState {
  flowId: string;
  providerId: string;
  providerName: string;
  status: "running" | "complete" | "error" | "cancelled";
  auth?: {
    url: string;
    instructions?: string;
    deviceCode?: { userCode: string; intervalSeconds?: number; expiresInSeconds?: number };
  };
  prompt?: {
    requestId: string;
    message: string;
    placeholder?: string;
    allowEmpty?: boolean;
    promptType: "text" | "secret" | "manual_code";
  };
  select?: { requestId: string; message: string; options: CommandOption[] };
  progress: string[];
  info?: { message: string; links?: { url: string; label?: string }[] }[];
  error?: string;
}

export interface ModelSelectionResponse {
  models: SessionModel[];
}

export interface ThinkingLevelsResponse {
  levels: string[];
}

export type SessionWarningSeverity = "info" | "warning" | "error";

/**
 * A live, runtime-scoped warning surfaced to the browser (skill/resource
 * diagnostics, extension load errors, subscription-auth billing notice, etc.).
 *
 * Warnings are recomputed whenever the runtime is (re)built inside sessiond and
 * are not persisted chat messages. `source` is an optional short origin label
 * (e.g. `"skill"`, `"extension"`, `"anthropic"`); `path` carries a related file
 * path when the warning came from a resource diagnostic.
 *
 * `dismiss` is present only when the warning has a durable, first-class
 * off-switch in the underlying `pi` agent (not a UI-only hide). Its `id` is the
 * opaque token the server maps back to that suppression; the client renders a
 * dismiss control for any warning carrying it, without knowing what it means.
 */
export interface SessionWarning {
  severity: SessionWarningSeverity;
  message: string;
  source?: string;
  path?: string;
  dismiss?: { id: string };
}

export interface SessionStatus {
  sessionId: string;
  /** True when the server has verified a backing session file exists; false when known transient. */
  persisted?: boolean;
  model?: SessionModel;
  thinkingLevel?: string;
  isStreaming: boolean;
  isCompacting: boolean;
  isBashRunning: boolean;
  pendingMessageCount: number;
  queuedMessages: QueuedSessionMessage[];
  messageCount?: number;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  cost: number;
  contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null };
  /**
   * Live, runtime-scoped warnings for this session (skill/resource diagnostics,
   * extension load errors, Anthropic subscription-auth billing notice, etc.).
   * Recomputed on each status read from the current runtime; absent/empty when
   * there are none. See {@link SessionWarning}.
   */
  warnings?: SessionWarning[];
  /**
   * The session's open `ask_user` question set, when one is waiting for the
   * user. Daemon-owned, so it survives browser reload and web/API restarts.
   */
  pendingAsk?: PendingAskUser;
  /**
   * The session's open extension dialogs, oldest first, when any are waiting
   * for the user. Daemon-owned, so they survive browser reload and web/API
   * restarts. Several may be open at once; the UI presents them as a queue.
   */
  pendingDialogs?: PendingExtensionDialog[];
}

export interface SlashCommand {
  name: string;
  description?: string;
  source: "extension" | "prompt" | "skill" | "builtin";
}

export interface FileSuggestion {
  path: string;
  kind: "tracked" | "untracked" | "other";
}

export interface TerminalInfo {
  id: string;
  cwd: string;
  name: string;
  createdAt: string;
  exited: boolean;
  exitCode?: number;
  commandRunId?: string;
}

export interface RunTerminalCommandInput {
  workspace: Workspace;
  title: string;
  command: string;
  metadata?: Record<string, string>;
  open?: boolean;
}

/** Secret-free identity of the pi agent state directory fixed for one sessiond lifetime. */
export interface ActiveAgentProfileDescriptor {
  readonly schemaVersion: 2;
  readonly dir: string;
}

export interface PiWebRuntimeComponent {
  component: PiWebServiceComponent;
  label: string;
  runtimeVersion?: string;
  /** Version of the Pi coding agent library loaded by this component's process; omitted when the component does not report it. */
  piVersion?: string;
  available: boolean;
  capabilities: PiWebCapability[];
  /** Present only for a session daemon that supports active-profile reporting. */
  activeAgentProfile?: ActiveAgentProfileDescriptor;
  /** Deprecated agent-configuration inputs detected in this component's process environment and config file; omitted when none. */
  deprecatedAgentInputs?: readonly PiWebDeprecatedAgentInput[];
  error?: string;
}

export interface PiWebRuntimeResponse {
  packageName: string;
  generatedAt: string;
  components: {
    web: PiWebRuntimeComponent;
    sessiond: PiWebRuntimeComponent;
  };
  capabilities: PiWebCapability[];
}

export type TerminalUiEvent =
  | { type: "terminal.created"; terminal: TerminalInfo }
  | { type: "terminal.exited"; terminal: TerminalInfo }
  | { type: "terminal.closed"; terminalId: string; cwd: string };

export interface CommandOption {
  value: string;
  label: string;
  description?: string;
}

export type SessionTreeNodeKind =
  | "user"
  | "assistant"
  | "tool-result"
  | "bash"
  | "custom-message"
  | "compaction"
  | "branch-summary"
  | "model-change"
  | "thinking-level-change"
  | "session-info"
  | "label"
  | "custom"
  | "other";

export interface SessionTreeNode {
  id: string;
  parentId: string | null;
  kind: SessionTreeNodeKind;
  summary: string;
  timestamp?: string;
  label?: string;
}

export interface SessionTreeSnapshot {
  /** Pre-order, parent-linked projection of all retained roots and descendants. */
  nodes: SessionTreeNode[];
  activeLeafId: string | null;
  /** Root-to-leaf IDs for explicit, non-color-only active-path rendering. */
  activePathIds: string[];
}

export const SESSION_TREE_CUSTOM_INSTRUCTIONS_MAX_LENGTH = 10_000;

export type SessionTreeSummaryChoice =
  | { mode: "none" }
  | { mode: "default" }
  | { mode: "custom"; instructions: string };

export interface SessionTreeNavigateRequest {
  targetId: string;
  /** Leaf shown when the navigator opened; null is valid for an empty/root position. */
  expectedLeafId: string | null;
  summary: SessionTreeSummaryChoice;
}

export type SessionTreeNavigateResult =
  | { cancelled: false; editorText?: string }
  | { cancelled: true; aborted?: boolean };

export interface SessionTreeForkRequest {
  entryId: string;
  /** Leaf shown when the navigator opened; null is valid for an empty/root position. */
  expectedLeafId: string | null;
}

/**
 * Fork-from-entry creates a new session file up to the selected entry and
 * switches the runtime to it, leaving the original session untouched. User
 * entries fork from "before" so their text returns as a `promptDraft` for the
 * forked session; every other entry forks "at".
 */
export type SessionTreeForkResult =
  | { cancelled: false; session: SessionInfo; promptDraft?: string }
  | { cancelled: true };

export interface MessagePage {
  messages: unknown[];
  start: number;
  total: number;
}

/**
 * Join-time snapshot of a session's in-flight assistant stream. `seq` is the
 * `SessionEventHub` watermark captured together with `partial` in a single tick,
 * so a joining client can seed `partial` and then apply only buffered live events
 * with `seq > snapshot.seq` (exactly-once). `partial` is a browser-projected
 * in-flight `AssistantMessage` (thinking signatures stripped), or `null` when the
 * session is not mid assistant-message stream.
 */
export interface SessionStreamSnapshot {
  seq: number;
  /** Browser-projected in-flight `AssistantMessage`, or `null` when idle. */
  partial: unknown;
}

export type CommandResult =
  | { type: "done"; message?: string; session?: SessionInfo; promptDraft?: string }
  | { type: "select"; requestId: string; title: string; options: CommandOption[] }
  | { type: "tree"; tree: SessionTreeSnapshot }
  | { type: "unsupported"; message: string };

/**
 * Transport-level per-session sequence stamp. `SessionEventHub.publish` assigns a
 * monotonic `seq` to every per-session event as it is serialized to the socket.
 * Clients use it as a watermark against the join-time stream snapshot so buffered
 * live events are applied exactly once. Existing consumers may ignore it.
 */
export type SessionUiEvent = SessionUiEventBody & { seq?: number };

type SessionUiEventBody =
  | { type: "message.append"; message: unknown }
  | { type: "assistant.delta"; text: string }
  | { type: "assistant.thinking.delta"; text: string }
  | { type: "tool.start"; toolName: string; toolCallId: string; summary: string; args?: unknown }
  | { type: "tool.update"; toolName: string; toolCallId: string; text: string; content?: unknown; details?: unknown }
  | { type: "tool.end"; toolName: string; toolCallId: string; text: string; isError: boolean; content?: unknown; details?: unknown }
  | { type: "shell.start"; command: string; excludeFromContext?: boolean }
  | { type: "shell.chunk"; chunk: string }
  | { type: "shell.end"; output?: string; exitCode?: number | null; cancelled?: boolean; truncated?: boolean; fullOutputPath?: string; isError?: boolean }
  | { type: "agent.start" }
  | { type: "agent.end" }
  | { type: "message.end"; message?: unknown }
  | { type: "status.update"; status: SessionStatus }
  | { type: "activity.update"; activity: SessionActivity }
  | { type: "command.output"; level: "info" | "success" | "error"; message: string }
  | SessionNotificationInboxEvent
  | { type: "session.error"; message: string }
  | { type: "ask.opened"; ask: PendingAskUser }
  | { type: "ask.closed"; askId: string; reason: AskUserCloseReason }
  | { type: "dialog.opened"; dialog: PendingExtensionDialog }
  | { type: "dialog.closed"; dialogId: string; reason: ExtensionDialogCloseReason; answer?: ExtensionDialogAnswer }
  | { type: "session.name"; sessionId: string; name?: string }
  | { type: "session.created"; session: SessionInfo }
  | { type: "pi.event"; eventType: string };

/** Global invalidation for the daemon-owned enabled-model scope. */
export interface ModelScopeChangedEvent {
  type: "models.changed";
  revision: number;
}

export type GlobalSessionEvent =
  | Extract<SessionUiEventBody, { type: "status.update" | "activity.update" | "session.name" | "session.created" }>
  | SessionNotificationSummaryEvent
  | SessionUnreadEvent
  | SessionStartupProgressEvent
  | ModelScopeChangedEvent;
export type RealtimeEvent = GlobalSessionEvent | TerminalUiEvent | MachineStatusUiEvent;
