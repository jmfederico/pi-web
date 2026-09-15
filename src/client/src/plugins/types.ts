import type { TemplateResult } from "lit";
import type { AppAction } from "../actions";
import type { DeleteWorkspaceFileResponse, FileContentResponse, FileTreeResponse, JsonValue, Machine, MoveWorkspaceFileOptions, MoveWorkspaceFileResponse, TerminalCommandRunHandle, WriteWorkspaceFileOptions, WriteWorkspaceFileResponse, Workspace } from "../api";
import type { PluginCapability, PluginCapabilityProvision } from "../../../shared/pluginApiTypes";
import type { AppState } from "../appState";
import type { SettingsSection } from "../settingsRoute";
import type { LocalContributionId, PluginId, QualifiedContributionId } from "./ids";

export type { PluginCapability, PluginCapabilityProvision } from "../../../shared/pluginApiTypes";
export type { LocalContributionId, PluginId, QualifiedContributionId } from "./ids";
export type HtmlTemplateTag = (strings: TemplateStringsArray, ...values: unknown[]) => TemplateResult;
export type SvgTemplateTag = (strings: TemplateStringsArray, ...values: unknown[]) => TemplateResult;

export interface PiWebPluginRegistrationDeclaration {
  id: PluginId;
  machineId?: string;
  sourcePluginId?: PluginId;
  /** Host-attributed package discovery metadata. */
  manifestSource?: string;
  manifestScope?: string;
  machineSpecific?: boolean;
}

export interface PiWebPluginRegistration extends PiWebPluginRegistrationDeclaration {
  plugin: PiWebPlugin;
  backendRevision?: string;
  pairedRequestVersion?: 1;
  pairedChannelVersion?: 1;
}

export interface WorkspacePluginBinding {
  registrationPluginId: PluginId;
  sourcePluginId: PluginId;
  backendRevision?: string;
  pairedRequestVersion?: 1;
  pairedChannelVersion?: 1;
}

type MaybePromise<T> = T | Promise<T>;

export interface PiWebPlugin {
  apiVersion: 4;
  name: string;
  requires?: readonly PluginCapability[];
  activate: (context: PluginActivationContext) => MaybePromise<PluginActivationResult>;
}

export interface PluginActivationContext {
  readonly apiVersion: 4;
  /** Stable package/source identity, including on federated machines. */
  readonly pluginId: PluginId;
  /** Host-unique identity for qualified contribution references in this runtime. */
  readonly runtimePluginId: PluginId;
  readonly html: HtmlTemplateTag;
  readonly svg: SvgTemplateTag;
  /** Signal for this bounded activation invocation, not the plugin lifetime. */
  readonly signal: AbortSignal;
  /** Aborted before failed-start rollback or browser-host shutdown disposal. */
  readonly lifetimeSignal: AbortSignal;
}

export interface PluginCapabilityResolver {
  readonly resolve: <Value>(capability: PluginCapability<Value>) => Value;
}

export interface PluginStartContext {
  readonly capabilities: PluginCapabilityResolver;
  readonly signal: AbortSignal;
}

export interface PluginActivationResult {
  contributions: PluginContributions;
  provides?: readonly PluginCapabilityProvision[];
  start?(context: PluginStartContext): MaybePromise<void>;
  dispose?(signal: AbortSignal): MaybePromise<void>;
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

export interface WorkspaceFileRequestOptions {
  readonly signal?: AbortSignal;
}

export interface WorkspaceFileReferenceOptions {
  readonly version?: string;
}

export interface WorkspaceFileUploadProgress {
  readonly loaded: number;
  readonly total: number;
  readonly percent: number;
  readonly lengthComputable: boolean;
}

export interface WorkspaceFileUploadOptions {
  readonly destinationFolder?: string;
  readonly createDirs?: boolean;
  readonly overwrite?: boolean;
  readonly onProgress?: (progress: WorkspaceFileUploadProgress) => void;
}

export interface WorkspaceFileUploadTask {
  readonly path: string;
  readonly completed: Promise<WriteWorkspaceFileResponse>;
  cancel(): void;
}

export interface WorkspaceFiles {
  readFile(path: string): Promise<FileContentResponse>;
  listFiles(path: string): Promise<FileTreeResponse>;
  writeFile(path: string, content: string | Uint8Array, options?: WriteWorkspaceFileOptions): Promise<WriteWorkspaceFileResponse>;
  deleteFile(path: string): Promise<DeleteWorkspaceFileResponse>;
  moveFile(fromPath: string, toPath: string, options?: MoveWorkspaceFileOptions): Promise<MoveWorkspaceFileResponse>;
}

export interface LegacyWorkspaceFiles extends WorkspaceFiles {
  readonly capabilityVersion?: undefined;
}

export interface WorkspaceFilesCapabilityV1 extends WorkspaceFiles {
  readonly capabilityVersion: 1;
  readonly defaultUploadFolder: string;
  readonly maxInlinePreviewBytes: number;
  readFile(path: string, options?: WorkspaceFileRequestOptions): Promise<FileContentResponse>;
  listFiles(path: string, options?: WorkspaceFileRequestOptions): Promise<FileTreeResponse>;
  previewUrl(path: string, options?: WorkspaceFileReferenceOptions): string;
  downloadUrl(path: string, options?: WorkspaceFileReferenceOptions): string;
  uploadFile(file: File, options?: WorkspaceFileUploadOptions): WorkspaceFileUploadTask;
}

export type WorkspaceFilesContextValue = LegacyWorkspaceFiles | WorkspaceFilesCapabilityV1;

export interface PluginPeerRequestOptions {
  readonly signal?: AbortSignal;
}

export interface PluginPeerChannelOptions {
  readonly signal?: AbortSignal;
  readonly onData: (data: JsonValue) => void;
}

export interface PluginPeerChannelClose {
  readonly code: number;
  readonly reason: string;
  readonly wasClean: boolean;
  readonly error?: Readonly<{ code: string; message: string }>;
}

export interface PluginPeerChannel {
  readonly closed: Promise<PluginPeerChannelClose>;
  send(data: JsonValue): void;
  close(reason?: string): void;
}

export type PluginPeer =
  | {
      request(operation: string, input: JsonValue, options?: PluginPeerRequestOptions): Promise<JsonValue>;
      openChannel?(operation: string, input: JsonValue, options: PluginPeerChannelOptions): Promise<PluginPeerChannel>;
    }
  | {
      request?: undefined;
      openChannel(operation: string, input: JsonValue, options: PluginPeerChannelOptions): Promise<PluginPeerChannel>;
    };

export interface WorkspaceHost {
  requestRender(): void;
}

export interface WorkspaceContext {
  machine: PluginMachine;
  workspace: Workspace;
  state: AppState;
  files: WorkspaceFilesContextValue;
  peer?: PluginPeer;
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

export interface PiWebUnstableRuntimeContext {
  openSettings?: (section?: SettingsSection) => void;
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
  /** @deprecated Compatibility alias that publishes `workspace.files` invalidation for the selected workspace. */
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

export type ContributionQueryValue = string | number | boolean | readonly (string | number | boolean)[];

export interface WorkspacePanelNavigationV1 {
  readonly version: 1;
  readonly contributionId: QualifiedContributionId;
  readonly query: Readonly<Record<string, string | readonly string[]>>;
  set(key: string, value: ContributionQueryValue | undefined | null, options?: { replace?: boolean | undefined }): void;
}

export interface WorkspacePanelContext extends WorkspaceContext {
  prompt: PluginPromptEditor;
  terminal: WorkspacePanelTerminal;
  /** Contribution-scoped address-bar state for deep links and browser history. */
  navigation?: WorkspacePanelNavigationV1;
}

export type WorkspacePanelIcon = TemplateResult;
export type WorkspaceResource = "workspace.files";
export type WorkspaceInvalidationReason = "manual" | "mutation" | "agent-activity";

export interface WorkspaceInvalidation {
  readonly reason: WorkspaceInvalidationReason;
  readonly resources: readonly WorkspaceResource[];
}

export interface WorkspacePanelContribution {
  id: LocalContributionId;
  title: string;
  icon?: WorkspacePanelIcon;
  order?: number;
  /** Former URL tool/view values that should resolve to this panel. */
  routeAliases?: string[];
  /** Former qualified contribution ids whose namespaced query keys remain readable. */
  navigationAliases?: QualifiedContributionId[];
  visible?: (context: WorkspacePanelContext) => boolean;
  badge?: (context: WorkspacePanelContext) => string | number | TemplateResult | undefined;
  invalidationResources?: readonly WorkspaceResource[];
  onInvalidate?: (context: WorkspacePanelContext, invalidation?: WorkspaceInvalidation) => void | Promise<void>;
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
  files: WorkspaceFilesContextValue;
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
