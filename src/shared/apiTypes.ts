export interface Project {
  id: string;
  name: string;
  path: string;
  createdAt: string;
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
}

export interface SessionInfo {
  id: string;
  path: string;
  cwd: string;
  name?: string;
  created: string;
  modified: string;
  messageCount: number;
  firstMessage: string;
  parentSessionPath?: string;
  archived?: boolean;
  archivedAt?: string;
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

export interface SessionModel {
  provider?: string;
  id?: string;
  name?: string;
  contextWindow?: number;
  reasoning?: unknown;
}

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

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
  levels: ThinkingLevel[];
}

export interface SessionStatus {
  sessionId: string;
  model?: SessionModel;
  thinkingLevel?: string;
  isStreaming: boolean;
  isCompacting: boolean;
  isBashRunning: boolean;
  pendingMessageCount: number;
  queuedMessages: QueuedSessionMessage[];
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  cost: number;
  contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null };
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

export interface FileContentResponse {
  path: string;
  language?: string;
  encoding: "utf8";
  size: number;
  modifiedAt: string;
  content: string;
  truncated: boolean;
  binary: boolean;
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
}

export type PiWebServiceComponent = "web" | "sessiond";
export type PiWebStatusSeverity = "info" | "warning" | "error";
export type PiWebInstallationKind = "pi-package" | "npm-global" | "local" | "unknown";

export interface PiWebInstallationInfo {
  kind: PiWebInstallationKind;
  path?: string;
  source?: string;
  scope?: "user" | "project";
  npmRoot?: string;
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

export interface PiWebStatusResponse {
  packageName: string;
  generatedAt: string;
  components: {
    web: PiWebComponentStatus;
    sessiond: PiWebComponentStatus;
  };
  release: PiWebReleaseStatus;
  commands: {
    update: string;
    restart: string;
    restartSystemd: string;
    restartDev: string;
  };
  messages: PiWebStatusMessage[];
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

export interface MessagePage {
  messages: unknown[];
  start: number;
  total: number;
}

export type CommandResult =
  | { type: "done"; message?: string; session?: SessionInfo }
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
  | { type: "pi.event"; eventType: string };

export type GlobalSessionEvent = Extract<SessionUiEvent, { type: "status.update" | "activity.update" | "session.name" }>;
export type RealtimeEvent = GlobalSessionEvent | TerminalUiEvent;
