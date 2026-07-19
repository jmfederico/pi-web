import type { AuthProviderOption, CommandOption, CommandResult, FileContentResponse, FileTreeEntry, GitDiffResponse, GitStatusResponse, Machine, MachineHealth, MachineRuntime, OAuthFlowState, PiWebStatusResponse, Project, QueuedSessionMessage, SessionActivity, SessionInfo, SessionStatus, TerminalCommandRun, Workspace, WorkspaceActivity } from "./api";
import type { ChatLine } from "./components/shared";
import type { QualifiedContributionId } from "./plugins/ids";
import type { SelectedSessionNotificationInbox, SessionNotificationCatalogProjection } from "./sessionNotifications";
import type { WorkspaceUploadBatchState } from "./workspaceUploadState";

export interface AppState {
  machines: Machine[];
  selectedMachine: Machine | undefined;
  isLoadingMachines: boolean;
  machineStatuses: Record<string, MachineHealth>;
  machineRuntimes: Record<string, MachineRuntime>;
  projects: Project[];
  workspaces: Workspace[];
  sessions: SessionInfo[];
  messages: ChatLine[];
  messagePageStart: number;
  messagePageEnd: number;
  messagePageTotal: number;
  isLoadingEarlierMessages: boolean;
  /** Sessions with a prompt upload in flight, keyed by sessionId (client-owned). */
  sendingPrompts: Record<string, true>;
  /** Client-side queued sends waiting for a just-created backend session, keyed by sessionId. */
  clientQueuedSessionMessages: Record<string, QueuedSessionMessage[]>;
  /** Client-initiated session creation requests waiting for the server. */
  startingSessionCount: number;
  isLoadingProjects: boolean;
  isLoadingWorkspaces: boolean;
  selectedProject: Project | undefined;
  selectedWorkspace: Workspace | undefined;
  selectedSession: SessionInfo | undefined;
  status: SessionStatus | undefined;
  activity: SessionActivity | undefined;
  /** Thinking levels available for the selected session's current model. */
  availableThinkingLevels: readonly string[];
  sessionStatuses: Record<string, SessionStatus>;
  sessionActivities: Record<string, SessionActivity>;
  workspaceActivities: Record<string, WorkspaceActivity>;
  machineActivities: Record<string, Record<string, WorkspaceActivity>>;
  /** Fresh/stale daemon notification catalogs, isolated by exact machine id. */
  notificationCatalogsByMachine: Record<string, SessionNotificationCatalogProjection>;
  /** Authoritative projection plus browser-local optimistic overlays for the selected inbox. */
  selectedNotificationInbox: SelectedSessionNotificationInbox | undefined;
  workspacesByProjectId: Record<string, Workspace[]>;
  workspaceDeletionRuns: Record<string, TerminalCommandRun>;
  commandDialog: Extract<CommandResult, { type: "select" }> | undefined;
  modelDialog: { title: string; options: CommandOption[]; selectedValue?: string } | undefined;
  thinkingDialog: { title: string; options: CommandOption[]; selectedValue?: string } | undefined;
  themeDialog: { title: string; options: CommandOption[]; selectedValue?: string } | undefined;
  authDialog: AuthDialogState | undefined;
  actionPaletteOpen: boolean;
  projectDialogOpen: boolean;
  machineDialogOpen: boolean;
  workspaceTool: QualifiedContributionId;
  mainView: "navigation" | "chat" | QualifiedContributionId;
  fileTree: FileTreeEntry[];
  expandedDirs: Record<string, FileTreeEntry[]>;
  selectedFilePath: string | undefined;
  selectedFileContent: FileContentResponse | undefined;
  fileTreeStale: boolean;
  /** Manual workspace file upload batches, keyed by client-owned batch id. */
  workspaceUploadBatches: Record<string, WorkspaceUploadBatchState>;
  gitStatus: GitStatusResponse | undefined;
  selectedDiffPath: string | undefined;
  selectedDiff: GitDiffResponse | undefined;
  selectedStagedDiff: GitDiffResponse | undefined;
  gitStale: boolean;
  activeTerminalCount: number;
  selectedTerminalId: string | undefined;
  piWebStatus: PiWebStatusResponse | undefined;
  error: string;
}

export type AuthDialogState =
  | { step: "method" }
  | { step: "providers"; mode: "login"; authType?: "oauth" | "api_key"; providers: AuthProviderOption[] }
  | { step: "apiKey"; provider: AuthProviderOption; value: string; saving?: boolean; error?: string }
  | { step: "oauth"; flow: OAuthFlowState; machineId: string; responding?: boolean; inputValue?: string; error?: string }
  | { step: "logout"; providers: AuthProviderOption[] };

export type WorkspaceScopedStateReset = Pick<AppState,
  | "sessions"
  | "clientQueuedSessionMessages"
  | "startingSessionCount"
  | "selectedNotificationInbox"
  | "fileTree"
  | "expandedDirs"
  | "selectedFilePath"
  | "selectedFileContent"
  | "fileTreeStale"
  | "gitStatus"
  | "selectedDiffPath"
  | "selectedDiff"
  | "selectedStagedDiff"
  | "gitStale"
  | "selectedTerminalId"
  | "error"
>;

export function resetWorkspaceScopedState(): WorkspaceScopedStateReset {
  return {
    sessions: [],
    clientQueuedSessionMessages: {},
    startingSessionCount: 0,
    selectedNotificationInbox: undefined,
    fileTree: [],
    expandedDirs: {},
    selectedFilePath: undefined,
    selectedFileContent: undefined,
    fileTreeStale: false,
    gitStatus: undefined,
    selectedDiffPath: undefined,
    selectedDiff: undefined,
    selectedStagedDiff: undefined,
    gitStale: false,
    selectedTerminalId: undefined,
    error: "",
  };
}

export function initialAppState(): AppState {
  return {
    machines: [],
    selectedMachine: undefined,
    isLoadingMachines: false,
    machineStatuses: {},
    machineRuntimes: {},
    projects: [],
    workspaces: [],
    sessions: [],
    messages: [],
    messagePageStart: 0,
    messagePageEnd: 0,
    messagePageTotal: 0,
    isLoadingEarlierMessages: false,
    sendingPrompts: {},
    clientQueuedSessionMessages: {},
    startingSessionCount: 0,
    isLoadingProjects: false,
    isLoadingWorkspaces: false,
    selectedProject: undefined,
    selectedWorkspace: undefined,
    selectedSession: undefined,
    status: undefined,
    activity: undefined,
    availableThinkingLevels: [],
    sessionStatuses: {},
    sessionActivities: {},
    workspaceActivities: {},
    machineActivities: {},
    notificationCatalogsByMachine: {},
    selectedNotificationInbox: undefined,
    workspacesByProjectId: {},
    workspaceDeletionRuns: {},
    commandDialog: undefined,
    modelDialog: undefined,
    thinkingDialog: undefined,
    themeDialog: undefined,
    authDialog: undefined,
    actionPaletteOpen: false,
    projectDialogOpen: false,
    machineDialogOpen: false,
    workspaceTool: "core:workspace.files",
    mainView: "chat",
    fileTree: [],
    expandedDirs: {},
    selectedFilePath: undefined,
    selectedFileContent: undefined,
    fileTreeStale: false,
    workspaceUploadBatches: {},
    gitStatus: undefined,
    selectedDiffPath: undefined,
    selectedDiff: undefined,
    selectedStagedDiff: undefined,
    gitStale: false,
    activeTerminalCount: 0,
    selectedTerminalId: undefined,
    piWebStatus: undefined,
    error: "",
  };
}
