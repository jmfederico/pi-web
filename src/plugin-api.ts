import type { TemplateResult } from "lit";
import type { DeleteWorkspaceFileResponse, FileContentResponse, FileTreeResponse, JsonValue, MachineKind, MoveWorkspaceFileOptions, MoveWorkspaceFileResponse, PiWebStatusResponse, PluginCapability, PluginCapabilityProvision, TerminalCommandRunHandle, WorkspaceProviderMetadata, WorkspaceRemovalPresentation, WriteWorkspaceFileOptions, WriteWorkspaceFileResponse } from "./shared/pluginApiTypes.js";

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
  PluginCapability,
  PluginCapabilityProvision,
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

type MaybePromise<T> = T | Promise<T>;

export interface PiWebPlugin {
  apiVersion: 4;
  name: string;
  /** Exact capability versions that must be active before this plugin starts. */
  requires?: readonly PluginCapability[];
  activate: (context: PluginActivationContext) => MaybePromise<PluginActivationResult>;
}

/** Host-owned frozen values supplied once during browser plugin activation. */
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

/** Resolver containing only the exact capability requirements declared by a plugin. */
export interface PluginCapabilityResolver {
  readonly resolve: <Value>(capability: PluginCapability<Value>) => Value;
}

/** Frozen values supplied after every declared dependency is active. */
export interface PluginStartContext {
  readonly capabilities: PluginCapabilityResolver;
  /** Signal for this bounded start invocation, not the plugin lifetime. */
  readonly signal: AbortSignal;
}

export interface PluginActivationResult {
  contributions: PluginContributions;
  /** Typed capability values owned by this plugin and published only after start succeeds. */
  provides?: readonly PluginCapabilityProvision[];
  /** Initialize resources after every exact declared capability requirement is active. */
  start?(context: PluginStartContext): MaybePromise<void>;
  /** Release resources within one host-bounded disposal invocation. */
  dispose?(signal: AbortSignal): MaybePromise<void>;
}

export interface ContentRendererInput {
  readonly text: string;
  /** Aborted when source, renderer, mode, mounting, or plugin lifetime changes. */
  readonly signal: AbortSignal;
  /** Report asynchronous failure; calls from obsolete renders are ignored. */
  readonly fail: (error: unknown) => void;
}

export interface ContentRendererContribution {
  id: LocalContributionId;
  languages?: readonly string[];
  /** Extensions without a leading dot, matched case-insensitively. */
  fileExtensions?: readonly string[];
  /** Defaults to manual: render is not called until the user chooses Render. */
  renderMode?: "manual" | "automatic";
  /** Synchronous Lit template; own async work and activation efficiency in a component and honor signal. */
  render(input: ContentRendererInput): TemplateResult;
}

export interface ContentRenderRequest {
  machineId: string;
  text: string;
  language?: string;
  filePath?: string;
  truncated?: boolean;
}

export interface ContentRendererOption {
  readonly id: string;
  readonly label: string;
  readonly renderMode: "manual" | "automatic";
}

export type ContentTextRenderRequest = ContentRenderRequest & {
  /** Authorize manual previews; false/omitted retains automatic defaults. Never overrides user Raw. */
  allowManualPreview?: boolean;
} & ({ controls: "external"; rendererId?: string } | { controls?: never; rendererId?: never });

export interface ContentMarkdownRenderRequest {
  machineId: string;
  text: string;
  truncated?: boolean;
  toSafeHtml: (text: string) => string;
  /** Authorize manual fence previews; false/omitted retains automatic defaults. Never overrides user Raw. */
  allowManualPreview?: boolean;
}

/** Host capability token: { pluginId: "pi-web", id: "content-rendering", version: 1, parse }. */
export interface ContentRenderingCapability {
  /** Eligible choices in source plugin ID order, then local contribution ID order. */
  listRenderers(request: ContentRenderRequest): readonly ContentRendererOption[];
  /**
   * Undefined when no renderer claims the complete text file.
   * External controls require the caller to provide raw-source access, mode switching and a renderer chooser.
   * Only external controls accept rendererId; absent or unavailable IDs use the first match.
   * Consumers authorize manual previews according to their own user-intent policy.
   * Listing and creating templates never call render.
   */
  renderText(request: ContentTextRenderRequest): TemplateResult | undefined;
  /**
   * The caller supplies its existing trusted HTML sanitizer; policies are not shared.
   * Each eligible fence owns its chooser and Raw control. No remembered intent is stored.
   */
  renderMarkdown(request: ContentMarkdownRenderRequest): TemplateResult;
}

export interface PluginContributions {
  contentRenderers?: ContentRendererContribution[];
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

/** Selected conversation snapshot, scoped to PluginRuntimeState.selectedMachine. */
export interface PluginSelectedSession {
  id: string;
  /** Workspace working directory. */
  cwd: string;
  name?: string;
  archived: boolean;
  /** True while the browser is waiting for session creation to finish. */
  pending: boolean;
}

export interface PluginRuntimeState {
  /** Identity of the currently selected machine. Undefined only on older hosts or before machines load. */
  selectedMachine?: PluginMachine;
  selectedWorkspace?: Workspace;
  selectedSession?: PluginSelectedSession;
  workspaceTool?: string;
  mainView?: "navigation" | "chat" | "workspace";
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
  selectMainView: (view: "navigation" | "chat" | "workspace") => void;
  selectWorkspaceTool: (tool: QualifiedContributionId) => void;
  openTerminal: (options?: { terminalId?: string | undefined }) => void;
  /** @deprecated Compatibility alias that publishes `workspace.files` invalidation for the selected workspace. */
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

export interface WorkspaceFileRequestOptions {
  readonly signal?: AbortSignal;
}

export interface WorkspaceFileReferenceOptions {
  /** Opaque cache discriminator, such as the file's modified time. */
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

/** The five workspace-file operations published by browser API v2 hosts. */
export interface WorkspaceFiles {
  /** Read a file from the workspace. Works for local and federated machines. */
  readFile(path: string): Promise<FileContentResponse>;
  /** List the entries of a workspace directory. Pass "" for the workspace root.
   *  Works for local and federated machines. Rejects when the directory does not
   *  exist or cannot be read, matching readFile error behavior. */
  listFiles(path: string): Promise<FileTreeResponse>;
  /** Write content to a workspace file. Creates intermediate directories by default. */
  writeFile(path: string, content: string | Uint8Array, options?: WriteWorkspaceFileOptions): Promise<WriteWorkspaceFileResponse>;
  /** Delete a file from the workspace. Idempotent — returns { existed: false } if it does not exist. */
  deleteFile(path: string): Promise<DeleteWorkspaceFileResponse>;
  /** Move or rename a file within the workspace. Default overwrite: false. */
  moveFile(fromPath: string, toPath: string, options?: MoveWorkspaceFileOptions): Promise<MoveWorkspaceFileResponse>;
}

/** Structural workspace-files value supplied by browser API v2 hosts before capability versioning. */
export interface LegacyWorkspaceFiles extends WorkspaceFiles {
  readonly capabilityVersion?: undefined;
}

/** Versioned workspace-scoped host capability available to first- and third-party browser plugins. */
export interface WorkspaceFilesCapabilityV1 extends WorkspaceFiles {
  readonly capabilityVersion: 1;
  readonly defaultUploadFolder: string;
  readonly maxInlinePreviewBytes: number;
  readFile(path: string, options?: WorkspaceFileRequestOptions): Promise<FileContentResponse>;
  listFiles(path: string, options?: WorkspaceFileRequestOptions): Promise<FileTreeResponse>;
  /** Return a browser-ready URL already resolved by the host for this deployment and machine. */
  previewUrl(path: string, options?: WorkspaceFileReferenceOptions): string;
  /** Return a browser-ready download URL already resolved by the host for this deployment and machine. */
  downloadUrl(path: string, options?: WorkspaceFileReferenceOptions): string;
  /** Start one upload transport operation. Cancellation rejects `completed` with an AbortError. */
  uploadFile(file: File, options?: WorkspaceFileUploadOptions): WorkspaceFileUploadTask;
}

/** Host context value used to feature-detect versioned workspace-file additions. */
export type WorkspaceFilesContextValue = LegacyWorkspaceFiles | WorkspaceFilesCapabilityV1;
export type WorkspacePanelFiles = WorkspaceFiles;

export interface PluginPeerRequestOptions {
  /** Cancels this bounded request through local or federated host transport. */
  readonly signal?: AbortSignal;
}

/** Callbacks and cancellation for one bounded package-peer channel. */
export interface PluginPeerChannelOptions {
  /** Cancels the channel open or closes the live channel through every host hop. */
  readonly signal?: AbortSignal;
  /** Receives one plugin-authored JSON frame after the channel is ready. */
  readonly onData: (data: JsonValue) => void;
}

export interface PluginPeerChannelClose {
  readonly code: number;
  readonly reason: string;
  readonly wasClean: boolean;
  /** Attributed host or server-plugin failure when one preceded the close. */
  readonly error?: Readonly<{ code: string; message: string }>;
}

export interface PluginPeerChannel {
  readonly closed: Promise<PluginPeerChannelClose>;
  /** Queue one bounded JSON frame or throw. Success means queue acceptance, not remote receipt. */
  send(data: JsonValue): void;
  close(reason?: string): void;
}

/**
 * Exact revision-paired path to this browser package's active server entry.
 * A peer supplies a request handler, a channel handler, or both, but never neither.
 */
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

export type WorkspacePanelHost = WorkspaceHost;

export interface WorkspaceContext {
  machine: PluginMachine;
  workspace: Workspace;
  state?: PluginRuntimeState;
  files: WorkspaceFilesContextValue;
  /** Exact package-paired request/channel capabilities, independent of workspace ownership. */
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
  /** Return a deep-link query to open a workspace-relative file, or undefined if unsupported. */
  fileOpenQuery?: (context: WorkspacePanelContext, path: string) => Readonly<Record<string, ContributionQueryValue>> | undefined;
  badge?: (context: WorkspacePanelContext) => string | number | TemplateResult | undefined;
  /** Fixed workspace resources whose automatic invalidations this contribution receives. */
  invalidationResources?: readonly WorkspaceResource[];
  /** Called for manual panel invalidation or a declared resource invalidation. */
  onInvalidate?: (context: WorkspacePanelContext, invalidation?: WorkspaceInvalidation) => void | Promise<void>;
  render: (context: WorkspacePanelContext) => TemplateResult;
}

export interface WorkspaceLabelContext extends WorkspaceContext {
  machine: PluginMachine;
  workspace: Workspace;
  state?: PluginRuntimeState;
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
