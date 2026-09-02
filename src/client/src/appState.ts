import type { AuthProviderOption, CommandOption, CommandResult, ExtensionDialogAnswer, ExtensionDialogCloseReason, FileContentResponse, FileTreeEntry, Machine, MachineHealth, MachineRuntime, OAuthFlowState, PendingAskUser, PendingExtensionDialog, PiWebStatusResponse, Project, QueuedSessionMessage, SessionActivity, SessionInfo, SessionModelCatalogEntry, SessionStatus, SessionTreeSnapshot, TerminalCommandRun, Workspace } from "./api";
import type { ChatLine } from "./components/shared";
import type { MachineStatusSnapshot } from "../../shared/machineStatus";
import type { QualifiedContributionId } from "./plugins/ids";
import type { ReviewComment, ReviewDraft, ReviewSide } from "./review/reviewTypes";
import type { SelectedSessionNotificationInbox } from "./sessionNotifications";
import type { WorkspaceUploadBatchState } from "./workspaceUploadState";

export interface AppState {
  machines: Machine[];
  selectedMachine: Machine | undefined;
  isLoadingMachines: boolean;
  machineStatuses: Record<string, MachineHealth>;
  machineRuntimes: Record<string, MachineRuntime>;
  /** Latest per-machine status tree published by each machine's daemon. */
  machineStatusSnapshots: Record<string, MachineStatusSnapshot>;
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
  /**
   * The selected session's open `ask_user` question set, derived from the
   * daemon-owned {@link SessionStatus.pendingAsk} plus live ask events.
   */
  pendingAsk: PendingAskUser | undefined;
  /**
   * The selected session's open extension dialogs, derived from the
   * daemon-owned {@link SessionStatus.pendingDialogs} plus live dialog events.
   * Oldest first; unlike an ask, opening never supersedes, so several dialogs
   * may wait at once.
   */
  pendingDialogs: PendingExtensionDialog[];
  /**
   * Dialogs that closed while their session was selected, kept with the close
   * reason and any answer so the settled card can show what became of the
   * dialog. The card stays until the user dismisses it. The wire outcome is
   * deliberately small, so only a browser that saw the dialog open can show
   * the closed card; deselection and reloads drop these.
   */
  closedDialogs: ClosedExtensionDialog[];
  /** Thinking levels available for the selected session's current model. */
  availableThinkingLevels: readonly string[];
  sessionStatuses: Record<string, SessionStatus>;
  sessionActivities: Record<string, SessionActivity>;
  /** Authoritative projection plus browser-local optimistic overlays for the selected inbox. */
  selectedNotificationInbox: SelectedSessionNotificationInbox | undefined;
  workspacesByProjectId: Record<string, Workspace[]>;
  workspaceDeletionRuns: Record<string, TerminalCommandRun>;
  commandDialog: Extract<CommandResult, { type: "select" }> | undefined;
  treeDialog: SessionTreeSnapshot | undefined;
  modelDialog: { instanceId: number; origin: ModelDialogOrigin; title: string; options: CommandOption[]; catalog: SessionModelCatalogEntry[]; selectedValue?: string } | undefined;
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
  selectedFileLoadError: string | undefined;
  fileTreeStale: boolean;
  /** Manual workspace file upload batches, keyed by client-owned batch id. */
  workspaceUploadBatches: Record<string, WorkspaceUploadBatchState>;
  activeTerminalCount: number;
  selectedTerminalId: string | undefined;
  piWebStatus: PiWebStatusResponse | undefined;
  error: string;
  /** The selected session's pending code review comments (Files/Git tabs). */
  reviewComments: readonly ReviewComment[];
  /** The single active, not-yet-saved review comment editor (app-wide). */
  reviewDraft: ReviewDraft | undefined;
  /**
   * The transient in-progress line-drag selection (before a draft is opened).
   * `anchorLine` is where the drag started; `currentLine` follows the pointer.
   * Both share `side` (single-side selection): `extendSelection` clamps
   * updates to a different side.
   */
  reviewSelection: { filePath: string; side: ReviewSide; anchorLine: number; currentLine: number } | undefined;
  /** True while a send is in flight; disables authoring/removal until it settles. */
  reviewSendLocked: boolean;
}

/** A closed extension dialog paired with the record the browser rendered while it was open. */
export interface ModelDialogOrigin {
  machineId: string;
  sessionId: string;
  cwd: string;
}

export interface ClosedExtensionDialog {
  dialog: PendingExtensionDialog;
  reason: ExtensionDialogCloseReason;
  /** Present only when `reason` is `"answered"`. */
  answer?: ExtensionDialogAnswer;
}

/** `machineId` stays bound to the machine selected when the auth operation began. */
export type AuthDialogState =
  | { step: "method"; machineId: string }
  | { step: "providers"; mode: "login"; machineId: string; authType?: "oauth" | "api_key"; providers: AuthProviderOption[] }
  | { step: "oauth"; flow: OAuthFlowState; machineId: string; responding?: boolean; inputValue?: string; error?: string }
  | { step: "logout"; machineId: string; providers: AuthProviderOption[] };

export type WorkspaceScopedStateReset = Pick<AppState,
  | "sessions"
  | "clientQueuedSessionMessages"
  | "startingSessionCount"
  | "selectedNotificationInbox"
  | "treeDialog"
  | "fileTree"
  | "expandedDirs"
  | "selectedFilePath"
  | "selectedFileContent"
  | "selectedFileLoadError"
  | "fileTreeStale"
  | "selectedTerminalId"
  | "error"
>;

export function resetWorkspaceScopedState(): WorkspaceScopedStateReset {
  return {
    sessions: [],
    clientQueuedSessionMessages: {},
    startingSessionCount: 0,
    selectedNotificationInbox: undefined,
    treeDialog: undefined,
    fileTree: [],
    expandedDirs: {},
    selectedFilePath: undefined,
    selectedFileContent: undefined,
    selectedFileLoadError: undefined,
    fileTreeStale: false,
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
    machineStatusSnapshots: {},
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
    pendingAsk: undefined,
    pendingDialogs: [],
    closedDialogs: [],
    availableThinkingLevels: [],
    sessionStatuses: {},
    sessionActivities: {},
    selectedNotificationInbox: undefined,
    workspacesByProjectId: {},
    workspaceDeletionRuns: {},
    commandDialog: undefined,
    treeDialog: undefined,
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
    selectedFileLoadError: undefined,
    fileTreeStale: false,
    workspaceUploadBatches: {},
    activeTerminalCount: 0,
    selectedTerminalId: undefined,
    piWebStatus: undefined,
    error: "",
    reviewComments: [],
    reviewDraft: undefined,
    reviewSelection: undefined,
    reviewSendLocked: false,
  };
}
