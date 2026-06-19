import type { TemplateResult } from "lit";
import type { FileContentResponse, MachineKind, PiWebStatusResponse, SessionInfo, TerminalCommandRunHandle } from "./shared/apiTypes.js";

export type {
  FileContentMediaType,
  FileContentResponse,
  FileTreeEntry,
  FileTreeResponse,
  MachineKind,
  PiWebComponentStatus,
  PiWebInstallationInfo,
  PiWebInstallationKind,
  PiWebReleaseStatus,
  PiWebServiceComponent,
  PiWebStatusMessage,
  PiWebStatusResponse,
  PiWebStatusSeverity,
  PiWebVersionResponse,
  SessionInfo,
  TerminalCommandRun,
  TerminalCommandRunFilter,
  TerminalCommandRunHandle,
  TerminalCommandRunStatus,
} from "./shared/apiTypes.js";

export type PluginId = string;
export type LocalContributionId = string;
export type QualifiedContributionId = string;
export type HtmlTemplateTag = (strings: TemplateStringsArray, ...values: unknown[]) => TemplateResult;
export type SvgTemplateTag = (strings: TemplateStringsArray, ...values: unknown[]) => TemplateResult;

export interface PiWebPlugin {
  apiVersion: 1;
  name: string;
  activate: (context: PluginActivationContext) => PluginActivationResult;
}

export interface PluginActivationContext {
  apiVersion: 1;
  pluginId: PluginId;
  html: HtmlTemplateTag;
  svg: SvgTemplateTag;
}

export interface PluginActivationResult {
  contributions: PluginContributions;
}

export interface PluginContributions {
  actions?: PluginAction[];
  workspacePanels?: WorkspacePanelContribution[];
  workspaceLabels?: WorkspaceLabelContribution[];
  themes?: ThemeContribution[];
  themePairs?: ThemePairContribution[];
}

export interface PluginMachine {
  id: string;
  name: string;
  kind: MachineKind;
}

export interface PluginRuntimeState {
  selectedWorkspace?: Workspace;
  selectedSession?: unknown;
  workspaceTool?: string;
  mainView?: string;
  piWebStatus?: PiWebStatusResponse;
}

export interface PluginRuntimeContext {
  state: PluginRuntimeState;
  openActionPalette: () => void;
  focusPrompt: () => void;
  addProject: () => void | Promise<void>;
  configureAuth: () => void | Promise<void>;
  logoutAuth: () => void | Promise<void>;
  openThemePicker: () => void;
  selectMainView: (view: string) => void;
  selectWorkspaceTool: (tool: QualifiedContributionId) => void;
  openTerminal: (options?: { terminalId?: string | undefined }) => void;
  refreshFiles: () => void | Promise<void>;
  refreshGit: () => void | Promise<void>;
  refreshAppData: () => void | Promise<void>;
  reloadPage: () => void;
  startSession: () => void | Promise<void>;
  archiveSession: () => void | Promise<void>;
  stopActiveWork: () => void | Promise<void>;
}

export interface PluginAction {
  id: LocalContributionId;
  title: string;
  description?: string;
  shortcut?: string;
  group?: string;
  enabled?: (context: PluginRuntimeContext) => boolean;
  run: (context: PluginRuntimeContext) => void | Promise<void>;
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

export interface WorkspaceFiles {
  readFile(path: string): Promise<FileContentResponse>;
  writeFile(path: string, content: string): Promise<void>;
}

export type WorkspacePanelFiles = WorkspaceFiles;

export interface WorkspaceHost {
  requestRender(): void;
}

export type WorkspacePanelHost = WorkspaceHost;

export interface WorkspaceContext {
  machine: PluginMachine;
  workspace: Workspace;
  state?: PluginRuntimeState;
  files: WorkspaceFiles;
  host: WorkspaceHost;
}

export interface WorkspaceTerminalCommandInput {
  title: string;
  command: string;
  metadata?: Record<string, string>;
  open?: boolean;
}

export interface WorkspacePanelTerminal {
  open(options?: { terminalId?: string | undefined }): void;
  runCommand(input: WorkspaceTerminalCommandInput): Promise<TerminalCommandRunHandle>;
}

export interface WorkspacePanelSessionInfo extends SessionInfo {
  workspaceId?: string;
}

export interface WorkspacePanelSessions {
  startWithPrompt(prompt: string, options?: { newWorkspace?: boolean | undefined; ideaId?: string | undefined }): Promise<WorkspacePanelSessionInfo>;
}

export interface WorkspacePanelContext extends WorkspaceContext {
  terminal: WorkspacePanelTerminal;
  sessions: WorkspacePanelSessions;
}

export type WorkspacePanelIcon = TemplateResult;

export interface WorkspacePanelContribution {
  id: LocalContributionId;
  title: string;
  icon?: WorkspacePanelIcon;
  order?: number;
  visible?: (context: WorkspacePanelContext) => boolean;
  badge?: (context: WorkspacePanelContext) => string | number | TemplateResult | undefined;
  render: (context: WorkspacePanelContext) => TemplateResult;
}

export interface WorkspaceLabelContext extends WorkspaceContext {
  machine: PluginMachine;
  workspace: Workspace;
  state?: PluginRuntimeState;
  files: WorkspaceFiles;
  host: WorkspaceHost;
}

export type WorkspaceLabelItem = WorkspaceLabelTextItem | WorkspaceLabelLinkItem | WorkspaceLabelRenderItem;

export interface WorkspaceLabelTextItem {
  type: "text";
  text: string;
  title?: string;
}

export interface WorkspaceLabelLinkItem {
  type: "link";
  text: string;
  href: string;
  title?: string;
  target?: "_blank" | "_self";
}

export interface WorkspaceLabelRenderItem {
  type: "render";
  render: () => TemplateResult;
}

export interface WorkspaceLabelContribution {
  id: LocalContributionId;
  order?: number;
  visible?: (context: WorkspaceLabelContext) => boolean;
  items: (context: WorkspaceLabelContext) => WorkspaceLabelItem[];
}

export type ThemeColorScheme = "dark" | "light";
export type ThemeTokens = Record<string, string>;

export interface ThemeContribution {
  id: LocalContributionId;
  name: string;
  description?: string;
  order?: number;
  colorScheme: ThemeColorScheme;
  tokens: ThemeTokens;
}

export interface ThemePairContribution {
  id: LocalContributionId;
  name: string;
  description?: string;
  order?: number;
  light: LocalContributionId;
  dark: LocalContributionId;
}
