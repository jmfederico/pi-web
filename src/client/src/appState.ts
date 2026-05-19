import type { AuthProviderOption, CommandOption, CommandResult, FileContentResponse, FileTreeEntry, GitDiffResponse, GitStatusResponse, OAuthFlowState, PiWebStatusResponse, Project, SessionActivity, SessionInfo, SessionStatus, Workspace } from "./api";
import type { ChatLine } from "./components/shared";
import type { QualifiedContributionId } from "./plugins/types";

export interface AppState {
  projects: Project[];
  workspaces: Workspace[];
  sessions: SessionInfo[];
  messages: ChatLine[];
  messagePageStart: number;
  messagePageTotal: number;
  isLoadingEarlierMessages: boolean;
  isReceivingPartialStream: boolean;
  selectedProject: Project | undefined;
  selectedWorkspace: Workspace | undefined;
  selectedSession: SessionInfo | undefined;
  status: SessionStatus | undefined;
  activity: SessionActivity | undefined;
  sessionStatuses: Record<string, SessionStatus>;
  sessionActivities: Record<string, SessionActivity>;
  commandDialog: Extract<CommandResult, { type: "select" }> | undefined;
  modelDialog: { title: string; options: CommandOption[]; selectedValue?: string } | undefined;
  thinkingDialog: { title: string; options: CommandOption[]; selectedValue?: string } | undefined;
  themeDialog: { title: string; options: CommandOption[]; selectedValue?: string } | undefined;
  authDialog: AuthDialogState | undefined;
  actionPaletteOpen: boolean;
  projectDialogOpen: boolean;
  workspaceTool: QualifiedContributionId;
  mainView: "navigation" | "chat" | QualifiedContributionId;
  fileTree: FileTreeEntry[];
  expandedDirs: Record<string, FileTreeEntry[]>;
  selectedFilePath: string | undefined;
  selectedFileContent: FileContentResponse | undefined;
  fileTreeStale: boolean;
  gitStatus: GitStatusResponse | undefined;
  selectedDiffPath: string | undefined;
  selectedDiff: GitDiffResponse | undefined;
  selectedStagedDiff: GitDiffResponse | undefined;
  gitStale: boolean;
  activeTerminalCount: number;
  piWebStatus: PiWebStatusResponse | undefined;
  error: string;
}

export type AuthDialogState =
  | { step: "method" }
  | { step: "providers"; mode: "login"; authType?: "oauth" | "api_key"; providers: AuthProviderOption[] }
  | { step: "apiKey"; provider: AuthProviderOption; value: string; saving?: boolean; error?: string }
  | { step: "oauth"; flow: OAuthFlowState; responding?: boolean; inputValue?: string; error?: string }
  | { step: "logout"; providers: AuthProviderOption[] };

export function initialAppState(): AppState {
  return {
    projects: [],
    workspaces: [],
    sessions: [],
    messages: [],
    messagePageStart: 0,
    messagePageTotal: 0,
    isLoadingEarlierMessages: false,
    isReceivingPartialStream: false,
    selectedProject: undefined,
    selectedWorkspace: undefined,
    selectedSession: undefined,
    status: undefined,
    activity: undefined,
    sessionStatuses: {},
    sessionActivities: {},
    commandDialog: undefined,
    modelDialog: undefined,
    thinkingDialog: undefined,
    themeDialog: undefined,
    authDialog: undefined,
    actionPaletteOpen: false,
    projectDialogOpen: false,
    workspaceTool: "core:workspace.files",
    mainView: "chat",
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
    activeTerminalCount: 0,
    piWebStatus: undefined,
    error: "",
  };
}
