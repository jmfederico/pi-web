import type { TemplateResult } from "lit";
import type { AppAction } from "../actions";
import type { DeleteWorkspaceFileResponse, FileContentResponse, FileTreeEntry, FileTreeResponse, JsonValue, Machine, MoveWorkspaceFileOptions, MoveWorkspaceFileResponse, RunTerminalCommandInput, TerminalCommandRun, TerminalCommandRunFilter, TerminalCommandRunHandle, WriteWorkspaceFileOptions, WriteWorkspaceFileResponse, Workspace } from "../api";
import type { AppState } from "../appState";
import type { SettingsSection } from "../settingsRoute";
import type { ReviewAnchor, ReviewComment, ReviewLineRef } from "../review/reviewTypes";
import type { LocalContributionId, PluginId, QualifiedContributionId } from "./ids";

export type { LocalContributionId, PluginId, QualifiedContributionId } from "./ids";
export type HtmlTemplateTag = (strings: TemplateStringsArray, ...values: unknown[]) => TemplateResult;
export type SvgTemplateTag = (strings: TemplateStringsArray, ...values: unknown[]) => TemplateResult;

export interface PiWebPluginRegistration {
  id: PluginId;
  plugin: PiWebPlugin;
  machineId?: string;
  sourcePluginId?: PluginId;
  backendRevision?: string;
  machineSpecific?: boolean;
}

export interface WorkspacePluginBinding {
  registrationPluginId: PluginId;
  sourcePluginId: PluginId;
  backendRevision?: string;
}

export interface PiWebPlugin {
  apiVersion: 2;
  name: string;
  activate: (context: PluginActivationContext) => PluginActivationResult;
}

export interface PluginActivationContext {
  readonly apiVersion: 2;
  /** Stable package/source identity, including on federated machines. */
  readonly pluginId: PluginId;
  /** Host-unique identity for qualified contribution references in this runtime. */
  readonly runtimePluginId: PluginId;
  readonly html: HtmlTemplateTag;
  readonly svg: SvgTemplateTag;
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
  kind: Machine["kind"];
}

export interface WorkspaceFiles {
  readFile(path: string): Promise<FileContentResponse>;
  listFiles(path: string): Promise<FileTreeResponse>;
  writeFile(path: string, content: string | Uint8Array, options?: WriteWorkspaceFileOptions): Promise<WriteWorkspaceFileResponse>;
  deleteFile(path: string): Promise<DeleteWorkspaceFileResponse>;
  moveFile(fromPath: string, toPath: string, options?: MoveWorkspaceFileOptions): Promise<MoveWorkspaceFileResponse>;
}

export interface WorkspaceBackend {
  request(operation: string, input: JsonValue): Promise<JsonValue>;
}

export interface WorkspaceHost {
  requestRender(): void;
}

export interface WorkspaceContext {
  machine: PluginMachine;
  workspace: Workspace;
  state: AppState;
  files: WorkspaceFiles;
  backend?: WorkspaceBackend;
  host: WorkspaceHost;
}

export type WorkspaceTerminalCommandInput = Omit<RunTerminalCommandInput, "workspace">;

export interface WorkspacePanelTerminal {
  open(options?: { terminalId?: string | undefined }): void;
  runCommand(input: WorkspaceTerminalCommandInput): Promise<TerminalCommandRunHandle>;
}

export interface PiWebUnstableRuntimeContext {
  terminalCommandRuns: TerminalCommandRunsInternalRuntime;
  openSettings?: (section?: SettingsSection) => void;
}

export interface TerminalCommandRunsInternalRuntime {
  runCommand(input: RunTerminalCommandInput): Promise<TerminalCommandRunHandle>;
  listCommandRuns(filter?: TerminalCommandRunFilter): Promise<TerminalCommandRun[]>;
  getCommandRun(runId: string): Promise<TerminalCommandRun | undefined>;
  open(options?: { terminalId?: string | undefined }): void;
}

export interface PluginPromptEditor {
  insertText(text: string): void;
  getText(): string;
  getSelection(): { start: number; end: number; text: string } | null;
}

export interface PluginRuntimeContext {
  state: AppState;
  prompt: PluginPromptEditor;
  piWebUnstable?: PiWebUnstableRuntimeContext;
  openActionPalette: () => void;
  focusPrompt: () => void;
  addProject: () => void | Promise<void>;
  addMachine: () => void | Promise<void>;
  refreshSelectedMachine: () => void | Promise<void>;
  removeSelectedMachine: () => void | Promise<void>;
  openSelectedMachine: () => void | Promise<void>;
  configureAuth: () => void | Promise<void>;
  logoutAuth: () => void | Promise<void>;
  openThemePicker: () => void;
  openModelPicker: () => void | Promise<void>;
  openThinkingLevelPicker: () => void | Promise<void>;
  selectMainView: (view: AppState["mainView"]) => void;
  selectWorkspaceTool: (tool: QualifiedContributionId) => void;
  openTerminal: (options?: { terminalId?: string | undefined }) => void;
  refreshFiles: () => void | Promise<void>;
  /** Invalidate plugin workspace-panel data for the selected workspace. */
  refreshWorkspacePanels: (panelId?: QualifiedContributionId) => void | Promise<void>;
  refreshAppData: () => void | Promise<void>;
  checkForPiWebUpdates?: () => void | Promise<void>;
  reloadPage: () => void;
  deleteWorkspace: (workspace?: Workspace) => void | Promise<void>;
  startSession: () => void | Promise<void>;
  archiveSession: () => void | Promise<void>;
  reloadSession: () => void | Promise<void>;
  deleteCachedNewSession: () => void | Promise<void>;
  stopActiveWork: () => void | Promise<void>;
}

export interface PluginAction {
  id: LocalContributionId;
  title: string;
  description?: string;
  shortcut?: string;
  /** Former qualified action ids whose saved shortcut preference should still apply. */
  shortcutAliases?: QualifiedContributionId[];
  group?: string;
  enabled?: (context: PluginRuntimeContext) => boolean;
  /** Explain why a disabled action is visible but unavailable. */
  disabledReason?: (context: PluginRuntimeContext) => string | undefined;
  run: (context: PluginRuntimeContext) => void | Promise<void>;
}

export interface QualifiedPluginAction extends AppAction {
  pluginId: PluginId;
  localId: LocalContributionId;
  machineId?: string;
}

export interface WorkspacePanelContext extends WorkspaceContext {
  prompt: PluginPromptEditor;
  terminal: WorkspacePanelTerminal;
  /**
   * @deprecated Runtime-only compatibility alias for pre-v2 plugins. Use `terminal.open()` instead.
   * This is intentionally not part of the public `@jmfederico/pi-web/plugin-api` declarations.
   */
  openTerminal?: (options?: { terminalId?: string | undefined }) => void;
  piWebUnstable?: Pick<PiWebUnstableRuntimeContext, "terminalCommandRuns">;
  fileTree: FileTreeEntry[];
  expandedDirs: Record<string, FileTreeEntry[]>;
  review: WorkspaceReview;
  selectedFilePath: string | undefined;
  selectedFileContent: FileContentResponse | undefined;
  selectedFileLoadError: string | undefined;
  fileTreeStale: boolean;
  activeTerminalCount: number;
  selectedTerminalId: string | undefined;
  terminalAutoStart: boolean;
  workspaceUploadDefaultFolder: string;
  onRefreshFiles: () => void;
  onExpandDir: (path: string) => void;
  onSelectFile: (path: string) => void;
  onStartWorkspaceUpload: (files: readonly File[], options: { destinationFolder: string; createDirs?: boolean; overwrite?: boolean; selectUploadedFile?: boolean }) => { batchId: string; done: Promise<void> } | undefined;
  onCancelWorkspaceUpload: (batchId: string) => void;
  onClearWorkspaceUpload: (batchId: string) => void;
  onSelectTerminal: (terminalId: string | undefined, options?: { replace?: boolean | undefined }) => void;
}

/** A line reference on a diff/file surface, used by the review selection and query APIs. */
export type WorkspaceReviewLineRef = ReviewLineRef;

/** An in-progress, not-yet-saved review comment. */
export interface WorkspaceReviewDraft {
  anchor: ReviewAnchor;
  body: string;
}

/**
 * Gesture-agnostic review service: data/badges, a selection/draft state
 * machine driven by line refs (not DOM handlers), and existing-comment
 * mutation. The SAME service instance is used by the core Files (CodeMirror)
 * surface and by plugins; only the gesture-to-ref mapping and where
 * `<pi-web-review-thread>` mounts differ per surface.
 */
export interface WorkspaceReview {
  // --- data / badges ---
  total(): number;
  countForFile(filePath: string): number;
  commentsForLine(filePath: string, ref: WorkspaceReviewLineRef): readonly ReviewComment[];
  draftForLine(filePath: string, ref: WorkspaceReviewLineRef): WorkspaceReviewDraft | null;
  /** For styling: is this line inside the active selection / does it have comments. */
  lineState(filePath: string, ref: WorkspaceReviewLineRef): { selected: boolean; commented: boolean };

  // --- selection + draft state machine (gesture-agnostic) ---
  canAuthor(): boolean;
  beginSelection(filePath: string, ref: WorkspaceReviewLineRef): void;
  extendSelection(ref: WorkspaceReviewLineRef): void; // clamped to the anchor's side
  commitSelection(sourceHash: string): void; // opens the draft at the current selection
  cancelSelection(): void;
  setDraftBody(body: string): void;
  submitDraft(anchor?: ReviewAnchor): void;
  cancelDraft(): void;

  // --- existing comments ---
  updateComment(id: string, body: string, anchor: ReviewAnchor): void;
  removeComment(id: string): void;
}

export type WorkspacePanelIcon = TemplateResult;

export interface WorkspacePanelContribution {
  id: LocalContributionId;
  title: string;
  icon?: WorkspacePanelIcon;
  order?: number;
  /** Former URL tool/view values that should resolve to this panel. */
  routeAliases?: string[];
  visible?: (context: WorkspacePanelContext) => boolean;
  badge?: (context: WorkspacePanelContext) => string | number | TemplateResult | undefined;
  onInvalidate?: (context: WorkspacePanelContext) => void | Promise<void>;
  render: (context: WorkspacePanelContext) => TemplateResult;
}

export interface QualifiedWorkspacePanelContribution extends WorkspacePanelContribution {
  id: QualifiedContributionId;
  pluginId: PluginId;
  localId: LocalContributionId;
  machineId?: string;
  sourcePluginId?: PluginId;
}

export interface WorkspaceLabelContext extends WorkspaceContext {
  machine: PluginMachine;
  workspace: Workspace;
  state: AppState;
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

export type ThemeToken =
  | "--pi-bg"
  | "--pi-surface"
  | "--pi-surface-hover"
  | "--pi-terminal-bg"
  | "--pi-terminal-text"
  | "--pi-border"
  | "--pi-border-muted"
  | "--pi-text"
  | "--pi-text-secondary"
  | "--pi-text-bright"
  | "--pi-muted"
  | "--pi-dim"
  | "--pi-accent"
  | "--pi-accent-border"
  | "--pi-selection-bg"
  | "--pi-success"
  | "--pi-success-border"
  | "--pi-success-bg"
  | "--pi-success-surface"
  | "--pi-success-ring"
  | "--pi-warning"
  | "--pi-warning-border"
  | "--pi-warning-surface"
  | "--pi-danger"
  | "--pi-purple"
  | "--pi-purple-border"
  | "--pi-purple-surface"
  | "--pi-overlay"
  | "--pi-shadow-soft"
  | "--pi-shadow"
  | "--pi-shadow-strong"
  | "--pi-bg-overlay-soft"
  | "--pi-bg-overlay"
  | "--pi-success-bg-overlay"
  | "--pi-terminal-selection";

export type ThemeTokens = Record<ThemeToken, string>;

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

export interface QualifiedThemeContribution extends ThemeContribution {
  id: QualifiedContributionId;
  pluginId: PluginId;
  localId: LocalContributionId;
}

export interface QualifiedThemePairContribution extends Omit<ThemePairContribution, "id" | "light" | "dark"> {
  id: QualifiedContributionId;
  pluginId: PluginId;
  localId: LocalContributionId;
  light: QualifiedContributionId;
  dark: QualifiedContributionId;
}

export interface QualifiedWorkspaceLabelContribution extends WorkspaceLabelContribution {
  id: QualifiedContributionId;
  pluginId: PluginId;
  localId: LocalContributionId;
  machineId?: string;
}
