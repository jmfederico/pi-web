import type { TemplateResult } from "lit";
import type { DeleteWorkspaceFileResponse, FileContentResponse, FileTreeResponse, JsonValue, MachineKind, MoveWorkspaceFileOptions, MoveWorkspaceFileResponse, PiWebStatusResponse, TerminalCommandRunHandle, WorkspaceProviderMetadata, WorkspaceRemovalPresentation, WriteWorkspaceFileOptions, WriteWorkspaceFileResponse } from "./shared/pluginApiTypes.js";

export type {
  FileContentMediaType,
  FileContentResponse,
  FileTreeEntry,
  FileTreeResponse,
  JsonObject,
  JsonPrimitive,
  JsonValue,
  MachineKind,
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
  DeleteWorkspaceFileResponse,
  MoveWorkspaceFileOptions,
  MoveWorkspaceFileResponse,
} from "./shared/pluginApiTypes.js";

export type PluginId = string;
export type LocalContributionId = string;
export type QualifiedContributionId = string;
export type HtmlTemplateTag = (strings: TemplateStringsArray, ...values: unknown[]) => TemplateResult;
export type SvgTemplateTag = (strings: TemplateStringsArray, ...values: unknown[]) => TemplateResult;

export interface PiWebPlugin {
  apiVersion: 2;
  name: string;
  activate: (context: PluginActivationContext) => PluginActivationResult;
}

/** Host-owned frozen values supplied once during browser plugin activation. */
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
  kind: MachineKind;
}

export interface PluginRuntimeState {
  /** Identity of the currently selected machine. Undefined only on older hosts or before machines load. */
  selectedMachine?: PluginMachine;
  selectedWorkspace?: Workspace;
  selectedSession?: unknown;
  workspaceTool?: string;
  mainView?: string;
  piWebStatus?: PiWebStatusResponse;
}

export interface PluginPromptEditor {
  /** Insert text at the current cursor position. Replaces any selection.
   *  If the editor is not focused, focuses it first.
   *  No-op if the editor is not mounted. */
  insertText(text: string): void;
  /** Get the current prompt text content. Returns "" if the editor is not mounted. */
  getText(): string;
  /** Get the current selection range, or null if no selection or editor not mounted. */
  getSelection(): { start: number; end: number; text: string } | null;
}

export interface PluginRuntimeContext {
  state: PluginRuntimeState;
  prompt: PluginPromptEditor;
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
  /** Invalidate plugin workspace-panel data for the selected workspace, optionally targeting one qualified panel id. */
  refreshWorkspacePanels: (panelId?: QualifiedContributionId) => void | Promise<void>;
  refreshAppData: () => void | Promise<void>;
  /** Force a fresh PI WEB release check on the selected machine. Optional for compatibility with older hosts. */
  checkForPiWebUpdates?: () => void | Promise<void>;
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
  /** Former qualified action ids whose saved shortcut preference should still apply. */
  shortcutAliases?: QualifiedContributionId[];
  group?: string;
  enabled?: (context: PluginRuntimeContext) => boolean;
  /** Explain why a disabled action is visible but unavailable. */
  disabledReason?: (context: PluginRuntimeContext) => string | undefined;
  run: (context: PluginRuntimeContext) => void | Promise<void>;
}

/** Host-resolved workspace snapshot exposed to browser plugin callbacks. */
export interface Workspace {
  readonly id: string;
  readonly projectId: string;
  readonly path: string;
  readonly label: string;
  readonly isMain: boolean;
  readonly provider?: WorkspaceProviderMetadata;
  readonly removal?: WorkspaceRemovalPresentation;
}

export interface WorkspaceFiles {
  /** Read a file from the workspace. Works for local and federated machines. */
  readFile(path: string): Promise<FileContentResponse>;
  /** List the entries of a workspace directory. Pass "" for the workspace root.
   *  Works for local and federated machines. Rejects when the directory does not
   *  exist or cannot be read, matching readFile error behavior. */
  listFiles(path: string): Promise<FileTreeResponse>;
  /** Write content to a workspace file. Creates intermediate directories by default.
   *  Works for local and federated machines. Auto-refreshes the file explorer after success. */
  writeFile(path: string, content: string | Uint8Array, options?: WriteWorkspaceFileOptions): Promise<WriteWorkspaceFileResponse>;
  /** Delete a file from the workspace. Idempotent — returns { existed: false } if file doesn't exist.
   *  Deletes the entry itself (for symlinks, removes the symlink not the target). */
  deleteFile(path: string): Promise<DeleteWorkspaceFileResponse>;
  /** Move or rename a file within the workspace. Unix mv semantics.
   *  Default overwrite: false (safer than writeFile). Auto-refreshes the file explorer after success. */
  moveFile(fromPath: string, toPath: string, options?: MoveWorkspaceFileOptions): Promise<MoveWorkspaceFileResponse>;
}

export type WorkspacePanelFiles = WorkspaceFiles;

/** JSON-only request path to the server module that currently owns this workspace. */
export interface WorkspaceBackend {
  request(operation: string, input: JsonValue): Promise<JsonValue>;
}

export interface WorkspaceHost {
  requestRender(): void;
}

export type WorkspacePanelHost = WorkspaceHost;

export interface WorkspaceContext {
  machine: PluginMachine;
  workspace: Workspace;
  state?: PluginRuntimeState;
  files: WorkspaceFiles;
  /** Present only when this browser entry has a paired active server backend. */
  backend?: WorkspaceBackend;
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

/**
 * Side a review anchor/line ref refers to. The Files raw view is always
 * "new" (current file lines). Git context/added lines are "new"; git
 * deleted lines are "old". A single comment is single-side.
 *
 * Mirrored by hand from `src/client/src/review/reviewTypes.ts` rather than
 * sourced from `src/shared/pluginApiTypes.ts`. That shared file is reserved
 * for DTOs that already cross the server/client boundary (re-exported
 * through `src/shared/apiTypes.ts`); the review types are browser-only
 * local state. Hand duplication here follows the same pattern already used
 * for `WorkspacePanelContext` itself (which also can't be a raw shared
 * import, since the internal version depends on `AppState`).
 */
export type ReviewSide = "new" | "old";

export interface ReviewLineRange {
  side: ReviewSide;
  /** 1-based inclusive line number on the given side. */
  start: number;
  end: number;
}

export interface ReviewAnchor {
  /** Workspace-relative path. */
  filePath: string;
  /** Single side, contiguous range. */
  range: ReviewLineRange;
}

export interface ReviewComment {
  /** Stable local id, e.g. "review-<seq>". */
  id: string;
  anchor: ReviewAnchor;
  /** User text (markdown allowed). */
  body: string;
  createdAt: number;
  updatedAt: number;
  /** Fingerprint of the underlying content at creation, for staleness invalidation. */
  sourceHash: string;
}

/** A line reference on a diff/file surface, used by the review selection and query APIs. */
export interface WorkspaceReviewLineRef {
  side: ReviewSide;
  line: number;
}

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

export interface WorkspacePanelContext extends WorkspaceContext {
  prompt: PluginPromptEditor;
  terminal: WorkspacePanelTerminal;
  review: WorkspaceReview;
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
  /** Called when the host invalidates workspace-panel data. */
  onInvalidate?: (context: WorkspacePanelContext) => void | Promise<void>;
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
