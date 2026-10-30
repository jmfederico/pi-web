import { queuedMessageRecallConfirmation, type QueuedMessageActionTarget } from "../queuedMessageActions";
import { appActionMessages } from "../appActionMessages";
import { chatActionMessages, HistoryActionError } from "../chatActionMessages";
import { configureLocalizationPolicy, localization, LocalizationController } from "../localization/browser";
import { pickerMessages } from "../pickerMessages";
import { LitElement, html, type TemplateResult } from "lit";
import { customElement, property, query, state } from "lit/decorators.js";
import { guard } from "lit/directives/guard.js";
import { markdownWorkspaceContext, type MarkdownWorkspaceContext, type WorkspaceFileOpenRequest } from "../formatting/workspaceLinks";
import { DEFAULT_CHAT_BEHAVIORS, type ChatBehaviors } from "../chatBehaviors";
import { configApi, projectsApi, effectiveWorkspaceAttachmentsFolder, effectiveWorkspaceUploadFolder, sessionsApi, workspacesApi, workspaceEffectiveAttachmentsFolder, workspaceEffectiveUploadFolder, type AskUserSubmission, type CommandOption, type ExtensionDialogAnswer, type Machine, type MachineHealth, type PiWebConfigValues, type PiWebShortcutConfig, type Project, type SessionCleanupExecuteResponse, type SessionCleanupPreviewResponse, type SessionCleanupRequest, type SessionInfo, type SessionModel, type SessionModelCatalogEntry, type SessionModelScopeMode, type SessionTreeForkResult, type SessionTreeNavigateResult, type SessionTreeSummaryChoice, type TerminalCommandRun, type Workspace } from "../api";
import type { AppAction } from "../actions";
import { initialAppState, type AppState, type ModelDialogOrigin } from "../appState";
import { browserErrorContext, browserErrorScopeKey, BrowserErrorReporter, clearBrowserError, machineBrowserErrorScope, visibleBrowserErrors, workspaceBrowserErrorScope, type BrowserError, type BrowserErrorScope } from "../browserErrors";
import { isSessionActive } from "../../../shared/activity";
import { workspaceDeleteOperation } from "../../../shared/workspaceDeletion";
import { PI_WEB_CAPABILITIES, supportsPiWebCapability } from "../../../shared/capabilities";
import { machineScopedBundledPluginId, machineScopedManifestPluginId } from "../../../shared/machinePluginIds";
import { AuthController } from "../controllers/authController";
import { MachineController } from "../controllers/machineController";
import { MachineStatusController } from "../controllers/machineStatusController";
import { NavigationOrderController, type NavigationOrderScope } from "../controllers/navigationOrderController";
import { navigationOrderPort } from "../api/navigationOrder";
import { moveOrderedId, orderItems } from "../navigationOrder";
import { ProjectController, type ProjectTrustChoice } from "../controllers/projectController";
import { PiWebStatusController } from "../controllers/piWebStatusController";
import { SessionController } from "../controllers/sessionController";
import { SessionWorkTransitions } from "../controllers/sessionWorkTransitions";
import { completeRefreshBatch } from "../controllers/refreshBatch";
import { SessionNotificationController } from "../controllers/sessionNotificationController";
import { WorkspaceController, type WorkspaceSelectionError } from "../controllers/workspaceController";
import { routeFeedbackMessages as routeFeedback } from "../routeFeedbackMessages";
import { emptyMachineNavigationSnapshot, machineNavigationSnapshotFromState, routeFromMachineNavigationSnapshot, SessionStorageMachineNavigationMemory, type MachineNavigationSnapshot, type WorkspaceRouteSurface } from "../controllers/machineNavigationMemory";
import { SessionStorageSessionSelectionMemory } from "../controllers/sessionSelection";
import { SessionStorageWorkspaceSelectionMemory, shouldShowWorkspaceSelection } from "../controllers/workspaceSelection";
import { KeyboardShortcutDispatcher } from "../keyboardShortcuts";
import { selectedMachineId, type NavigationDestinationOptions, type NavigationFreshness, type NavigationScope, type NavigationSelection } from "../controllers/types";
import { machineSessionKey } from "../machineKeys";
import { appendPromptChipText, samePromptChipTarget, type PromptChipTarget, type StagedPromptChip } from "../promptChips";
import { HttpRequestError } from "../api/http";
import { sessionCleanupRequestKey } from "../sessionCleanupUi";
import { sessionCleanupMessages } from "../sessionCleanupMessages";
import { selectedNotificationView } from "../sessionNotifications";
import { SessionUnreadController, type SessionUnreadCompletion } from "../sessionUnread";
import { sessionNotices } from "../plugins/core/notices";
import type { SessionNoticeDismissDetail } from "./SessionNoticesPanel";
import { RealtimeSocket, type BrowserRealtimeEvent } from "../sessionSocket";
import { serverNoticeMessage } from "../serverNoticeMessages";
import { ServerNoticesController, visibleServerNotices } from "../serverNotices";
import type { ServerNotice } from "../../../shared/apiTypes";
import type { ApplicationPanelContext, MaintenanceTerminal, PluginNavigationPatchDestination, PluginNavigationOptions, ContributionQueryValue, PiWebPluginRegistration, PluginMachine, PluginPromptEditor, QualifiedContributionId, QualifiedThemeContribution, PluginRuntimeContext, SessionLabelContext, SessionLabelItem, WorkspaceFilesCapabilityV1, WorkspaceHost, WorkspaceInvalidation, WorkspaceLabelContext, WorkspaceLabelItem, WorkspacePanelContext, WorkspacePanelNavigationV1, WorkspacePanelTerminal, WorkspacePluginBinding, WorkspaceTerminalCommandInput } from "../plugins/types";
import { applyPiWebTheme, clearPiWebTheme, clearStoredThemePreference, configureThemePolicy, effectiveThemePreference, getThemePolicy, readStoredThemePreference, resolveThemePreference, writeStoredThemePreference, type ThemePreference, type ThemePreferenceResolution } from "../theme";
import { corePlugin } from "../plugins/core";
import { localizeBuiltInThemeMetadata, themePackPlugin } from "../plugins/themes";
import { cancelInitialTheme, claimStartupDocument, revealApplication, themeStartup } from "../themeStartup";
import { bootstrapPreference, loadThemeBootstrap, mergeThemeCatalog, type BrowserThemeCatalog } from "../themeCatalog";
import { FileIconService, fileIconsCapabilityToken } from "../fileIconService";
import { NO_FILE_ICONS, readStoredFileIconPreference, writeStoredFileIconPreference } from "../fileIconPreferences";
import { pluginStyles, PluginStyleRuntime, stylesheetIntegrationCapability } from "../plugins/styles";
import { addThemeStylesheets } from "../plugins/styleSources";
import { loadExternalPlugins, type ExternalPluginLoadResult } from "../plugins/external";
import { publicPluginSelection, publicPluginSession } from "../plugins/publicContext";
import type { DisplayedMessageActionAvailabilityContext, MessageActionAvailabilityContext, MessageActionContext, MessageActionResult } from "../../../plugin-api";
import { messageActionMessage } from "../plugins/messageActions";
import { createPluginProjects } from "../plugins/projects";
import { REQUIRED_TERMINAL_PLUGIN_ID, type TerminalPluginMode } from "../../../shared/requiredTerminalPlugin";
import { PluginRegistry, installApplicationPanelScope, installPluginRuntimeScope, installSessionLabelScope, installWorkspaceLabelScope, installWorkspacePanelScope, type BrowserPluginLifecyclePhase, type PluginRegistrationFailure } from "../plugins/registry";
import { createPluginBackend, createPluginPeer } from "../plugins/pluginPeer";
import { REQUIRED_TERMINAL_BROWSER_FACADE_CAPABILITY, requiredTerminalUnavailableError, type RequiredTerminalBrowserComposition, type WorkspaceContributionNavigationV1 } from "../plugins/requiredTerminalFacade";
import { createWorkspaceFiles as createPluginWorkspaceFiles } from "../plugins/workspaceFiles";
import { contributionQueryFromRecord, isContributionQueryLocalKey, patchContributionQueryRecord, readContributionQuery, readContributionQueryRecord, setContributionQueryKey, writeContributionQueryRecord, type ContributionQueryRecord } from "../namespacedQueryArgs";
import { AppShellController } from "../appShell/appShellController";
import { BrowserResumeController } from "../appShell/browserResumeController";
import { NavigationSectionsController, type NavigationSection } from "../appShell/navigationState";
import { PanelCollapseController, mainViewClass } from "../appShell/panelCollapseController";
import { PanelResizeController, type PanelResizeConstraints, type ResizablePanelSide } from "../appShell/panelResizeController";
import { isCreatingSessionId, parseMainView, readRoute, resolveAppRoute, routeMatchesWorkspaceIdentity, writeRoute, type AppRoute, type ParsedAppRoute, type WorkspaceRouteIdentity } from "../route";
import { resolvePluginNavigation } from "../pluginNavigation";
import { readSettingsSection, writeSettingsSection, type SettingsSection } from "../settingsRoute";
import { applyActiveShortcutPreferences } from "../shortcutPreferences";
import { loadNavigationPreferences, saveNavigationPreferences, pinnedNavigationTabs, type NavigationPreferences } from "../navigationPreferences";
import "./appShell/NavigationDialog";
import { canDeleteWorkspace, isWorkspaceDeletionPending, isWorkspaceDeletionRunPending, latestWorkspaceDeletionRuns, pendingWorkspaceDeletionIds, targetWorkspaceIdForRun, workspaceDeletionRunFilter, workspaceRemovalConfirmation } from "../workspaceDeletion";
import "./MachineList";
import "./ProjectList";
import "./WorkspaceList";
import { sessionNavigationCandidates, unreadSessionCount } from "./SessionList";
import "./SessionCleanupDialog";
import "./SessionTreeNavigator";
import "./ConversationLayout";
import "./ConversationSyncNotice";
import "./ChatView";
import type { ChatView } from "./ChatView";
import "./PromptEditor";
import type { PromptEditor } from "./PromptEditor";
import "./StatusBar";
import "./CommandPicker";
import "./ModelPicker";
import "./ActionPalette";
import "./AuthDialog";
import "./ProjectDialog";
import "./MachineDialog";
import type { MachineDialogSubmit } from "./MachineDialog";
import { deepActiveElement, focusElement, hasRenderedModal } from "./modalLayerRegistry";
import { hasOpenTransientPopup } from "./popupScope";
import "./SettingsDialog";
import "./WorkspacePanel";
import type { WorkspacePanelEmptyState, WorkspaceToolPanel } from "./WorkspacePanel";
import "./appShell/AppContextBar";
import "./appShell/AppMobileMainTabs";
import type { AppMobileMainTab } from "./appShell/AppMobileMainTabs";
import { shouldShowMachinesSection, type AppNavigationPanel, type NavigationFocusTarget } from "./appShell/AppNavigationPanel";
import "./appShell/AppPanelEdgeControl";
import { appShellMessages as appShellText } from "../appShellMessages";
import { appFeedbackMessages as appFeedback } from "../appFeedbackMessages";
import { PluginRecoveryError, pluginRecoveryMessages as pluginRecovery } from "../pluginRecoveryMessages";
import { renderPanelToggleButton } from "./appShell/panelToggleButton";
import "./appShell/AppRefreshControl";
import { errorBanner } from "./errorBanner";
import { deprecatedAgentInputsBanner, deprecatedAgentInputsWarnings } from "./deprecatedAgentInputsBanner";
import { appStyles } from "./shared";


const PI_WEB_STATUS_REFRESH_MS = 15 * 60 * 1000;
const SELECTED_SESSION_REFRESH_MS = 30_000;
const PI_WEB_STATUS_DEFER_MS = 750;
const REMOTE_ROUTE_RESTORE_RETRY_DELAYS_MS = [1_000, 3_000, 8_000, 15_000, 30_000] as const;
const WORKSPACE_DELETION_RECONCILE_RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 10_000] as const;
const GLOBAL_SHORTCUT_LISTENER_OPTIONS = { capture: true } as const;
const TERMINAL_PANEL_LOCAL_ID = "workspace.terminal";
const MIN_RESIZABLE_CHAT_WIDTH_PX = 320;
const PANEL_EDGE_COLUMNS_WIDTH_PX = 2;
const NAVIGATION_SCOPES = ["machine", "project", "workspace", "session", "tool", "view"] as const;
const ROUTE_RESTORE_SCOPE = NAVIGATION_SCOPES;
const ROUTE_SELECTION_SCOPE = ["machine", "project", "workspace", "session"] as const;
const WORKSPACE_SURFACE_SCOPE = ["tool", "view"] as const;

type WorkspaceRouteUrlPublication = "current-url" | "deferred";

interface WorkspaceRouteFinishOptions {
  updateUrl: boolean;
  urlPublication: WorkspaceRouteUrlPublication;
  unavailableToolRoute: boolean;
  unavailablePanelViewRoute: boolean;
  requestedTool: AppRoute["tool"];
  restoredWorkspaceIdentity?: WorkspaceRouteIdentity | undefined;
  requestedRoute?: ParsedAppRoute | undefined;
  restoreSeq?: number | undefined;
  navigation?: NavigationFreshness | undefined;
}

interface WorkspaceContributionQueryRestore {
  readonly identity: WorkspaceRouteIdentity;
  readonly query: Readonly<ContributionQueryRecord>;
}

interface NavigationUrlContext {
  readonly url: string;
  readonly navigation?: NavigationFreshness | undefined;
}

interface SessionCleanupDialogState {
  preview?: SessionCleanupPreviewResponse | undefined;
  previewRequest?: SessionCleanupRequest | undefined;
  result?: SessionCleanupExecuteResponse | undefined;
  loading?: boolean | undefined;
  running?: boolean | undefined;
  error?: string | (() => string) | undefined;
}

@customElement("pi-web-app")
export class PiWebApp extends LitElement {
  constructor() {
    super();
    new LocalizationController(this, localization, () => { this.invalidateWorkspaceSurface(); });
    stylesheetIntegrationCapability.createController(this);
  }

  /** Page-scoped injection seam for independently composing chat behavior. */
  @property({ attribute: false }) chatBehaviors: ChatBehaviors = DEFAULT_CHAT_BEHAVIORS;
  @state() private state: AppState = initialAppState();
  private readonly browserErrors = new BrowserErrorReporter(() => this.state, (patch) => { this.setState(patch); });
  @query("chat-view") private chatView?: ChatView;
  @state() private machineNameEditTarget: Machine | undefined;
  @state() private chatNavigation: TemplateResult | undefined;
  private readonly handleChatNavigationChange = (controls: TemplateResult) => { this.chatNavigation = controls; };
  @query("prompt-editor") private promptEditor?: PromptEditor;
  @state() private messageRevertTarget: PromptChipTarget | undefined;
  @state() private queuedMessageActionTarget: QueuedMessageActionTarget | undefined;
  @query("app-navigation-panel") private navigationPanel?: AppNavigationPanel;
  @query("#navigation-panel") private navigationPanelFrame?: HTMLElement;
  @query("#workspace-panel") private workspacePanelFrame?: HTMLElement;

  private readonly sessionUnread = new SessionUnreadController({
    onChange: (machineId) => {
      if (selectedMachineId(this.state) !== machineId) return;
      this.syncUnreadSessionIds();
      this.syncSelectedSessionReadState();
    },
    onBackgroundError: (operation, machineId, error) => {
      console.warn(`Failed to ${operation} session unread state for ${machineId}`, error);
    },
  });
  @state() private unreadSessionIds: ReadonlySet<string> = this.sessionUnread.unreadSessionIds(selectedMachineId(this.state), this.state.sessions);
  private unreadConnected = false;
  private committedChatIdentity: string | undefined;
  private chatWasVisible = false;
  private renderedUnreadCompletion: SessionUnreadCompletion | undefined;
  private unreadRenderGeneration = 0;
  private requestedUnreadSnapshot: string | undefined;
  /** An explicit reminder stays unread for the remainder of this selection. */
  private manuallyUnreadChatIdentity: string | undefined;
  @state() private readyChatIdentity: string | undefined;
  /** Prevent a global scope invalidation from racing the picker’s own mutation response. */
  private modelDialogMutationInFlight = 0;
  private modelDialogRefreshPending = false;
  private modelDialogScopeInvalidation = 0;

  @state() private navigationOrderVersion = 0;
  private navigationOrderConnected = false;
  private readonly navigationOrder = new NavigationOrderController(navigationOrderPort, {
    onChange: () => { this.navigationOrderVersion += 1; },
    onError: (scope, error) => {
      this.browserErrors.reportLocalized(machineBrowserErrorScope(scope.machineId), () => appFeedback.t("navigationOrderFailed", { detail: errorMessage(error) }));
    },
  });

  private readonly notifications = new SessionNotificationController(
    () => this.state,
    (patch) => { this.setState(patch); },
    { onBackgroundError: (message, error) => { console.warn(message, error); } },
  );
  private readonly sessionWorkTransitions = new SessionWorkTransitions();
  private readonly sessions = new SessionController(
    () => this.state,
    (patch) => { this.setState(patch); },
    () => { this.updateUrl(); },
    new SessionStorageSessionSelectionMemory(),
    {
      notifications: this.notifications,
      isChatVisible: () => this.isChatVisible(),
      observeSessionSnapshot: (machineId, sessionId) => {
        const observe = this.sessionWorkTransitions.snapshotObserver(machineId, sessionId);
        const discoveringWork = this.state.conversationRefreshedAt === undefined || !isSessionActive(this.state.status);
        const session = this.state.selectedSession;
        const generation = this.unreadRenderGeneration;
        const completion = session?.id === sessionId ? this.sessionUnread.completion(machineId, session) : undefined;
        return (status) => {
          if (status.sessionId !== sessionId) return;
          if (session !== undefined && completion !== undefined) {
            void this.commitUnreadCompletionAfterRender(machineId, session, completion, generation);
          }
          const idleSessionId = observe(status);
          // Synchronize newly discovered work and completion, not every periodic
          // snapshot of an already-observed active runtime.
          if ((discoveringWork && isSessionActive(status)) || idleSessionId !== undefined) this.invalidateFilesForSessionActivity(machineId, sessionId);
        };
      },
      automaticSessionCandidates: (sessions) => this.navigationPanel?.automaticSessionCandidates(sessions)
        ?? sessionNavigationCandidates(sessions, { collapsed: this.navigationSections.isCollapsed("sessions") }),
      navigateToSession: (session, options) => this.navigateToSessionFromController(session, options),
      captureNavigation: () => navigationSelectionFromState(this.state),
      beginNavigationOperation: (scope) => this.beginNavigationOperation(scope),
      onSelectedSessionReady: ({ machineId, session }) => {
        void this.commitReadyChatAfterRender(machineId, session);
      },
      onModelScopeChanged: () => {
        this.modelDialogScopeInvalidation += 1;
        void this.refreshOpenModelDialog();
      },
      replacePromptEditorText: async ({ machineId, sessionId, text }) => {
        await this.updateComplete;
        if (selectedMachineId(this.state) !== machineId || this.state.selectedSession?.id !== sessionId) return;
        this.promptEditor?.replaceText(text);
        if (this.messageRevertTarget?.machineId === machineId && this.messageRevertTarget.sessionId === sessionId) {
          this.messageRevertTarget = undefined;
        }
      },
    },
  );
  private readonly machineStatus = new MachineStatusController(
    () => this.state,
    (patch) => { this.setState(patch); },
  );
  private readonly auth = new AuthController(
    () => this.state,
    (patch) => { this.setState(patch); },
    (status) => { this.sessions.applySessionStatus(status); },
  );
  private readonly workspaces = new WorkspaceController(
    () => this.state,
    (patch) => { this.setState(patch); },
    () => { this.updateUrl(); },
    this.sessions,
    new SessionStorageWorkspaceSelectionMemory(),
    {
      navigateToWorkspace: (workspace, options) => this.navigateToWorkspaceFromController(workspace, options),
      captureNavigation: () => navigationSelectionFromState(this.state),
      beginNavigationOperation: (scope) => this.beginNavigationOperation(scope),
    },
  );
  private readonly projects = new ProjectController(
    () => this.state,
    (patch) => { this.setState(patch); },
    this.workspaces,
    {
      navigateToProject: (project, options) => this.navigateToProjectFromController(project, options),
      captureNavigation: () => navigationSelectionFromState(this.state),
    },
  );
  private readonly machines = new MachineController(
    () => this.state,
    (patch) => { this.setState(patch); },
    () => { this.updateUrl(); },
    this.projects,
    {
      navigateToMachine: (machine, options) => this.navigateToMachineFromController(machine, options),
      captureNavigation: () => navigationSelectionFromState(this.state),
    },
  );
  private readonly piWebStatusController = new PiWebStatusController(
    () => this.state,
    (patch) => { this.setState(patch); },
    { onRefreshError: (machineId, error) => { console.warn(`Failed to refresh PI WEB status for ${machineId}`, error); } },
  );
  private readonly keyboard = new KeyboardShortcutDispatcher();
  private readonly realtime = new RealtimeSocket();
  private readonly serverNotices = new ServerNoticesController({
    onChange: (machineId) => {
      if (selectedMachineId(this.state) === machineId) this.requestUpdate();
    },
    onBackgroundError: (operation, machineId, error) => {
      console.warn(`Failed to ${operation} server notices for ${machineId}`, error);
    },
  });
  private readonly machineRealtimeSockets = new Map<string, RealtimeSocket>();
  private readonly machineNavigation = new SessionStorageMachineNavigationMemory();
  private readonly appShell = new AppShellController(this);
  private readonly browserResume = new BrowserResumeController({
    onResumeSignal: () => { this.handleBrowserResumeSignal(); },
    refreshAfterResume: (renewSubscription) => this.refreshAfterBrowserResume(renewSubscription),
    onRefreshError: (error) => { console.warn("Failed to refresh after browser resume", error); },
  });
  private readonly panelCollapse = new PanelCollapseController(this);
  private readonly panelResize = new PanelResizeController(this);
  private readonly navigationSections = new NavigationSectionsController(
    this,
    () => ({ ...this.state, workspaceSelectionVisible: shouldShowWorkspaceSelection(this.state.workspaceResolution) }),
    () => this.appShell.isMobileNavigationLayout,
  );
  private readonly systemLightThemeMedia = typeof window !== "undefined" && "matchMedia" in window ? window.matchMedia("(prefers-color-scheme: light)") : undefined;
  private piWebStatusTimer: number | undefined;
  private selectedSessionRefreshTimer: number | undefined;
  private piWebStatusDeferredTimer: number | undefined;
  private workspaceDeletionPollTimer: number | undefined;
  private workspaceDeletionRefreshAbort: AbortController | undefined;
  private workspaceDeletionRefreshScope: string | undefined;
  private workspaceDeletionRefreshQueued = false;
  private workspaceDeletionRefreshGeneration = 0;
  private readonly workspaceDeletionReconcileRetries = new Map<string, { attempt: number; retryAt: number }>();
  private readonly handledWorkspaceDeletionRunIds = new Set<string>();
  private readonly requiredTerminalByMachine = new Map<string, RequiredTerminalBrowserComposition>();
  private readonly knownRequiredTerminalByMachine = new Map<string, RequiredTerminalBrowserComposition>();
  private readonly verifiedPluginModeByMachine = new Map<string, TerminalPluginMode>();
  /** Required-load failures outlive workspace/project resets until authoritative recovery. */
  private readonly requiredPluginFailureByMachine = new Map<string, () => string>();
  private readonly dismissedRequiredPluginFailureByMachine = new Map<string, () => string>();
  private machineNavigationRestoreSeq = 0;
  private navigationSelectionSeq = 0;
  @state() private pendingProjectNavigation: { seq: number; target: NavigationSection | undefined; cancelled: boolean } | undefined;
  private modelDialogInstanceId = 0;
  private routeRestoreSeq = 0;
  private routeSelectionRestoreSeq = 0;
  private navigationGeneration = 0;
  private observedNavigationRoute: ParsedAppRoute | undefined;
  private readonly navigationFieldGenerations: Record<NavigationScope, number> = {
    machine: 0,
    project: 0,
    workspace: 0,
    session: 0,
    tool: 0,
    view: 0,
  };
  private routeRestoreDepth = 0;
  private pendingRemoteRouteRestore: ParsedAppRoute | undefined;
  private remoteRouteRestoreTimer: number | undefined;
  private remoteRouteRestoreAttempt = 0;
  private remoteRouteRestoreInProgress = false;
  private readonly stylesheetRuntime = new PluginStyleRuntime(pluginStyles,
    (error) => { console.error("Failed to apply plugin stylesheets", error); },
    (error) => {
      console.error("Failed to apply theme stylesheets", error);
      this.revealAfterRender();
    },
  );
  private readonly fileIcons = new FileIconService();
  @state() private fileIconPreference: string | undefined = readStoredFileIconPreference();
  private readonly plugins = new PluginRegistry({
    hostCapabilities: [{ capability: fileIconsCapabilityToken, value: this.fileIcons.capability }],
    onPromptChipsChanged: () => { this.requestUpdate(); },
    isContributionEnabled: (pluginId, machineId) => this.pluginContributionAvailable(pluginId, machineId),
    getSelection: () => publicPluginSelection(this.state),
  });
  private readonly builtInPluginsReady = this.plugins.registerBatch([
    { id: "core", plugin: corePlugin },
    { id: "themes", plugin: themePackPlugin },
  ]).then(({ failures }) => {
    if (failures.length > 0) throw failures[0]?.error;
    if (this.isConnected) this.applyPreferredTheme(false);
    this.invalidateWorkspaceSurface();
  });
  private declarativeThemes: BrowserThemeCatalog | undefined;
  private requestedThemeId: string | undefined;
  private themeRequest: AbortController | undefined;
  private readonly declarativeThemesReady = themeStartup.catalog.then((catalog) => {
    if (catalog !== undefined) {
      // Settings may already have supplied a newer, complete inventory while
      // fallback HTML data was loading. That snapshot must remain authoritative.
      if (this.declarativeThemes === undefined) this.registerThemeCatalog(catalog);
      // The server has already resolved its intended default, even when only
      // the fallback is declarative and the intended theme needs legacy activation.
      this.requestedThemeId ??= bootstrapPreference(catalog, undefined).themeId;
    }
    return catalog;
  });
  private readonly loadedMachinePluginIds = new Set<string>();
  private readonly machinePluginLoadPromises = new Map<string, Promise<void>>();
  private gatewayPluginLoadPromise: Promise<void> | undefined;
  private gatewayPluginLoadAttemptComplete = false;
  private themeConfigReady = false;
  private themePolicyFromApplication = false;
  private activeThemeColorScheme: "light" | "dark" = this.startupColorScheme();
  @state() private localThemePreference: ThemePreference | undefined = readStoredThemePreference();
  @state() private configuredThemePreference: ThemePreference | undefined;
  private get themePreference(): ThemePreference {
    return effectiveThemePreference(this.localThemePreference, this.configuredThemePreference);
  }
  @state() private activeThemeId = "";
  @state() private isRefreshingApp = false;
  @state() private sessionCleanupDialog: SessionCleanupDialogState | undefined;
  private sessionCleanupRequestEpoch = 0;
  @state() private settingsSection: SettingsSection | undefined = readSettingsSection();
  @state() private shortcutConfig: PiWebShortcutConfig = {};
  @state() private defaultStreamingBehavior: "steer" | "followUp" = "steer";
  @state() private quietMode = false;
  @state() private workspaceUploadDefaultFolder = effectiveWorkspaceUploadFolder(undefined);
  @state() private workspaceAttachmentsDefaultFolder = effectiveWorkspaceAttachmentsFolder(undefined);
  /** Browser-local acknowledgement, retained per machine/session until activity elsewhere clears. */
  private readonly dismissedActivityNotices = new Set<string>();
  private readonly onPopState = () => {
    this.invalidateNavigationSelection();
    this.syncNavigationFreshness();
    // Retire the previous restore before scheduling async reconciliation. The
    // freshness token below handles scoped child state; this sequence also
    // prevents an older restore from normalizing the address bar afterward.
    this.routeRestoreSeq += 1;
    void this.withChatScrollTransition(async () => {
      this.restoreSettingsRoute();
      await this.restoreRoute(false);
    });
  };
  private readonly onSystemLightThemeChange = () => {
    if (this.themePreference.auto) this.applyPreferredTheme(false);
  };
  private get routeRestoreInProgress(): boolean {
    return this.routeRestoreDepth > 0;
  }

  private invalidateNavigationSelection(): void {
    this.navigationSelectionSeq += 1;
  }

  private readonly resetKeyboardSequence = () => { this.keyboard.reset(); };

  private readonly onKeyDown = (event: KeyboardEvent) => {
    if (this.isRenderedModalOpen() || (event.key === "Escape" && hasOpenTransientPopup(this.ownerDocument))) {
      this.keyboard.reset();
      return;
    }
    if (this.promptEditor?.ownsKeyboardEvent(event) === true) {
      this.keyboard.reset();
      return;
    }
    if (this.keyboard.handle(event, this.getDefaultActions(), { shortcuts: this.shortcutConfig })) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  protected override willUpdate(): void {
    this.toggleAttribute("pwa-display-mode", this.appShell.isPwaDisplayMode);
    this.syncSessionActivityAcknowledgement();
  }

  protected override updated(): void {
    if (this.sessions.isChatLoadDeferred) this.readyChatIdentity = undefined;
    // Lit has now committed the selected chat and app-shell visibility state.
    // Recheck after every rendered transition; the unread controller
    // deduplicates acknowledgements for the observed completion order.
    this.committedChatIdentity = selectedChatIdentity(this.state);
    this.syncSelectedSessionReadState();
    this.plugins.notifySelectionChanged();
    this.syncFileIcons();
    this.syncPluginStylesheets();
    const chatVisible = this.isChatVisible();
    if (chatVisible) {
      if (this.sessions.isChatLoadDeferred) this.scheduleSelectedChatLoad();
      else this.displayedChatIdentity = selectedChatIdentity(this.state);
      if (!this.chatWasVisible) this.chatView?.restoreScrollPosition();
    } else this.cancelSelectedChatLoad();
    this.chatWasVisible = chatVisible;
  }

  private selectedChatLoadFrame: number | undefined;

  private scheduleSelectedChatLoad(): void {
    if (this.selectedChatLoadFrame !== undefined) return;
    // Lit updates and Promise continuations run before paint. A second frame
    // lets the newly published list paint before cached chat/Markdown work starts.
    this.selectedChatLoadFrame = requestAnimationFrame(() => {
      this.selectedChatLoadFrame = requestAnimationFrame(() => {
        this.selectedChatLoadFrame = undefined;
        if (this.isConnected && this.isChatVisible()) void this.sessions.loadSelectedSession();
      });
    });
  }

  private cancelSelectedChatLoad(): void {
    if (this.selectedChatLoadFrame === undefined) return;
    cancelAnimationFrame(this.selectedChatLoadFrame);
    this.selectedChatLoadFrame = undefined;
  }

  // Once shown, retain the selected chat's DOM across tabs so drafts, scroll,
  // disclosures and in-flight UI state survive. A new hidden selection stays cold.
  private displayedChatIdentity: string | undefined;

  private isChatVisible(): boolean {
    const mainView = this.effectiveMainView();
    return mainView === "chat" || (mainView === "navigation" && !this.appShell.isMobileNavigationLayout) || this.isDesktopSideBySideLayout();
  }

  private syncSessionActivityAcknowledgement(): void {
    if (this.dismissedActivityNotices.size === 0) return;
    const session = this.state.selectedSession;
    const status = this.state.status;
    const machineId = selectedMachineId(this.state);
    // The cache belongs to the selected machine and receives global updates for
    // unselected sessions too. Their activity may clear while another chat is open.
    for (const cachedStatus of Object.values(this.state.sessionStatuses)) {
      if (cachedStatus.sessionId !== session?.id && cachedStatus.recentlyActiveElsewhere === false) {
        this.dismissedActivityNotices.delete(machineSessionKey(machineId, cachedStatus.sessionId));
      }
    }
    if (session !== undefined && status?.sessionId === session.id && status.recentlyActiveElsewhere === false) {
      this.dismissedActivityNotices.delete(machineSessionKey(machineId, session.id));
    }
  }

  private unacknowledgedActivitySessionKey(state = this.state): string | undefined {
    const session = state.selectedSession;
    if (session === undefined || state.status?.sessionId !== session.id || state.status.recentlyActiveElsewhere !== true) return undefined;
    const sessionKey = machineSessionKey(selectedMachineId(state), session.id);
    return this.dismissedActivityNotices.has(sessionKey) ? undefined : sessionKey;
  }

  private readonly handleDismissActivityNotice = async (): Promise<void> => {
    const sessionKey = this.unacknowledgedActivitySessionKey();
    if (sessionKey === undefined) return;
    this.dismissedActivityNotices.add(sessionKey);
    this.requestUpdate();
    await this.updateComplete;
    await this.promptEditor?.updateComplete;
    const session = this.state.selectedSession;
    if (session !== undefined
      && machineSessionKey(selectedMachineId(this.state), session.id) === sessionKey
      && this.unacknowledgedActivitySessionKey() === undefined
      && this.effectiveMainView() === "chat"
      && this.promptEditor?.disabled === false
      && !this.isRenderedModalOpen()) this.promptEditor.focusInput();
  };

  private renderSessionActivityNotice(): TemplateResult | null {
    if (this.unacknowledgedActivitySessionKey() === undefined) return null;
    return html`
      <section class="composer-activity-notice" role="alert" aria-label=${appFeedback.t("activityLabel")}>
        <div class="composer-activity-notice-text">
          <p>${appFeedback.t("activityNotice")}</p>
        </div>
        <button type="button" @click=${this.handleDismissActivityNotice}>${appFeedback.t("dismissActivity")}</button>
      </section>
    `;
  }

  private syncSelectedSessionReadState(): void {
    const session = this.state.selectedSession;
    if (session === undefined) return;
    const machineId = selectedMachineId(this.state);
    if (this.manuallyUnreadChatIdentity === unreadChatIdentity(machineId, session)
      || !this.isSessionSeen(machineId, session)) return;
    const completion = this.sessionUnread.completion(machineId, session);
    if (completion === undefined) return;
    const rendered = this.renderedUnreadCompletion;
    if (rendered !== undefined && JSON.stringify(rendered) === JSON.stringify(completion)) {
      void this.sessionUnread.acknowledgeRendered(machineId, session, rendered);
      return;
    }
    // Global completion delivery can precede the selected chat's final frames.
    // A snapshot requested after observing this order is the safe join boundary.
    const requestKey = JSON.stringify([machineId, completion]);
    if (this.requestedUnreadSnapshot === requestKey) return;
    this.requestedUnreadSnapshot = requestKey;
    void this.sessions.refreshSelectedSession(session.id, { silent: true });
  }

  private async commitUnreadCompletionAfterRender(
    machineId: string, session: SessionInfo, completion: SessionUnreadCompletion, generation: number,
  ): Promise<void> {
    const messages = this.state.messages;
    await this.updateComplete;
    if (!this.unreadConnected || generation !== this.unreadRenderGeneration
      || selectedChatIdentity(this.state) !== unreadChatIdentity(machineId, session)
      || this.state.messages !== messages) return;
    this.renderedUnreadCompletion = completion;
    this.syncSelectedSessionReadState();
  }

  private markSessionsRead(sessions: readonly SessionInfo[]): void {
    const machineId = selectedMachineId(this.state);
    for (const session of sessions) {
      if (this.manuallyUnreadChatIdentity === unreadChatIdentity(machineId, session)) this.manuallyUnreadChatIdentity = undefined;
      void this.sessionUnread.acknowledge(machineId, session);
    }
  }

  private async markSessionUnread(session: SessionInfo): Promise<void> {
    const machineId = selectedMachineId(this.state);
    const identity = unreadChatIdentity(machineId, session);
    // Set the guard before HTTP: the broadcast can arrive before its response.
    if (selectedChatIdentity(this.state) === identity) this.manuallyUnreadChatIdentity = identity;
    try {
      await this.sessionUnread.markUnread(machineId, session);
    } catch (error: unknown) {
      if (this.manuallyUnreadChatIdentity === identity) this.manuallyUnreadChatIdentity = undefined;
      this.browserErrors.reportLocalized(machineBrowserErrorScope(machineId), () => appFeedback.t("actionFailed", { detail: errorMessage(error) }));
    }
  }

  private async commitReadyChatAfterRender(machineId: string, session: SessionInfo): Promise<void> {
    const identity = unreadChatIdentity(machineId, session);
    await this.updateComplete;
    if (!this.unreadConnected || selectedChatIdentity(this.state) !== identity) return;
    this.readyChatIdentity = identity;
    this.syncSelectedSessionReadState();
  }

  private syncUnreadSessionIds(): void {
    const next = this.sessionUnread.unreadSessionIds(selectedMachineId(this.state), this.state.sessions);
    if (!sameStringSet(next, this.unreadSessionIds)) this.unreadSessionIds = next;
  }

  private isSessionSeen(machineId: string, session: SessionInfo): boolean {
    if (!this.unreadConnected) return false;
    const identity = unreadChatIdentity(machineId, session);
    if (selectedChatIdentity(this.state) !== identity
      || this.committedChatIdentity !== identity
      || this.readyChatIdentity !== identity) return false;
    if (typeof document !== "undefined") {
      if (document.visibilityState !== "visible") return false;
      if (typeof document.hasFocus === "function" && !document.hasFocus()) return false;
    }
    if (this.isRenderedModalOpen()) return false;
    const mainView = this.effectiveMainView();
    if (mainView === "chat") return true;
    if (mainView === "navigation") return !this.appShell.isMobileNavigationLayout;
    return this.isDesktopSideBySideLayout();
  }

  private isRenderedModalOpen(): boolean {
    return hasRenderedModal(this.ownerDocument);
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this.stylesheetRuntime.connect(this.ownerDocument);
    claimStartupDocument();
    void this.declarativeThemesReady.then(async (catalog) => {
      await themeStartup.ready;
      if (!this.isConnected || !themeStartup.started) return;
      // The startup snapshot must not overwrite a newer application config response.
      if (!this.themePolicyFromApplication && catalog !== undefined) this.applyThemeCatalogPolicy(catalog);
      this.themeConfigReady = true;
      this.activeThemeId = this.ownerDocument.documentElement.dataset["piWebTheme"] ?? "";
      const deliveredScheme = this.ownerDocument.documentElement.style.colorScheme;
      if (this.activeThemeId !== "" && (deliveredScheme === "light" || deliveredScheme === "dark")) {
        this.activeThemeColorScheme = deliveredScheme;
        this.syncFileIcons();
      }
      this.applyPreferredTheme(false);
      // The delivered palette is usable now. A browser override or legacy
      // activation can finish without keeping the rendered application hidden.
      this.revealAfterRender();
    });
    this.navigationOrderConnected = true;
    this.syncNavigationOrder();
    this.unreadConnected = true;
    window.addEventListener("popstate", this.onPopState);
    this.browserResume.connect();
    window.addEventListener("keydown", this.onKeyDown, GLOBAL_SHORTCUT_LISTENER_OPTIONS);
    window.addEventListener("focusin", this.resetKeyboardSequence);
    window.addEventListener("blur", this.resetKeyboardSequence);
    this.systemLightThemeMedia?.addEventListener("change", this.onSystemLightThemeChange);
    this.applyPreferredTheme(false);
    this.connectRealtime();
    this.syncSessionUnreadMachines();
    this.piWebStatusTimer = window.setInterval(() => { this.schedulePiWebStatusRefresh(); }, PI_WEB_STATUS_REFRESH_MS);
    this.scheduleSelectedSessionRefresh();
    void this.loadClientConfig();
    void this.ensureGatewayPluginsLoaded();
    void this.loadProjectsAndRestoreRoute().finally(() => { this.schedulePiWebStatusRefresh(); });
  }

  override disconnectedCallback(): void {
    cancelInitialTheme();
    this.themeRequest?.abort();
    this.stylesheetRuntime.disconnect(() => {
      if (this.activeThemeId === "") return;
      this.activeThemeId = "";
      clearPiWebTheme();
      this.activeThemeColorScheme = this.startupColorScheme();
    });
    this.navigationOrderConnected = false;
    this.unreadConnected = false;
    this.committedChatIdentity = undefined;
    this.readyChatIdentity = undefined;
    this.renderedUnreadCompletion = undefined;
    this.unreadRenderGeneration += 1;
    this.requestedUnreadSnapshot = undefined;
    this.sessionUnread.retainMachines(new Set<string>());
    window.removeEventListener("popstate", this.onPopState);
    this.browserResume.disconnect();
    window.removeEventListener("keydown", this.onKeyDown, GLOBAL_SHORTCUT_LISTENER_OPTIONS);
    window.removeEventListener("focusin", this.resetKeyboardSequence);
    window.removeEventListener("blur", this.resetKeyboardSequence);
    this.systemLightThemeMedia?.removeEventListener("change", this.onSystemLightThemeChange);
    this.keyboard.reset();
    // A custom element can be removed before its constructor-scheduled built-in
    // batch reaches the registration queue. The shutdown owns that rejection.
    void this.builtInPluginsReady.catch(() => undefined);
    this.plugins.beginShutdown();
    void this.plugins.dispose();
    this.auth.dispose();
    this.sessions.dispose();
    this.sessionWorkTransitions.clear();
    this.notifications.dispose();
    this.serverNotices.retainMachines(new Set<string>());
    this.realtime.close();
    this.closeMachineActivitySockets();
    if (this.piWebStatusTimer !== undefined) window.clearInterval(this.piWebStatusTimer);
    this.piWebStatusTimer = undefined;
    if (this.selectedSessionRefreshTimer !== undefined) window.clearTimeout(this.selectedSessionRefreshTimer);
    this.selectedSessionRefreshTimer = undefined;
    this.clearScheduledPiWebStatusRefresh();
    this.cancelSelectedChatLoad();
    this.cancelWorkspaceDeletionRefresh();
    this.clearPendingRemoteRouteRestore();
    super.disconnectedCallback();
  }

  private setState(patch: Partial<AppState>) {
    if (!patchChangesState(this.state, patch)) return;
    const previous = this.state;
    this.state = { ...this.state, ...patch };
    const pending = this.pendingProjectNavigation;
    if (pending?.seq === this.navigationSelectionSeq && !pending.cancelled && pending.target === undefined
      && previous.isLoadingWorkspaces && !this.state.isLoadingWorkspaces && this.state.workspaceResolution !== undefined) {
      // Decide the mobile destination from topology, without waiting for sessions.
      pending.target = this.state.workspaceResolution.status !== "degraded" && this.state.workspaces.length === 1 ? "sessions" : "workspaces";
      void this.focusNavigationTarget(pending.target, () => pending.seq === this.navigationSelectionSeq && !pending.cancelled);
    }
    if (workspaceDeletionScopeKey(previous) !== workspaceDeletionScopeKey(this.state)) {
      this.cancelWorkspaceDeletionRefresh();
      if (Object.keys(this.state.workspaceDeletionRuns).length > 0) this.state = { ...this.state, workspaceDeletionRuns: {} };
    }
    if (modelValueFromStatus(previous.status) !== modelValueFromStatus(this.state.status) && this.state.modelDialog !== undefined) {
      this.state = { ...this.state, modelDialog: undefined };
    }
    if (selectedChatIdentity(previous) !== selectedChatIdentity(this.state)) {
      this.manuallyUnreadChatIdentity = undefined;
      this.committedChatIdentity = undefined;
      this.readyChatIdentity = undefined;
      this.renderedUnreadCompletion = undefined;
      this.unreadRenderGeneration += 1;
      this.requestedUnreadSnapshot = undefined;
      this.displayedChatIdentity = undefined;
    }
    if (machineUnreadInputsChanged(previous, this.state)) this.syncSessionUnreadMachines();
    this.syncUnreadSessionIds();
    this.handleWorkspaceChange(previous, this.state);
    this.handleMachineChange(previous, this.state);
    if (machineActivitySubscriptionInputsChanged(previous, this.state)) this.syncMachineActivitySubscriptions();
    this.notifications.syncEnvironment(previous, this.state);
    if (this.navigationOrderConnected && (
      selectedMachineId(previous) !== selectedMachineId(this.state)
      || previous.selectedProject?.id !== this.state.selectedProject?.id
      || previous.selectedWorkspace?.id !== this.state.selectedWorkspace?.id
    )) this.syncNavigationOrder();
  }

  private async loadProjectsAndRestoreRoute() {
    this.restoreSettingsRoute();
    const route = readRoute();
    if (!await this.machines.loadMachines(route.machineId)) {
      this.setContentError(route, this.state.error);
      return;
    }
    if (!this.routeLocationMatchesUrl(route)) {
      await this.projects.loadProjects();
      await this.withChatScrollTransition(async () => { await this.restoreRoute(false); });
      await this.refreshWorkspaceDeletionRuns();
      return;
    }
    const initialRouteMachineHealth = this.state.machineStatuses[route.machineId ?? "local"];
    // An unavailable machine must not turn its requested hierarchy into a local route.
    if (selectedMachineId(this.state) === (route.machineId ?? "local")) await this.projects.loadProjects();
    // Project loading can outlive the initial URL capture; only hand the fixed
    // route to reconciliation while it is still the current destination.
    if (!this.routeLocationMatchesUrl(route)) {
      await this.withChatScrollTransition(async () => { await this.restoreRoute(false); });
      await this.refreshWorkspaceDeletionRuns();
      return;
    }
    await this.withChatScrollTransition(() => this.restoreRouteFor(route, false));
    if (this.shouldDeferRemoteRouteRestore(route, initialRouteMachineHealth)) this.deferRemoteRouteRestore(route);
    else {
      this.clearPendingRemoteRouteRestore();
      this.rememberCurrentMachineNavigation();
    }
    await this.refreshWorkspaceDeletionRuns();
  }

  private handleBrowserResumeSignal(): void {
    this.appShell.repairViewportPosition();
    this.schedulePiWebStatusRefresh();
    this.retryPendingRemoteRouteRestoreSoon();
  }

  private async refreshAfterBrowserResume(renewSubscription = false): Promise<void> {
    if (renewSubscription) {
      this.realtime.reconnect();
      for (const socket of this.machineRealtimeSockets.values()) socket.reconnect();
    }
    await completeRefreshBatch([
      this.sessionUnread.refreshAll(),
      this.sessions.resumeSelectedSession({ reconnect: renewSubscription }),
      this.sessions.refreshCurrentWorkspaceSessions(selectedMachineId(this.state), { recoverNetwork: true }),
      this.refreshMachineStatusSnapshots(),
      this.refreshWorkspaceDeletionRuns(),
      this.refreshCurrentWorkspaceSurface(),
      this.workspaces.refreshSelectedProjectTopology(),
      ...this.navigationOrderScopes().map((scope) => this.navigationOrder.load(scope)),
    ]);
  }

  /** One slow reconciliation loop; live events remain the normal update path. */
  private scheduleSelectedSessionRefresh(): void {
    if (this.selectedSessionRefreshTimer !== undefined) window.clearTimeout(this.selectedSessionRefreshTimer);
    this.selectedSessionRefreshTimer = window.setTimeout(() => {
      this.selectedSessionRefreshTimer = undefined;
      void this.refreshSelectedTranscript().finally(() => { this.scheduleSelectedSessionRefresh(); });
    }, SELECTED_SESSION_REFRESH_MS);
  }

  private async refreshSelectedTranscript(): Promise<void> {
    const session = this.state.selectedSession;
    if (session === undefined || session.archived === true || !this.isChatVisible() || document.visibilityState !== "visible") return;
    await this.sessions.refreshSelectedSession(session.id, { silent: true });
  }

  private schedulePiWebStatusRefresh(delayMs = PI_WEB_STATUS_DEFER_MS): void {
    this.clearScheduledPiWebStatusRefresh();
    this.piWebStatusDeferredTimer = window.setTimeout(() => {
      this.piWebStatusDeferredTimer = undefined;
      void this.piWebStatusController.refresh().finally(() => { this.schedulePiWebStatusRetry(); });
    }, delayMs);
  }

  private schedulePiWebStatusRetry(): void {
    if (this.isConnected && this.state.piWebStatus?.components.sessiond.available === false) {
      this.schedulePiWebStatusRefresh(5_000);
    }
  }

  private clearScheduledPiWebStatusRefresh(): void {
    if (this.piWebStatusDeferredTimer === undefined) return;
    window.clearTimeout(this.piWebStatusDeferredTimer);
    this.piWebStatusDeferredTimer = undefined;
  }

  /**
   * Explicit-refresh path for the status tree. Socket frames keep a loaded
   * snapshot current, including the one sent on connect, so this only covers
   * resumes and manual refreshes. A machine whose daemon does not serve the
   * route simply keeps no snapshot, which renders as no indicators.
   */
  private async refreshMachineStatusSnapshots(): Promise<void> {
    await Promise.all(this.refreshableMachineIds().map(async (machineId) => {
      try {
        await this.machineStatus.refresh(machineId);
      } catch (error) {
        console.warn(`Failed to refresh machine status for ${machineId}`, error);
      }
    }));
  }

  private refreshableMachineIds(): string[] {
    if (this.state.machines.length === 0) return [selectedMachineId(this.state)];
    return this.state.machines
      .filter((machine) => shouldRefreshMachineActivity(machine, this.state.machineStatuses[machine.id]))
      .map((machine) => machine.id);
  }

  private async loadClientConfig(): Promise<void> {
    try {
      const response = await configApi.config();
      configureThemePolicy(response);
      void configureLocalizationPolicy(response).catch((error: unknown) => {
        console.warn("Failed to apply gateway localization policy", error);
      });
      this.applyClientConfig(response.effectiveConfig);
    } catch (error) {
      console.warn("Failed to load PI WEB config", error);
    } finally {
      this.themeConfigReady = true;
      this.applyPreferredTheme(false);
    }
  }

  private applyThemeCatalogPolicy(catalog: BrowserThemeCatalog): void {
    configureThemePolicy({
      effectiveConfig: { ...(catalog.defaultTheme === undefined ? {} : { defaultTheme: catalog.defaultTheme }) },
      ...(catalog.enforcedBy === undefined ? {} : { enforcedSettings: { "/defaultTheme": catalog.enforcedBy } }),
    });
    this.configuredThemePreference = catalog.defaultTheme;
  }

  private applyClientConfig(config: PiWebConfigValues): void {
    this.themeConfigReady = true;
    this.themePolicyFromApplication = true;
    this.configuredThemePreference = config.defaultTheme;
    this.applyPreferredTheme(false);
    this.shortcutConfig = config.shortcuts ?? {};
    this.defaultStreamingBehavior = config.defaultStreamingBehavior ?? "steer";
    this.quietMode = config.quietMode === true;
    this.workspaceUploadDefaultFolder = effectiveWorkspaceUploadFolder(config);
    this.workspaceAttachmentsDefaultFolder = effectiveWorkspaceAttachmentsFolder(config);
  }

  private async refreshAppData(): Promise<void> {
    if (this.isRefreshingApp) return;
    this.isRefreshingApp = true;
    try {
      await completeRefreshBatch([
        this.sessions.refreshSelectedSession(),
        this.refreshMachineStatusSnapshots(),
        this.loadClientConfig(),
        this.refreshWorkspaceDeletionRuns(),
        this.refreshCurrentWorkspaceSurface(),
        this.workspaces.refreshSelectedProjectTopology(),
      ]);
      this.schedulePiWebStatusRefresh();
    } finally {
      this.isRefreshingApp = false;
    }
  }

  private async refreshCurrentWorkspaceSurface(): Promise<void> {
    const tool = this.effectiveWorkspaceTool();
    if (tool !== undefined) await this.invalidateWorkspacePanels(tool);
  }

  private hardReloadApp(): void {
    window.location.reload();
  }

  private async restoreRoute(
    updateUrl: boolean,
    restoredMainView?: AppState["mainView"],
    urlPublication: WorkspaceRouteUrlPublication = "current-url",
  ): Promise<boolean> {
    const restore = this.restoreRouteFor(readRoute(), updateUrl, undefined, restoredMainView, urlPublication);
    const restoreSeq = this.routeRestoreSeq;
    await restore;
    if (restoreSeq !== this.routeRestoreSeq) return false;
    this.rememberCurrentMachineNavigation();
    return true;
  }

  /**
   * Reconcile a route that has already been published by an imperative action.
   * Reconciliation may display an unavailable destination, but must not turn a
   * load failure into navigation. Only explicit actions publish another URL.
   */
  private async restoreCommittedNavigation(snapshot: MachineNavigationSnapshot): Promise<boolean> {
    return this.restoreRoute(false, parseMainView(snapshot.view), "deferred");
  }

  private async navigate(destination: PluginNavigationPatchDestination | null, options?: PluginNavigationOptions, capturedMachineId?: string): Promise<void> {
    const { route, contributionQuery } = resolvePluginNavigation(
      destination, options, readRoute(), readContributionQueryRecord(), selectedMachineId(this.state),
      (tool, machineId) => {
        const contributionId = this.plugins.resolveWorkspacePanelRouteId(tool, machineId);
        if (contributionId === undefined) return undefined;
        const sourceContributionId = this.plugins.getWorkspacePanels().find((panel) => panel.id === contributionId)?.sourceContributionId;
        return { contributionId, sourceContributionId };
      },
      capturedMachineId,
    );
    await this.commitAndRestoreNavigation({
      ...route,
      machineId: route.machineId ?? "local",
      // Retain omitted raw URL values in patch mode, including unavailable IDs/views.
      // Restoration resolves or explains them, rather than silently dropping them.
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
      tool: route.tool as QualifiedContributionId | undefined,
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
      view: route.view as AppState["mainView"] | undefined,
      surface: { contributionQuery },
    }, { replace: options?.history === "replace" });
  }

  private async commitAndRestoreNavigation(snapshot: MachineNavigationSnapshot, options: NavigationDestinationOptions = {}): Promise<boolean> {
    if (options.expected !== undefined && !this.navigationSelectionMatchesUrl(options.expected, options.creationHandoff === true)) return false;
    if (options.creationHandoff === true) {
      if (!isCreatingSessionId(options.expected?.sessionId)) return false;
      // A creation handoff owns only the session field. Surface changes may
      // already be in the URL while their asynchronous restore is still running.
      writeRoute({ ...readRoute(), sessionId: snapshot.sessionId }, { replace: true });
      return this.restoreRoute(false, undefined, "deferred");
    }
    this.commitMachineNavigationSnapshot(snapshot, { replace: options.replace });
    return this.restoreCommittedNavigation(snapshot);
  }

  private async restoreRouteFor(
    parsedRoute: ParsedAppRoute,
    updateUrl: boolean,
    surface = this.readWorkspaceRouteSurface(parsedRoute),
    restoredMainView?: AppState["mainView"],
    urlPublication: WorkspaceRouteUrlPublication = "current-url",
  ) {
    this.setContentError(parsedRoute, "");
    const machineBeforeRestore = selectedMachineId(this.state);
    const routeSurface = parsedRoute.projectId === undefined || parsedRoute.projectId === "" ? emptyWorkspaceRouteSurface() : surface;
    const navigation = this.beginNavigationOperation(ROUTE_RESTORE_SCOPE);
    const selectionFreshness = this.beginNavigationOperation(ROUTE_SELECTION_SCOPE);
    // A matching selection reuses its existing join (which may still be loading).
    // Only a restore that needs selection work supersedes that work's owner.
    if (!this.routeMatchesCurrentSelection(parsedRoute)) this.routeSelectionRestoreSeq += 1;
    const selectionRestoreSeq = this.routeSelectionRestoreSeq;
    // Keep selection ordering separate from finalization, which surface-only
    // navigation may retire even while the same selection is still loading.
    const selectionNavigation: NavigationFreshness = {
      ...selectionFreshness,
      isCurrent: () => selectionRestoreSeq === this.routeSelectionRestoreSeq && selectionFreshness.isCurrent(),
    };
    const restoreSeq = ++this.routeRestoreSeq;
    this.routeRestoreDepth += 1;
    try {
      const machineResolved = await this.restoreRouteMachine(parsedRoute, false);
      if (!machineResolved) {
        if (!selectionNavigation.isCurrent()) return;
        const error = this.state.error;
        this.workspaces.clearSelection({ updateUrl: false });
        if (error !== "") this.setState({ error });
        const machineId = parsedRoute.machineId ?? "local";
        const missingMachine = () => routeFeedback.t("machineNotFound", { id: machineId });
        this.setContentError(parsedRoute, missingMachine);
        const scope = machineBrowserErrorScope(machineId);
        if (this.state.browserErrors[browserErrorScopeKey(scope)] === undefined) {
          if (error !== "") this.browserErrors.report(scope, error);
          else this.browserErrors.reportLocalized(scope, missingMachine);
        }
        return;
      }
      // Machine/project loading may finish after navigation has selected a
      // newer destination, including after switching away and back.
      if (!selectionNavigation.isCurrent()) return;
      // Only resolving a `tool` route value needs plugin contributions. The
      // project/workspace/session selection never does, so it restores while
      // plugins load; a tool route waits for them only before finalization, so
      // opening a session never waits on every plugin module over slow links.
      const pluginsReady = this.loadPluginsForSelectedMachine();
      // Awaited only for tool routes; the load reports its own failures.
      pluginsReady.catch(() => undefined);
      const route = resolveAppRoute({ ...parsedRoute, tool: undefined }, () => undefined);
      const unavailablePanelViewRoute = parsedRoute.view !== undefined && route.view === undefined;
      const restoredWorkspaceIdentity = workspaceRouteIdentity(route);
      const baseFinishOptions: WorkspaceRouteFinishOptions = {
        updateUrl,
        urlPublication,
        unavailableToolRoute: false,
        unavailablePanelViewRoute,
        requestedTool: undefined,
        requestedRoute: parsedRoute,
        restoreSeq,
        navigation,
        ...(restoredWorkspaceIdentity === undefined ? {} : { restoredWorkspaceIdentity }),
      };
      const resolveToolRoute = async (): Promise<WorkspaceRouteFinishOptions | undefined> => {
        if (parsedRoute.tool === undefined) return baseFinishOptions;
        await pluginsReady;
        if (!this.isCurrentRouteRestore(restoreSeq, navigation)) return undefined;
        const tool = resolveAppRoute(parsedRoute, (value) => this.plugins.resolveWorkspacePanelRouteId(value, selectedMachineId(this.state))).tool;
        this.setState({ workspaceTool: tool });
        return { ...baseFinishOptions, unavailableToolRoute: tool === undefined, requestedTool: tool };
      };
      // A newer surface may retire route finalization without retiring the
      // hierarchy load needed by that same workspace/session destination.
      if (this.isCurrentRouteRestore(restoreSeq, navigation)) {
        this.setState({
          ...(parsedRoute.tool === undefined ? { workspaceTool: undefined } : {}),
          mainView: restoredMainView ?? route.view ?? this.defaultRouteView(),
        });
      }
      if (route.projectId === undefined || route.projectId === "") {
        const error = this.state.error;
        this.workspaces.clearSelection({ updateUrl: false });
        if (error !== "") this.setState({ error });
        const finishOptions = await resolveToolRoute();
        if (finishOptions !== undefined) await this.finishWorkspaceRouteRestore(routeSurface, finishOptions);
        return;
      }
      if (this.routeMatchesCurrentSelection(route)) {
        const finishOptions = await resolveToolRoute();
        if (finishOptions !== undefined) await this.finishWorkspaceRouteRestore(routeSurface, finishOptions);
        return;
      }
      const project = this.state.projects.find((p) => p.id === route.projectId);
      if (!project) {
        // A requested project that cannot be resolved must not leave the prior
        // project/session rendered underneath the new URL. Preserve a legacy
        // load error across the workspace reset so remembered remote routes
        // can remain as an explicit recoverable destination.
        const error = this.state.error;
        this.workspaces.clearSelection({ updateUrl: false });
        if (error !== "") this.setState({ error });
        const projectId = route.projectId;
        const missingProject = () => routeFeedback.t("projectNotFound", { id: projectId });
        this.setContentError(parsedRoute, this.projects.loadErrors.get(selectedMachineId(this.state)) ?? missingProject);
        const scope = machineBrowserErrorScope(selectedMachineId(this.state));
        if (this.state.browserErrors[browserErrorScopeKey(scope)] === undefined) {
          this.browserErrors.reportLocalized(scope, missingProject);
        }
        return;
      }
      const loadedWorkspace = urlPublication === "deferred"
        && this.state.selectedProject?.id === project.id
        && route.workspaceId !== undefined
        ? this.state.workspaces.find((workspace) => workspace.projectId === project.id && workspace.id === route.workspaceId)
        : undefined;
      const loadedSession = loadedWorkspace !== undefined
        && this.state.selectedWorkspace?.projectId === loadedWorkspace.projectId
        && this.state.selectedWorkspace.id === loadedWorkspace.id
        ? this.sessions.preferredSession(loadedWorkspace.path, this.state.sessions, route.sessionId)
        : undefined;
      // In-app navigation published this known destination before reconciliation.
      // Re-enter at the deepest loaded parent instead of blanking and relisting its
      // unchanged ancestors. Current-URL restores still validate through their
      // normal workspace and session listing requests.
      let loadError: WorkspaceSelectionError | undefined;
      if (loadedSession !== undefined) {
        await this.sessions.selectSession(loadedSession, { deferChatLoading: route.sessionId === undefined, updateUrl: false, navigation: selectionNavigation });
      } else if (loadedWorkspace !== undefined) {
        loadError = await this.workspaces.selectWorkspace(loadedWorkspace, { sessionId: route.sessionId, updateUrl: false, navigation: selectionNavigation });
      } else {
        loadError = await this.workspaces.selectProject(project, { workspaceId: route.workspaceId, sessionId: route.sessionId, updateUrl: false, navigation: selectionNavigation });
      }
      if (selectionNavigation.isCurrent()) this.setContentError(parsedRoute, loadError ?? "");
      if (!this.isCurrentRouteRestore(restoreSeq, navigation)) return;
      const finishOptions = await resolveToolRoute();
      if (finishOptions !== undefined) await this.finishWorkspaceRouteRestore(routeSurface, finishOptions);
    } finally {
      this.routeRestoreDepth = Math.max(0, this.routeRestoreDepth - 1);
      if (selectedMachineId(this.state) !== machineBeforeRestore) this.schedulePiWebStatusRefresh();
    }
  }

  private async finishWorkspaceRouteRestore(
    surface: WorkspaceRouteSurface,
    options: WorkspaceRouteFinishOptions,
  ): Promise<void> {
    if (options.restoreSeq !== undefined && !this.isCurrentRouteRestore(options.restoreSeq, options.navigation)) return;
    const panels = this.visibleWorkspacePanels();
    const requestedToolUnavailable = options.requestedTool !== undefined
      && this.availableWorkspacePanelId(options.requestedTool, panels) === undefined;
    const requestedWorkspaceUnavailable = options.requestedRoute?.workspaceId !== undefined
      && (this.state.selectedProject?.id !== options.requestedRoute.projectId
        || this.state.selectedWorkspace?.id !== options.requestedRoute.workspaceId);
    const requestedSessionUnavailable = options.requestedRoute?.sessionId !== undefined
      && this.state.selectedSession?.id !== options.requestedRoute.sessionId;
    const unavailablePanel = options.unavailableToolRoute || options.unavailablePanelViewRoute
      || requestedToolUnavailable;
    // Invalid destinations belong to panel content, not the notification history.
    const panelLoadError = this.pluginLoadErrors.get(selectedMachineId(this.state));
    if (unavailablePanel && panelLoadError !== undefined) {
      const workspace = this.state.selectedWorkspace;
      const scope = workspace === undefined
        ? machineBrowserErrorScope(selectedMachineId(this.state))
        : workspaceBrowserErrorScope(selectedMachineId(this.state), workspace.projectId, workspace.id);
      if (this.state.browserErrors[browserErrorScopeKey(scope)] === undefined) {
        this.browserErrors.report(scope, panelLoadError);
      }
    }
    this.reconcileWorkspacePanelSelection();
    if (options.unavailablePanelViewRoute) this.setState({ mainView: this.effectiveMainView() });
    const contributionQueryRestore = options.restoredWorkspaceIdentity === undefined
      ? undefined
      : { identity: options.restoredWorkspaceIdentity, query: surface.contributionQuery ?? {} };
    await this.refreshRestoredWorkspaceTool(this.state.workspaceTool, contributionQueryRestore);
    if (options.restoreSeq !== undefined && !this.isCurrentRouteRestore(options.restoreSeq, options.navigation)) return;
    if (options.urlPublication === "current-url"
      && options.updateUrl && !unavailablePanel && !requestedWorkspaceUnavailable && !requestedSessionUnavailable
      && (options.requestedRoute === undefined
        || (this.routeLocationMatchesUrl(options.requestedRoute)
          && (options.requestedRoute.workspaceId === undefined || this.navigationSurfaceMatchesUrl(surface))))) {
      const contributionQuery = this.restoredContributionQueryForSelectedWorkspace(surface, options.restoredWorkspaceIdentity);
      this.updateUrl(undefined, contributionQuery);
    }
  }

  private restoredContributionQueryForSelectedWorkspace(
    surface: WorkspaceRouteSurface,
    restoredWorkspaceIdentity: WorkspaceRouteIdentity | undefined,
  ): Readonly<ContributionQueryRecord> {
    const selectedIdentity = this.selectedWorkspaceRouteIdentity();
    return restoredWorkspaceIdentity !== undefined
      && selectedIdentity !== undefined
      && sameWorkspaceRouteIdentity(restoredWorkspaceIdentity, selectedIdentity)
      ? surface.contributionQuery ?? {}
      : {};
  }

  private isCurrentRouteRestore(restoreSeq: number, navigation?: NavigationFreshness): boolean {
    return restoreSeq === this.routeRestoreSeq && (navigation === undefined || navigation.isCurrent());
  }

  /**
   * Capture the coordinator-owned generation for only the route fields an
   * asynchronous operation can apply. A surface-only URL change therefore
   * does not retire a background selection operation, while a route restore
   * that owns both selection and view state is retired by either change.
   */
  private beginNavigationOperation(scope: readonly NavigationScope[]): NavigationFreshness {
    this.syncNavigationFreshness();
    const operation: NavigationFreshness = {
      generation: this.navigationGeneration,
      scope: Object.freeze([...scope]),
      isCurrent: () => this.isNavigationFresh(operation),
    };
    return operation;
  }

  private isNavigationFresh(operation: NavigationFreshness): boolean {
    this.syncNavigationFreshness();
    return operation.scope.every((field) => this.navigationFieldGenerations[field] <= operation.generation);
  }

  private syncNavigationFreshness(): void {
    const route = readRoute();
    const previous = this.observedNavigationRoute;
    if (previous !== undefined) {
      const changedFields = NAVIGATION_SCOPES.filter((field) => navigationRouteValue(previous, field) !== navigationRouteValue(route, field));
      if (changedFields.length > 0) {
        const generation = ++this.navigationGeneration;
        for (const field of changedFields) this.navigationFieldGenerations[field] = generation;
      }
    }
    this.observedNavigationRoute = route;
  }

  private retireNavigationScope(scope: readonly NavigationScope[]): void {
    this.syncNavigationFreshness();
    if (scope.length === 0) return;
    const generation = ++this.navigationGeneration;
    for (const field of scope) this.navigationFieldGenerations[field] = generation;
    // Even same-route navigation retires callbacks held by visible panels.
    this.invalidateWorkspaceSurface();
  }

  private retireRouteRestoreForSynchronousNavigation(): void {
    this.retireNavigationScope(WORKSPACE_SURFACE_SCOPE);
    this.routeRestoreSeq += 1;
  }

  private readWorkspaceRouteSurface(route: ParsedAppRoute): WorkspaceRouteSurface {
    if (route.projectId === undefined || route.projectId === "") return emptyWorkspaceRouteSurface();
    return {
      contributionQuery: readContributionQueryRecord(),
    };
  }

  private shouldDeferRemoteRouteRestore(route: ParsedAppRoute, routeMachineHealth = this.state.machineStatuses[route.machineId ?? "local"]): boolean {
    const machineId = route.machineId ?? "local";
    const machine = this.state.selectedMachine;
    if (machineId === "local" || machine?.id !== machineId || machine.kind !== "remote") return false;
    if (routeMachineHealth?.ok !== false) return false;
    if (route.projectId === undefined || route.projectId === "") return this.state.projects.length === 0;
    return this.state.selectedProject?.id !== route.projectId;
  }

  private deferRemoteRouteRestore(route: ParsedAppRoute): void {
    this.pendingRemoteRouteRestore = route;
    this.remoteRouteRestoreAttempt = 0;
    this.setRemoteRouteRestoreMessage(route);
    this.schedulePendingRemoteRouteRestore();
  }

  private retryPendingRemoteRouteRestoreSoon(): void {
    if (this.pendingRemoteRouteRestore === undefined) return;
    this.schedulePendingRemoteRouteRestore(0);
  }

  private schedulePendingRemoteRouteRestore(delayMs = remoteRouteRestoreRetryDelay(this.remoteRouteRestoreAttempt)): void {
    if (this.pendingRemoteRouteRestore === undefined) return;
    this.clearPendingRemoteRouteRestoreTimer();
    this.remoteRouteRestoreTimer = window.setTimeout(() => {
      this.remoteRouteRestoreTimer = undefined;
      void this.retryPendingRemoteRouteRestore();
    }, delayMs);
  }

  private async retryPendingRemoteRouteRestore(): Promise<void> {
    if (this.remoteRouteRestoreInProgress) return;
    const route = this.pendingRemoteRouteRestore;
    if (route === undefined) return;
    if (!this.pendingRemoteRouteRestoreStillCurrent(route)) {
      this.clearPendingRemoteRouteRestore();
      return;
    }

    this.remoteRouteRestoreInProgress = true;
    try {
      const machineId = route.machineId ?? "local";
      const scope = machineBrowserErrorScope(machineId);
      const errorBeforeRetry = this.state.browserErrors[browserErrorScopeKey(scope)];
      const hasNewMachineError = () => this.state.browserErrors[browserErrorScopeKey(scope)] !== errorBeforeRetry;
      const health = await this.machines.refreshMachineHealth(machineId);
      if (!this.pendingRemoteRouteRestoreStillCurrent(route)) return;
      if (health?.ok !== true) {
        this.scheduleNextRemoteRouteRestoreAttempt(route);
        return;
      }

      await this.machines.refreshMachineRuntime(machineId);
      if (!this.pendingRemoteRouteRestoreStillCurrent(route)) return;
      if (hasNewMachineError()) {
        this.scheduleNextRemoteRouteRestoreAttempt(route);
        return;
      }
      await this.projects.loadProjects();
      if (!this.pendingRemoteRouteRestoreStillCurrent(route)) return;
      if (hasNewMachineError()) {
        this.scheduleNextRemoteRouteRestoreAttempt(route);
        return;
      }

      await this.withChatScrollTransition(() => this.restoreRouteFor(route, false));
      if (!this.pendingRemoteRouteRestoreStillCurrent(route)) return;
      this.clearPendingRemoteRouteRestore();
      this.rememberCurrentMachineNavigation();
      await this.refreshWorkspaceDeletionRuns();
    } finally {
      this.remoteRouteRestoreInProgress = false;
    }
  }

  private scheduleNextRemoteRouteRestoreAttempt(route: ParsedAppRoute): void {
    this.remoteRouteRestoreAttempt += 1;
    if (this.remoteRouteRestoreAttempt >= REMOTE_ROUTE_RESTORE_RETRY_DELAYS_MS.length) {
      this.setRemoteRouteRestoreMessage(route, { exhausted: true });
      this.clearPendingRemoteRouteRestore();
      return;
    }
    this.setRemoteRouteRestoreMessage(route);
    this.schedulePendingRemoteRouteRestore();
  }

  // Track provenance by retained banner identity, never by matching translated text.
  private readonly remoteRouteRestoreDetails = new WeakMap<BrowserError, { detail: string | undefined }>();

  private setRemoteRouteRestoreMessage(route: ParsedAppRoute, options: { exhausted?: boolean } = {}): void {
    const machineId = route.machineId ?? "local";
    const machineName = this.state.machines.find((machine) => machine.id === machineId)?.name ?? this.state.selectedMachine?.name;
    const scope = machineBrowserErrorScope(machineId);
    const key = browserErrorScopeKey(scope);
    const existing = this.state.browserErrors[key];
    const previous = existing === undefined ? undefined : this.remoteRouteRestoreDetails.get(existing);
    const detail = this.state.machineStatuses[machineId]?.error ?? (previous === undefined ? existing?.message : previous.detail);
    const messageKey = options.exhausted === true ? "exhausted" : "reconnecting";
    this.browserErrors.reportLocalized(scope, () => routeFeedback.t(messageKey, {
      machine: machineName ?? routeFeedback.t("remoteMachine"),
      detail: detail ?? "",
      hasDetail: detail === undefined ? "no" : "yes",
    }));
    const reported = this.state.browserErrors[key];
    if (reported !== undefined) this.remoteRouteRestoreDetails.set(reported, { detail });
  }

  private pendingRemoteRouteRestoreStillCurrent(route: ParsedAppRoute): boolean {
    const machineId = route.machineId ?? "local";
    return machineId !== "local"
      && this.pendingRemoteRouteRestore === route
      && this.routeLocationMatchesUrl(route)
      && this.state.selectedMachine?.id === machineId
      && this.state.machines.some((machine) => machine.id === machineId);
  }

  private clearPendingRemoteRouteRestore(): void {
    this.clearPendingRemoteRouteRestoreTimer();
    this.pendingRemoteRouteRestore = undefined;
    this.remoteRouteRestoreAttempt = 0;
  }

  private clearPendingRemoteRouteRestoreTimer(): void {
    if (this.remoteRouteRestoreTimer === undefined) return;
    window.clearTimeout(this.remoteRouteRestoreTimer);
    this.remoteRouteRestoreTimer = undefined;
  }

  private async restoreRouteMachine(route: ParsedAppRoute, updateUrl: boolean): Promise<boolean> {
    const routeMachineId = route.machineId ?? "local";
    if (selectedMachineId(this.state) === routeMachineId) return true;
    const machine = this.state.machines.find((candidate) => candidate.id === routeMachineId);
    if (machine === undefined) return false;
    await this.machines.selectMachine(machine, { updateUrl });
    return this.state.selectedMachine?.id === routeMachineId;
  }

  private routeMatchesCurrentSelection(route: Pick<AppRoute, "machineId" | "projectId" | "workspaceId" | "sessionId">): boolean {
    const workspace = this.state.selectedWorkspace;
    if ((route.machineId ?? "local") !== selectedMachineId(this.state)
      || route.workspaceId === undefined || route.workspaceId === ""
      || this.state.selectedProject?.id !== route.projectId
      || workspace?.id !== route.workspaceId
      || !this.sessions.canReuseSelectedSession()) return false;
    // A URL can omit the session while its remembered/default conversation is
    // already joined. Surface navigation must not repeat that same join.
    return route.sessionId === undefined
      ? this.state.selectedSession?.id === this.sessions.preferredSession(workspace.path, this.state.sessions, undefined)?.id
      : this.state.selectedSession?.id === route.sessionId;
  }

  private async refreshRestoredWorkspaceTool(
    tool: QualifiedContributionId | undefined,
    contributionQueryRestore?: WorkspaceContributionQueryRestore,
  ): Promise<void> {
    if (tool !== undefined) await this.invalidateWorkspacePanels(tool, contributionQueryRestore);
  }

  private async withChatScrollTransition(action: () => Promise<void>, shouldComplete: () => boolean = () => true) {
    this.chatView?.saveScrollPosition();
    await action();
    if (!shouldComplete()) return;
    await this.updateComplete;
    if (!shouldComplete()) return;
    await this.chatView?.updateComplete;
    if (!shouldComplete()) return;
    await nextFrame();
    if (!shouldComplete()) return;
    this.chatView?.restoreScrollPosition();
    if (this.shouldAutoFocusPrompt()) this.promptEditor?.focusInput();
  }

  private shouldAutoFocusPrompt(): boolean {
    return !this.isRenderedModalOpen() && this.appShell.shouldAutoFocusPrompt();
  }

  private async withChatPrependTransition(action: () => Promise<void>) {
    await action();
    await this.updateComplete;
    await this.chatView?.updateComplete;
  }

  private defaultRouteView(): AppState["mainView"] {
    return this.appShell.defaultRouteView();
  }

  private updateUrl(
    options?: { replace?: boolean | undefined },
    contributionQuery: Readonly<ContributionQueryRecord> = this.currentContributionQueryForState(),
  ): void {
    this.commitMachineNavigationSnapshot(machineNavigationSnapshotFromState(this.state, contributionQuery), options);
  }

  /** Replace a completed async destination without pairing a new route with an old surface query. */
  private replaceNavigationUrl(
    contributionQuery: Readonly<ContributionQueryRecord> = this.currentContributionQueryForState(),
  ): void {
    this.replaceMachineNavigationSnapshot(machineNavigationSnapshotFromState(this.state, contributionQuery));
  }

  /**
   * The app shell is the sole owner of app navigation history writes. Callers
   * that already know the destination can publish a complete snapshot before
   * applying its corresponding UI state.
   */
  private commitMachineNavigationSnapshot(snapshot: MachineNavigationSnapshot, options?: { replace?: boolean | undefined }): void {
    this.syncNavigationFreshness();
    this.machineNavigation.remember(snapshot);
    writeRoute(routeFromMachineNavigationSnapshot(snapshot), { ...options, contributionQuery: snapshot.surface.contributionQuery ?? {} });
    this.syncNavigationFreshness();
  }

  private rememberCurrentMachineNavigation(): void {
    this.machineNavigation.remember(machineNavigationSnapshotFromState(this.state, this.currentContributionQueryForState()));
  }

  private currentContributionQueryForState(): ContributionQueryRecord {
    const identity = this.selectedWorkspaceRouteIdentity();
    if (identity === undefined || !routeMatchesWorkspaceIdentity(readRoute(), identity)) return {};
    return readContributionQueryRecord();
  }

  private selectedWorkspaceRouteIdentity(
    workspace = this.state.selectedWorkspace,
    machine: PluginMachine = pluginMachineFromState(this.state),
  ): WorkspaceRouteIdentity | undefined {
    if (workspace === undefined) return undefined;
    return { machineId: machine.id, projectId: workspace.projectId, workspaceId: workspace.id };
  }

  private replaceMachineNavigationSnapshot(snapshot: MachineNavigationSnapshot): void {
    this.syncNavigationFreshness();
    this.machineNavigation.remember(snapshot);
    const route = routeFromMachineNavigationSnapshot(snapshot);
    const routeMatches = this.navigationRouteMatchesUrl(route);
    if (!this.navigationSurfaceMatchesUrl(snapshot.surface)) this.writeWorkspaceRouteSurfaceToUrl(snapshot.surface);
    if (!routeMatches) writeRoute(route, { replace: true });
    this.syncNavigationFreshness();
  }

  private navigationRouteMatchesUrl(route: AppRoute): boolean {
    const current = readRoute();
    return (current.machineId ?? "local") === (route.machineId ?? "local")
      && current.projectId === route.projectId
      && current.workspaceId === route.workspaceId
      && current.sessionId === route.sessionId
      && current.tool === route.tool
      && current.view === route.view;
  }

  private navigationSelectionMatchesUrl(expected: NavigationSelection, selectionOnly = false): boolean {
    const current = readRoute();
    return (current.machineId ?? "local") === expected.machineId
      && current.projectId === expected.projectId
      && current.workspaceId === expected.workspaceId
      && current.sessionId === expected.sessionId
      && (selectionOnly || (current.tool === expected.tool && current.view === expected.view));
  }

  private routeSelectionMatchesUrl(route: Pick<ParsedAppRoute, "machineId" | "projectId" | "workspaceId" | "sessionId">): boolean {
    const current = readRoute();
    return (current.machineId ?? "local") === (route.machineId ?? "local")
      && current.projectId === route.projectId
      && current.workspaceId === route.workspaceId
      && current.sessionId === route.sessionId;
  }

  private routeLocationMatchesUrl(route: Pick<ParsedAppRoute, "machineId" | "projectId" | "workspaceId" | "sessionId" | "tool" | "view">): boolean {
    const current = readRoute();
    return this.routeSelectionMatchesUrl(route)
      && current.tool === route.tool
      && current.view === route.view;
  }

  private navigationUrlContextMatchesUrl(expected: NavigationUrlContext): boolean {
    return (expected.navigation === undefined || expected.navigation.isCurrent())
      && currentBrowserUrl() === expected.url;
  }

  private navigationSurfaceMatchesUrl(surface: WorkspaceRouteSurface): boolean {
    return sameContributionQueryRecord(readContributionQueryRecord(), surface.contributionQuery ?? {});
  }

  private writeWorkspaceRouteSurfaceToUrl(surface: WorkspaceRouteSurface): void {
    writeContributionQueryRecord(surface.contributionQuery ?? {}, { replace: true });
  }

  private async selectMachineWithMemory(
    machine: Machine,
    options: NavigationDestinationOptions & { rememberCurrent?: boolean } = {},
  ): Promise<boolean> {
    if (this.state.selectedMachine?.id === machine.id) return true;
    if (options.rememberCurrent !== false && !this.routeRestoreInProgress) this.rememberCurrentMachineNavigation();
    const seq = ++this.machineNavigationRestoreSeq;
    const snapshot = this.machineNavigation.latest(machine.id) ?? emptyMachineNavigationSnapshot(machine.id);
    if (!await this.commitAndRestoreNavigation(snapshot, options)) return false;
    if (seq !== this.machineNavigationRestoreSeq || this.state.selectedMachine?.id !== machine.id) return false;
    if (this.shouldPreserveUnrestoredMachineNavigation(snapshot)) {
      this.replaceMachineNavigationSnapshot(snapshot);
      return true;
    }
    this.replaceNavigationUrl(this.currentContributionQueryForState());
    return true;
  }

  private async navigateToMachineFromController(machine: Machine, options: NavigationDestinationOptions = {}): Promise<boolean> {
    return this.selectMachineWithMemory(machine, options);
  }

  private selectProjectFromNavigation(project: Project): Promise<boolean> {
    return this.navigateToProjectFromController(project);
  }

  private async navigateToProjectFromController(project: Project | undefined, options: NavigationDestinationOptions = {}): Promise<boolean> {
    const current = machineNavigationSnapshotFromState(this.state, this.currentContributionQueryForState());
    const destination: MachineNavigationSnapshot = project === undefined
      ? { ...current, projectId: undefined, workspaceId: undefined, sessionId: undefined, surface: {} }
      : { ...current, projectId: project.id, workspaceId: undefined, sessionId: undefined, surface: {} };
    if (!await this.commitAndRestoreNavigation(destination, options)) return false;
    this.replaceNavigationUrl();
    return true;
  }

  private selectWorkspaceFromNavigation(workspace: Workspace): Promise<boolean> {
    return this.navigateToWorkspaceFromController(workspace);
  }

  private async navigateToWorkspaceFromController(workspace: Workspace | undefined, options: NavigationDestinationOptions = {}): Promise<boolean> {
    const current = machineNavigationSnapshotFromState(this.state, this.currentContributionQueryForState());
    const destination: MachineNavigationSnapshot = workspace === undefined
      ? { ...current, projectId: undefined, workspaceId: undefined, sessionId: undefined, surface: {} }
      : { ...current, projectId: workspace.projectId, workspaceId: workspace.id, sessionId: undefined, surface: {} };
    if (!await this.commitAndRestoreNavigation(destination, options)) return false;
    this.replaceNavigationUrl();
    return true;
  }

  private selectSessionFromNavigation(session: SessionInfo): Promise<boolean> {
    return this.navigateToSessionFromController(session);
  }

  private async navigateToSessionFromController(session: SessionInfo | undefined, options: NavigationDestinationOptions = {}): Promise<boolean> {
    const current = machineNavigationSnapshotFromState(this.state, this.currentContributionQueryForState());
    const workspace = this.state.selectedWorkspace;
    const destination: MachineNavigationSnapshot = {
      ...current,
      ...(session !== undefined && workspace !== undefined ? { projectId: workspace.projectId, workspaceId: workspace.id } : {}),
      sessionId: session?.id,
    };
    if (!await this.commitAndRestoreNavigation(destination, options)) return false;
    this.replaceNavigationUrl();
    return true;
  }

  private shouldPreserveUnrestoredMachineNavigation(snapshot: MachineNavigationSnapshot): boolean {
    const machineError = this.state.browserErrors[browserErrorScopeKey(machineBrowserErrorScope(selectedMachineId(this.state)))];
    return snapshot.projectId !== undefined
      && this.state.selectedProject?.id !== snapshot.projectId
      && (this.state.error !== "" || machineError !== undefined);
  }

  private openWorkspaceTool(tool: QualifiedContributionId, options: { invalidateNavigationSelection?: boolean | undefined } = {}): void {
    const machineId = selectedMachineId(this.state);
    const workspace = this.state.selectedWorkspace;
    if (workspace !== undefined && this.terminalAvailableForMachine(machineId) && tool === this.requiredTerminalPanelId(machineId)) {
      this.workspaceTerminal("core", workspace, machineId).open();
      return;
    }
    this.publishWorkspaceTool(tool, this.currentContributionQueryForState(), options);
  }

  private publishWorkspaceTool(
    tool: QualifiedContributionId,
    contributionQuery: Readonly<ContributionQueryRecord> = this.currentContributionQueryForState(),
    options: { invalidateNavigationSelection?: boolean | undefined } = {},
  ): void {
    const availableTool = this.availableWorkspacePanelId(tool);
    if (availableTool === undefined) return;
    const selectionChanged = this.state.workspaceTool !== availableTool || this.state.mainView !== "workspace";
    if (selectionChanged && options.invalidateNavigationSelection !== false) this.invalidateNavigationSelection();
    const currentSnapshot = machineNavigationSnapshotFromState(this.state, contributionQuery);
    this.commitMachineNavigationSnapshot({
      ...currentSnapshot,
      tool: availableTool,
      view: "workspace",
      surface: { contributionQuery },
    });
    if (selectionChanged) this.retireRouteRestoreForSynchronousNavigation();
    else this.routeRestoreSeq += 1;
    if (selectionChanged) this.setState({ workspaceTool: availableTool, mainView: "workspace" });
    else this.requestUpdate();
    this.refreshSelectedWorkspaceTool(availableTool);
  }

  private openTerminal(options?: { terminalId?: string | undefined }): void {
    const machineId = selectedMachineId(this.state);
    const workspace = this.state.selectedWorkspace;
    if (workspace === undefined) {
      const terminal = this.maintenanceTerminal("core", machineId, this.beginNavigationOperation(WORKSPACE_SURFACE_SCOPE));
      if (terminal === undefined) this.browserErrors.reportLocalized(machineBrowserErrorScope(machineId), () => requiredTerminalUnavailableError(machineId).message);
      else terminal.open(options);
      return;
    }
    this.workspaceTerminal("core", workspace, machineId).open(options);
  }

  private workspacePanelSourceQueryIds(contributionId: QualifiedContributionId): readonly QualifiedContributionId[] {
    const sourceContributionId = [...this.plugins.getWorkspacePanels(), ...this.plugins.getApplicationPanels()]
      .find((panel) => panel.id === contributionId)?.sourceContributionId;
    return sourceContributionId === undefined || sourceContributionId === contributionId ? [] : [sourceContributionId];
  }

  private async navigateRuntimeWorkspaceContribution(
    machineId: string,
    workspace: Workspace,
    navigation: WorkspaceContributionNavigationV1,
    expected: NavigationUrlContext,
  ): Promise<void> {
    if (!this.navigationUrlContextMatchesUrl(expected)) return;
    const sourceQueryIds = this.workspacePanelSourceQueryIds(navigation.contributionId);
    const currentIdentity = this.selectedWorkspaceRouteIdentity();
    const targetIdentity: WorkspaceRouteIdentity = { machineId, projectId: workspace.projectId, workspaceId: workspace.id };
    const contributionQuery = patchContributionQueryRecord(
      currentIdentity !== undefined && sameWorkspaceRouteIdentity(currentIdentity, targetIdentity)
        ? this.currentContributionQueryForState()
        : {},
      navigation.contributionId,
      sourceQueryIds,
      navigation.query,
    );
    const destination: MachineNavigationSnapshot = {
      machineId,
      projectId: workspace.projectId,
      workspaceId: workspace.id,
      sessionId: undefined,
      tool: navigation.contributionId,
      view: "workspace",
      surface: { contributionQuery },
    };

    if (selectedMachineId(this.state) !== machineId
      || this.state.selectedWorkspace?.id !== workspace.id
      || this.state.selectedProject?.id !== workspace.projectId) {
      if (!this.routeRestoreInProgress) this.rememberCurrentMachineNavigation();
      if (!await this.commitAndRestoreNavigation(destination)) return;
      this.replaceNavigationUrl();
      return;
    }

    this.publishWorkspaceTool(navigation.contributionId, contributionQuery);
  }

  private workspaceTerminal(
    origin: string,
    workspace: Workspace,
    machineId: string,
    navigation?: NavigationFreshness,
  ): WorkspacePanelTerminal {
    const composition = this.requiredTerminalByMachine.get(machineId);
    const peer = composition === undefined ? undefined : createPluginPeer(composition.binding, workspace, machineId);
    if (composition === undefined || peer === undefined) {
      const error = requiredTerminalUnavailableError(machineId);
      return Object.freeze({
        open: () => { this.browserErrors.reportLocalized(machineBrowserErrorScope(machineId), () => error.message); },
        runCommand: () => Promise.reject(error),
      });
    }

    const contextIsCurrent = (surfaceSensitive: boolean): boolean => selectedMachineId(this.state) === machineId
      && (navigation === undefined
        || (this.state.selectedProject?.id === workspace.projectId
          && this.state.selectedWorkspace?.id === workspace.id
          && routeMatchesWorkspaceIdentity(readRoute(), { machineId, projectId: workspace.projectId, workspaceId: workspace.id })
          && (!surfaceSensitive || navigation.isCurrent())));
    const createTerminal = (expected: NavigationUrlContext): WorkspacePanelTerminal => composition.facade.createWorkspaceTerminal({
      origin,
      registrationPluginId: composition.binding.registrationPluginId,
      workspace,
      peer,
      host: {
        navigateWorkspaceContribution: (targetWorkspace, targetNavigation) =>
          this.navigateRuntimeWorkspaceContribution(machineId, targetWorkspace, targetNavigation, expected),
      },
    });

    return Object.freeze({
      open: (options?: { terminalId?: string | undefined }) => {
        if (!contextIsCurrent(true)) return;
        createTerminal(navigationUrlContext(navigation)).open(options);
      },
      runCommand: (input: WorkspaceTerminalCommandInput) => {
        if (!contextIsCurrent(input.open === true)) return Promise.reject(new Error("Workspace panel context is no longer current"));
        const expected = navigationUrlContext(input.open === true ? navigation : undefined);
        return createTerminal(expected).runCommand(input);
      },
    });
  }

  private maintenanceTerminal(origin: string, machineId: string, navigation: NavigationFreshness): MaintenanceTerminal | undefined {
    const composition = this.requiredTerminalByMachine.get(machineId);
    const createTerminal = composition?.facade.createMaintenanceTerminal?.bind(composition.facade);
    const peer = composition === undefined ? undefined : createPluginBackend(composition.binding, machineId)?.forScope({ kind: "machine" });
    if (composition === undefined || createTerminal === undefined || peer === undefined) return undefined;
    const isCurrent = (): boolean => selectedMachineId(this.state) === machineId && navigation.isCurrent();
    const terminal = createTerminal({
      origin,
      machineId,
      registrationPluginId: composition.binding.registrationPluginId,
      peer,
      host: {
        navigateApplicationContribution: (contributionId) => {
          if (!isCurrent()) return false;
          this.publishWorkspaceTool(contributionId);
          return true;
        },
      },
    });
    return Object.freeze({
      open: (options?: { terminalId?: string | undefined }) => { if (isCurrent()) terminal.open(options); },
      runCommand: async (input: WorkspaceTerminalCommandInput) => {
        if (!isCurrent()) throw new Error("Maintenance terminal context is no longer current");
        try {
          return await terminal.runCommand(input);
        } catch (error) {
          if (isCurrent()) this.setState({ error: error instanceof Error ? error.message : String(error) });
          throw error;
        }
      },
    });
  }

  private requiredTerminalComposition(machineId: string): RequiredTerminalBrowserComposition {
    const composition = this.requiredTerminalByMachine.get(machineId);
    if (composition === undefined) throw requiredTerminalUnavailableError(machineId);
    return composition;
  }

  private requiredTerminalPanelId(machineId: string): QualifiedContributionId {
    return `${this.requiredTerminalComposition(machineId).binding.registrationPluginId}:${TERMINAL_PANEL_LOCAL_ID}`;
  }

  private selectMainView(view: AppState["mainView"], options: { invalidateNavigationSelection?: boolean | undefined } = {}) {
    if (options.invalidateNavigationSelection !== false) this.invalidateNavigationSelection();
    const currentSnapshot = machineNavigationSnapshotFromState(this.state, this.currentContributionQueryForState());
    this.commitMachineNavigationSnapshot({ ...currentSnapshot, view });
    this.retireRouteRestoreForSynchronousNavigation();
    this.setState({ mainView: view });
  }

  private openSettings(section: SettingsSection = "general"): void {
    writeSettingsSection(section);
    this.settingsSection = section;
  }

  private closeSettings(): void {
    writeSettingsSection(undefined);
    this.settingsSection = undefined;
  }

  private navigateSettings(section: SettingsSection): void {
    writeSettingsSection(section);
    this.settingsSection = section;
  }

  private restoreSettingsRoute(): void {
    this.settingsSection = readSettingsSection();
  }

  private handleWorkspaceChange(previous: AppState, next: AppState) {
    if (selectedMachineId(previous) === selectedMachineId(next)
      && previous.selectedProject?.id === next.selectedProject?.id
      && previous.selectedWorkspace?.id === next.selectedWorkspace?.id) return;
    const gatewayPluginsLoading = this.gatewayPluginLoadPromise !== undefined && !this.gatewayPluginLoadAttemptComplete;
    if ((!this.routeRestoreInProgress || next.selectedWorkspace !== undefined) && !gatewayPluginsLoading) this.reconcileWorkspacePanelSelection();
    if (!this.routeRestoreInProgress) this.rememberCurrentMachineNavigation();
    if (next.selectedWorkspace === undefined) return;
    void this.refreshWorkspaceDeletionRuns();
    this.refreshSelectedWorkspaceTool(this.state.workspaceTool);
  }

  private syncSessionUnreadMachines(): void {
    if (!this.unreadConnected) {
      this.sessionUnread.retainMachines(new Set<string>());
      return;
    }
    const machineIds = new Set(this.state.machines.map((machine) => machine.id));
    machineIds.add(selectedMachineId(this.state));
    this.sessionUnread.retainMachines(machineIds);
    for (const machineId of machineIds) {
      // Socket events keep a loaded projection current; only the initial join
      // (or a machine whose snapshot never landed) needs an HTTP snapshot.
      if (this.sessionUnread.projection(machineId) === undefined) void this.sessionUnread.refresh(machineId);
    }
  }

  private connectRealtime(): void {
    const machineId = selectedMachineId(this.state);
    this.realtime.connect(
      (event) => { this.handleRealtimeEvent(machineId, event); },
      () => {
        // Live broadcasts are not replayed after a connection gap.
        void this.sessions.refreshCurrentWorkspaceSessions(machineId, { recoverNetwork: true });
        if (selectedMachineId(this.state) === machineId) void this.workspaces.refreshSelectedProjectTopology();
        void this.sessionUnread.refresh(machineId);
        void this.serverNotices.refresh(machineId);
        void this.navigationOrder.refreshSessionPins(machineId).catch(() => undefined);
      },
      machineId,
    );
  }

  private syncMachineActivitySubscriptions(): void {
    const desiredMachineIds = this.machineActivitySubscriptionIds();
    for (const [machineId, socket] of this.machineRealtimeSockets.entries()) {
      if (desiredMachineIds.has(machineId)) continue;
      socket.close();
      this.machineRealtimeSockets.delete(machineId);
    }
    for (const machineId of desiredMachineIds) {
      if (this.machineRealtimeSockets.has(machineId)) continue;
      const socket = new RealtimeSocket();
      socket.connect(
        (event) => { this.handleMachineActivityEvent(machineId, event); },
        () => {
          void this.sessionUnread.refresh(machineId);
          void this.navigationOrder.refreshSessionPins(machineId).catch(() => undefined);
        },
        machineId,
      );
      this.machineRealtimeSockets.set(machineId, socket);
    }
  }

  private closeMachineActivitySockets(): void {
    for (const socket of this.machineRealtimeSockets.values()) socket.close();
    this.machineRealtimeSockets.clear();
  }

  private machineActivitySubscriptionIds(): Set<string> {
    const selected = selectedMachineId(this.state);
    return new Set(this.state.machines
      .filter((machine) => machine.id !== selected)
      .filter((machine) => shouldSubscribeToMachineActivity(machine, this.state.machineStatuses[machine.id]))
      .map((machine) => machine.id));
  }

  private handleMachineActivityEvent(machineId: string, event: BrowserRealtimeEvent): void {
    if (event.type === "session-pins.changed") {
      void this.navigationOrder.load({ kind: "sessionPins", machineId, projectId: event.projectId, workspaceId: event.workspaceId }).catch(() => undefined);
    } else if (event.type === "sessions.unread") this.sessionUnread.applyEvent(machineId, event);
    else if (event.type === "machine.status") this.machineStatus.apply(machineId, event.status);
  }

  private handleRealtimeEvent(machineId: string, event: BrowserRealtimeEvent): void {
    if (event.type === "session-pins.changed") this.handleMachineActivityEvent(machineId, event);
    else if (event.type === "sessions.unread") this.sessionUnread.applyEvent(machineId, event);
    else if (event.type === "notices.updated") this.serverNotices.applyEvent(machineId, event);
    else if (event.type === "machine.status") this.machineStatus.apply(machineId, event.status);
    else if (event.type === "workspaces.changed") {
      if (selectedMachineId(this.state) === machineId && this.state.selectedProject?.id === event.projectId) {
        void this.workspaces.refreshSelectedProjectTopology();
        void this.sessions.refreshCurrentWorkspaceSessions(machineId, { recoverNetwork: true });
      }
    } else {
      if (event.type === "status.update" || event.type === "activity.update") {
        const idleSessionId = this.sessionWorkTransitions.observe(machineId, event);
        if (idleSessionId !== undefined) this.invalidateFilesForSessionActivity(machineId, idleSessionId);
      }
      this.sessions.applyGlobalEvent(event);
    }
  }

  private invalidateFilesForSessionActivity(machineId: string, sessionId: string): void {
    const state = this.state;
    const workspace = state.selectedWorkspace;
    if (machineId !== selectedMachineId(state) || workspace === undefined
      || !state.sessions.some((session) => session.id === sessionId)) return;
    const reportFailure = (error: unknown) => { console.warn("Workspace file refresh after session activity failed", error); };
    try {
      // Capture the resource context while this workspace still owns the event.
      // Refresh failures belong to this resource, never to a transcript reader.
      void this.invalidateWorkspaceResources(workspace, pluginMachineFromState(state), {
        reason: "agent-activity",
        resources: ["workspace.files"],
      }).catch(reportFailure);
    } catch (error) {
      reportFailure(error);
    }
  }

  private handleMachineChange(previous: AppState, next: AppState): void {
    if ((previous.selectedMachine?.id ?? "local") === (next.selectedMachine?.id ?? "local")) return;
    const pendingMachineId = this.pendingRemoteRouteRestore?.machineId ?? "local";
    if (pendingMachineId !== (next.selectedMachine?.id ?? "local")) this.clearPendingRemoteRouteRestore();
    this.sessions.clearActiveSession();
    this.realtime.close();
    this.connectRealtime();
    this.closeSessionCleanupDialog();
    this.setState({ piWebStatus: undefined });
    void this.loadPluginsForSelectedMachine();
  }

  private refreshSelectedWorkspaceTool(tool: QualifiedContributionId | undefined): void {
    if (tool !== undefined) void this.invalidateWorkspacePanels(tool);
  }

  @state() private workspaceSurfaceRevision = 0;

  private invalidateWorkspaceSurface(): void {
    this.workspaceSurfaceRevision += 1;
  }

  private workspaceSurfaceInputs(): unknown[] {
    // Workspace plugins consume PluginRuntimeState, not the live transcript.
    // Keep that public state boundary explicit; plugin-owned data changes use
    // host.requestRender(), while route/config changes refresh capabilities.
    const state = this.state;
    return [
      state.selectedMachine, state.selectedWorkspace, state.selectedSession,
      // Core Notices observes conditions, not per-token status churn.
      JSON.stringify(sessionNotices(state)),
      state.workspaceTool, state.mainView, state.piWebStatus, this.appShell.isMobileNavigationLayout,
      state.selectedProject, state.projects, state.workspaces,
      state.isLoadingProjects, state.isLoadingWorkspaces, this.workspaceContentError(),
      this.workspaceUploadDefaultFolder, this.workspaceSurfaceRevision,
      this.navigationPreferences, this.appShell.isMobileNavigationLayout, this.isDesktopSideBySideLayout(),
      currentBrowserUrl(),
    ];
  }

  private renderWorkspacePanel() {
    const workspace = this.state.selectedWorkspace;
    const emptyState = workspace === undefined ? this.workspacePanelEmptyState() : undefined;
    const panels = this.visibleWorkspacePanels();
    return html`
      <workspace-panel
        id="workspace-panel"
        @session-notice-dismiss=${this.handleNoticeDismiss}
        .workspace=${workspace}
        .emptyState=${emptyState}
        .error=${this.workspaceContentError()}
        .tool=${this.effectiveWorkspaceTool(panels)}
        .panels=${panels}
        .pinnedIds=${this.navigationPreferences.pinnedIds}
        .hideToolTabs=${!this.isDesktopSideBySideLayout()}
        .onShowNavigation=${this.showNavigation}
        .onTogglePanel=${this.isDesktopSideBySideLayout() ? this.workspacePanelActions.toggle : undefined}
        .onSelectTool=${(tool: QualifiedContributionId) => { this.openWorkspaceTool(tool); }}
      ></workspace-panel>
    `;
  }

  private readonly navigationPanelActions = this.createPanelActions("navigation");
  private readonly workspacePanelActions = this.createPanelActions("workspace");

  private createPanelActions(side: ResizablePanelSide) {
    return {
      toggle: () => {
        const restoreFocus = deepActiveElement(this.ownerDocument)?.getAttribute("data-panel-toggle") === side;
        if (side === "navigation") this.panelCollapse.toggleNavigationPanel();
        else {
          this.panelCollapse.toggleWorkspacePanel();
          if (this.panelCollapse.workspacePanelCollapsed && this.effectiveMainView() === "workspace") this.selectMainView("chat");
        }
        if (restoreFocus) void this.focusPanelToggle(side);
      },
      resizeStart: () => this.startPanelResize(side),
      resize: (width: number) => { this.panelResize.resizePanel(side, width, { persist: false }); },
      resizeEnd: () => { this.panelResize.persistPanelSizes(); },
      reset: () => { this.resetResizablePanel(side); },
    };
  }

  private async focusPanelToggle(side: ResizablePanelSide): Promise<void> {
    await this.updateComplete;
    if (hasRenderedModal(this.ownerDocument)) return;
    const collapsed = side === "navigation" ? this.panelCollapse.navigationPanelCollapsed : this.panelCollapse.workspacePanelCollapsed;
    const selector = collapsed ? "app-mobile-main-tabs" : side === "navigation" ? "aside app-navigation-panel" : "workspace-panel";
    const host = this.renderRoot.querySelector(selector);
    if (!(host instanceof LitElement)) return;
    await host.updateComplete;
    const button = host.shadowRoot?.querySelector<HTMLButtonElement>(`[data-panel-toggle="${side}"]`);
    if (button !== undefined && button !== null) focusElement(button);
  }

  private renderNavigationPanelEdgeControl() {
    const constraints = this.resizablePanelConstraints("navigation");
    return html`
      <app-panel-edge-control
        side="navigation"
        controls="navigation-panel"
        .resizable=${!this.appShell.isMobileNavigationLayout}
        .panelWidth=${this.panelResize.panelWidth("navigation")}
        .minWidth=${constraints.minWidth}
        .maxWidth=${constraints.maxWidth}
        .onResizeStart=${this.navigationPanelActions.resizeStart}
        .onResize=${this.navigationPanelActions.resize}
        .onResizeEnd=${this.navigationPanelActions.resizeEnd}
        .onReset=${this.navigationPanelActions.reset}
      ></app-panel-edge-control>
    `;
  }

  private renderWorkspacePanelEdgeControl() {
    const constraints = this.resizablePanelConstraints("workspace");
    return html`
      <app-panel-edge-control
        side="workspace"
        controls="workspace-panel"
        .resizable=${!this.appShell.isMobileNavigationLayout}
        .panelWidth=${this.panelResize.panelWidth("workspace")}
        .minWidth=${constraints.minWidth}
        .maxWidth=${constraints.maxWidth}
        .onResizeStart=${this.workspacePanelActions.resizeStart}
        .onResize=${this.workspacePanelActions.resize}
        .onResizeEnd=${this.workspacePanelActions.resizeEnd}
        .onReset=${this.workspacePanelActions.reset}
      ></app-panel-edge-control>
    `;
  }

  private startPanelResize(side: ResizablePanelSide): number {
    if (side === "navigation") this.panelCollapse.expandNavigationPanel();
    else this.panelCollapse.expandWorkspacePanel();
    return this.measuredPanelWidth(side) ?? this.panelResize.panelWidth(side);
  }

  private resizablePanelConstraints(side: ResizablePanelSide): PanelResizeConstraints {
    const constraints = this.panelResize.constraints(side);
    return {
      ...constraints,
      maxWidth: this.resizablePanelMaxWidth(side, constraints),
    };
  }

  private resizablePanelMaxWidth(side: ResizablePanelSide, constraints: PanelResizeConstraints): number {
    const shellWidth = this.getBoundingClientRect().width || (typeof window === "undefined" ? 0 : window.innerWidth);
    if (shellWidth <= 0) return constraints.maxWidth;

    const otherPanelWidth = this.oppositeResizablePanelWidth(side);
    const maxWidth = Math.floor(shellWidth - otherPanelWidth - PANEL_EDGE_COLUMNS_WIDTH_PX - MIN_RESIZABLE_CHAT_WIDTH_PX);
    return Math.max(constraints.minWidth, Math.min(constraints.maxWidth, maxWidth));
  }

  private oppositeResizablePanelWidth(side: ResizablePanelSide): number {
    const otherSide: ResizablePanelSide = side === "navigation" ? "workspace" : "navigation";
    if (this.isResizablePanelCollapsedOrStacked(otherSide)) return 0;
    return this.measuredPanelWidth(otherSide) ?? this.panelResize.panelWidth(otherSide);
  }

  private isResizablePanelCollapsedOrStacked(side: ResizablePanelSide): boolean {
    if (side === "navigation") return this.panelCollapse.navigationPanelCollapsed;
    return this.panelCollapse.workspacePanelCollapsed || !this.isDesktopSideBySideLayout();
  }

  private isDesktopSideBySideLayout(): boolean {
    return this.appShell.isDesktopSideBySideLayout && !this.panelCollapse.workspacePanelCollapsed;
  }

  private measuredPanelWidth(side: ResizablePanelSide): number | undefined {
    const element = side === "navigation" ? this.navigationPanelFrame : this.workspacePanelFrame;
    const width = element?.getBoundingClientRect().width;
    return width === undefined || width <= 0 ? undefined : width;
  }

  private resetResizablePanel(side: ResizablePanelSide): void {
    this.panelResize.resetPanel(side);
  }

  private resetResizablePanels(): void {
    this.panelResize.resetPanels();
  }

  private selectedMachineRuntime() {
    return this.state.machineRuntimes[selectedMachineId(this.state)];
  }

  private openSessionCleanupDialog(): void {
    this.sessionCleanupRequestEpoch += 1;
    this.sessionCleanupDialog = { error: "" };
  }

  private closeSessionCleanupDialog(): void {
    this.sessionCleanupRequestEpoch += 1;
    this.sessionCleanupDialog = undefined;
  }

  private isCurrentSessionCleanupRequest(epoch: number, machineId: string): boolean {
    return this.sessionCleanupDialog !== undefined
      && this.sessionCleanupRequestEpoch === epoch
      && selectedMachineId(this.state) === machineId;
  }

  private async previewSessionCleanup(request: SessionCleanupRequest): Promise<void> {
    if (this.sessionCleanupDialog === undefined) return;
    const machineId = selectedMachineId(this.state);
    const epoch = ++this.sessionCleanupRequestEpoch;
    this.sessionCleanupDialog = { ...this.sessionCleanupDialog, loading: true, running: false, error: "", preview: undefined, previewRequest: undefined, result: undefined };
    try {
      const preview = await sessionsApi.cleanupPreview(request, machineId);
      if (!this.isCurrentSessionCleanupRequest(epoch, machineId)) return;
      this.sessionCleanupDialog = { ...this.sessionCleanupDialog, preview, previewRequest: request, result: undefined, loading: false, error: "" };
    } catch (error) {
      if (this.isCurrentSessionCleanupRequest(epoch, machineId)) this.sessionCleanupDialog = { ...this.sessionCleanupDialog, loading: false, error: () => sessionCleanupMessages.t("previewFailed", { error: errorMessage(error) }) };
    }
  }

  private async runSessionCleanup(request: SessionCleanupRequest): Promise<void> {
    const dialog = this.sessionCleanupDialog;
    if (dialog === undefined || dialog.running === true) return;
    if (dialog.preview === undefined || sessionCleanupRequestKey(dialog.previewRequest) !== sessionCleanupRequestKey(request)) {
      this.sessionCleanupDialog = { ...dialog, error: () => sessionCleanupMessages.t("previewRequired") };
      return;
    }
    const machineId = selectedMachineId(this.state);
    const epoch = ++this.sessionCleanupRequestEpoch;
    this.sessionCleanupDialog = { ...dialog, running: true, error: "" };
    try {
      const result = await sessionsApi.cleanup(request, machineId);
      if (selectedMachineId(this.state) !== machineId) return;
      if (this.isCurrentSessionCleanupRequest(epoch, machineId)) {
        this.sessionCleanupDialog = { ...this.sessionCleanupDialog, preview: undefined, previewRequest: undefined, result, running: false, error: "" };
      }
      // Closing or replacing the dialog must not skip reconciliation of completed work.
      await this.sessions.applySessionCleanupResult(result, machineId);
    } catch (error) {
      if (this.isCurrentSessionCleanupRequest(epoch, machineId)) this.sessionCleanupDialog = { ...this.sessionCleanupDialog, running: false, error: () => sessionCleanupMessages.t("runFailed", { error: errorMessage(error) }) };
    }
  }

  // Stable callback inputs let navigation children update for their own data,
  // rather than for every transcript delta rendered by the application shell.
  private readonly navigationActions = {
    toggleMachines: () => { this.cancelAutomaticProjectNavigation(); this.navigationSections.toggle("machines"); },
    selectMachine: (machine: Machine) => this.selectNavigationItem("machines", "projects", () => this.selectMachineWithMemory(machine)),
    removeMachine: (machine: Machine) => { void this.removeMachine(machine); },
    showActions: () => { this.setState({ actionPaletteOpen: true }); },
    toggleProjects: () => { this.cancelAutomaticProjectNavigation(); this.navigationSections.toggle("projects"); },
    toggleWorkspaces: () => { this.cancelAutomaticProjectNavigation(); this.navigationSections.toggle("workspaces"); },
    toggleSessions: () => { this.cancelAutomaticProjectNavigation(); this.navigationSections.toggle("sessions"); },
    selectProject: (project: Project) => this.selectNavigationItem("projects", "workspaces", () => this.selectProjectFromNavigation(project)),
    closeProject: (project: Project) => this.projects.closeProject(project.id),
    selectWorkspace: (workspace: Workspace) => this.selectNavigationItem("workspaces", "sessions", () => this.selectWorkspaceFromNavigation(workspace)),
    deleteWorkspace: (workspace: Workspace) => { void this.deleteWorkspace(workspace); },
    archivedCollapsed: () => { void this.sessions.clearSelectionAfterArchivedCollapse(); },
    startSession: () => this.startSessionFromNavigation(),
    selectSession: (session: SessionInfo) => this.selectNavigationItem("sessions", "chat", () => this.selectSessionFromNavigation(session)),
    markSessionRead: (session: SessionInfo) => { this.markSessionsRead([session]); },
    markSessionUnread: (session: SessionInfo) => { void this.markSessionUnread(session); },
    markSessionsRead: (sessions: SessionInfo[]) => { this.markSessionsRead(sessions); },
    archiveSession: (session: SessionInfo) => this.sessions.archiveSession(session),
    archiveSessionWithDescendants: (session: SessionInfo) => this.sessions.archiveSessionWithDescendants(session),
    archiveSessions: (sessions: SessionInfo[]) => this.sessions.archiveSessions(sessions),
    restoreSession: (session: SessionInfo) => this.selectNavigationItem("sessions", "chat", async () => {
      const restored = await this.sessions.restoreSession(session);
      return restored === undefined ? false : this.selectSessionFromNavigation(restored);
    }),
    deleteCachedNewSession: (session: SessionInfo) => this.sessions.deleteCachedNewSession(session),
    deleteArchivedSession: (session: SessionInfo) => this.sessions.deleteArchivedSessions([session]),
    deleteArchivedSessions: (sessions: SessionInfo[]) => this.sessions.deleteArchivedSessions(sessions),
    detachParentSession: (session: SessionInfo) => this.sessions.detachParent(session),
    reloadSession: (session: SessionInfo) => this.sessions.reloadSession(session),
    cleanupSessions: () => { this.openSessionCleanupDialog(); },
    focusNavigationTarget: (target: NavigationFocusTarget) => { this.cancelAutomaticProjectNavigation(); void this.focusNavigationTarget(target); },
    cancelKeyboardNavigation: () => { this.cancelAutomaticProjectNavigation(); void this.openChatAndFocusComposer(); },
    moveProject: (project: Project, direction: -1 | 1) => { this.moveNavigationItem({ kind: "projects", machineId: selectedMachineId(this.state) }, project.id, direction); },
    moveWorkspace: (workspace: Workspace, direction: -1 | 1) => { this.moveNavigationItem({ kind: "workspaces", machineId: selectedMachineId(this.state), projectId: workspace.projectId }, workspace.id, direction); },
    pinSession: (session: SessionInfo) => { this.changeSessionPin(session, "pin"); },
    unpinSession: (session: SessionInfo) => { this.changeSessionPin(session, "unpin"); },
    moveSessionPin: (session: SessionInfo, direction: -1 | 1) => { this.changeSessionPin(session, direction); },
  };

  private workspaceDeletionInput: AppState["workspaceDeletionRuns"] | undefined;
  private deletingWorkspaceIds: string[] = [];

  private navigationOrderScopes(): NavigationOrderScope[] {
    const machineId = selectedMachineId(this.state);
    const scopes: NavigationOrderScope[] = [{ kind: "projects", machineId }];
    const project = this.state.selectedProject;
    const workspace = this.state.selectedWorkspace;
    if (project) scopes.push({ kind: "workspaces", machineId, projectId: project.id });
    if (workspace) scopes.push({ kind: "sessionPins", machineId, projectId: workspace.projectId, workspaceId: workspace.id });
    return scopes;
  }

  private syncNavigationOrder(): void {
    for (const scope of this.navigationOrderScopes()) void this.navigationOrder.ensure(scope).catch(() => undefined);
  }

  private moveNavigationItem(scope: NavigationOrderScope, id: string, direction: -1 | 1): void {
    const items = scope.kind === "projects" ? this.state.projects : this.state.workspaces;
    const visibleIds = items.map((item) => item.id);
    void this.navigationOrder.mutate(scope, (ids) => {
      const displayed = orderItems(visibleIds.map((id) => ({ id })), ids).map((item) => item.id);
      const neighbor = displayed[displayed.indexOf(id) + direction];
      return neighbor === undefined ? ids : moveOrderedId(ids, displayed, id, neighbor, direction < 0 ? "before" : "after");
    }).catch(() => undefined);
  }

  private changeSessionPin(session: SessionInfo, action: "pin" | "unpin" | -1 | 1): void {
    const workspace = this.state.selectedWorkspace;
    if (!workspace || session.parentSessionPath !== undefined) return;
    const scope: NavigationOrderScope = { kind: "sessionPins", machineId: selectedMachineId(this.state), projectId: workspace.projectId, workspaceId: workspace.id };
    const rootIds = new Set(this.state.sessions.filter((item) => item.parentSessionPath === undefined && item.archived !== true).map((item) => item.id));
    void this.navigationOrder.mutate(scope, (ids) => {
      if (action === "unpin") return ids.filter((id) => id !== session.id);
      if (action === "pin") return rootIds.has(session.id) && !ids.includes(session.id) ? [...ids, session.id] : ids;
      const visible = ids.filter((id) => rootIds.has(id));
      const neighbor = visible[visible.indexOf(session.id) + action];
      return neighbor === undefined ? ids : moveOrderedId(ids, visible, session.id, neighbor, action < 0 ? "before" : "after");
    }).catch(() => undefined);
  }

  private renderNavigationPanel() {
    if (this.workspaceDeletionInput !== this.state.workspaceDeletionRuns) {
      this.workspaceDeletionInput = this.state.workspaceDeletionRuns;
      this.deletingWorkspaceIds = pendingWorkspaceDeletionIds(this.state.workspaceDeletionRuns);
    }
    const scopes = this.navigationOrderScopes();
    const projectScope = scopes.find((scope) => scope.kind === "projects");
    const workspaceScope = scopes.find((scope) => scope.kind === "workspaces");
    const sessionScope = scopes.find((scope) => scope.kind === "sessionPins");
    return html`
      <app-navigation-panel
        .machines=${this.state.machines}
        .selectedMachine=${this.state.selectedMachine}
        .machineStatuses=${this.state.machineStatuses}
        .machineStatusSnapshots=${this.state.machineStatusSnapshots}
        .machinesCollapsed=${this.navigationSections.isCollapsed("machines")}
        .onToggleMachines=${this.navigationActions.toggleMachines}
        .onSelectMachine=${this.navigationActions.selectMachine}
        .onEditMachine=${(machine: Machine) => { this.machineNameEditTarget = machine; this.setState({ machineDialogOpen: true, error: "" }); }}
        .onRemoveMachine=${this.navigationActions.removeMachine}
        .projects=${guard([this.state.projects, this.navigationOrderVersion, selectedMachineId(this.state)], () => orderItems(this.state.projects, projectScope ? this.navigationOrder.ids(projectScope) : []))}
        .selectedProject=${this.state.selectedProject}
        .workspaces=${guard([this.state.workspaces, this.navigationOrderVersion, selectedMachineId(this.state), this.state.selectedProject?.id], () => orderItems(this.state.workspaces, workspaceScope ? this.navigationOrder.ids(workspaceScope) : []))}
        .selectedWorkspace=${this.state.selectedWorkspace}
        .deletingWorkspaceIds=${this.deletingWorkspaceIds}
        .sessions=${this.state.sessions}
        .projectSelectionLoading=${this.pendingProjectNavigation?.seq === this.navigationSelectionSeq && this.state.isLoadingWorkspaces}
        .sessionsLoading=${this.pendingProjectNavigation?.seq === this.navigationSelectionSeq && this.state.selectedWorkspace !== undefined && this.state.sessions.length === 0}
        .pinnedRootIds=${guard([this.navigationOrderVersion, selectedMachineId(this.state), this.state.selectedWorkspace?.id], () => sessionScope ? [...this.navigationOrder.ids(sessionScope)] : [])}
        .sessionStatuses=${this.state.sessionStatuses}
        .sessionActivities=${this.state.sessionActivities}
        .sendingPrompts=${this.state.sendingPrompts}
        .unreadSessionIds=${this.unreadSessionIds}
        .selectedSession=${this.state.selectedSession}
        .startingSessionCount=${this.state.startingSessionCount}
        .canStartSession=${!!this.state.selectedWorkspace}
        .collapsible=${true}
        .compact=${this.appShell.isMobileNavigationLayout}
        .projectsCollapsed=${this.navigationSections.isCollapsed("projects")}
        .workspaceSelectionVisible=${shouldShowWorkspaceSelection(this.state.workspaceResolution)}
        .workspacesCollapsed=${this.navigationSections.isCollapsed("workspaces")}
        .sessionsCollapsed=${this.navigationSections.isCollapsed("sessions")}
        .workspaceLabelItems=${guard(this.workspaceSurfaceInputs(), () => (workspace: Workspace) => this.workspaceLabelItems(workspace))}
        .sessionLabelItems=${guard(this.workspaceSurfaceInputs(), () => (session: SessionInfo) => this.sessionLabelItems(session))}
        .refreshControl=${this.appShell.shouldShowAppRefreshInHeader() ? this.renderAppRefresh() : undefined}
        .onShowActions=${this.navigationActions.showActions}
        .onTogglePanel=${this.appShell.isMobileNavigationLayout ? undefined : this.navigationPanelActions.toggle}
        .onToggleProjects=${this.navigationActions.toggleProjects}
        .onToggleWorkspaces=${this.navigationActions.toggleWorkspaces}
        .onToggleSessions=${this.navigationActions.toggleSessions}
        .onSelectProject=${this.navigationActions.selectProject}
        .onCloseProject=${this.navigationActions.closeProject}
        .onMoveProject=${this.navigationActions.moveProject}
        .onMoveWorkspace=${this.navigationActions.moveWorkspace}
        .onPinSession=${this.navigationActions.pinSession}
        .onUnpinSession=${this.navigationActions.unpinSession}
        .onMoveSessionPin=${this.navigationActions.moveSessionPin}
        .onSelectWorkspace=${this.navigationActions.selectWorkspace}
        .onDeleteWorkspace=${this.navigationActions.deleteWorkspace}
        .onArchivedCollapsed=${this.navigationActions.archivedCollapsed}
        .onStartSession=${this.navigationActions.startSession}
        .onSelectSession=${this.navigationActions.selectSession}
        .onMarkSessionRead=${this.navigationActions.markSessionRead}
        .onMarkSessionUnread=${this.navigationActions.markSessionUnread}
        .onMarkSessionsRead=${this.navigationActions.markSessionsRead}
        .onArchiveSession=${this.navigationActions.archiveSession}
        .onArchiveSessionWithDescendants=${this.navigationActions.archiveSessionWithDescendants}
        .onArchiveSessions=${this.navigationActions.archiveSessions}
        .onRestoreSession=${this.navigationActions.restoreSession}
        .onDeleteCachedNewSession=${this.navigationActions.deleteCachedNewSession}
        .onDeleteArchivedSession=${this.navigationActions.deleteArchivedSession}
        .onDeleteArchivedSessions=${this.navigationActions.deleteArchivedSessions}
        .onDetachParentSession=${this.navigationActions.detachParentSession}
        .onReloadSession=${this.navigationActions.reloadSession}
        .onCleanupSessions=${this.navigationActions.cleanupSessions}
        .onFocusNavigationTarget=${this.navigationActions.focusNavigationTarget}
        .onCancelKeyboardNavigation=${this.navigationActions.cancelKeyboardNavigation}
      ></app-navigation-panel>
    `;
  }

  private cancelAutomaticProjectNavigation(): void {
    if (this.pendingProjectNavigation !== undefined) this.pendingProjectNavigation.cancelled = true;
  }

  private openNavigationSection(section: NavigationSection): void {
    this.cancelAutomaticProjectNavigation();
    this.navigationSections.open(section, () => { this.selectMainView("navigation"); });
  }

  private async selectNavigationItem(section: NavigationSection, nextTarget: NavigationFocusTarget, action: () => Promise<boolean | undefined>): Promise<void> {
    const seq = ++this.navigationSelectionSeq;
    const isCurrentSelection = () => seq === this.navigationSelectionSeq;
    let navigationAccepted: boolean | undefined;

    const pending: typeof this.pendingProjectNavigation = this.appShell.isMobileNavigationLayout && section === "projects"
      ? { seq, target: undefined, cancelled: false } : undefined;
    this.pendingProjectNavigation = pending;
    try {
      await this.withChatScrollTransition(async () => {
        if (pending !== undefined) this.navigationSections.expand("projects");
        else this.navigationSections.advanceAfterSelection(section);
        navigationAccepted = await action();
      }, isCurrentSelection);

      if (!isCurrentSelection() || navigationAccepted === false) return;
      // Topology resolution already opened the destination. Never re-open it
      // after session loading, which could override an explicit section choice.
      if (pending !== undefined && (pending.target !== undefined || pending.cancelled)) return;
      await this.focusNavigationTarget(nextTarget, isCurrentSelection);
    } finally {
      if (this.pendingProjectNavigation === pending) this.pendingProjectNavigation = undefined;
    }
  }

  private async startSessionFromNavigation(): Promise<void> {
    const seq = ++this.navigationSelectionSeq;
    const isCurrentSelection = () => seq === this.navigationSelectionSeq;

    this.navigationSections.advanceAfterSelection("sessions");
    await this.startSessionAndOpenChat(isCurrentSelection);
  }

  private async startSessionAndOpenChat(shouldComplete: () => boolean = () => true): Promise<void> {
    // Open Chat before publishing the creation token; completion owns only
    // that token and leaves subsequent surface navigation untouched.
    const navigationSeq = this.navigationSelectionSeq;
    const isCurrent = () => navigationSeq === this.navigationSelectionSeq && shouldComplete();
    const workspace = this.state.selectedWorkspace;
    const machineId = selectedMachineId(this.state);
    if (isCurrent()) await this.openChatAndFocusComposer(isCurrent);
    if (!isCurrent()) return;
    const start = this.sessions.startSession().catch((error: unknown) => {
      if (workspace === undefined) return;
      this.browserErrors.reportLocalized(workspaceBrowserErrorScope(machineId, workspace.projectId, workspace.id), () => String(error));
    });
    void start;
  }

  private async focusNavigationTarget(target: NavigationFocusTarget, shouldComplete: () => boolean = () => true): Promise<void> {
    const navigationSeq = this.navigationSelectionSeq;
    const isCurrent = () => navigationSeq === this.navigationSelectionSeq && shouldComplete();
    if (!isCurrent()) return;
    if (target === "chat") {
      await this.openChatAndFocusComposer(isCurrent);
      return;
    }
    await this.focusNavigationSection(target, isCurrent);
  }

  private async focusNavigationSection(section: NavigationSection, shouldComplete: () => boolean = () => true): Promise<void> {
    const navigationSeq = this.navigationSelectionSeq;
    const isCurrent = () => navigationSeq === this.navigationSelectionSeq && shouldComplete();
    if (!isCurrent()) return;
    if (section === "workspaces" && !shouldShowWorkspaceSelection(this.state.workspaceResolution)) {
      await this.focusNavigationSection("sessions", isCurrent);
      return;
    }
    // The machines section is only focusable when a machine choice exists; the
    // single-machine bubble is not a control.
    if (section === "machines" && !shouldShowMachinesSection(this.state.machines)) {
      await this.focusNavigationSection("projects", isCurrent);
      return;
    }
    if (!isCurrent()) return;
    this.panelCollapse.expandNavigationPanel();
    if (this.appShell.isMobileNavigationLayout) this.selectMainView("navigation", { invalidateNavigationSelection: false });
    this.navigationSections.expand(section);
    await this.updateComplete;
    if (!isCurrent()) return;
    await nextFrame();
    if (!isCurrent()) return;
    await this.navigationPanel?.focusSection(section);
  }

  private async openChatAndFocusComposer(shouldComplete: () => boolean = () => true): Promise<void> {
    if (!shouldComplete()) return;
    if (this.effectiveMainView() !== "chat") this.selectMainView("chat", { invalidateNavigationSelection: false });
    await this.focusChatComposer(shouldComplete);
  }

  /** Restore focus only; callers that intend navigation must explicitly open Chat. */
  private async focusChatComposer(shouldComplete: () => boolean = () => true): Promise<void> {
    const navigationSeq = this.navigationSelectionSeq;
    const isCurrent = () => navigationSeq === this.navigationSelectionSeq && shouldComplete();
    if (!isCurrent() || !this.isChatVisible()) return;
    await this.updateComplete;
    if (!isCurrent()) return;
    await nextFrame();
    if (!isCurrent()) return;
    // A restored chat starts only after the list's first paint. Its editor may
    // not exist in that first frame; wait for the deferred mount, not the HTTP read.
    if (this.sessions.isChatLoadDeferred) await nextFrame();
    await this.updateComplete;
    await this.promptEditor?.updateComplete;
    // The focus request may outlive the dialog transition that scheduled it.
    // Recheck the rendered boundary at the final side-effect point so a newer
    // or surviving modal keeps visual and keyboard focus ownership.
    if (!isCurrent() || !this.isChatVisible() || this.isRenderedModalOpen()) return;
    if (this.unacknowledgedActivitySessionKey() !== undefined) {
      this.renderRoot.querySelector<HTMLButtonElement>(".composer-activity-notice button")?.focus();
      return;
    }
    this.promptEditor?.focusInput();
  }

  private async navigateSessionTree(targetId: string, summaryChoice: SessionTreeSummaryChoice): Promise<SessionTreeNavigateResult> {
    const originMachineId = selectedMachineId(this.state);
    const originSessionId = this.state.selectedSession?.id;
    const originNavigationSeq = this.navigationSelectionSeq;
    const result = await this.sessions.navigateTree(targetId, summaryChoice);
    if (!result.cancelled
      && this.navigationSelectionSeq === originNavigationSeq
      && originSessionId !== undefined
      && selectedMachineId(this.state) === originMachineId
      && this.state.selectedSession?.id === originSessionId) {
      await this.focusChatComposer();
    }
    return result;
  }

  private async forkSessionTree(entryId: string): Promise<SessionTreeForkResult> {
    // The controller selects the forked session and closes the dialog on success.
    return this.sessions.forkFromTree(entryId);
  }

  private closeSessionTreeNavigator(): void {
    this.sessions.closeTreeDialog();
    void this.focusChatComposer();
  }

  private renderSessionTreeNavigator(state: AppState) {
    return state.treeDialog === undefined ? null : html`
      <session-tree-navigator
        .tree=${state.treeDialog}
        .onNavigate=${(targetId: string, summaryChoice: SessionTreeSummaryChoice) => this.navigateSessionTree(targetId, summaryChoice)}
        .onFork=${(entryId: string) => this.forkSessionTree(entryId)}
        .onAbort=${() => this.sessions.abortTreeNavigation()}
        .onCancel=${() => { this.closeSessionTreeNavigator(); }}
      ></session-tree-navigator>
    `;
  }

  private readonly handleWorkspaceFileOpen = (event: CustomEvent<WorkspaceFileOpenRequest>): void => {
    const workspace = this.state.selectedWorkspace;
    const request = event.detail;
    if (event.defaultPrevented || workspace === undefined || request.machineId !== selectedMachineId(this.state)
      || request.projectId !== workspace.projectId || request.workspaceId !== workspace.id || request.root !== workspace.path) return;
    const navigation = this.plugins.resolveWorkspaceFileOpen(this.createWorkspacePanelContext(workspace), request.path);
    if (navigation === undefined) return;
    const query = patchContributionQueryRecord(this.currentContributionQueryForState(), navigation.contributionId, this.workspacePanelSourceQueryIds(navigation.contributionId), navigation.query);
    event.preventDefault();
    this.publishWorkspaceTool(navigation.contributionId, query);
  };

  private visibleWorkspacePanels(): WorkspaceToolPanel[] {
    const panels: WorkspaceToolPanel[] = this.plugins.getApplicationPanels().flatMap((panel) => {
      const applicationContext = this.createApplicationPanelContext(panel.id, panel.sourceContributionId);
      return (panel.visible?.(applicationContext) ?? true) ? [{
        ...panel,
        badge: () => panel.badge?.(applicationContext),
        render: () => panel.render(applicationContext),
      }] : [];
    });
    const workspace = this.state.selectedWorkspace;
    if (workspace !== undefined) {
      const context = this.createWorkspacePanelContext(workspace);
      panels.push(...this.plugins.getWorkspacePanels().filter((panel) => panel.visible?.(context) ?? true).map((panel) => ({
        ...panel,
        badge: () => panel.badge?.(context),
        render: () => panel.render(context),
      })));
    }
    return panels.sort((left, right) => (left.order ?? 1000) - (right.order ?? 1000) || left.title.localeCompare(right.title));
  }

  private availableWorkspacePanelId(
    requested: QualifiedContributionId | undefined,
    panels = this.visibleWorkspacePanels(),
  ): QualifiedContributionId | undefined {
    return panels.find((panel) => panel.id === requested)?.id;
  }

  private unavailableRouteTool(panels = this.visibleWorkspacePanels()): string | undefined {
    const route = readRoute();
    if (route.tool === undefined) return undefined;
    const tool = resolveAppRoute(route, (value) => this.plugins.resolveWorkspacePanelRouteId(value, selectedMachineId(this.state))).tool;
    return this.availableWorkspacePanelId(tool, panels) === undefined ? route.tool : undefined;
  }

  private effectiveWorkspaceTool(panels = this.visibleWorkspacePanels()): QualifiedContributionId | undefined {
    // A requested tool remains authoritative even while its plugin is unavailable.
    // Never substitute a remembered/default tab for an explicitly invalid tool.
    const route = readRoute();
    if (route.tool !== undefined) {
      return resolveAppRoute(route, (value) => this.plugins.resolveWorkspacePanelRouteId(value, selectedMachineId(this.state))).tool;
    }
    return this.state.workspaceTool ?? panels[0]?.id;
  }

  private unknownRouteView(): string | undefined {
    const route = readRoute();
    return route.view !== undefined
      && parseMainView(route.view) === undefined
      ? route.view : undefined;
  }

  private effectiveMainView(): AppState["mainView"] {
    if (this.unknownRouteView() === undefined) return this.state.mainView;
    if (this.appShell.isMobileNavigationLayout) return "navigation";
    const route = readRoute();
    return route.tool !== undefined && this.unavailableRouteTool() === undefined ? "workspace" : "chat";
  }

  private reconcileWorkspacePanelSelection(): boolean {
    const panels = this.visibleWorkspacePanels();
    const workspaceTool = this.effectiveWorkspaceTool(panels);
    if (workspaceTool === this.state.workspaceTool) return false;
    this.setState({ workspaceTool });
    return true;
  }

  private workspacePanelEmptyState(): WorkspacePanelEmptyState {
    const project = this.state.selectedProject;
    if (this.state.isLoadingProjects) {
      return {
        title: appShellText.t("loadingProjects"),
        body: appShellText.t("lookingForProjects"),
      };
    }
    if (project === undefined) {
      return this.state.projects.length === 0
        ? {
            title: appShellText.t("noProjects"),
            body: appShellText.t("addProjectHint"),
          }
        : {
            title: appShellText.t("selectProject"),
            body: appShellText.t("chooseProject"),
          };
    }
    if (this.state.isLoadingWorkspaces) {
      return {
        title: appShellText.t("loadingWorkspaces"),
        body: appShellText.t("preparingTools", { project: project.name }),
      };
    }
    if (this.state.workspaces.length === 0) {
      return {
        title: appShellText.t("noWorkspaces"),
        body: appShellText.t("noWorkspacesHint", { project: project.name }),
      };
    }
    return {
      title: appShellText.t("selectWorkspace"),
      body: appShellText.t("chooseProjectWorkspace", { project: project.name }),
    };
  }

  private contentLoadOutcome: { destination: string; error: WorkspaceSelectionError } | undefined;

  private contentDestination(route: ParsedAppRoute): string {
    return JSON.stringify([route.machineId ?? "local", route.projectId, route.workspaceId, route.sessionId]);
  }

  private setContentError(route: ParsedAppRoute, error: WorkspaceSelectionError): void {
    this.contentLoadOutcome = { destination: this.contentDestination(route), error };
    this.requestUpdate();
  }

  private contentError(): string {
    if (this.contentLoadOutcome?.destination !== this.contentDestination(readRoute())) return "";
    const error = this.contentLoadOutcome.error;
    return typeof error === "function" ? error() : error;
  }

  private readonly pluginLoadErrors = new Map<string, string>();

  private workspaceContentError(): string {
    const route = readRoute();
    if (this.state.selectedWorkspace === undefined && route.tool === undefined) return this.contentError();
    const requested = route.tool;
    const panel = requested === undefined ? this.effectiveWorkspaceTool()
      : resolveAppRoute({ ...route, tool: requested }, (value) => this.plugins.resolveWorkspacePanelRouteId(value, selectedMachineId(this.state))).tool;
    if ((requested !== undefined || panel !== undefined) && this.availableWorkspacePanelId(panel) === undefined) {
      return this.pluginLoadErrors.get(selectedMachineId(this.state))
        ?? this.requiredPluginFailureByMachine.get(selectedMachineId(this.state))?.()
        ?? appShellText.t("unavailablePanel", { id: requested ?? panel ?? "unknown" });
    }
    return "";
  }

  private sessionEmptyMessage(): string {
    const error = this.contentError();
    if (error !== "") return error;
    if (this.state.isLoadingProjects) return routeFeedback.t("loadingProjects");
    if (this.state.selectedWorkspace !== undefined) return routeFeedback.t("selectSession");
    if (this.state.selectedProject !== undefined) return routeFeedback.t("selectWorkspace");
    if (this.state.projects.length === 0) return routeFeedback.t("addProject");
    return routeFeedback.t("selectProject");
  }

  private workspaceLabelItems(workspace: Workspace): WorkspaceLabelItem[] {
    return this.plugins.getWorkspaceLabelItems(this.createWorkspaceLabelContext(workspace));
  }

  private createWorkspaceLabelContext(workspace: Workspace): WorkspaceLabelContext {
    const machine = pluginMachineFromState(this.state);
    const createContext = (binding: WorkspacePluginBinding): WorkspaceLabelContext => {
      const peer = createPluginPeer(binding, workspace, machine.id);
      return installWorkspaceLabelScope({
        machine,
        workspace,
        state: this.state,
        files: this.createWorkspaceFiles(workspace, machine),
        projects: createPluginProjects(projectsApi, machine.id),
        ...(peer === undefined ? {} : { peer }),
        host: this.createWorkspaceHost(),
      }, createContext);
    };
    return createContext(coreWorkspacePluginBinding());
  }

  private sessionLabelItems(session: SessionInfo): SessionLabelItem[] {
    const workspace = this.state.selectedWorkspace;
    if (workspace === undefined) return [];
    const machine = pluginMachineFromState(this.state);
    const createContext = (binding: WorkspacePluginBinding): SessionLabelContext => {
      const peer = createPluginPeer(binding, workspace, machine.id);
      return installSessionLabelScope({
        machine,
        workspace,
        session: publicPluginSession(session),
        state: this.state,
        files: this.createWorkspaceFiles(workspace, machine),
        projects: createPluginProjects(projectsApi, machine.id),
        ...(peer === undefined ? {} : { peer }),
        navigate: (destination, options) => this.navigate(destination, options, machine.id),
        host: this.createWorkspaceHost(),
      }, createContext);
    };
    return this.plugins.getSessionLabelItems(createContext(coreWorkspacePluginBinding()));
  }

  private createWorkspaceFiles(workspace: Workspace, machine: PluginMachine): WorkspaceFilesCapabilityV1 {
    return createPluginWorkspaceFiles(workspacesApi, workspace, machine.id, {
      defaultUploadFolder: workspaceEffectiveUploadFolder(workspace.effectiveConfig, this.workspaceUploadDefaultFolder),
      onInvalidate: (invalidation) => { void this.invalidateWorkspaceResources(workspace, machine, invalidation); },
    });
  }

  private createWorkspaceHost(): WorkspaceHost {
    return {
      requestRender: () => { this.invalidateWorkspaceSurface(); },
    };
  }

  private createApplicationPanelContext(
    contributionId?: QualifiedContributionId,
    sourceContributionId: QualifiedContributionId | undefined = contributionId,
    contributionQueryRestore?: WorkspaceContributionQueryRestore,
  ): ApplicationPanelContext {
    const machine = pluginMachineFromState(this.state);
    const workspace = this.state.selectedWorkspace;
    const createContext = (pluginId: string): ApplicationPanelContext => {
      const navigation = this.beginNavigationOperation(WORKSPACE_SURFACE_SCOPE);
      const maintenanceTerminal = this.maintenanceTerminal(pluginId, machine.id, navigation);
      return installApplicationPanelScope({
        ...(maintenanceTerminal === undefined ? {} : { maintenanceTerminal }),
        machine,
        state: this.state,
        projects: createPluginProjects(projectsApi, machine.id),
        ...(workspace === undefined ? {} : { workspace }),
        ...(workspace === undefined || contributionId === undefined ? {} : {
          navigation: this.createWorkspacePanelNavigation(workspace, machine, contributionId, sourceContributionId, contributionQueryRestore, navigation),
        }),
        ...(workspace === undefined || !this.terminalAvailableForMachine(machine.id) ? {} : {
          terminal: this.workspaceTerminal(pluginId, workspace, machine.id, navigation),
        }),
        navigate: (destination, options) => this.navigate(destination, options),
        prompt: this.createPromptEditor(pluginId, machine.id),
        host: this.createWorkspaceHost(),
      }, createContext);
    };
    return createContext("core");
  }

  private createWorkspacePanelContext(
    workspace: Workspace,
    machine = pluginMachineFromState(this.state),
    contributionQueryRestore?: WorkspaceContributionQueryRestore,
  ): WorkspacePanelContext {
    const machineId = machine.id;
    const createContext = (
      binding: WorkspacePluginBinding,
      contributionId?: QualifiedContributionId,
      sourceContributionId: QualifiedContributionId | undefined = contributionId,
    ): WorkspacePanelContext => {
      // Retained panel contexts may outlive the visible surface. Terminal and
      // navigation mutations use this token; workspace data refreshes do not.
      const navigation = this.beginNavigationOperation(WORKSPACE_SURFACE_SCOPE);
      const peer = createPluginPeer(binding, workspace, machineId);
      return installWorkspacePanelScope({
        navigate: (destination, options) => this.navigate(destination, options),
        machine,
        workspace,
        state: this.state,
        files: this.createWorkspaceFiles(workspace, machine),
        projects: createPluginProjects(projectsApi, machineId),
        ...(peer === undefined ? {} : { peer }),
        prompt: this.createPromptEditor(binding.registrationPluginId, machineId),
        terminal: this.workspaceTerminal(binding.registrationPluginId, workspace, machineId, navigation),
        ...(contributionId === undefined ? {} : {
          navigation: this.createWorkspacePanelNavigation(workspace, machine, contributionId, sourceContributionId, contributionQueryRestore, navigation),
        }),
        host: this.createWorkspaceHost(),
      }, createContext);
    };
    return createContext(coreWorkspacePluginBinding());
  }

  private workspacePanelContextIsCurrent(workspace: Workspace, machine: PluginMachine, navigation?: NavigationFreshness): boolean {
    return selectedMachineId(this.state) === machine.id
      && this.state.selectedProject?.id === workspace.projectId
      && this.state.selectedWorkspace?.id === workspace.id
      && routeMatchesWorkspaceIdentity(readRoute(), {
        machineId: machine.id,
        projectId: workspace.projectId,
        workspaceId: workspace.id,
      })
      && (navigation === undefined || navigation.isCurrent());
  }

  private createWorkspacePanelNavigation(
    workspace: Workspace,
    machine: PluginMachine,
    contributionId: QualifiedContributionId,
    sourceContributionId: QualifiedContributionId | undefined,
    contributionQueryRestore: WorkspaceContributionQueryRestore | undefined,
    navigation: NavigationFreshness,
  ): WorkspacePanelNavigationV1 {
    const sourceQueryIds = sourceContributionId === undefined || sourceContributionId === contributionId ? [] : [sourceContributionId];
    const identity: WorkspaceRouteIdentity = { machineId: machine.id, projectId: workspace.projectId, workspaceId: workspace.id };
    const query = contributionQueryRestore !== undefined && sameWorkspaceRouteIdentity(identity, contributionQueryRestore.identity)
      ? contributionQueryFromRecord(contributionQueryRestore.query, contributionId, sourceQueryIds)
      : routeMatchesWorkspaceIdentity(readRoute(), identity)
        ? readContributionQuery(contributionId, sourceQueryIds)
        : Object.freeze({});
    let expectedQuery = query;
    return Object.freeze({
      version: 1,
      contributionId,
      query,
      set: (key: string, value: ContributionQueryValue | undefined | null, options?: { replace?: boolean | undefined }) => {
        if (!isContributionQueryLocalKey(key)) throw new Error(`Invalid contribution navigation key: ${key}`);
        if (!navigation.isCurrent()) return false;
        const selectedIdentity = this.selectedWorkspaceRouteIdentity();
        if (selectedIdentity === undefined
          || !sameWorkspaceRouteIdentity(identity, selectedIdentity)
          || !routeMatchesWorkspaceIdentity(readRoute(), identity)
          || !sameContributionQueryRecord(readContributionQuery(contributionId, sourceQueryIds), expectedQuery)) return false;
        if (setContributionQueryKey(contributionId, sourceQueryIds, key, value, options)) {
          expectedQuery = readContributionQuery(contributionId, sourceQueryIds);
          this.rememberCurrentMachineNavigation();
          this.requestUpdate();
        }
        return true;
      },
    });
  }

  private invalidateWorkspacePanels(
    panelId?: QualifiedContributionId,
    contributionQueryRestore?: WorkspaceContributionQueryRestore,
  ): Promise<void> {
    const applicationPanels = this.plugins.getApplicationPanels().filter((panel) => panelId === undefined || panel.id === panelId);
    const refreshApplicationPanels = applicationPanels.map(async (panel) => {
      const context = this.createApplicationPanelContext(panel.id, panel.sourceContributionId, contributionQueryRestore);
      if (panel.visible?.(context) ?? true) await panel.onInvalidate?.(context);
    });
    const workspace = this.state.selectedWorkspace;
    return Promise.all([
      ...refreshApplicationPanels,
      ...(workspace === undefined ? [] : [this.plugins.invalidateWorkspacePanels(
        this.createWorkspacePanelContext(workspace, pluginMachineFromState(this.state), contributionQueryRestore),
        panelId,
      )]),
    ]).then(() => undefined);
  }

  private invalidateWorkspaceResources(workspace: Workspace, machine: PluginMachine, invalidation: WorkspaceInvalidation): Promise<void> {
    return this.plugins.invalidateWorkspaceResources(this.createWorkspacePanelContext(workspace, machine), invalidation);
  }

  private invalidateSelectedWorkspaceFiles(): Promise<void> {
    const workspace = this.state.selectedWorkspace;
    if (workspace === undefined) return Promise.resolve();
    return this.invalidateWorkspaceResources(workspace, pluginMachineFromState(this.state), {
      reason: "manual",
      resources: ["workspace.files"],
    });
  }

  private getActions(): AppAction[] {
    return applyActiveShortcutPreferences(this.getDefaultActions(), this.shortcutConfig);
  }

  private getDefaultActions(): AppAction[] {
    const pluginActions = this.plugins.getActions(this.createPluginRuntimeContext());
    return [...pluginActions, ...this.workspaceSurfaceActions(), ...this.sessionActions(), ...this.navigationFocusActions(), ...this.panelLayoutActions()];
  }

  private workspaceSurfaceActions(): AppAction[] {
    return [{
      id: "core:workspace.refresh-current",
      get title() { return appActionMessages.t("refreshTitle"); },
      shortcut: "mod+shift+r",
      get group() { return appActionMessages.t("groupWorkspace"); },
      enabled: this.state.selectedWorkspace !== undefined,
      run: () => this.refreshCurrentWorkspaceSurface(),
    }];
  }

  private sessionActions(): AppAction[] {
    return [
      {
        id: "app.sessions.cleanup",
        get title() { return sessionCleanupMessages.t("actionTitle"); },
        get description() { return sessionCleanupMessages.t("actionDescription"); },
        get group() { return sessionCleanupMessages.t("eyebrow"); },
        run: () => { this.openSessionCleanupDialog(); },
      },
    ];
  }

  private panelLayoutActions(): AppAction[] {
    return [
      {
        id: "app.layout.reset-navigation-panel-size",
        get title() { return appActionMessages.t("resetNavigationTitle"); },
        get description() { return appActionMessages.t("resetNavigationDescription"); },
        get group() { return appActionMessages.t("groupView"); },
        run: () => { this.resetResizablePanel("navigation"); },
      },
      {
        id: "app.layout.reset-workspace-panel-size",
        get title() { return appActionMessages.t("resetWorkspaceTitle"); },
        get description() { return appActionMessages.t("resetWorkspaceDescription"); },
        get group() { return appActionMessages.t("groupView"); },
        run: () => { this.resetResizablePanel("workspace"); },
      },
      {
        id: "app.layout.reset-panel-sizes",
        get title() { return appActionMessages.t("resetAllTitle"); },
        get description() { return appActionMessages.t("resetAllDescription"); },
        get group() { return appActionMessages.t("groupView"); },
        run: () => { this.resetResizablePanels(); },
      },
    ];
  }

  private navigationFocusActions(): AppAction[] {
    return [
      {
        id: "app.navigation.open",
        get title() { return appActionMessages.t("openNavigationTitle"); },
        get description() { return appActionMessages.t("openNavigationDescription"); },
        get group() { return appActionMessages.t("groupNavigation"); },
        run: () => { this.showNavigation(); },
      },
      {
        id: "app.navigation.focus-machines",
        get title() { return appActionMessages.t("focusMachinesTitle"); },
        get description() { return appActionMessages.t("focusMachinesDescription"); },
        shortcut: "mod+g m",
        get group() { return appActionMessages.t("groupNavigation"); },
        run: () => this.focusNavigationSection("machines"),
      },
      {
        id: "app.navigation.focus-projects",
        get title() { return appActionMessages.t("focusProjectsTitle"); },
        get description() { return appActionMessages.t("focusProjectsDescription"); },
        shortcut: "mod+g p",
        get group() { return appActionMessages.t("groupNavigation"); },
        run: () => this.focusNavigationSection("projects"),
      },
      {
        id: "app.navigation.focus-workspaces",
        get title() { return appActionMessages.t("focusWorkspacesTitle"); },
        get description() { return appActionMessages.t("focusWorkspacesDescription"); },
        shortcut: "mod+g w",
        get group() { return appActionMessages.t("groupNavigation"); },
        run: () => this.focusNavigationSection("workspaces"),
      },
      {
        id: "app.navigation.focus-sessions",
        get title() { return appActionMessages.t("focusSessionsTitle"); },
        get description() { return appActionMessages.t("focusSessionsDescription"); },
        shortcut: "mod+g s",
        get group() { return appActionMessages.t("groupNavigation"); },
        run: () => this.focusNavigationSection("sessions"),
      },
    ];
  }

  private ensureGatewayPluginsLoaded(): Promise<void> {
    const existing = this.gatewayPluginLoadPromise;
    if (existing !== undefined) return existing;
    this.gatewayPluginLoadAttemptComplete = false;
    const load = Promise.all([this.builtInPluginsReady, this.declarativeThemesReady]).then(() => this.loadExternalPlugins()).then((complete) => {
      this.gatewayPluginLoadAttemptComplete = true;
      this.applyPreferredTheme(false);
      if (!complete && this.gatewayPluginLoadPromise === load) this.gatewayPluginLoadPromise = undefined;
    });
    this.gatewayPluginLoadPromise = load;
    return load;
  }

  private loadExternalPlugins(): Promise<boolean> {
    return this.registerExternalPlugins(() => pluginRecovery.t("source"), () => loadExternalPlugins("pi-web-plugins/manifest.json", {
      shouldLoadPlugin: (entry) => (entry.id === REQUIRED_TERMINAL_PLUGIN_ID && !this.terminalAvailableForMachine("local"))
        || !this.plugins.hasPlugin(entry.id),
    }));
  }

  private async loadPluginsForSelectedMachine(): Promise<void> {
    await this.ensureGatewayPluginsLoaded();
    const machine = this.state.selectedMachine;
    if (machine?.kind !== "remote") return;
    await this.loadPluginsForMachine(machine);
  }

  private async loadPluginsForMachine(machine: Machine): Promise<void> {
    const urlAtLoad = currentBrowserUrl();
    await this.ensureGatewayPluginsLoaded();
    if (machine.kind !== "remote" || this.loadedMachinePluginIds.has(machine.id)) return;
    const runtime = this.state.machineRuntimes[machine.id];
    if (runtime?.ok === true && !supportsPiWebCapability(runtime, PI_WEB_CAPABILITIES.pluginLifecycle)) {
      const message = () => pluginRecovery.t("lifecycleRequired", { name: machine.name });
      console.warn(message());
      this.verifiedPluginModeByMachine.delete(machine.id);
      this.clearRequiredTerminal(machine.id);
      this.reconcilePluginLoadSelection(urlAtLoad);
      this.setRequiredPluginFailure(machine.id, message);
      return;
    }
    const existing = this.machinePluginLoadPromises.get(machine.id);
    if (existing !== undefined) return existing;

    const load = this.registerExternalPlugins(() => pluginRecovery.t("remoteSource", { name: machine.name }), () => loadExternalPlugins(`api/machines/${encodeURIComponent(machine.id)}/pi-web-plugins/manifest.json`, {
      machineId: machine.id,
      shouldLoadPlugin: (entry) => this.plugins.shouldLoadRemotePlugin(entry.id, entry.machineSpecific)
        && ((entry.id === REQUIRED_TERMINAL_PLUGIN_ID && !this.terminalAvailableForMachine(machine.id))
          || !this.plugins.hasPlugin(machineScopedManifestPluginId(machine.id, entry.id))),
    }), machine.id)
      .then((loaded) => { if (loaded) this.loadedMachinePluginIds.add(machine.id); })
      .finally(() => { this.machinePluginLoadPromises.delete(machine.id); });
    this.machinePluginLoadPromises.set(machine.id, load);
    await load;
  }

  private async registerExternalPlugins(label: string | (() => string), load: () => Promise<ExternalPluginLoadResult>, machineId = "local"): Promise<boolean> {
    const urlAtLoad = currentBrowserUrl();
    try {
      const result = await load();
      if (result.terminalMode === "recovery-disabled") {
        this.clearRequiredTerminal(machineId);
        this.verifiedPluginModeByMachine.set(machineId, "recovery-disabled");
        this.clearRequiredPluginFailure(machineId);
      }
      const loadErrors = result.failures.map((failure) => errorMessage(failure.error));
      this.pluginLoadErrors.delete(machineId);
      if (loadErrors.length > 0) this.pluginLoadErrors.set(machineId, loadErrors.join("\n"));
      let complete = result.failures.length === 0;
      for (const failure of result.failures) {
        console.warn(`Failed to load PI WEB plugin ${failure.entry.id} (${failure.entry.module})`, failure.error);
      }
      const declarations = result.declarations;
      const registryImportFailures = externalRegistryFailures(result, declarations);
      const requiredTerminalLoadFailure = result.terminalMode === "required"
        ? result.failures.find(({ entry }) => entry.id === REQUIRED_TERMINAL_PLUGIN_ID)
        : undefined;
      if (requiredTerminalLoadFailure !== undefined) {
        this.verifiedPluginModeByMachine.delete(machineId);
        this.clearRequiredTerminal(machineId);
        this.reconcilePluginLoadSelection(urlAtLoad);
        this.applyPreferredTheme(false);
        this.setRequiredPluginFailure(machineId, () => pluginRecovery.t("terminalLoadFailed", { detail: errorMessage(requiredTerminalLoadFailure.error) }));
        this.requestUpdate();
        return false;
      }

      const terminalRuntimeId = machineId === "local"
        ? REQUIRED_TERMINAL_PLUGIN_ID
        : machineScopedBundledPluginId(machineId, REQUIRED_TERMINAL_PLUGIN_ID);
      if (result.terminalMode === "required") {
        let terminalFailurePhase: BrowserPluginLifecyclePhase = "validate";
        try {
          const terminalRegistration = result.registrations.find(({ id }) => id === terminalRuntimeId);
          if (this.plugins.hasPlugin(terminalRuntimeId)) {
            const known = this.knownRequiredTerminalByMachine.get(machineId);
            if (known === undefined) throw new PluginRecoveryError(() => pluginRecovery.t("capabilityLost"));
            if (terminalRegistration !== undefined) {
              const requiredBinding = requiredTerminalPluginBinding(terminalRegistration, machineId);
              if (!sameWorkspacePluginBinding(known.binding, requiredBinding)) {
                throw new PluginRecoveryError(() => pluginRecovery.t("revisionChanged"));
              }
            }
            this.requiredTerminalByMachine.set(machineId, known);
          } else {
            if (terminalRegistration === undefined) throw new PluginRecoveryError(() => pluginRecovery.t("registrationMissing"));
            const requiredBinding = requiredTerminalPluginBinding(terminalRegistration, machineId);
            const terminalDeclaration = declarations.find(({ id }) => id === terminalRuntimeId);
            if (terminalDeclaration === undefined) throw new PluginRecoveryError(() => pluginRecovery.t("declarationMissing"));
            const terminalBatch = await this.plugins.registerBatch([terminalRegistration], {
              declarations: [terminalDeclaration],
              failures: registryImportFailures.filter(({ declaration }) => declaration.id === terminalRuntimeId),
              requiredCapabilities: [{
                registrationPluginId: terminalRuntimeId,
                capability: REQUIRED_TERMINAL_BROWSER_FACADE_CAPABILITY,
              }],
            });
            const terminalFailure = terminalBatch.failures.find(({ declaration }) => declaration.id === terminalRuntimeId);
            if (terminalFailure !== undefined) {
              terminalFailurePhase = terminalFailure.phase;
              throw terminalFailure.error;
            }
            const facade = this.plugins.resolveCapability(terminalRuntimeId, REQUIRED_TERMINAL_BROWSER_FACADE_CAPABILITY);
            const composition = Object.freeze({ binding: requiredBinding, facade });
            this.knownRequiredTerminalByMachine.set(machineId, composition);
            this.requiredTerminalByMachine.set(machineId, composition);
          }
        } catch (error) {
          complete = false;
          console.warn(`Failed to register PI WEB plugin ${terminalRuntimeId} during ${terminalFailurePhase}`, error);
          this.verifiedPluginModeByMachine.delete(machineId);
          this.clearRequiredTerminal(machineId);
          this.setRequiredPluginFailure(machineId, () => pluginRecovery.t("terminalActivationFailed", { phase: terminalFailurePhase, detail: errorMessage(error) }));
        }
      }

      if (result.terminalMode !== "required" || this.terminalAvailableForMachine(machineId)) {
        const ordinaryRegistrations = result.registrations.filter(({ id }) => id !== terminalRuntimeId);
        const ordinaryDeclarations = declarations.filter(({ id }) => id !== terminalRuntimeId);
        const ordinaryBatch = await this.plugins.registerBatch(ordinaryRegistrations, {
          declarations: ordinaryDeclarations,
          failures: registryImportFailures.filter(({ declaration }) => declaration.id !== terminalRuntimeId),
        });
        for (const failure of ordinaryBatch.failures) {
          if (failure.phase === "import") continue;
          complete = false;
          loadErrors.push(errorMessage(failure.error));
          this.pluginLoadErrors.set(machineId, loadErrors.join("\n"));
          console.warn(`Failed to register PI WEB plugin ${failure.declaration.id} during ${failure.phase}`, failure.error);
        }
      }

      if (result.terminalMode === "required" && (!this.plugins.hasPlugin(terminalRuntimeId) || !this.terminalAvailableForMachine(machineId))) {
        complete = false;
        this.verifiedPluginModeByMachine.delete(machineId);
        this.clearRequiredTerminal(machineId);
        if (!this.requiredPluginFailureByMachine.has(machineId)) {
          this.setRequiredPluginFailure(machineId, () => pluginRecovery.t("terminalMissingAfterActivation"));
        }
      } else if (result.terminalMode === "required") {
        this.verifiedPluginModeByMachine.set(machineId, "required");
        this.clearRequiredPluginFailure(machineId);
      }
      this.reconcilePluginLoadSelection(urlAtLoad);
      this.applyPreferredTheme(false);
      this.invalidateWorkspaceSurface();
      return complete;
    } catch (error) {
      console.warn(`Failed to load ${typeof label === "function" ? label() : label}`, error);
      this.pluginLoadErrors.set(machineId, errorMessage(error));
      this.verifiedPluginModeByMachine.delete(machineId);
      this.clearRequiredTerminal(machineId);
      this.reconcilePluginLoadSelection(urlAtLoad);
      this.applyPreferredTheme(false);
      this.setRequiredPluginFailure(machineId, () => pluginRecovery.t("loadFailed", { source: typeof label === "function" ? label() : label, detail: errorMessage(error) }));
      this.requestUpdate();
      return false;
    }
  }

  private reconcilePluginLoadSelection(urlAtLoad: string): void {
    // Check before reconciling: even a fallback's local surface change belongs
    // to the initiating destination, including its contribution query.
    if (currentBrowserUrl() !== urlAtLoad) return;
    // Plugin availability can change without user navigation. Reconcile the UI,
    // but keep the requested destination (and its query) available for retry.
    this.reconcileWorkspacePanelSelection();
  }

  private setRequiredPluginFailure(machineId: string, message: () => string): void {
    this.requiredPluginFailureByMachine.set(machineId, message);
    this.dismissedRequiredPluginFailureByMachine.delete(machineId);
    if (selectedMachineId(this.state) === machineId) this.requestUpdate();
  }

  private clearRequiredPluginFailure(machineId: string): void {
    if (!this.requiredPluginFailureByMachine.delete(machineId)) return;
    this.dismissedRequiredPluginFailureByMachine.delete(machineId);
    if (selectedMachineId(this.state) === machineId) this.requestUpdate();
  }

  private displayedError(): string {
    if (this.state.error !== "") return this.state.error;
    const machineId = selectedMachineId(this.state);
    const failure = this.requiredPluginFailureByMachine.get(machineId);
    return failure !== undefined && this.dismissedRequiredPluginFailureByMachine.get(machineId) !== failure
      ? failure()
      : "";
  }

  private dismissDisplayedError(): void {
    if (this.state.error !== "") {
      this.setState({ error: "" });
      return;
    }
    const machineId = selectedMachineId(this.state);
    const failure = this.requiredPluginFailureByMachine.get(machineId);
    if (failure === undefined) return;
    this.dismissedRequiredPluginFailureByMachine.set(machineId, failure);
    this.requestUpdate();
  }

  private clearRequiredTerminal(machineId: string): void {
    this.requiredTerminalByMachine.delete(machineId);
    this.invalidateWorkspaceSurface();
    this.loadedMachinePluginIds.delete(machineId);
    if (selectedMachineId(this.state) !== machineId) return;
    this.cancelWorkspaceDeletionRefresh();
    this.setState({ workspaceDeletionRuns: {} });
  }

  private terminalAvailableForMachine(machineId: string): boolean {
    return this.requiredTerminalByMachine.has(machineId);
  }

  private pluginContributionAvailable(pluginId: string, effectiveMachineId: string | undefined): boolean {
    if (pluginId === "core" || pluginId === "themes") return true;
    // Machine-using callbacks are rechecked against the live selection so a
    // closure captured on another healthy machine cannot act after a switch.
    if (effectiveMachineId !== undefined && effectiveMachineId !== selectedMachineId(this.state)) return false;
    // Undefined is reserved for intentional app-global theme evaluation.
    const machineId = effectiveMachineId ?? "local";
    const mode = this.verifiedPluginModeByMachine.get(machineId);
    const terminalRuntimeId = machineId === "local"
      ? REQUIRED_TERMINAL_PLUGIN_ID
      : machineScopedBundledPluginId(machineId, REQUIRED_TERMINAL_PLUGIN_ID);
    if (pluginId === terminalRuntimeId) return mode === "required" && this.terminalAvailableForMachine(machineId);
    return mode === "recovery-disabled" || (mode === "required" && this.terminalAvailableForMachine(machineId));
  }

  private createPromptEditor(pluginId = "core", machineId = selectedMachineId(this.state)): PluginPromptEditor {
    const session = this.state.selectedSession;
    const target = session !== undefined && session.archived !== true && !isCreatingSessionId(session.id) && machineId === selectedMachineId(this.state)
      ? { machineId, sessionId: session.id } : undefined;
    return {
      ...this.plugins.promptChipMethods(pluginId, target),
      insertText: (text: string) => {
        const editor = this.promptEditor?.view;
        if (!editor) return;
        if (!editor.hasFocus) editor.focus();
        const sel = editor.state.selection.main;
        editor.dispatch({
          changes: { from: sel.from, to: sel.to, insert: text },
          selection: { anchor: sel.from + text.length },
        });
      },
      getText: () => {
        return this.promptEditor?.view?.state.doc.toString() ?? "";
      },
      getSelection: () => {
        const editor = this.promptEditor?.view;
        if (!editor) return null;
        const sel = editor.state.selection.main;
        if (sel.empty) return null;
        return { start: sel.from, end: sel.to, text: editor.state.sliceDoc(sel.from, sel.to) };
      },
    };
  }

  private createPluginRuntimeContext(): PluginRuntimeContext {
    const createContext = (pluginId = "core"): PluginRuntimeContext => installPluginRuntimeScope({
      state: this.state,
      projects: createPluginProjects(projectsApi, selectedMachineId(this.state)),
      prompt: this.createPromptEditor(pluginId),
      piWebUnstable: {
        openSettings: (section) => { this.openSettings(section); },
        openMcpAuth: (mode) => this.auth.openMcpAuth(mode),
      },
      openActionPalette: () => { this.setState({ actionPaletteOpen: true }); },
      focusPrompt: () => { void this.openChatAndFocusComposer(); },
      addProject: () => { this.setState({ projectDialogOpen: true }); },
      addMachine: () => { this.openMachineDialog(); },
      refreshSelectedMachine: async () => {
        await Promise.all([this.machines.refreshMachineHealth(), this.machines.refreshMachineRuntime()]);
      },
      removeSelectedMachine: () => this.removeMachine(),
      openSelectedMachine: () => { this.openSelectedMachine(); },
      configureAuth: () => this.auth.openLogin(),
      logoutAuth: () => this.auth.openLogout(),
      openThemePicker: () => { this.openThemeDialog(); },
      openModelPicker: () => this.openModelDialog(),
      openThinkingLevelPicker: () => this.openThinkingDialog(),
      selectMainView: (view) => { this.selectMainView(view); },
      navigate: (destination, options) => this.navigate(destination, options),
      selectWorkspaceTool: (tool) => { this.openWorkspaceTool(tool); },
      openTerminal: (options) => { this.openTerminal(options); },
      refreshFiles: () => this.invalidateSelectedWorkspaceFiles(),
      refreshWorkspacePanels: (panelId) => this.invalidateWorkspacePanels(panelId),
      refreshAppData: () => this.refreshAppData(),
      checkForPiWebUpdates: () => this.piWebStatusController.checkForUpdates().finally(() => { this.schedulePiWebStatusRetry(); }),
      reloadPage: () => { this.hardReloadApp(); },
      deleteWorkspace: (workspace) => this.deleteWorkspace(workspace),
      startSession: () => this.withChatScrollTransition(() => this.startSessionAndOpenChat()),
      archiveSession: () => this.sessions.archiveSession(),
      reloadSession: () => this.sessions.reloadSession(),
      deleteCachedNewSession: () => this.sessions.deleteCachedNewSession(),
      stopActiveWork: () => this.sessions.stopActiveWork(),
    }, createContext);
    return createContext();
  }

  private async deleteWorkspace(workspace = this.state.selectedWorkspace): Promise<void> {
    if (workspace === undefined) return;
    const machineId = selectedMachineId(this.state);
    const scope = workspaceBrowserErrorScope(machineId, workspace.projectId, workspace.id);
    if (!canDeleteWorkspace(workspace)) {
      this.browserErrors.reportLocalized(scope, () => appFeedback.t("workspaceRemovalUnavailable"));
      return;
    }
    if (isWorkspaceDeletionPending(this.state, workspace)) return;
    const removal = workspace.removal;
    const confirmation = workspaceRemovalConfirmation(workspace);
    if (removal === undefined || confirmation === undefined || !confirm(confirmation)) return;

    const expected = navigationUrlContext(this.beginNavigationOperation(ROUTE_RESTORE_SCOPE));
    try {
      const composition = this.requiredTerminalComposition(machineId);
      const run = composition.facade.parseCommandRun(await workspacesApi.deleteWorkspace(
        workspace.projectId,
        workspace.id,
        removal.precondition,
        machineId,
      ));
      if (!this.recordWorkspaceDeletionRun(run, machineId)) return;
      const commandWorkspace = await this.workspaceForCommandRun(run, machineId);
      if (selectedMachineId(this.state) !== machineId || !this.navigationUrlContextMatchesUrl(expected)) return;
      if (commandWorkspace !== undefined) this.workspaceTerminal("core", commandWorkspace, machineId).open({ terminalId: run.terminalId });
    } catch (error) {
      await this.reportWorkspaceRemovalFailure(workspace, machineId, scope, error);
    }
  }

  private async reportWorkspaceRemovalFailure(workspace: Workspace, machineId: string, scope: BrowserErrorScope, error: unknown): Promise<void> {
    const message = errorMessage(error);
    // A fetch/parser failure and the gateway's explicit daemon-unavailable
    // response have no sessiond-owned notice to rely on, so keep browser
    // feedback even when an older notice for this workspace is still visible.
    if (!(error instanceof HttpRequestError) || message.startsWith("Session daemon unavailable:")) {
      this.browserErrors.reportLocalized(scope, () => appFeedback.t("workspaceRemovalFailed", { detail: errorMessage(error) }));
      return;
    }

    const expectedNoticeMessage = `Workspace removal failed: ${message}`;
    const hasNotice = () => this.serverNotices.hasNotice(machineId, (notice) => {
      const context = notice.context ?? {};
      return notice.source === workspaceDeleteOperation
        && notice.message === expectedNoticeMessage
        && notice.scope?.projectId === workspace.projectId
        && context["targetWorkspaceId"] === workspace.id;
    });
    if (!hasNotice()) await this.serverNotices.refresh(machineId);
    if (!hasNotice()) this.browserErrors.reportLocalized(scope, () => appFeedback.t("workspaceRemovalFailed", { detail: errorMessage(error) }));
  }

  private async workspaceForCommandRun(run: TerminalCommandRun, machineId: string): Promise<Workspace | undefined> {
    let workspaces = this.state.selectedProject?.id === run.projectId ? this.state.workspaces : this.state.workspacesByProjectId[run.projectId];
    if (workspaces === undefined || workspaces.length === 0) {
      workspaces = await this.workspaces.refreshProjectWorkspaces(run.projectId, machineId);
    }
    if (selectedMachineId(this.state) !== machineId || this.state.selectedProject?.id !== run.projectId) return undefined;
    return workspaces.find((workspace) => workspace.id === run.workspaceId);
  }

  private recordWorkspaceDeletionRun(run: TerminalCommandRun, machineId: string): boolean {
    if (selectedMachineId(this.state) !== machineId || this.state.selectedProject?.id !== run.projectId) return false;
    const workspaceId = targetWorkspaceIdForRun(run);
    if (workspaceId === undefined) return false;
    this.setState({ workspaceDeletionRuns: { ...this.state.workspaceDeletionRuns, [workspaceId]: run } });
    this.updateWorkspaceDeletionPolling();
    return true;
  }

  private async refreshWorkspaceDeletionRuns(): Promise<void> {
    const machineId = selectedMachineId(this.state);
    const project = this.state.selectedProject;
    const scope = workspaceDeletionScopeKey(this.state);
    if (project === undefined || scope === undefined || !this.terminalAvailableForMachine(machineId)) {
      this.cancelWorkspaceDeletionRefresh();
      this.setState({ workspaceDeletionRuns: {} });
      return;
    }
    if (this.workspaceDeletionRefreshAbort !== undefined) {
      if (this.workspaceDeletionRefreshScope === scope) {
        this.workspaceDeletionRefreshQueued = true;
        return;
      }
      this.cancelWorkspaceDeletionRefresh();
    }

    const controller = new AbortController();
    const generation = ++this.workspaceDeletionRefreshGeneration;
    this.workspaceDeletionRefreshAbort = controller;
    this.workspaceDeletionRefreshScope = scope;
    try {
      const initiallyTrackedRuns = Object.values(this.state.workspaceDeletionRuns)
        .filter((run) => run.projectId === project.id);
      for (const run of initiallyTrackedRuns) {
        if (!isWorkspaceDeletionRunPending(run)) {
          await this.handleCompletedWorkspaceDeletionRun(run, machineId, project.id, generation, controller);
        }
      }
      if (!this.workspaceDeletionRefreshIsCurrent(machineId, project.id, generation, controller)) return;

      const trackedRuns = Object.values(this.state.workspaceDeletionRuns)
        .filter((run) => run.projectId === project.id);
      const pendingRuns = trackedRuns.filter(isWorkspaceDeletionRunPending);
      if (initiallyTrackedRuns.length > 0 && pendingRuns.length === 0) return;

      const composition = this.requiredTerminalComposition(machineId);
      const filter = workspaceDeletionRunFilter();
      const queryWorkspaces: Pick<Workspace, "id" | "projectId">[] = pendingRuns.length === 0
        ? this.state.workspaces.filter((workspace) => workspace.projectId === project.id)
        : [...new Map(pendingRuns.map((run) => [run.workspaceId, { id: run.workspaceId, projectId: run.projectId }])).values()];
      const runsBeforeQuery = this.state.workspaceDeletionRuns;
      const results = await Promise.allSettled(queryWorkspaces.map(async (workspace) => {
        const peer = createPluginPeer(composition.binding, workspace, machineId);
        if (peer === undefined) throw requiredTerminalUnavailableError(machineId);
        return composition.facade.listCommandRuns({
          peer,
          filter: { metadata: filter.metadata },
          signal: controller.signal,
        });
      }));
      if (!this.workspaceDeletionRefreshIsCurrent(machineId, project.id, generation, controller)) return;
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
      const successfulRuns = results.filter((result): result is PromiseFulfilledResult<TerminalCommandRun[]> => result.status === "fulfilled");
      if (successfulRuns.length === 0 && failures.length > 0) throw failures[0]?.reason;
      for (const failure of failures) console.warn("Failed to query workspace deletion runs for one workspace", failure.reason);
      const failedWorkspaceIds = new Set(results.flatMap((result, index) => {
        const failedWorkspace = result.status === "rejected" ? queryWorkspaces[index] : undefined;
        return failedWorkspace === undefined ? [] : [failedWorkspace.id];
      }));
      // Poll responses must not erase runs recorded or updated while the query was in flight.
      const retainedRuns = Object.entries(this.state.workspaceDeletionRuns).filter(([workspaceId, run]) =>
        run.projectId === project.id && (run !== runsBeforeQuery[workspaceId]
          || (isWorkspaceDeletionRunPending(run) && failedWorkspaceIds.has(run.workspaceId))))
        .map(([, run]) => run);
      const discoveredRuns = [...successfulRuns.flatMap((result) => result.value), ...retainedRuns]
        .filter((run) => !this.handledWorkspaceDeletionRunIds.has(machineScopedKey(machineId, run.id)));
      const latestRuns = latestWorkspaceDeletionRuns(discoveredRuns);
      this.setState({ workspaceDeletionRuns: latestRuns });
      for (const run of Object.values(latestRuns)) {
        if (!isWorkspaceDeletionRunPending(run)) {
          await this.handleCompletedWorkspaceDeletionRun(run, machineId, project.id, generation, controller);
        }
      }
    } catch (error) {
      if (!controller.signal.aborted && this.workspaceDeletionRefreshIsCurrent(machineId, project.id, generation, controller)) {
        console.warn("Failed to refresh workspace deletion runs", error);
      }
    } finally {
      if (this.workspaceDeletionRefreshAbort === controller) {
        this.workspaceDeletionRefreshAbort = undefined;
        this.workspaceDeletionRefreshScope = undefined;
        const refreshQueued = this.workspaceDeletionRefreshQueued;
        this.workspaceDeletionRefreshQueued = false;
        if (refreshQueued && workspaceDeletionScopeKey(this.state) === scope) {
          if (this.workspaceDeletionPollTimer !== undefined) window.clearTimeout(this.workspaceDeletionPollTimer);
          this.workspaceDeletionPollTimer = undefined;
          queueMicrotask(() => { void this.refreshWorkspaceDeletionRuns(); });
        } else {
          this.updateWorkspaceDeletionPolling();
        }
      }
    }
  }

  private workspaceDeletionRefreshIsCurrent(
    machineId: string,
    projectId: string,
    generation: number,
    controller: AbortController,
  ): boolean {
    return this.workspaceDeletionRefreshAbort === controller
      && !controller.signal.aborted
      && generation === this.workspaceDeletionRefreshGeneration
      && selectedMachineId(this.state) === machineId
      && this.state.selectedProject?.id === projectId;
  }

  private cancelWorkspaceDeletionRefresh(): void {
    this.workspaceDeletionRefreshGeneration += 1;
    this.workspaceDeletionRefreshAbort?.abort(new DOMException("Workspace deletion scope changed", "AbortError"));
    this.workspaceDeletionRefreshAbort = undefined;
    this.workspaceDeletionRefreshScope = undefined;
    this.workspaceDeletionRefreshQueued = false;
    this.workspaceDeletionReconcileRetries.clear();
    if (this.workspaceDeletionPollTimer !== undefined) window.clearTimeout(this.workspaceDeletionPollTimer);
    this.workspaceDeletionPollTimer = undefined;
  }

  private updateWorkspaceDeletionPolling(): void {
    const machineId = selectedMachineId(this.state);
    const now = Date.now();
    let nextDelay = Number.POSITIVE_INFINITY;
    for (const run of Object.values(this.state.workspaceDeletionRuns)) {
      const runKey = machineScopedKey(machineId, run.id);
      if (this.handledWorkspaceDeletionRunIds.has(runKey)) continue;
      if (isWorkspaceDeletionRunPending(run)) {
        nextDelay = Math.min(nextDelay, 1_000);
        continue;
      }
      const retryAt = this.workspaceDeletionReconcileRetries.get(runKey)?.retryAt ?? now;
      nextDelay = Math.min(nextDelay, Math.max(0, retryAt - now));
    }
    if (Number.isFinite(nextDelay) && this.workspaceDeletionPollTimer === undefined) {
      this.workspaceDeletionPollTimer = window.setTimeout(() => {
        this.workspaceDeletionPollTimer = undefined;
        void this.refreshWorkspaceDeletionRuns();
      }, nextDelay);
      return;
    }
    if (!Number.isFinite(nextDelay) && this.workspaceDeletionPollTimer !== undefined) {
      window.clearTimeout(this.workspaceDeletionPollTimer);
      this.workspaceDeletionPollTimer = undefined;
    }
  }

  private async handleCompletedWorkspaceDeletionRun(
    run: TerminalCommandRun,
    machineId: string,
    projectId: string,
    generation: number,
    controller: AbortController,
  ): Promise<void> {
    if (!this.workspaceDeletionRefreshIsCurrent(machineId, projectId, generation, controller)) return;
    const runKey = machineScopedKey(machineId, run.id);
    if (this.handledWorkspaceDeletionRunIds.has(runKey)) return;
    const workspaceId = targetWorkspaceIdForRun(run);
    if (workspaceId === undefined) return;

    if (run.status === "succeeded") {
      const retry = this.workspaceDeletionReconcileRetries.get(runKey);
      if (retry !== undefined && retry.retryAt > Date.now()) return;
      const errorScope = workspaceBrowserErrorScope(machineId, run.projectId, workspaceId);
      try {
        await this.workspaces.refreshAfterWorkspaceDeleted(run.projectId, workspaceId, machineId, {
          signal: controller.signal,
          isCurrent: () => this.workspaceDeletionRefreshIsCurrent(machineId, projectId, generation, controller),
        });
      } catch (error) {
        if (!this.workspaceDeletionRefreshIsCurrent(machineId, projectId, generation, controller)) return;
        const attempt = (retry?.attempt ?? 0) + 1;
        const delay = WORKSPACE_DELETION_RECONCILE_RETRY_DELAYS_MS[
          Math.min(attempt - 1, WORKSPACE_DELETION_RECONCILE_RETRY_DELAYS_MS.length - 1)
        ] ?? 10_000;
        this.workspaceDeletionReconcileRetries.set(runKey, { attempt, retryAt: Date.now() + delay });
        this.browserErrors.reportLocalized(errorScope, () => appFeedback.t("workspaceRemovalRefreshFailed", { detail: errorMessage(error) }));
        return;
      }
      if (!this.workspaceDeletionRefreshIsCurrent(machineId, projectId, generation, controller)) return;
      this.workspaceDeletionReconcileRetries.delete(runKey);
      this.handledWorkspaceDeletionRunIds.add(runKey);
      this.browserErrors.discard(errorScope);
      this.setState({ workspaceDeletionRuns: omitWorkspaceDeletionRun(this.state.workspaceDeletionRuns, workspaceId) });
      return;
    }

    if (run.status === "failed") {
      this.workspaceDeletionReconcileRetries.delete(runKey);
      this.handledWorkspaceDeletionRunIds.add(runKey);
    }
  }

  private openMachineDialog(): void {
    this.machineNameEditTarget = undefined;
    this.setState({ machineDialogOpen: true, error: "" });
  }

  private async submitMachineDialog(input: MachineDialogSubmit): Promise<void> {
    const machine = this.machineNameEditTarget === undefined
      ? await this.machines.addMachine(input)
      : await this.machines.updateMachine(this.machineNameEditTarget.id, input.name);
    if (machine !== undefined) {
      this.setState({ machineDialogOpen: false });
      this.schedulePiWebStatusRefresh();
    }
  }

  private async removeMachine(machine: Machine | undefined = this.state.selectedMachine): Promise<void> {
    if (machine === undefined || machine.kind === "local") return;
    if (!window.confirm(appFeedback.t("removeMachine", { name: machine.name }))) return;
    const wasSelected = this.state.selectedMachine?.id === machine.id;
    if (wasSelected) this.rememberCurrentMachineNavigation();
    const fallback = await this.machines.deleteMachine(machine, { selectFallback: !wasSelected });
    if (!this.state.machines.some((candidate) => candidate.id === machine.id)) this.machineNavigation.forget(machine.id);
    if (this.state.selectedMachine?.id === machine.id && fallback !== undefined) {
      const expected = navigationSelectionFromState(this.state);
      await this.selectMachineWithMemory(fallback, { rememberCurrent: false, expected });
    }
  }

  private openSelectedMachine(): void {
    const machine = this.state.selectedMachine;
    if (machine?.kind !== "remote" || machine.baseUrl === undefined) return;
    window.open(machine.baseUrl, "_blank", "noopener,noreferrer");
  }

  private runAction(action: AppAction): void {
    void Promise.resolve()
      .then(() => action.run())
      .catch((error: unknown) => {
        console.warn(`Action failed: ${action.id}`, error);
        this.browserErrors.reportLocalized({ kind: "global" }, () => appFeedback.t("actionFailed", { detail: errorMessage(error) }));
      });
  }

  private async openModelDialog() {
    const session = this.state.selectedSession;
    if (session === undefined) return;
    const origin: ModelDialogOrigin = { machineId: selectedMachineId(this.state), sessionId: session.id, cwd: session.cwd };
    const [{ models, catalog }, defaults] = await Promise.all([this.loadModelDialogData(), this.sessions.getSessionDefaults()]);
    if (!this.modelDialogOriginIsCurrent(origin)) return;
    const selectedValue = this.currentModelValue();
    this.setState({
      modelDialog: {
        instanceId: ++this.modelDialogInstanceId,
        origin,
        get title() { return pickerMessages.t("selectModel"); },
        defaultsLoading: defaults === undefined,
        ...(defaults?.defaultProvider !== undefined && defaults.defaultModel !== undefined ? { defaultValue: `${defaults.defaultProvider}/${defaults.defaultModel}` } : {}),
        ...(selectedValue !== undefined ? { selectedValue } : {}),
        options: this.modelDialogOptions(models),
        catalog,
      },
    });
  }

  private async loadModelDialogData(): Promise<{ models: SessionModel[]; catalog: SessionModelCatalogEntry[] }> {
    for (;;) {
      const invalidation = this.modelDialogScopeInvalidation;
      const [models, catalog] = await Promise.all([this.sessions.listModels(), this.sessions.listModelCatalog()]);
      if (invalidation === this.modelDialogScopeInvalidation) return { models, catalog };
    }
  }

  /** Refresh an already-open picker after another session changes the shared scope. */
  private async refreshOpenModelDialog(): Promise<void> {
    if (this.modelDialogMutationInFlight > 0) {
      this.modelDialogRefreshPending = true;
      return;
    }
    const dialog = this.currentModelDialog();
    if (dialog === undefined) return;
    const origin = dialog.origin;
    const instanceId = dialog.instanceId;
    const { models, catalog } = await this.loadModelDialogData();
    if (this.modelDialogMutationInFlight > 0 || this.state.modelDialog?.instanceId !== instanceId || !this.modelDialogOriginIsCurrent(origin)) return;
    const refreshedDialog = { ...dialog, options: this.modelDialogOptions(models), catalog };
    const selectedValue = this.currentModelValue();
    if (selectedValue === undefined) delete refreshedDialog.selectedValue;
    else refreshedDialog.selectedValue = selectedValue;
    this.setState({ modelDialog: refreshedDialog });
  }

  private currentModelValue(): string | undefined {
    return modelValueFromStatus(this.state.status);
  }

  private modelDialogOptions(models: readonly Pick<SessionModel, "provider" | "id">[]): CommandOption[] {
    const selectedValue = this.currentModelValue();
    return models.map((model) => {
      const provider = model.provider ?? "";
      const id = model.id ?? "";
      const value = `${provider}/${id}`;
      return { value, get label() { return value === selectedValue ? pickerMessages.t("currentModel", { model: id }) : id; }, description: provider };
    });
  }

  private async pickModel(value: string) {
    this.setState({ modelDialog: undefined });
    const slash = value.indexOf("/");
    if (slash <= 0) return;
    await this.sessions.setModel(value.slice(0, slash), value.slice(slash + 1));
  }

  private openThemeDialog(): void {
    this.navigateSettings("general");
  }

  private pickTheme(preference: ThemePreference): void {
    if (getThemePolicy().enforcedBy !== undefined) return;
    if (!this.plugins.getThemes().some((theme) => theme.id === preference.themeId)) return;
    this.localThemePreference = { ...preference };
    cancelInitialTheme();
    this.applyPreferredTheme(true);
  }

  private useDefaultTheme(): void {
    if (getThemePolicy().enforcedBy !== undefined) return;
    this.localThemePreference = undefined;
    cancelInitialTheme();
    clearStoredThemePreference();
    this.applyPreferredTheme(false);
  }

  private registerThemeCatalog(catalog: BrowserThemeCatalog, append = false): void {
    if (!append) {
      this.themeRequest?.abort();
      this.themeRequest = undefined;
    }
    this.declarativeThemes = append && this.declarativeThemes !== undefined ? mergeThemeCatalog(this.declarativeThemes, catalog) : catalog;
    this.plugins.setDeclarativeThemes(
      this.declarativeThemes.themes.map((theme) => localizeBuiltInThemeMetadata(theme)),
      this.declarativeThemes.themePairs.map((pair) => localizeBuiltInThemeMetadata(pair)),
    );
    this.requestUpdate();
  }

  private loadPreferredThemeIfNeeded(themes: readonly QualifiedThemeContribution[]): void {
    const preference = this.themePreference;
    const available = themes.some((theme) => theme.id === preference.themeId);
    if (this.requestedThemeId !== preference.themeId || available) {
      this.themeRequest?.abort();
      this.themeRequest = undefined;
      if (this.requestedThemeId === preference.themeId) return;
      this.requestedThemeId = preference.themeId;
      if (available || (this.declarativeThemes !== undefined && preference.themeId === bootstrapPreference(this.declarativeThemes, undefined).themeId)) return;
      const controller = new AbortController();
      this.themeRequest = controller;
      void loadThemeBootstrap(preference, controller.signal).then((response) => {
        if (controller.signal.aborted || !this.isConnected) return;
        this.registerThemeCatalog(response.catalog, true);
        addThemeStylesheets(response.stylesheets);
      }).catch((error: unknown) => {
        if (!controller.signal.aborted) console.warn("Could not load the preferred theme; keeping the available palette", error);
      }).finally(() => {
        if (this.themeRequest === controller) {
          this.themeRequest = undefined;
          this.requestUpdate();
        }
      });
    }
  }

  private syncPluginStylesheets(): void {
    if (!this.isConnected) return;
    this.stylesheetRuntime.update(this.plugins.getStylesheets(selectedMachineId(this.state)));
    if (themeStartup.pending) return;
    const themes = this.plugins.getThemes();
    if (this.activeThemeId !== "" && !themes.some((theme) => theme.id === this.activeThemeId)) {
      this.stylesheetRuntime.clearTheme(() => {
        this.activeThemeId = "";
        clearPiWebTheme();
        this.activeThemeColorScheme = this.startupColorScheme();
        this.syncFileIcons();
      });
    }
    if (this.themeConfigReady) this.loadPreferredThemeIfNeeded(themes);
    if (this.themeRequest !== undefined) {
      this.stylesheetRuntime.suspendTheme();
      return;
    }
    const theme = this.themeConfigReady ? this.resolveCurrentThemePreference(themes).activeTheme : undefined;
    if (theme === undefined) {
      this.stylesheetRuntime.suspendTheme();
      return;
    }
    this.stylesheetRuntime.updateTheme(theme, () => {
      this.activeThemeId = theme.id;
      this.activeThemeColorScheme = theme.colorScheme;
      applyPiWebTheme(theme);
      this.syncFileIcons();
      this.revealAfterRender();
    });
  }

  private selectFileIconTheme(id: string | undefined): void {
    if (id !== undefined && id !== NO_FILE_ICONS && !this.plugins.getFileIconThemes().some((theme) => theme.id === id)) return;
    this.fileIconPreference = id;
    writeStoredFileIconPreference(id);
    this.syncFileIcons();
  }

  private syncFileIcons(): void {
    this.fileIcons.update(this.plugins.getFileIconThemes(), this.fileIconPreference, this.activeThemeColorScheme);
  }

  private applyPreferredTheme(persist: boolean): void {
    if (persist) writeStoredThemePreference(this.themePreference);
    this.syncPluginStylesheets();
  }

  private resolveCurrentThemePreference(themes = this.plugins.getThemes()): ThemePreferenceResolution {
    return resolveThemePreference({
      themes,
      themePairs: this.plugins.getThemePairs(),
      preference: this.themePreference,
      prefersLight: this.systemPrefersLight(),
      // Missing choices keep the already committed palette; they do not select
      // a different fallback or rewrite the browser's preference.
      pending: true,
    });
  }

  private revealAfterRender(): void {
    void this.updateComplete.then(() => { if (this.isConnected) revealApplication(); });
  }

  private startupColorScheme(): "light" | "dark" {
    return this.systemPrefersLight() ? "light" : "dark";
  }

  private systemPrefersLight(): boolean {
    return this.systemLightThemeMedia?.matches ?? false;
  }

  private async openThinkingDialog() {
    const session = this.state.selectedSession;
    if (session === undefined) return;
    const origin: ModelDialogOrigin = { machineId: selectedMachineId(this.state), sessionId: session.id, cwd: session.cwd };
    const [levels, defaults] = await Promise.all([this.sessions.listThinkingLevels(), this.sessions.getSessionDefaults()]);
    if (!this.modelDialogOriginIsCurrent(origin)) return;
    const current = this.state.status?.thinkingLevel ?? "off";
    this.setState({
      thinkingDialog: {
        get title() { return pickerMessages.t("selectThinking"); },
        origin,
        defaultsLoading: defaults === undefined,
        ...(defaults?.defaultThinkingLevel === undefined ? {} : { defaultValue: defaults.defaultThinkingLevel }),
        selectedValue: current,
        options: levels.map((level) => ({
          value: level,
          get label() { return level === current ? pickerMessages.t("currentModel", { model: level }) : level; },
          get description() { return thinkingDescription(level) ?? ""; },
        })),
      },
    });
  }

  private readonly handleSetDefaultModel = async (value: string): Promise<void> => {
    const dialog = this.currentModelDialog();
    if (dialog === undefined) return;
    const separator = value.indexOf("/");
    if (separator < 1) return;
    const defaults = await this.sessions.setSessionDefaults({ provider: value.slice(0, separator), modelId: value.slice(separator + 1) });
    const current = this.currentModelDialog();
    if (defaults === undefined || current?.instanceId !== dialog.instanceId) return;
    if (defaults.defaultProvider !== undefined && defaults.defaultModel !== undefined) {
      this.setState({ modelDialog: { ...current, defaultValue: `${defaults.defaultProvider}/${defaults.defaultModel}` } });
    }
  };

  private readonly handleSetDefaultThinking = async (value: string): Promise<void> => {
    const dialog = this.state.thinkingDialog;
    if (dialog?.origin === undefined || !this.modelDialogOriginIsCurrent(dialog.origin)) return;
    if (value !== "off" && value !== "minimal" && value !== "low" && value !== "medium" && value !== "high" && value !== "xhigh" && value !== "max") return;
    const defaults = await this.sessions.setSessionDefaults({ thinkingLevel: value });
    if (defaults?.defaultThinkingLevel === undefined || this.state.thinkingDialog !== dialog || !this.modelDialogOriginIsCurrent(dialog.origin)) return;
    this.setState({ thinkingDialog: { ...dialog, defaultValue: defaults.defaultThinkingLevel } });
  };

  private async pickThinking(value: string) {
    this.setState({ thinkingDialog: undefined });
    if (value !== "") await this.sessions.setThinkingLevel(value);
  }

  private async sendPrompt(text: string, streamingBehavior?: "steer" | "followUp", attachments?: import("../api").PromptAttachment[], delivery?: import("../../../shared/apiTypes").PromptAttachmentDelivery, folder?: string, chips: readonly StagedPromptChip[] = []): Promise<boolean> {
    if (this.unacknowledgedActivitySessionKey() !== undefined) return false;
    const hasAttachments = attachments !== undefined && attachments.length > 0;
    if (chips.length === 0) {
      if (!hasAttachments && streamingBehavior === undefined && this.auth.handleSlashCommand(text)) return false;
      return this.sessions.send(text, streamingBehavior, attachments, delivery, folder);
    }
    const target = chips[0]?.target;
    if (target === undefined || chips.some((chip) => !samePromptChipTarget(chip.target, target) || !this.plugins.promptChipOwnerAvailable(chip.pluginId, target.machineId))) return false;
    const accepted = await this.sessions.send(appendPromptChipText(text, chips), streamingBehavior, attachments, delivery, folder, target);
    if (accepted) this.plugins.promptChips.consume(chips);
    return accepted;
  }

  // Stable handler identities for child components. Inlined arrow closures
  // would be a fresh reference on every render, forcing Lit to re-commit the
  // bindings each time the app re-renders; bound class fields keep them constant.
  private readonly handleSendPrompt = (text: string, streamingBehavior?: "steer" | "followUp", attachments?: import("../api").PromptAttachment[], delivery?: import("../../../shared/apiTypes").PromptAttachmentDelivery, folder?: string, chips?: readonly StagedPromptChip[]): Promise<boolean> => {
    return this.sendPrompt(text, streamingBehavior, attachments, delivery, folder, chips);
  };

  private visiblePromptChips: readonly StagedPromptChip[] = [];

  private selectedPromptChips(): readonly StagedPromptChip[] {
    const machineId = selectedMachineId(this.state);
    const sessionId = this.state.selectedSession?.id;
    const chips = sessionId === undefined ? [] : this.plugins.promptChips.list({ machineId, sessionId })
      .filter((chip) => this.plugins.promptChipOwnerAvailable(chip.pluginId, machineId));
    // Keep the property stable during per-token status updates; otherwise an
    // empty chip list would undo the composer's render-churn protection.
    if (chips.length !== this.visiblePromptChips.length || chips.some((chip, index) => chip !== this.visiblePromptChips[index])) this.visiblePromptChips = chips;
    return this.visiblePromptChips;
  }

  private readonly handleRemovePromptChip = (chip: StagedPromptChip): void => {
    this.plugins.promptChips.removeByUser(chip);
  };

  private readonly handleStopActiveWork = (): void => {
    void this.sessions.stopActiveWork();
  };

  private readonly handleQueuedMessageAction = async (target: QueuedMessageActionTarget): Promise<void> => {
    if (this.queuedMessageActionTarget !== undefined || this.messageRevertTarget !== undefined) return;
    if (selectedMachineId(this.state) !== target.machineId || this.state.selectedSession?.id !== target.sessionId) return;
    const editor = this.promptEditor;
    if (target.action === "edit") {
      const confirmation = queuedMessageRecallConfirmation(target.expectedQueue, target.index);
      if (confirmation !== undefined && !window.confirm(confirmation)) return;
      if ((editor?.view?.state.doc.toString() ?? "") !== "" && !window.confirm(chatActionMessages.t("recallDraft"))) return;
    }
    this.queuedMessageActionTarget = target;
    try {
      if (target.action === "edit" && editor !== undefined) {
        editor.disabled = true;
        await editor.updateComplete;
      }
      const currentState = this.state;
      if (selectedMachineId(currentState) !== target.machineId || currentState.selectedSession?.id !== target.sessionId) return;
      await this.sessions.mutateQueuedMessage(target.action, target.index, target.expectedQueue);
    } finally {
      if (this.queuedMessageActionTarget === target) this.queuedMessageActionTarget = undefined;
      this.requestUpdate();
    }
  };

  private readonly handleClearServerQueue = (): void => {
    void this.sessions.clearServerQueue();
  };

  private readonly handleNoticeDismiss = (event: CustomEvent<SessionNoticeDismissDetail>): void => {
    const { machineId, sessionId, dismissId } = event.detail;
    if (machineId !== selectedMachineId(this.state) || sessionId !== this.state.selectedSession?.id) return;
    void this.sessions.dismissWarning(dismissId);
  };

  private readonly handleSubmitAsk = (askId: string, submission: AskUserSubmission): Promise<void> => this.sessions.submitAsk(askId, submission);

  private readonly handleAnswerDialog = (dialogId: string, value: ExtensionDialogAnswer): Promise<void> => this.sessions.answerDialog(dialogId, value);

  private readonly handleCancelDialog = (dialogId: string): Promise<void> => this.sessions.cancelDialog(dialogId);

  private readonly handleDismissClosedDialog = (dialogId: string): void => {
    this.sessions.dismissClosedDialog(dialogId);
  };

  private readonly handleDismissNotification = (notificationId: string): void => {
    void this.notifications.dismissNotification(notificationId);
  };

  private readonly handleDismissAllNotifications = (): void => {
    void this.notifications.dismissAll();
  };

  private readonly handleSelectModel = (): void => {
    void this.openModelDialog();
  };

  private readonly handleToggleModelEnabled = async (provider: string, modelId: string, enabled: boolean): Promise<void> => {
    const dialog = this.currentModelDialog();
    if (dialog === undefined) return;
    this.modelDialogMutationInFlight += 1;
    try {
      const catalog = await this.sessions.setModelEnabled(provider, modelId, enabled);
      this.applyModelDialogCatalog(dialog, catalog);
    } finally {
      this.modelDialogMutationInFlight -= 1;
      if (this.modelDialogMutationInFlight === 0 && this.modelDialogRefreshPending) {
        this.modelDialogRefreshPending = false;
        void this.refreshOpenModelDialog();
      }
    }
  };

  private readonly handleSetModelScope = async (mode: SessionModelScopeMode): Promise<void> => {
    const dialog = this.currentModelDialog();
    if (dialog === undefined) return;
    this.modelDialogMutationInFlight += 1;
    try {
      const catalog = await this.sessions.setModelScope(mode);
      this.applyModelDialogCatalog(dialog, catalog);
    } finally {
      this.modelDialogMutationInFlight -= 1;
      if (this.modelDialogMutationInFlight === 0 && this.modelDialogRefreshPending) {
        this.modelDialogRefreshPending = false;
        void this.refreshOpenModelDialog();
      }
    }
  };

  private currentModelDialog(): NonNullable<AppState["modelDialog"]> | undefined {
    const dialog = this.state.modelDialog;
    if (dialog !== undefined && this.modelDialogOriginIsCurrent(dialog.origin)) return dialog;
    if (dialog !== undefined) this.setState({ modelDialog: undefined });
    return undefined;
  }

  private modelDialogOriginIsCurrent(origin: ModelDialogOrigin): boolean {
    const session = this.state.selectedSession;
    return session !== undefined && origin.machineId === selectedMachineId(this.state) && origin.sessionId === session.id && origin.cwd === session.cwd;
  }

  private applyModelDialogCatalog(dialog: NonNullable<AppState["modelDialog"]>, catalog: SessionModelCatalogEntry[] | undefined): void {
    if (catalog === undefined || this.state.modelDialog?.instanceId !== dialog.instanceId || !this.modelDialogOriginIsCurrent(dialog.origin)) return;
    // The fresh catalog's enabled rows are the session's Enabled list in
    // order, so rebuilding both data sets keeps the dialog's modes and pi's
    // persisted scope consistent without another round trip.
    this.setState({ modelDialog: { ...dialog, catalog, options: this.modelDialogOptions(catalog.filter((entry) => entry.enabled)) } });
  }

  private readonly handleSelectThinking = (): void => {
    void this.openThinkingDialog();
  };

  private readonly emptyClientQueue: NonNullable<AppState["clientQueuedSessionMessages"][string]> = [];
  private messageActionInputs = "";
  private messageActionSnapshot: Omit<MessageActionAvailabilityContext, "message"> | undefined;

  private messageActionContext(state: AppState): Omit<MessageActionAvailabilityContext, "message"> | undefined {
    const session = publicPluginSelection(state).selectedSession;
    if (session === undefined) return undefined;
    const context = {
      machine: Object.freeze(pluginMachineFromState(state)),
      session: Object.freeze({ ...session, busy: state.sendingPrompts[session.id] === true || isSessionActive(state.status, state.activity) }),
    };
    const inputs = JSON.stringify(context);
    if (inputs !== this.messageActionInputs) {
      this.messageActionInputs = inputs;
      this.messageActionSnapshot = context;
    }
    return this.messageActionSnapshot;
  }

  private readonly handleMessageAction = async (target: MessageActionAvailabilityContext, actionId: string): Promise<MessageActionResult> => {
    const state = this.state;
    const context = this.messageActionContext(state);
    if (context?.machine.id !== target.machine.id || context.session.id !== target.session.id) return;
    const message = state.messages.find((item) => item.entryId === target.message.entryId);
    const snapshot = message === undefined ? undefined : messageActionMessage(message, target.message.role);
    if (snapshot === undefined) return;
    const input = { ...context, message: snapshot };
    return this.plugins.runMessageAction(actionId, input, (binding): MessageActionContext => {
      const isCurrent = () => selectedMachineId(this.state) === input.machine.id && this.state.selectedSession?.id === input.session.id;
      const actOnHistory = async (action: "fork" | "back"): Promise<void> => {
        if (!isCurrent() || !this.plugins.promptChipOwnerAvailable(binding.registrationPluginId, input.machine.id)) {
          throw new HistoryActionError("conversationUnavailable");
        }
        if (action === "fork") return this.sessions.actOnMessage(input.message.entryId, action);
        if (this.messageRevertTarget !== undefined || this.queuedMessageActionTarget !== undefined) throw new HistoryActionError("draftActionPending");
        const editor = this.promptEditor;
        const draft = editor?.view?.state.doc.toString() ?? "";
        if (input.message.role === "user" && draft !== "" && !window.confirm(chatActionMessages.t("backDraft"))) return;

        const target = { machineId: input.machine.id, sessionId: input.session.id };
        this.messageRevertTarget = target;
        try {
          // Lock only until the response restores the text, not while history
          // refreshes. This prevents typing during the request from being lost.
          if (editor) {
            editor.disabled = true;
            await editor.updateComplete;
          }
          if (!isCurrent()) return;
          await this.sessions.actOnMessage(input.message.entryId, action);
        } finally {
          if (this.messageRevertTarget === target) this.messageRevertTarget = undefined;
        }
      };
      return {
        ...input,
        ...this.messageActionHelpers(binding, input),
        history: { fork: () => actOnHistory("fork"), goBack: () => actOnHistory("back") },
      };
    });
  };

  private isRevertingMessage(state: AppState): boolean {
    return (this.messageRevertTarget?.machineId === selectedMachineId(state)
      && this.messageRevertTarget.sessionId === state.selectedSession?.id)
      || (this.queuedMessageActionTarget?.action === "edit"
        && this.queuedMessageActionTarget.machineId === selectedMachineId(state)
        && this.queuedMessageActionTarget.sessionId === state.selectedSession?.id);
  }

  private readonly handleDisplayedMessageAction = async (target: DisplayedMessageActionAvailabilityContext, actionId: string): Promise<MessageActionResult> => {
    const context = this.messageActionContext(this.state);
    if (context?.machine.id !== target.machine.id || context.session.id !== target.session.id) return;
    // Display workflows operate on the clicked slice, even before it has an
    // entry ID or when several normalized lines share the same durable ID.
    const input = { ...context, message: target.message };
    return this.plugins.runDisplayedMessageAction(actionId, input, (binding) => ({
      ...input,
      ...this.messageActionHelpers(binding, input),
    }));
  };

  private messageActionHelpers(
    binding: WorkspacePluginBinding,
    input: Omit<MessageActionAvailabilityContext, "message">,
  ): Omit<MessageActionContext, "machine" | "session" | "message" | "history"> {
    const state = this.state;
    const machineId = input.machine.id;
    const workspace = state.selectedWorkspace;
    const workspaceSnapshot = publicPluginSelection(state).selectedWorkspace;
    const peer = workspace === undefined ? undefined : createPluginPeer(binding, workspace, machineId);
    const isCurrent = () => selectedMachineId(this.state) === machineId && this.state.selectedSession?.id === input.session.id;
    const prompt = this.createPromptEditor(binding.registrationPluginId, machineId);
    return {
      prompt: {
        ...prompt,
        insertText: (text) => { if (isCurrent()) prompt.insertText(text); },
        getText: () => isCurrent() ? prompt.getText() : "",
        getSelection: () => isCurrent() ? prompt.getSelection() : null,
      },
      navigate: (destination, options) => this.navigate(destination, options, machineId),
      projects: createPluginProjects(projectsApi, machineId),
      ...(workspace === undefined || workspaceSnapshot === undefined ? {} : {
        workspace: workspaceSnapshot,
        files: this.createWorkspaceFiles(workspace, input.machine),
        ...(this.terminalAvailableForMachine(machineId) ? { terminal: this.workspaceTerminal(binding.registrationPluginId, workspace, machineId) } : {}),
      }),
      ...(peer === undefined ? {} : { peer }),
    };
  }
  private readonly handleLoadEarlierMessages = () => this.withChatPrependTransition(() => this.sessions.loadEarlierMessages());
  private notificationViewInput: AppState["selectedNotificationInbox"];
  private notificationView: ReturnType<typeof selectedNotificationView>;
  private chatWorkspaceContext: MarkdownWorkspaceContext | undefined;
  private chatWorkspaceContextKey: string | undefined;

  private renderChatView(state: AppState, session: SessionInfo) {
    const workspaceContext = markdownWorkspaceContext(selectedMachineId(state), state.selectedWorkspace, session);
    const contextKey = JSON.stringify(workspaceContext);
    // Unrelated shell updates must not invalidate every formatted transcript part.
    if (contextKey !== this.chatWorkspaceContextKey) {
      this.chatWorkspaceContextKey = contextKey;
      this.chatWorkspaceContext = workspaceContext;
    }
    if (this.notificationViewInput !== state.selectedNotificationInbox) {
      this.notificationViewInput = state.selectedNotificationInbox;
      this.notificationView = selectedNotificationView(state.selectedNotificationInbox);
    }
    return html`
      <chat-view .onNavigationChange=${this.handleChatNavigationChange} .quietMode=${this.quietMode} .behaviors=${this.chatBehaviors} .contentRendering=${this.plugins.getChatContentRendering(selectedMachineId(state))} .machineId=${selectedMachineId(state)} @workspace-file-open=${this.handleWorkspaceFileOpen} .workspaceContext=${this.chatWorkspaceContext} .sessionId=${session.id} .sessionCwd=${session.cwd} .onMessageAction=${this.handleMessageAction} .onDisplayedMessageAction=${this.handleDisplayedMessageAction} .messageActions=${this.plugins.getMessageActions(selectedMachineId(state))} .messageActionContext=${this.messageActionContext(state)} .messages=${state.messages} .messageStart=${state.messagePageStart} .messageEnd=${state.messagePageEnd} .messageTotal=${state.messagePageTotal} .hasMore=${state.messagePageStart > 0} .historyReady=${this.readyChatIdentity === selectedChatIdentity(state)} .loadingMore=${state.isLoadingEarlierMessages} .isSendingPrompt=${state.sendingPrompts[session.id] === true} .isCompacting=${state.status?.isCompacting === true} .pendingMessageCount=${state.status?.pendingMessageCount ?? 0} .clientQueuedMessages=${state.clientQueuedSessionMessages[session.id] ?? this.emptyClientQueue} .status=${state.status} .activity=${state.activity} .pendingDialogs=${state.pendingDialogs} .closedDialogs=${state.closedDialogs} .onAnswerDialog=${this.handleAnswerDialog} .onCancelDialog=${this.handleCancelDialog} .onDismissClosedDialog=${this.handleDismissClosedDialog} .askDraftSessionId=${machineSessionKey(selectedMachineId(state), session.id)} .onSubmitAsk=${session.archived === true ? undefined : this.handleSubmitAsk} .notificationInbox=${this.notificationView} .onClearServerQueue=${this.handleClearServerQueue} .onQueuedMessageAction=${session.archived === true ? undefined : this.handleQueuedMessageAction} .queuedMessageActionPending=${this.queuedMessageActionTarget !== undefined || this.messageRevertTarget !== undefined} .onDismissNotification=${this.handleDismissNotification} .onDismissAllNotifications=${this.handleDismissAllNotifications} .onLoadMore=${this.handleLoadEarlierMessages}></chat-view>
    `;
  }

  private renderStatusBar(state: AppState) {
    return html`<status-bar slot="status" .status=${state.status}></status-bar>`;
  }

  private readonly handleOpenNavigationSection = (section: NavigationSection) => { this.openNavigationSection(section); };
  private readonly handleReloadApp = () => { this.hardReloadApp(); };

  @state() private navigationPreferences = loadNavigationPreferences();
  @state() private navigationDialogOpen = false;

  private navigationOpener: HTMLElement | undefined;
  private readonly showNavigation = () => {
    const active = deepActiveElement(this.ownerDocument);
    this.navigationOpener = active instanceof HTMLElement ? active : undefined;
    this.navigationDialogOpen = true;
  };
  private readonly closeNavigation = () => {
    this.navigationDialogOpen = false;
    const opener = this.navigationOpener;
    this.navigationOpener = undefined;
    void this.updateComplete.then(() => {
      if (this.navigationDialogOpen || hasRenderedModal(this.ownerDocument)) return;
      if (opener !== undefined && focusElement(opener)) return;
      const restored = deepActiveElement(this.ownerDocument);
      if (restored instanceof HTMLElement && restored !== this && restored !== this.ownerDocument.body
        && restored !== this.ownerDocument.documentElement && focusElement(restored)) return;
      // Collapse/resize may replace the original trigger while the dialog is open.
      for (const host of this.renderRoot.querySelectorAll("app-context-bar, app-mobile-main-tabs, workspace-panel")) {
        const button = host.shadowRoot?.querySelector<HTMLButtonElement>('button[data-navigation-trigger]');
        if (button !== null && button !== undefined && focusElement(button)) return;
      }
    });
  };
  private readonly changeNavigationPreferences = (preferences: NavigationPreferences) => {
    this.navigationPreferences = preferences;
    saveNavigationPreferences(preferences);
  };

  private renderContextBar() {
    if (!this.appShell.isMobileNavigationLayout) return null;
    return html`
      <app-context-bar
        .machines=${this.state.machines}
        .machine=${this.state.selectedMachine}
        .project=${this.state.selectedProject}
        .workspaceSelectionVisible=${shouldShowWorkspaceSelection(this.state.workspaceResolution)}
        .workspace=${this.state.selectedWorkspace}
        .session=${this.state.selectedSession}
        .refreshControl=${this.appShell.shouldShowAppRefreshInContextBar() ? this.renderAppRefresh() : undefined}
        .onOpenSection=${this.handleOpenNavigationSection}
        .onShowNavigation=${this.navigationPreferences.mobileCollapsed ? this.showNavigation : undefined}
        .hiddenActiveDestination=${this.availableNavigationTabs().some((tab) => tab.id === this.selectedNavigationTab())}
        .onShowActions=${this.navigationActions.showActions}
      ></app-context-bar>
    `;
  }

  private renderMobileMainTabs() {
    if (this.appShell.isMobileNavigationLayout && this.navigationPreferences.mobileCollapsed) return null;
    const panels = this.visibleWorkspacePanels();
    const availableTabs = this.availableNavigationTabs(panels);
    const pinnedTabs = pinnedNavigationTabs(availableTabs, this.navigationPreferences.pinnedIds);
    const selectedTab = this.selectedNavigationTab(panels);
    return html`
      <app-mobile-main-tabs
        ?panel-controls=${(!this.appShell.isMobileNavigationLayout && this.panelCollapse.navigationPanelCollapsed) || (this.appShell.isDesktopSideBySideLayout && this.panelCollapse.workspacePanelCollapsed)}
        .controlsOnly=${this.isDesktopSideBySideLayout()}
        .leadingControl=${!this.appShell.isMobileNavigationLayout && this.panelCollapse.navigationPanelCollapsed ? renderPanelToggleButton("navigation", true, this.navigationPanelActions.toggle) : null}
        .trailingControl=${this.appShell.isDesktopSideBySideLayout && this.panelCollapse.workspacePanelCollapsed ? renderPanelToggleButton("workspace", true, this.workspacePanelActions.toggle) : null}
        .tabs=${pinnedTabs}
        .hiddenActiveDestination=${availableTabs.some((tab) => tab.id === selectedTab) && !pinnedTabs.some((tab) => tab.id === selectedTab)}
        .onShowNavigation=${this.showNavigation}
        .selectedTab=${selectedTab}
        .onSelect=${this.selectNavigationTab}
      ></app-mobile-main-tabs>
    `;
  }

  private readonly selectNavigationTab = (tab: AppMobileMainTab["id"]): void => {
    if (tab === "navigation" || tab === "chat") this.selectMainView(tab);
    else this.openWorkspaceTool(tab);
  };

  private selectedNavigationTab(panels = this.visibleWorkspacePanels()): AppMobileMainTab["id"] | undefined {
    const mainView = this.effectiveMainView();
    if (!this.isDesktopSideBySideLayout() && mainView !== "workspace") return mainView;
    // An unavailable destination displays an error, not a remembered/default tool.
    if (this.workspaceContentError() !== "") return undefined;
    return this.effectiveWorkspaceTool(panels);
  }

  private availableNavigationTabs(panels = this.visibleWorkspacePanels()): AppMobileMainTab[] {
    return this.mobileMainTabs(panels).filter((tab) => {
      if (tab.id === "navigation") return this.appShell.isMobileNavigationLayout;
      if (tab.id === "chat") return !this.isDesktopSideBySideLayout();
      return true;
    });
  }

  private mobileMainTabs(panels = this.visibleWorkspacePanels()): AppMobileMainTab[] {
    const unreadCount = unreadSessionCount(this.state.sessions, this.unreadSessionIds);
    return [
      {
        id: "navigation",
        label: appShellText.t("sessions"),
        icon: "navigation",
        className: "navigation-tab",
        ...(unreadCount === 0 ? {} : { badge: unreadCount, badgeLabel: appShellText.t("unread", { count: unreadCount }), badgeTone: "unread" }),
      },
      { id: "chat", label: appShellText.t("chat"), icon: "chat" },
      ...panels.map((panel): AppMobileMainTab => {
        const icon = panel.icon;
        return {
          id: panel.id,
          label: panel.title,
          ...(icon === undefined ? {} : { icon }),
          badge: panel.badge?.(),
        };
      }),
    ];
  }

  private renderAppRefresh() {
    return html`<app-refresh-control .onReload=${this.handleReloadApp}></app-refresh-control>`;
  }

  private renderServerNoticeBanners(): TemplateResult | null {
    const machineId = selectedMachineId(this.state);
    const projection = this.serverNotices.projection(machineId);
    const notices = projection?.status === "fresh" ? visibleServerNotices(projection.notices, browserErrorContext(this.state)) : [];
    if (notices.length === 0) return null;
    return html`${notices.map((notice: ServerNotice) => errorBanner(serverNoticeMessage(notice), () => {
      void this.serverNotices.dismiss(machineId, notice.id);
    }, notice.severity))}`;
  }

  private renderBrowserErrorBanners(state: AppState): TemplateResult | null {
    const errors = this.visibleBrowserErrorsForCurrentRoute(state);
    if (errors.length === 0) return null;
    return html`${errors.map((error) => errorBanner(
      error.displayMessage?.() ?? error.message,
      () => { this.dismissBrowserError(error); },
      "error",
      error.recovery === undefined ? undefined : () => { this.retryBrowserError(error); },
    ))}`;
  }

  private retryBrowserError(error: BrowserError): void {
    if (this.state.browserErrors[browserErrorScopeKey(error.scope)] !== error) return;
    const scope = error.scope;
    if (scope.kind === "session" && error.recovery === "session-refresh" && scope.machineId === selectedMachineId(this.state)) {
      void this.sessions.refreshSelectedSession(scope.sessionId, { recoverNetwork: true });
    } else if (scope.kind === "workspace" && error.recovery === "workspace-sessions-refresh"
      && scope.machineId === selectedMachineId(this.state)
      && scope.workspaceId === this.state.selectedWorkspace?.id
      && scope.projectId === this.state.selectedWorkspace.projectId) {
      void this.sessions.refreshCurrentWorkspaceSessions(scope.machineId, { recoverNetwork: true });
    }
  }

  private visibleBrowserErrorsForCurrentRoute(state: AppState): BrowserError[] {
    return visibleBrowserErrors(state.browserErrors, browserErrorContextForRoute(state, readRoute()));
  }

  private dismissBrowserError(error: BrowserError): void {
    const browserErrors = clearBrowserError(this.state.browserErrors, error.scope, error.message);
    if (browserErrors !== this.state.browserErrors) this.setState({ browserErrors });
  }

  override render() {
    const state = this.state;
    const mainView = this.effectiveMainView();
    const activityNoticeVisible = this.unacknowledgedActivitySessionKey(state) !== undefined;
    return html`
      <div class=${`${this.panelCollapse.shellClass(mainView)}${this.isDesktopSideBySideLayout() ? "" : " two-column-layout"}`} style=${this.panelResize.shellStyle({ navigation: this.resizablePanelConstraints("navigation"), workspace: this.resizablePanelConstraints("workspace") })}>
        <aside id="navigation-panel">${this.appShell.isMobileNavigationLayout ? null : this.renderNavigationPanel()}</aside>
        ${this.renderNavigationPanelEdgeControl()}
        <main class=${mainViewClass(mainView)}>
          ${this.renderContextBar()}
          ${guard([...this.workspaceSurfaceInputs(), state.sessions, this.unreadSessionIds, this.panelCollapse.navigationPanelCollapsed, this.panelCollapse.workspacePanelCollapsed], () => this.renderMobileMainTabs())}
          ${this.unknownRouteView() === undefined ? null : html`<div class="error warning" role="alert"><span class="error-text">${routeFeedback.t("unknownView", { view: this.unknownRouteView() ?? "" })}</span></div>`}
          ${this.renderServerNoticeBanners()}
          ${errorBanner(this.displayedError(), () => { this.dismissDisplayedError(); })}
          ${this.renderBrowserErrorBanners(state)}
          ${deprecatedAgentInputsBanner(deprecatedAgentInputsWarnings(state.machines, state.machineRuntimes))}
          <div class="mobile-navigation-panel">${this.appShell.isMobileNavigationLayout ? this.renderNavigationPanel() : null}</div>
          ${state.selectedSession && !this.sessions.isChatLoadDeferred && (this.isChatVisible() || this.displayedChatIdentity === selectedChatIdentity(state)) ? html`
            ${this.isChatVisible() ? html`<conversation-sync-notice .state=${state.conversationSync} .onRetry=${() => { void this.sessions.resumeSelectedSession({ reconnect: true }); }}></conversation-sync-notice>` : null}
            <conversation-layout .status=${state.status} .activity=${state.activity} .sending=${state.sendingPrompts[state.selectedSession.id] === true} .visualEffects=${this.chatBehaviors.visualEffects}>
            ${this.renderChatView(state, state.selectedSession)}
            <div class="composer-area" slot="composer">
              <prompt-editor .chatNavigation=${this.chatNavigation} ?inert=${activityNoticeVisible || this.isRevertingMessage(state)} .promptChips=${this.selectedPromptChips()} .onRemoveChip=${this.handleRemovePromptChip} .shortcuts=${this.shortcutConfig} .defaultStreamingBehavior=${this.defaultStreamingBehavior} .sessionId=${state.selectedSession.id} .cwd=${state.selectedWorkspace?.path} .machineId=${selectedMachineId(state)} .projectId=${state.selectedWorkspace?.projectId} .workspaceId=${state.selectedWorkspace?.id} .attachmentsFolder=${workspaceEffectiveAttachmentsFolder(state.selectedWorkspace?.effectiveConfig, this.workspaceAttachmentsDefaultFolder)} .disabled=${state.selectedSession.archived === true || activityNoticeVisible || this.isRevertingMessage(state)} .canSteer=${state.status?.isStreaming === true} .isCompacting=${state.status?.isCompacting === true} .canStop=${state.status?.isStreaming === true || state.status?.isBashRunning === true || state.status?.isCompacting === true || (state.status?.pendingMessageCount ?? 0) > 0} .status=${state.status} .availableThinkingLevels=${state.availableThinkingLevels} .sending=${state.sendingPrompts[state.selectedSession.id] === true} .onSend=${this.handleSendPrompt} .onStop=${this.handleStopActiveWork} .onSelectModel=${this.handleSelectModel} .onSelectThinking=${this.handleSelectThinking}></prompt-editor>
              ${this.renderSessionActivityNotice()}
            </div>
            ${this.renderStatusBar(state)}
            </conversation-layout>
            ${state.commandDialog !== undefined ? html`<command-picker .title=${state.commandDialog.title} .options=${state.commandDialog.options} .onPick=${(value: string) => this.sessions.respondToCommand(state.commandDialog?.requestId ?? "", value)} .onCancel=${() => { this.sessions.cancelCommand(); }}></command-picker>` : null}
            ${state.modelDialog !== undefined ? html`<model-picker title=${pickerMessages.t("selectModel")} .options=${state.modelDialog.options} .catalog=${state.modelDialog.catalog} .defaultValue=${state.modelDialog.defaultValue} .defaultsLoading=${state.modelDialog.defaultsLoading === true} .onSetDefault=${this.handleSetDefaultModel} .selectedValue=${state.modelDialog.selectedValue} .onPick=${(value: string) => { void this.pickModel(value); }} .onToggleEnabled=${this.handleToggleModelEnabled} .onSetScope=${this.handleSetModelScope} .onCancel=${() => { this.setState({ modelDialog: undefined }); }}></model-picker>` : null}
            ${state.thinkingDialog !== undefined ? html`<command-picker title=${pickerMessages.t("selectThinking")} .options=${state.thinkingDialog.options} .defaultValue=${state.thinkingDialog.defaultValue} .defaultsLoading=${state.thinkingDialog.defaultsLoading === true} .onSetDefault=${this.handleSetDefaultThinking} .selectedValue=${state.thinkingDialog.selectedValue} .onPick=${(value: string) => { void this.pickThinking(value); }} .onCancel=${() => { this.setState({ thinkingDialog: undefined }); }}></command-picker>` : null}
          ` : state.selectedSession !== undefined && this.isChatVisible() && this.sessions.isChatLoadDeferred
            ? html`<div class="empty" role="status">${appFeedback.t("loadingConversation")}</div>`
            : html`<div class="empty">${this.sessionEmptyMessage()}</div>`}
        </main>
        ${this.renderWorkspacePanelEdgeControl()}
        ${guard(this.workspaceSurfaceInputs(), () => this.renderWorkspacePanel())}
        ${state.authDialog !== undefined ? html`<auth-dialog .state=${state.authDialog} .onChooseMethod=${(authType: "oauth" | "api_key") => { void this.auth.chooseLoginMethod(authType); }} .onSelectProvider=${(providerId: string, authType: "oauth" | "api_key") => { void this.auth.selectLoginProvider(providerId, authType); }} .onLogoutProvider=${(providerId: string) => { void this.auth.logoutProvider(providerId); }} .onOAuthInput=${(value: string) => { this.auth.updateOAuthInput(value); }} .onOAuthRespond=${(value?: string) => { void this.auth.respondOAuth(value); }} .onOAuthCancel=${() => { void this.auth.cancelOAuth(); }} .onCancel=${() => { this.auth.closeDialog(); }}></auth-dialog>` : null}
        ${this.navigationDialogOpen ? html`<navigation-dialog
          .tabs=${this.availableNavigationTabs()}
          .pinUniverse=${this.mobileMainTabs().map((tab) => tab.id)}
          .selectedTab=${this.selectedNavigationTab()}
          .preferences=${this.navigationPreferences}
          .onPreferencesChange=${this.changeNavigationPreferences}
          .onSelect=${this.selectNavigationTab}
          .onClose=${this.closeNavigation}
        ></navigation-dialog>` : null}
        ${state.actionPaletteOpen ? html`<action-palette .actions=${this.getActions()} .onRun=${(action: AppAction) => { this.setState({ actionPaletteOpen: false }); this.runAction(action); }} .onCancel=${() => { this.setState({ actionPaletteOpen: false }); }}></action-palette>` : null}
        ${this.renderSessionTreeNavigator(state)}
        ${state.projectDialogOpen ? html`<project-dialog .machineId=${selectedMachineId(state)} .onSubmit=${(path: string, create: boolean, trust: ProjectTrustChoice | undefined) => this.projects.addProject(path, create, trust)} .onCancel=${() => { this.setState({ projectDialogOpen: false }); }}></project-dialog>` : null}
        ${state.machineDialogOpen ? html`<machine-dialog .machine=${this.machineNameEditTarget} .error=${state.error} .onSubmit=${(input: MachineDialogSubmit) => this.submitMachineDialog(input)} .onCancel=${() => { this.setState({ machineDialogOpen: false }); }}></machine-dialog>` : null}
        ${this.sessionCleanupDialog !== undefined ? html`<session-cleanup-dialog .preview=${this.sessionCleanupDialog.preview} .previewRequest=${this.sessionCleanupDialog.previewRequest} .result=${this.sessionCleanupDialog.result} .loading=${this.sessionCleanupDialog.loading === true} .running=${this.sessionCleanupDialog.running === true} .error=${typeof this.sessionCleanupDialog.error === "string" ? this.sessionCleanupDialog.error : ""} .errorMessage=${typeof this.sessionCleanupDialog.error === "function" ? this.sessionCleanupDialog.error : undefined} .onPreview=${(request: SessionCleanupRequest) => { void this.previewSessionCleanup(request); }} .onRun=${(request: SessionCleanupRequest) => { void this.runSessionCleanup(request); }} .onClose=${() => { this.closeSessionCleanupDialog(); }}></session-cleanup-dialog>` : null}
        ${this.settingsSection !== undefined ? html`<settings-dialog .section=${this.settingsSection} .mcpContext=${state.selectedSession !== undefined && state.selectedSession.archived !== true ? { session: { id: state.selectedSession.id, cwd: state.selectedSession.cwd }, machineId: selectedMachineId(state) } : undefined} .onMcpAuth=${(mode: "login" | "logout", serverName: string, context: { session: { id: string; cwd: string }; machineId: string }) => { this.closeSettings(); void this.auth.openMcpAuth(mode, serverName, context); }} .machine=${state.selectedMachine} .machineRuntime=${this.selectedMachineRuntime()} .machines=${state.machines} .machineStatuses=${state.machineStatuses} .machineRuntimes=${state.machineRuntimes} .actions=${this.getDefaultActions()} .themes=${this.plugins.getThemes()} .onThemeCatalogLoaded=${(catalog: BrowserThemeCatalog) => { this.registerThemeCatalog(catalog); }} .fileIconThemes=${this.plugins.getFileIconThemes()} .fileIconPreference=${this.fileIconPreference} .onSelectFileIconTheme=${(id: string) => { this.selectFileIconTheme(id); }} .onResetFileIconTheme=${() => { this.selectFileIconTheme(undefined); }} .themePreference=${this.themePreference} .activeThemeId=${this.activeThemeId} .hasLocalThemeOverride=${this.localThemePreference !== undefined} .onUseLocalTheme=${(preference: ThemePreference) => { this.pickTheme(preference); }} .onUseDefaultTheme=${() => { this.useDefaultTheme(); }} .onNavigate=${(section: SettingsSection) => { this.navigateSettings(section); }} .onClose=${() => { this.closeSettings(); }} .onMachineConfigSaved=${(machineId: string) => { void this.machines.refreshMachineIdentity(machineId); }} .onConfigSaved=${(config: PiWebConfigValues) => { this.applyClientConfig(config); }} .onRefreshMachineRuntime=${async (machineId: string) => { await this.machines.refreshMachineRuntime(machineId); }}></settings-dialog>` : null}
      </div>
    `;
  }

  static override styles = appStyles;
}

function modelValueFromStatus(status: AppState["status"]): string | undefined {
  const provider = status?.model?.provider;
  const id = status?.model?.id;
  return provider !== undefined && id !== undefined ? `${provider}/${id}` : undefined;
}

function coreWorkspacePluginBinding(): WorkspacePluginBinding {
  return { registrationPluginId: "core", sourcePluginId: "core" };
}

function pluginMachineFromState(state: Pick<AppState, "selectedMachine">): PluginMachine {
  const machine = state.selectedMachine;
  if (machine !== undefined) return { id: machine.id, name: machine.name, kind: machine.kind };
  return { id: "local", name: "local", kind: "local" };
}

function unreadChatIdentity(machineId: string, session: Pick<SessionInfo, "id" | "cwd">): string {
  return JSON.stringify([machineId, session.id, session.cwd]);
}

function navigationSelectionFromState(state: Pick<AppState, "selectedMachine" | "selectedProject" | "selectedWorkspace" | "selectedSession">): NavigationSelection {
  const route = readRoute();
  return {
    machineId: selectedMachineId(state),
    projectId: state.selectedProject?.id,
    workspaceId: state.selectedWorkspace?.id,
    sessionId: state.selectedSession?.id,
    ...(route.tool === undefined ? {} : { tool: route.tool }),
    ...(route.view === undefined ? {} : { view: route.view }),
  };
}

function navigationUrlContext(navigation?: NavigationFreshness): NavigationUrlContext {
  return {
    url: currentBrowserUrl(),
    ...(navigation === undefined ? {} : { navigation }),
  };
}

function currentBrowserUrl(): string {
  return window.location.href;
}

function selectedChatIdentity(state: Pick<AppState, "selectedMachine" | "selectedSession">): string | undefined {
  const session = state.selectedSession;
  return session === undefined ? undefined : unreadChatIdentity(selectedMachineId(state), session);
}

function browserErrorContextForRoute(
  state: Pick<AppState, "selectedSession">,
  route: Pick<ParsedAppRoute, "machineId" | "projectId" | "workspaceId" | "sessionId">,
): ReturnType<typeof browserErrorContext> {
  const selectedSession = state.selectedSession;
  const sessionId = route.sessionId;
  return {
    machineId: route.machineId ?? "local",
    ...(route.projectId === undefined ? {} : { projectId: route.projectId }),
    ...(route.workspaceId === undefined ? {} : { workspaceId: route.workspaceId }),
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(selectedSession === undefined || selectedSession.id !== sessionId ? {} : { cwd: selectedSession.cwd }),
  };
}

function machineUnreadInputsChanged(previous: AppState, next: AppState): boolean {
  return previous.machines !== next.machines;
}

function machineActivitySubscriptionInputsChanged(previous: AppState, next: AppState): boolean {
  return previous.machines !== next.machines
    || previous.machineStatuses !== next.machineStatuses
    || (previous.selectedMachine?.id ?? "local") !== (next.selectedMachine?.id ?? "local");
}

function shouldSubscribeToMachineActivity(machine: Machine, health: MachineHealth | undefined): boolean {
  return shouldRefreshMachineActivity(machine, health);
}

function shouldRefreshMachineActivity(machine: Machine, health: MachineHealth | undefined): boolean {
  if (machine.kind === "local") return true;
  const status = health?.status ?? machine.status;
  return status === undefined || status === "unknown" || status === "online";
}

function patchChangesState(state: AppState, patch: Partial<AppState>): boolean {
  return Object.entries(patch).some(([key, value]) => Reflect.get(state, key) !== value);
}

function sameStringSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function sameContributionQueryRecord(
  left: Readonly<Record<string, string | readonly string[]>>,
  right: Readonly<Record<string, string | readonly string[]>>,
): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key) => Object.hasOwn(right, key) && sameContributionQueryValue(left[key], right[key]));
}

function sameContributionQueryValue(left: string | readonly string[] | undefined, right: string | readonly string[] | undefined): boolean {
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => value === right[index]);
  }
  return left === right;
}

function emptyWorkspaceRouteSurface(): WorkspaceRouteSurface {
  return {};
}

function workspaceRouteIdentity(route: Pick<AppRoute, "machineId" | "projectId" | "workspaceId">): WorkspaceRouteIdentity | undefined {
  if (route.projectId === undefined || route.projectId === "" || route.workspaceId === undefined || route.workspaceId === "") return undefined;
  return { machineId: route.machineId ?? "local", projectId: route.projectId, workspaceId: route.workspaceId };
}

function machineScopedKey(machineId: string, value: string): string {
  return JSON.stringify([machineId, value]);
}

function workspaceDeletionScopeKey(state: Pick<AppState, "selectedMachine" | "selectedProject">): string | undefined {
  const projectId = state.selectedProject?.id;
  if (projectId === undefined) return undefined;
  return JSON.stringify([state.selectedMachine?.id ?? "local", projectId]);
}

function sameWorkspaceRouteIdentity(left: WorkspaceRouteIdentity, right: WorkspaceRouteIdentity): boolean {
  return left.machineId === right.machineId
    && left.projectId === right.projectId
    && left.workspaceId === right.workspaceId;
}

function navigationRouteValue(route: ParsedAppRoute, scope: NavigationScope): string | undefined {
  switch (scope) {
    case "machine": return route.machineId ?? "local";
    case "project": return route.projectId;
    case "workspace": return route.workspaceId;
    case "session": return route.sessionId;
    case "tool": return route.tool;
    case "view": return route.view;
    default: return undefined;
  }
}

function remoteRouteRestoreRetryDelay(attempt: number): number {
  const index = Math.min(attempt, REMOTE_ROUTE_RESTORE_RETRY_DELAYS_MS.length - 1);
  return REMOTE_ROUTE_RESTORE_RETRY_DELAYS_MS[index] ?? 30_000;
}

function externalRegistryFailures(
  result: ExternalPluginLoadResult,
  declarations: ExternalPluginLoadResult["declarations"],
): PluginRegistrationFailure[] {
  return result.failures.flatMap((failure) => {
    const declaration = declarations.find((candidate) => (candidate.sourcePluginId ?? candidate.id) === failure.entry.id);
    return declaration === undefined ? [] : [{ declaration, phase: "import" as const, error: failure.error }];
  });
}

function sameWorkspacePluginBinding(left: WorkspacePluginBinding, right: WorkspacePluginBinding): boolean {
  return left.registrationPluginId === right.registrationPluginId
    && left.sourcePluginId === right.sourcePluginId
    && left.backendRevision === right.backendRevision
    && left.pairedRequestVersion === right.pairedRequestVersion
    && left.pairedChannelVersion === right.pairedChannelVersion
    && left.pairedResourceVersion === right.pairedResourceVersion;
}

function requiredTerminalPluginBinding(registration: PiWebPluginRegistration, machineId: string): WorkspacePluginBinding {
  const expectedRuntimeId = machineId === "local"
    ? REQUIRED_TERMINAL_PLUGIN_ID
    : machineScopedBundledPluginId(machineId, REQUIRED_TERMINAL_PLUGIN_ID);
  const machineScopeMatches = machineId === "local"
    ? registration.machineId === undefined && registration.sourcePluginId === undefined
    : registration.machineId === machineId && registration.sourcePluginId === REQUIRED_TERMINAL_PLUGIN_ID;
  if (registration.id !== expectedRuntimeId
    || !machineScopeMatches
    || registration.machineSpecific !== true
    || (registration.manifestSource !== undefined && registration.manifestSource !== "bundled")
    || (registration.manifestScope !== undefined && registration.manifestScope !== "bundled")
    || registration.backendRevision === undefined
    || registration.pairedRequestVersion !== 1
    || registration.pairedChannelVersion !== 1) {
    throw new Error("Required Terminal browser entry does not have bundled identity, machine scope, and matching peer request/channel capabilities");
  }
  return Object.freeze({
    registrationPluginId: registration.id,
    sourcePluginId: REQUIRED_TERMINAL_PLUGIN_ID,
    backendRevision: registration.backendRevision,
    pairedRequestVersion: 1,
    pairedChannelVersion: 1,
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function omitWorkspaceDeletionRun(runs: Record<string, TerminalCommandRun>, workspaceId: string): Record<string, TerminalCommandRun> {
  return Object.fromEntries(Object.entries(runs).filter(([candidate]) => candidate !== workspaceId));
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => { resolve(); }));
}

function thinkingDescription(level: string): string | undefined {
  switch (level) {
    case "off": return pickerMessages.t("reasoningOff");
    case "minimal": return pickerMessages.t("reasoningMinimal", { tokens: localization.number(1) });
    case "low": return pickerMessages.t("reasoningLow", { tokens: localization.number(2) });
    case "medium": return pickerMessages.t("reasoningMedium", { tokens: localization.number(8) });
    case "high": return pickerMessages.t("reasoningHigh", { tokens: localization.number(16) });
    case "xhigh": return pickerMessages.t("reasoningXhigh", { tokens: localization.number(32) });
    default: return undefined; // unknown level from a newer pi: no description
  }
}
