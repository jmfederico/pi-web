export type MachineKind = "local" | "remote";
export type MachineStatus = "unknown" | "online" | "offline" | "error";

export const PI_WEB_CAPABILITIES = {
  sessionsDeleteArchived: "sessions.deleteArchived",
  sessionsBulkMutations: "sessions.bulkMutations",
  sessionsCleanup: "sessions.cleanup",
  sessionsReload: "sessions.reload",
  sessionsPersistedState: "sessions.persistedState",
  promptAttachments: "prompt.attachments",
  workspaceFileSuggestions: "workspace.fileSuggestions",
  piPackagesManage: "piPackages.manage",
  selectedMachineSettings: "settings.selectedMachine",
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
  /** Maximum accepted HTTP request body size in bytes (uploads/attachments). */
  maxUploadBytes?: number;
  /** When true, LLMs can start new sessions via the spawn_session tool. */
  spawnSessions?: boolean;
  /**
   * Beta: when true, LLMs can start tracked child sessions via the
   * spawn_subsession / list_subsessions / check_subsession / read_subsession
   * tools. Off by default
   * while the capability stabilizes. Requires spawnSessions to be enabled.
   */
  subsessions?: boolean;
  /** When true (the default), the Scheduled Tasks cron scheduler runs. */
  scheduledTasks?: boolean;
  /** VAPID public key for Web Push notifications (generated via `npx web-push generate-vapid-keys`). */
  vapidPublicKey?: string;
  /** VAPID private key for Web Push notifications. Keep secret. */
  vapidPrivateKey?: string;
  /** Email for VAPID contact (required by push services; shown if something goes wrong). */
  vapidContact?: string;
}

export type PiWebPluginScope = "bundled" | "local" | "user" | "project";

export interface PiWebPluginInfo {
  id: string;
  module: string;
  source: string;
  scope: PiWebPluginScope;
  machineSpecific: boolean;
  enabled: boolean;
}

export interface PiWebPluginsResponse {
  plugins: PiWebPluginInfo[];
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
  uploads?: PiWebUploadsConfig;
}

export interface Workspace {
  id: string;
  projectId: string;
  path: string;
  label: string;
  branch?: string;
  isMain: boolean;
  isGitRepo: boolean;
  isGitWorktree: boolean;
  /** Workspace-effective project/global settings needed by workspace UI features. */
  effectiveConfig?: WorkspaceEffectiveConfig;
}

export type ScheduledTaskSessionMode = "new" | "continue-latest";

export interface ScheduledTaskSchedule {
  /** Standard cron expression (5 fields, or 6 with a leading seconds field). */
  cron: string;
  /** IANA timezone, e.g. "Asia/Jakarta". */
  timezone: string;
}

export interface ScheduledTask {
  id: string;
  name: string;
  projectId: string;
  /** Omitted = the project's main workspace/checkout. */
  workspaceId?: string;
  /** Sent verbatim as the prompt text on each run — identical to a typed chat message. */
  prompt: string;
  schedule: ScheduledTaskSchedule;
  sessionMode: ScheduledTaskSessionMode;
  notifyOnComplete: boolean;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  /** Computed, not persisted: ISO timestamp of the next scheduled fire. Absent when disabled or unschedulable. */
  nextRunAt?: string;
}

export type ScheduledTaskRunStatus = "running" | "success" | "failure" | "skipped";
export type ScheduledTaskRunTrigger = "schedule" | "manual";

export interface ScheduledTaskRun {
  id: string;
  taskId: string;
  triggeredBy: ScheduledTaskRunTrigger;
  startedAt: string;
  finishedAt?: string;
  status: ScheduledTaskRunStatus;
  sessionId?: string;
  cwd?: string;
  /** Populated for "skipped" (why it was skipped) and "failure" (what went wrong) runs. */
  note?: string;
}

export interface ScheduledTaskCreateRequest {
  name: string;
  projectId: string;
  workspaceId?: string;
  prompt: string;
  schedule: ScheduledTaskSchedule;
  sessionMode?: ScheduledTaskSessionMode;
  notifyOnComplete?: boolean;
  enabled?: boolean;
}

export interface ScheduledTaskUpdateRequest {
  name?: string;
  projectId?: string;
  workspaceId?: string;
  /** Set true to clear workspaceId back to "project's main workspace", distinct from "not provided". */
  clearWorkspaceId?: boolean;
  prompt?: string;
  schedule?: ScheduledTaskSchedule;
  sessionMode?: ScheduledTaskSessionMode;
  notifyOnComplete?: boolean;
  enabled?: boolean;
}

export interface SessionRef {
  id: string;
  cwd: string;
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
  /** ISO timestamp of when the session was last marked as read. */
  lastReadAt?: string;
  /** Message count at the time the session was last marked as read. */
  lastReadMessageCount?: number;
}

export interface ArchiveSessionsResponse {
  archived: true;
  sessionIds?: string[];
  archivedCount?: number;
  skippedAlreadyArchivedCount?: number;
}

export interface SessionBulkMutationRef {
  id: string;
  cwd?: string;
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
}

export interface QueuedSessionMessage {
  kind: "steer" | "followUp";
  text: string;
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
}

export interface AuthProvidersResponse {
  providers: AuthProviderOption[];
}

export interface OAuthFlowState {
  flowId: string;
  providerId: string;
  providerName: string;
  status: "running" | "complete" | "error" | "cancelled";
  auth?: { url: string; instructions?: string };
  prompt?: { requestId: string; message: string; placeholder?: string; allowEmpty?: boolean; kind: "prompt" | "manual" };
  select?: { requestId: string; message: string; options: CommandOption[] };
  progress: string[];
  error?: string;
}

export interface ModelSelectionResponse {
  models: SessionModel[];
}

export interface ThinkingLevelsResponse {
  levels: string[];
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
}

export interface WorkspaceActivity {
  cwd: string;
  hasSessionActivity: boolean;
  hasTerminalActivity: boolean;
  updatedAt: string;
}

export interface WorkspaceActivityResponse {
  workspaces: WorkspaceActivity[];
  generatedAt: string;
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

export interface FileTreeEntry {
  name: string;
  path: string;
  type: "file" | "directory" | "symlink";
  size?: number;
  modifiedAt?: string;
}

export interface FileTreeResponse {
  path: string;
  entries: FileTreeEntry[];
  scannedAt: string;
  truncated: boolean;
}

export type FileContentMediaType = "image";

export interface FileContentResponse {
  path: string;
  language?: string;
  mediaType?: FileContentMediaType;
  mimeType?: string;
  encoding: "utf8";
  size: number;
  modifiedAt: string;
  content: string;
  truncated: boolean;
  binary: boolean;
}

export interface WriteWorkspaceFileOptions {
  createDirs?: boolean;     // default: true — mkdir -p equivalent
  overwrite?: boolean;      // default: true — throw if false and file exists
}

export interface WriteWorkspaceFileResponse {
  path: string;
  size: number;
  modifiedAt: string;
  created: boolean;  // true if file was created, false if overwritten
}

export interface DeleteWorkspaceFileResponse {
  path: string;
  existed: boolean;  // true if file existed and was deleted, false if file did not exist
}

export interface MoveWorkspaceFileOptions {
  createDirs?: boolean;   // default: true — mkdir -p equivalent for target parent directory
  overwrite?: boolean;    // default: false — throw if target exists (safer default than writeFile)
}

export interface MoveWorkspaceFileResponse {
  fromPath: string;
  toPath: string;
  size: number;
  modifiedAt: string;
}

export type GitFileState = "unmodified" | "modified" | "added" | "deleted" | "renamed" | "copied" | "untracked" | "ignored" | "conflicted";

export interface GitStatusFile {
  path: string;
  oldPath?: string;
  index: GitFileState;
  workingTree: GitFileState;
}

export interface GitStatusResponse {
  isGitRepo: boolean;
  hash: string;
  branch?: string;
  upstream?: string;
  ahead?: number;
  behind?: number;
  files: GitStatusFile[];
}

export interface GitDiffResponse {
  path?: string;
  staged: boolean;
  hash: string;
  diff: string;
  truncated: boolean;
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

export type TerminalCommandRunStatus = "queued" | "running" | "succeeded" | "failed";

export interface TerminalCommandRun {
  id: string;
  origin: string;
  projectId: string;
  workspaceId: string;
  terminalId: string;
  title: string;
  command: string;
  status: TerminalCommandRunStatus;
  exitCode?: number;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  metadata: Record<string, string>;
}

export interface RunTerminalCommandInput {
  workspace: Workspace;
  title: string;
  command: string;
  metadata?: Record<string, string>;
  open?: boolean;
}

export interface TerminalCommandRunHandle {
  run: TerminalCommandRun;
  completed: Promise<TerminalCommandRun>;
}

export interface TerminalCommandRunFilter {
  projectId?: string;
  workspaceId?: string;
  terminalId?: string;
  statuses?: TerminalCommandRunStatus[];
  metadata?: Record<string, string>;
}

export type PiWebServiceComponent = "web" | "sessiond";
export type PiWebStatusSeverity = "info" | "warning" | "error";
export type PiWebInstallationKind = "pi-package" | "npm-global" | "local" | "docker" | "unknown";
export type PiWebDockerMode = "runtime" | "dev";

export interface PiWebInstallationInfo {
  kind: PiWebInstallationKind;
  path?: string;
  source?: string;
  scope?: "user" | "project";
  npmRoot?: string;
  dockerMode?: PiWebDockerMode;
}

export interface PiWebComponentStatus {
  component: PiWebServiceComponent;
  label: string;
  runtimeVersion?: string;
  installedVersion?: string;
  stale: boolean;
  available: boolean;
  installation?: PiWebInstallationInfo;
  error?: string;
}

export interface PiWebRuntimeComponent {
  component: PiWebServiceComponent;
  label: string;
  runtimeVersion?: string;
  available: boolean;
  capabilities: PiWebCapability[];
  error?: string;
}

export interface PiWebReleaseStatus {
  packageName: string;
  latestVersion?: string;
  updateAvailable: boolean;
  checkedAt?: string;
  skipped?: boolean;
  error?: string;
}

export interface PiWebStatusMessage {
  id: string;
  severity: PiWebStatusSeverity;
  title: string;
  body: string;
  command?: string;
}

export interface PiWebVersionResponse {
  packageName: string;
  generatedAt: string;
  components: {
    web: PiWebComponentStatus;
    sessiond: PiWebComponentStatus;
  };
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

export interface PiWebStatusResponse extends PiWebVersionResponse {
  release: PiWebReleaseStatus;
  commands: {
    update?: string;
    restart?: string;
    restartWeb?: string;
    restartSessiond?: string;
    status?: string;
  };
  messages: PiWebStatusMessage[];
}

export type TerminalUiEvent =
  | { type: "terminal.created"; terminal: TerminalInfo }
  | { type: "terminal.exited"; terminal: TerminalInfo }
  | { type: "terminal.closed"; terminalId: string; cwd: string };

export interface WorkspaceActivityUiEvent {
  type: "workspace.activity";
  activity: WorkspaceActivity;
}

export interface CommandOption {
  value: string;
  label: string;
  description?: string;
}

export interface MessagePage {
  messages: unknown[];
  start: number;
  total: number;
}

export type CommandResult =
  | { type: "done"; message?: string; session?: SessionInfo; promptDraft?: string }
  | { type: "select"; requestId: string; title: string; options: CommandOption[] }
  | { type: "unsupported"; message: string };

export type SessionUiEvent =
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
  | { type: "session.error"; message: string }
  | { type: "session.name"; sessionId: string; name?: string }
  | { type: "session.created"; session: SessionInfo }
  | { type: "session.read"; sessionId: string; lastReadAt: string; lastReadMessageCount: number }
  | { type: "pi.event"; eventType: string }
  | { type: "questionnaire.show"; requestId: string; questions: QuestionnaireQuestion[] };

export interface QuestionnaireQuestion {
  question: string;
  header: string;
  multiSelect: boolean;
  options: QuestionnaireOption[];
}

export interface QuestionnaireOption {
  label: string;
  description: string;
  preview?: string;
}

export interface QuestionnaireAnswer {
  questionIndex: number;
  question: string;
  kind: "option" | "custom" | "chat" | "multi";
  answer: string | null;
  selected?: string[];
  notes?: string;
}

export interface AskUserQuestionResult {
  answers: QuestionnaireAnswer[];
  cancelled: boolean;
  error?: string;
}

export type GlobalSessionEvent = Extract<SessionUiEvent, { type: "status.update" | "activity.update" | "session.name" | "session.created" | "session.read" }>;
export type RealtimeEvent = GlobalSessionEvent | TerminalUiEvent | WorkspaceActivityUiEvent;
