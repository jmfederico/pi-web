import type { ReactiveControllerHost, TemplateResult } from "lit";
import type { DeleteWorkspaceFileResponse, FileContentResponse, FileTreeResponse, MachineKind, PluginBackend, PluginPeer, MoveWorkspaceFileOptions, MoveWorkspaceFileResponse, PiWebStatusResponse, PluginCapability, PluginCapabilityProvision, MaintenanceTerminalCommandRun, TerminalCommandRunHandle, WorkspaceProviderMetadata, WorkspaceRemovalPresentation, WriteWorkspaceFileOptions, WriteWorkspaceFileResponse } from "./shared/pluginApiTypes.js";
export type { FileContentMediaType, FileContentResponse, FileTreeEntry, FileTreeResponse, JsonObject, JsonPrimitive, JsonValue, PluginBackend, PluginBackendScope, PluginPeer, PluginPeerRequestOptions, PluginPeerChannelOptions, PluginPeerChannelClose, PluginPeerChannel, MachineKind, PiWebComponentStatus, PiWebRuntimeIdentity, PiWebDockerMode, PiWebInstallationInfo, PiWebInstallationKind, PiWebReleaseStatus, PiWebServiceComponent, PiWebStatusMessage, PiWebStatusResponse, PiWebStatusSeverity, PiWebVersionResponse, PluginCapability, PluginCapabilityProvision, SessionUiMetadata, AnyTerminalCommandRun, MaintenanceTerminalCommandRun, TerminalCommandRun, TerminalCommandRunHandle, TerminalCommandRunStatus, WorkspaceProviderCapabilities, WorkspaceProviderMetadata, WorkspaceRemovalPresentation, WriteWorkspaceFileOptions, WriteWorkspaceFileResponse, DeleteWorkspaceFileResponse, MoveWorkspaceFileOptions, MoveWorkspaceFileResponse, } from "./shared/pluginApiTypes.js";
export type { PluginCatalogV1, PluginCatalogProject, PluginCatalogWorkspace, PluginSessionSnapshot, PluginWorkspaceSelection, PluginSessionSelection, PluginCatalogReadOptions } from "./shared/pluginCatalogTypes.js";
import type { PluginCatalogV1 } from "./shared/pluginCatalogTypes.js";
export type PiWebPlugin = LegacyPiWebPlugin | PiWebPluginV5;
/** Current browser entrypoint. Existing contribution kinds and lifecycle behavior are unchanged. */
export interface PiWebPluginV5 {
    apiVersion: 5;
    name: string;
    requires?: readonly PluginCapability[];
    activate(context: PluginActivationContextV5): MaybePromise<PluginActivationResultV5>;
}
export type PluginActivationContextV5 = Omit<PluginActivationContext, "apiVersion"> & {
    readonly apiVersion: 5;
};
export type PluginActivationResultV5 = Omit<PluginActivationResult, "contributions"> & {
    contributions: PluginContributionsV5;
};
/** Captured machine target; changing selection never retargets this catalog. */
export interface PluginCatalog extends PluginCatalogV1 {
    readonly machineId: string;
}
export interface PluginDiscoveryContext {
    readonly catalog: PluginCatalog;
    readonly backend?: PluginBackend;
}
export type PluginRuntimeContextV5 = PluginRuntimeContext & PluginDiscoveryContext;
export type ApplicationPanelContextV5 = ApplicationPanelContext & PluginDiscoveryContext;
export type WorkspacePanelContextV5 = WorkspacePanelContext & PluginDiscoveryContext;
export type WorkspaceLabelContextV5 = WorkspaceLabelContext & PluginDiscoveryContext;
export type SessionLabelContextV5 = SessionLabelContext & PluginDiscoveryContext;
export interface MessageActionMessageV5 extends MessageActionMessage {
    /** This entry contains an ask_user question request, not an answer record. */
    readonly isQuestion?: boolean;
}
export interface MessageActionAvailabilityContextV5 extends Omit<MessageActionAvailabilityContext, "message"> {
    readonly message: MessageActionMessageV5;
}
export type MessageActionContextV5 = Omit<MessageActionContext, "message"> & MessageActionAvailabilityContextV5 & PluginDiscoveryContext;
export type DisplayedMessageActionContextV5 = DisplayedMessageActionContext & PluginDiscoveryContext;
export interface PluginContributionsV5 extends Omit<PluginContributions, "actions" | "applicationPanels" | "workspacePanels" | "workspaceLabels" | "sessionLabels" | "messageActions" | "contentRenderers" | "themes"> {
    stylesheets?: StylesheetContribution[];
    syntaxHighlighters?: SyntaxHighlighterContribution[];
    contentRenderers?: ContentRendererContributionV5[];
    themes?: ThemeContributionV5[];
    actions?: PluginActionV5[];
    applicationPanels?: ApplicationPanelContributionV5[];
    workspacePanels?: WorkspacePanelContributionV5[];
    workspaceLabels?: WorkspaceLabelContributionV5[];
    sessionLabels?: SessionLabelContributionV5[];
    messageActions?: MessageActionContributionV5[];
}
export type PluginActionV5 = Omit<PluginAction, "enabled" | "disabledReason" | "run"> & {
    enabled?: (context: PluginRuntimeContextV5) => boolean;
    disabledReason?: (context: PluginRuntimeContextV5) => string | undefined;
    run: (context: PluginRuntimeContextV5) => MaybePromise<void>;
};
export type ApplicationPanelContributionV5 = Omit<ApplicationPanelContribution, "visible" | "badge" | "render" | "onInvalidate"> & {
    onInvalidate?: (context: ApplicationPanelContextV5) => MaybePromise<void>;
    visible?: (context: ApplicationPanelContextV5) => boolean;
    badge?: (context: ApplicationPanelContextV5) => string | number | TemplateResult | undefined;
    render: (context: ApplicationPanelContextV5) => TemplateResult;
};
export type WorkspacePanelContributionV5 = Omit<WorkspacePanelContribution, "visible" | "badge" | "render" | "fileOpenQuery" | "onInvalidate"> & {
    visible?: (context: WorkspacePanelContextV5) => boolean;
    badge?: (context: WorkspacePanelContextV5) => string | number | TemplateResult | undefined;
    render: (context: WorkspacePanelContextV5) => TemplateResult;
    fileOpenQuery?: (context: WorkspacePanelContextV5, path: string) => Readonly<Record<string, ContributionQueryValue>> | undefined;
    onInvalidate?: (context: WorkspacePanelContextV5, invalidation?: WorkspaceInvalidation) => MaybePromise<void>;
};
export type WorkspaceLabelContributionV5 = Omit<WorkspaceLabelContribution, "visible" | "items"> & {
    visible?: (context: WorkspaceLabelContextV5) => boolean;
    items: (context: WorkspaceLabelContextV5) => WorkspaceLabelItem[];
};
export type SessionLabelContributionV5 = Omit<SessionLabelContribution, "visible" | "items"> & {
    visible?: (context: SessionLabelContextV5) => boolean;
    items: (context: SessionLabelContextV5) => SessionLabelItem[];
};
export type MessageActionContributionV5 = (Omit<EntryMessageActionContribution, "run" | "ariaLabel" | "visible" | "enabled"> & {
    ariaLabel?: (context: MessageActionAvailabilityContextV5) => string;
    visible?: (context: MessageActionAvailabilityContextV5) => boolean;
    enabled?: (context: MessageActionAvailabilityContextV5) => boolean;
    run: (context: MessageActionContextV5) => MaybePromise<MessageActionResult>;
}) | (Omit<DisplayedMessageActionContribution, "run"> & {
    run: (context: DisplayedMessageActionContextV5) => MaybePromise<MessageActionResult>;
});
export type PluginId = string;
export type LocalContributionId = string;
export type QualifiedContributionId = string;
export type HtmlTemplateTag = (strings: TemplateStringsArray, ...values: unknown[]) => TemplateResult;
export type SvgTemplateTag = (strings: TemplateStringsArray, ...values: unknown[]) => TemplateResult;
type MaybePromise<T> = T | Promise<T>;
/** @deprecated Browser API v4 remains supported; use PiWebPluginV5 for catalog and scoped backend access. */
export interface LegacyPiWebPlugin {
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
    /** Current browser selection, independent of panel mounting. Omitted by older hosts. */
    readonly selection?: PluginSelectionService;
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
export interface ContentRendererInputV5 extends ContentRendererInput {
    readonly machineId?: string;
    readonly language?: string;
    readonly filePath?: string;
}
export interface ContentRendererContributionV5 extends Omit<ContentRendererContribution, "render"> {
    /** Human-readable name used for renderer view buttons. */
    title?: string;
    /** Synchronous eligibility; replaces absent selectors or further restricts declared selectors. */
    supports?(request: Readonly<ContentRenderRequest>): boolean;
    render(input: ContentRendererInputV5): TemplateResult;
}
export type SyntaxHighlightTokenKind = "keyword" | "string" | "number" | "comment" | "type" | "function" | "variable" | "operator" | "punctuation" | "property" | "literal" | "meta";
export interface SyntaxHighlightToken {
    /** UTF-16 code-unit offsets: inclusive start, exclusive end. Sorted and nonoverlapping. */
    readonly from: number;
    readonly to: number;
    readonly kind: SyntaxHighlightTokenKind;
}
export interface SyntaxHighlighterContribution {
    id: LocalContributionId;
    languages?: readonly string[];
    /** Extensions without a leading dot, matched case-insensitively. */
    fileExtensions?: readonly string[];
    highlight(input: {
        readonly text: string;
        readonly signal: AbortSignal;
    }): readonly SyntaxHighlightToken[] | Promise<readonly SyntaxHighlightToken[]>;
}
export interface SyntaxHighlightRequest {
    machineId: string;
    text: string;
    language?: string;
    filePath?: string;
    signal: AbortSignal;
}
/** Host capability token: { pluginId: "pi-web", id: "syntax-highlighting", version: 1, parse }. */
export interface SyntaxHighlightingCapability {
    /** Whether a currently active grammar matches this machine and source metadata. */
    supports(request: Pick<ContentRenderRequest, "machineId" | "language" | "filePath">): boolean;
    /** Last discovered match; undefined when no match or over 100,000 UTF-16 units. Errors reject. */
    highlight(request: SyntaxHighlightRequest): Promise<readonly SyntaxHighlightToken[] | undefined>;
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
    /** Explicit plugin title, when supplied; label also includes the host's fallback name. */
    readonly title?: string;
    readonly renderMode: "manual" | "automatic";
}
export type ContentTextRenderRequest = ContentRenderRequest & {
    /** Authorize manual previews; false/omitted retains automatic defaults. Never overrides user Raw. */
    allowManualPreview?: boolean;
} & ({
    controls: "external";
    rendererId?: string;
} | {
    controls?: never;
    rendererId?: never;
});
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
    /** Eligible choices in plugin discovery order, then contribution declaration order. */
    listRenderers(request: ContentRenderRequest): readonly ContentRendererOption[];
    /**
     * Undefined when no renderer claims the complete text file.
     * External controls require the caller to provide raw-source access, mode switching and a renderer chooser.
     * Only external controls accept rendererId; absent or unavailable IDs use the last automatic match, otherwise the first manual match.
     * Consumers authorize manual previews according to their own user-intent policy.
     * Listing and creating templates never call render.
     */
    renderText(request: ContentTextRenderRequest): TemplateResult | undefined;
    /**
     * The caller supplies its existing trusted HTML sanitizer; policies are not shared.
     * Each eligible fence owns its renderer buttons and Raw control. No remembered intent is stored.
     */
    renderMarkdown(request: ContentMarkdownRenderRequest): TemplateResult;
}
/** Styling is experimental: shared classes, tokens and presentation may change between releases. */
export interface StylesheetRootOptions {
    /** Inject the host's shared controls and file/tree-row styles into this root. Defaults to false. */
    readonly sharedUi?: boolean;
}
/**
 * Host capability token: { pluginId: "pi-web", id: "stylesheet-integration", version: 1, parse }.
 * Direct stylesheet rules reach only explicitly registered roots; custom properties can inherit further.
 * Opt into shared UI styles per root; the host owns injection, ordering and cleanup.
 * Styling, including shared classes and internal host markup, is experimental rather than a stable API.
 */
export interface StylesheetIntegrationCapabilityV1 {
    /** Register a retained open or closed root. Release on disconnect; register again on reconnect. */
    readonly registerRoot: (root: ShadowRoot, options?: StylesheetRootOptions) => () => void;
    /**
     * Subscribe to active stylesheet changes after adoption in all registered roots.
     * Includes removal, not initial subscription or root registration. Read initial values
     * after registering your root. Listeners run synchronously; failures are logged in isolation.
     * Release on disconnect. This does not observe arbitrary CSS mutations or media queries.
     */
    readonly subscribe: (listener: () => void) => () => void;
    /** Installs a Lit lifecycle controller; call once when constructing the component. */
    readonly createController: (host: ReactiveControllerHost & {
        readonly renderRoot?: HTMLElement | DocumentFragment;
    }, options?: StylesheetRootOptions) => void;
}
/** A CSS file, normally new URL("./custom.css", import.meta.url).href. Inline CSS and runtime @import are unsupported. */
export interface StylesheetContribution {
    id: string;
    /** Absolute HTTP(S) URL. Assets resolve relative to the CSS file, including redirects. */
    url: string;
    /** Lower numbers load first; default 1000. Ties use qualified contribution IDs. */
    order?: number;
}
export interface PluginContributions {
    contentRenderers?: ContentRendererContribution[];
    messageActions?: MessageActionContribution[];
    actions?: PluginAction[];
    applicationPanels?: ApplicationPanelContribution[];
    workspacePanels?: WorkspacePanelContribution[];
    workspaceLabels?: WorkspaceLabelContribution[];
    sessionLabels?: SessionLabelContribution[];
    themes?: ThemeContribution[];
    themePairs?: ThemePairContribution[];
}
export interface PluginMachine {
    id: string;
    name: string;
    kind: MachineKind;
}
/** Basic registered project information on a host-bound machine. */
export interface PluginProject {
    readonly id: string;
    readonly name: string;
    readonly path: string;
}
/** A directory suggested by the target machine's project directory search. */
export interface PluginProjectDirectorySuggestion {
    readonly path: string;
}
/** Read-only project discovery with a fixed machine target, independent of later selection. */
export interface PluginProjects {
    readonly machineId: string;
    /** List registered projects, not every directory on the machine. */
    listProjects(): Promise<readonly PluginProject[]>;
    /** Suggest directories matching a path query using the host's project picker rules. */
    suggestDirectories(query: string): Promise<readonly PluginProjectDirectorySuggestion[]>;
}
/** Selected conversation snapshot, scoped to PluginRuntimeState.selectedMachine. */
export interface PluginSelectedSession {
    id: string;
    /** Workspace working directory. */
    cwd: string;
    name?: string;
    /** Detached, explicitly UI-safe data by package/plugin namespace. Absent on older hosts. */
    metadata?: import("./shared/pluginApiTypes.js").SessionUiMetadata;
    archived: boolean;
    /** True while the browser is waiting for session creation to finish. */
    pending: boolean;
}
/** Basic selection only; no transcript, route query, or status data. */
export interface PluginSelectionSnapshot {
    /** Undefined before machines load. */
    readonly selectedMachine?: Readonly<PluginMachine>;
    readonly selectedProject?: PluginProject;
    readonly selectedWorkspace?: Readonly<Workspace>;
    readonly selectedSession?: Readonly<PluginSelectedSession>;
}
export interface PluginSelectionService {
    /** Read a fresh, detached snapshot synchronously. */
    getSnapshot(): PluginSelectionSnapshot;
    /**
     * Notify after host UI commits that change basic selection; does not call immediately.
     * Multiple changes within one commit may be coalesced.
     * Works while panels are closed. Ends at plugin lifetime abort, or earlier via
     * the returned idempotent unsubscribe. Subscriber failures are logged in isolation.
     */
    subscribe(listener: (snapshot: PluginSelectionSnapshot) => void | Promise<void>): () => void;
}
export interface PluginRuntimeState {
    /** Identity of the currently selected machine. Undefined only on older hosts or before machines load. */
    selectedMachine?: PluginMachine;
    selectedProject?: PluginProject;
    selectedWorkspace?: Workspace;
    selectedSession?: PluginSelectedSession;
    workspaceTool?: string;
    mainView?: "navigation" | "chat" | "workspace";
    piWebStatus?: PiWebStatusResponse;
}
export interface PluginPromptChip {
    /** Plugin-local identity; setting the same id replaces its data and callback. */
    readonly id: string;
    readonly label: string;
    /** Non-empty text appended verbatim to the message, separated by blank lines. */
    readonly text: string;
    /** User removal or server-accepted submission; programmatic withdrawal is silent. */
    readonly onRemove?: (reason: "user" | "submitted") => void | Promise<void>;
}
export interface PluginPromptEditor {
    /** Insert text at the current cursor position. Replaces any selection.
     *  If the editor is not focused, focuses it first.
     *  No-op if the editor is not mounted. */
    insertText(text: string): void;
    /** Get the current prompt text content. Returns "" if the editor is not mounted. */
    getText(): string;
    /** Get the current selection range, or null if no selection or editor not mounted. */
    getSelection(): {
        start: number;
        end: number;
        text: string;
    } | null;
    /**
     * Stage or replace this plugin's chip in the machine/conversation captured by
     * this context. Requires a ready, non-archived selected conversation when the
     * context is created. Throws when that target or plugin is unavailable.
     * Browser memory only; survives panel closure/navigation, not page reload.
     * Omitted by older hosts. Call from event handlers, not render callbacks.
     */
    setChip?(chip: PluginPromptChip): void;
    /** Withdraw this plugin's chip from the captured conversation without notification. */
    removeChip?(id: string): void;
}
/** A non-null destination: complete by default, or a current-URL patch with mode: "patch". */
export interface PluginNavigationDestination {
    machineId?: string;
    projectId?: string;
    workspaceId?: string;
    /** Full, exact session ID in the target workspace; prefixes are not resolved. */
    sessionId?: string;
    view?: "navigation" | "chat" | "workspace";
    tool?: QualifiedContributionId;
    /** Local query keys for tool. Requires a tool/project/workspace
     *  (explicit in replace mode, optionally inherited in patch mode).
     *  Replace mode replaces all contribution query state; patch mode merges only these keys. */
    query?: Readonly<Record<string, ContributionQueryValue>>;
}
/** Current-URL patch, accepted only with mode: "patch". Undefined fields are preserved. */
export interface PluginNavigationPatchDestination {
    /** Null resets the machine to local; other null route fields remove that URL field. */
    machineId?: string | null;
    projectId?: string | null;
    workspaceId?: string | null;
    /** Full, exact session ID in the target workspace; prefixes are not resolved. */
    sessionId?: string | null;
    view?: "navigation" | "chat" | "workspace" | null;
    tool?: QualifiedContributionId | null;
    /** Merge local keys into the effective tool/project/workspace query; null values remove keys. */
    query?: Readonly<Record<string, ContributionQueryValue | null>>;
}
export interface PluginNavigationOptions {
    /** Defaults to replace. Patch preserves omitted fields and clears inherited descendants
     *  when their machine/project/workspace changes. Null route fields are valid only in patch mode. */
    mode?: "replace" | "patch";
    /** Browser history behavior, independent of mode. Defaults to push. */
    history?: "push" | "replace";
}
/** Shared navigation callable; nullable destinations require explicit patch options. */
export interface PluginNavigate {
    (destination: PluginNavigationDestination, options?: PluginNavigationOptions): Promise<void>;
    (destination: PluginNavigationPatchDestination, options: PluginNavigationOptions & {
        mode: "patch";
    }): Promise<void>;
}
export interface PluginRuntimeContext {
    /** Navigate using host restoration defaults. Route failures appear in the host UI. */
    navigate: PluginNavigate;
    state: PluginRuntimeState;
    /** Read-only discovery on this context's machine. Omitted by older hosts. */
    projects?: PluginProjects;
    prompt: PluginPromptEditor;
    openActionPalette: () => void;
    focusPrompt: () => void;
    addProject: () => void | Promise<void>;
    configureAuth: () => void | Promise<void>;
    logoutAuth: () => void | Promise<void>;
    openThemePicker: () => void;
    selectMainView: (view: "navigation" | "chat" | "workspace") => void;
    selectWorkspaceTool: (tool: QualifiedContributionId) => void;
    openTerminal: (options?: {
        terminalId?: string | undefined;
    }) => void;
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
/** A durable message displayed in the transcript; text excludes thinking and tool payloads. */
export interface MessageActionMessage {
    readonly entryId: string;
    readonly role: "user" | "assistant" | "tool" | "system" | "bash" | "skill";
    readonly text: string;
}
/** Small, detached inputs for synchronous, side-effect-free availability checks. */
export interface MessageActionAvailabilityContext {
    readonly machine: Readonly<PluginMachine>;
    readonly session: Readonly<PluginSelectedSession & {
        busy: boolean;
    }>;
    readonly message: MessageActionMessage;
}
/** Created on invocation, with helpers scoped to the initiating machine/conversation. */
export interface MessageActionContext extends MessageActionAvailabilityContext {
    readonly prompt: PluginPromptEditor;
    readonly navigate: PluginNavigate;
    readonly projects: PluginProjects;
    readonly workspace?: Workspace;
    readonly files?: WorkspaceFilesContextValue;
    readonly peer?: PluginPeer;
    readonly terminal?: WorkspacePanelTerminal;
    /** Guarded, fresh-history operations on this message; confirmation is the plugin's choice. */
    readonly history: {
        readonly fork: () => Promise<void>;
        readonly goBack: () => Promise<void>;
    };
}
/** Optional successful-action presentation, shown by the host for 1.2 seconds. */
export interface MessageActionFeedback {
    readonly title: string;
    readonly ariaLabel?: string;
    readonly icon?: TemplateResult;
}
export type MessageActionResult = void | MessageActionFeedback;
interface MessageActionDefinition<AvailabilityContext, Context> {
    id: LocalContributionId;
    title: string;
    icon?: TemplateResult;
    /** Defaults to title. Synchronous and side-effect-free, like availability checks. */
    ariaLabel?: (context: AvailabilityContext) => string;
    /** Checks run only when their message/session inputs or active contributions change. No I/O. */
    visible?: (context: AvailabilityContext) => boolean;
    enabled?: (context: AvailabilityContext) => boolean;
    /** Plugin-defined workflow; the host does not add a confirmation. */
    run: (context: Context) => MaybePromise<MessageActionResult>;
}
/** Default action target: an identified transcript entry with guarded history helpers. */
export interface EntryMessageActionContribution extends MessageActionDefinition<MessageActionAvailabilityContext, MessageActionContext> {
    target?: "entry";
}
/** The ordinary original text in one displayed header's slice, excluding thinking/tool payloads. */
export interface DisplayedMessageActionMessage {
    /** Absent for optimistic or streaming messages. */
    readonly entryId?: string;
    readonly role: MessageActionMessage["role"];
    /** Nonempty original text parts, trimmed individually and joined with blank lines. */
    readonly text: string;
}
export interface DisplayedMessageActionAvailabilityContext extends Omit<MessageActionAvailabilityContext, "message"> {
    readonly message: DisplayedMessageActionMessage;
}
/** Display-only workflows have no history helpers and can run alongside entry actions. */
export interface DisplayedMessageActionContext extends Omit<MessageActionContext, "message" | "history"> {
    readonly message: DisplayedMessageActionMessage;
}
export interface DisplayedMessageActionContribution extends MessageActionDefinition<DisplayedMessageActionAvailabilityContext, DisplayedMessageActionContext> {
    target: "display";
}
export type MessageActionContribution = EntryMessageActionContribution | DisplayedMessageActionContribution;
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
export interface WorkspaceHost {
    requestRender(): void;
}
export type WorkspacePanelHost = WorkspaceHost;
export interface WorkspaceContext {
    machine: PluginMachine;
    workspace: Workspace;
    state?: PluginRuntimeState;
    files: WorkspaceFilesContextValue;
    /** Read-only discovery on this context's machine. Omitted by older hosts. */
    projects?: PluginProjects;
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
    open(options?: {
        terminalId?: string | undefined;
    }): void;
    runCommand(input: WorkspaceTerminalCommandInput): Promise<TerminalCommandRunHandle>;
}
export interface MaintenanceTerminal {
    open(options?: {
        terminalId?: string | undefined;
    }): void;
    runCommand(input: WorkspaceTerminalCommandInput): Promise<TerminalCommandRunHandle<MaintenanceTerminalCommandRun>>;
}
export type ContributionQueryValue = string | number | boolean | readonly (string | number | boolean)[];
export interface WorkspacePanelNavigationV1 {
    readonly version: 1;
    readonly contributionId: QualifiedContributionId;
    readonly query: Readonly<Record<string, string | readonly string[]>>;
    set(key: string, value: ContributionQueryValue | undefined | null, options?: {
        replace?: boolean | undefined;
    }): void;
}
export interface WorkspacePanelContext extends WorkspaceContext {
    /** Navigate using host restoration defaults. Route failures appear in the host UI. */
    navigate: PluginNavigate;
    prompt: PluginPromptEditor;
    terminal: WorkspacePanelTerminal;
    /** Contribution-scoped address-bar state for deep links and browser history. */
    navigation?: WorkspacePanelNavigationV1;
}
/** Fresh selection context; available even when no project, workspace, or session is selected. */
export interface ApplicationPanelContext {
    machine: PluginMachine;
    state: PluginRuntimeState;
    /** Read-only discovery on this context's machine. Omitted by older hosts. */
    projects?: PluginProjects;
    /** Present only when a workspace is selected on this machine. */
    workspace?: Workspace;
    /** Workspace-bound terminal; present only with a selected workspace and an available Terminal provider. */
    terminal?: WorkspacePanelTerminal;
    /** Runs on this machine in PI WEB's maintenance directory, independent of workspace selection. Omitted by older hosts. */
    maintenanceTerminal?: MaintenanceTerminal;
    /** Contribution-scoped workspace queries; present only when a workspace is selected. */
    navigation?: WorkspacePanelNavigationV1;
    navigate: PluginNavigate;
    prompt: PluginPromptEditor;
    host: WorkspaceHost;
}
/** A third-column tool tab that does not require a workspace. */
export interface ApplicationPanelContribution {
    id: LocalContributionId;
    title: string;
    icon?: TemplateResult;
    order?: number;
    visible?: (context: ApplicationPanelContext) => boolean;
    badge?: (context: ApplicationPanelContext) => string | number | TemplateResult | undefined;
    /** Refreshes the panel after navigation restore or manual invalidation. */
    onInvalidate?: (context: ApplicationPanelContext) => void | Promise<void>;
    render: (context: ApplicationPanelContext) => TemplateResult;
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
/** Context for one session-list row, including unselected and archived sessions. */
export interface SessionLabelContext extends WorkspaceContext {
    /** Basic detached row snapshot, not necessarily state.selectedSession. */
    session: Readonly<PluginSelectedSession>;
    navigate: PluginNavigate;
}
export type SessionLabelItem = SessionLabelTextItem | SessionLabelLinkItem | SessionLabelRenderItem;
export interface SessionLabelTextItem {
    type: "text";
    text: string;
    title?: string;
}
export interface SessionLabelLinkItem {
    type: "link";
    text: string;
    href: string;
    title?: string;
    target?: "_blank" | "_self";
}
export interface SessionLabelRenderItem {
    type: "render";
    render: () => TemplateResult;
}
/** Indicators on session-list rows only. Callbacks are synchronous and side-effect-free. */
export interface SessionLabelContribution {
    id: LocalContributionId;
    order?: number;
    visible?: (context: SessionLabelContext) => boolean;
    items: (context: SessionLabelContext) => SessionLabelItem[];
}
export type ThemeColorScheme = "dark" | "light";
export type ThemeTokens = Record<string, string>;
/** Legacy v4 palette contract. V5 themes contribute CSS files instead. */
export interface ThemeContribution {
    id: LocalContributionId;
    name: string;
    description?: string;
    order?: number;
    colorScheme: ThemeColorScheme;
    tokens: ThemeTokens;
}
export interface ThemeContributionV5 extends Omit<ThemeContribution, "tokens"> {
    stylesheets?: StylesheetContribution[];
}
export interface ThemePairContribution {
    id: LocalContributionId;
    name: string;
    description?: string;
    order?: number;
    light: LocalContributionId;
    dark: LocalContributionId;
}
