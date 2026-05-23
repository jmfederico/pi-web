import type { TemplateResult } from "lit";

export type PluginId = string;
export type LocalContributionId = string;
export type QualifiedContributionId = string;
export type HtmlTemplateTag = (strings: TemplateStringsArray, ...values: unknown[]) => TemplateResult;

export interface PiWebPlugin {
  apiVersion: 1;
  name: string;
  activate: (context: PluginActivationContext) => PluginActivationResult;
}

export interface PluginActivationContext {
  apiVersion: 1;
  pluginId: PluginId;
  html: HtmlTemplateTag;
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

export interface PluginRuntimeState {
  selectedWorkspace?: Workspace;
  selectedSession?: unknown;
  workspaceTool?: string;
  mainView?: string;
  piWebStatus?: unknown;
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

export interface WorkspacePanelContext {
  workspace: Workspace;
  state?: PluginRuntimeState;
  openTerminal: (options?: { terminalId?: string | undefined }) => void;
}

export interface WorkspacePanelContribution {
  id: LocalContributionId;
  title: string;
  order?: number;
  visible?: (context: WorkspacePanelContext) => boolean;
  badge?: (context: WorkspacePanelContext) => string | number | TemplateResult | undefined;
  render: (context: WorkspacePanelContext) => TemplateResult;
}

export interface WorkspaceLabelContext {
  workspace: Workspace;
  state?: PluginRuntimeState;
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
