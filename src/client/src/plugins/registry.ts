import { html, svg } from "lit";
import { filePreviewerMatches, snapshotFilePreviewer, type RegisteredFilePreviewer } from "./filePreviewers";
import { createFilePreviewingCapability, filePreviewingCapabilityToken } from "./filePreviewing";
import { snapshotFileIconTheme } from "./fileIcons";
import type { QualifiedFileIconThemeContribution } from "./types";
import { textFilePreviewer } from "./textFilePreviewer";
import { snapshotDisplayMetadata } from "./displayMetadata";
import { localization } from "../localization/browser";
import type { LocalizationService } from "../localization/service";
import { createPluginLocalization } from "./localization";
import { createSyntaxHighlightingCapability, runSyntaxHighlighter, snapshotSyntaxHighlighter, syntaxHighlightingCapabilityToken, type RegisteredSyntaxHighlighter } from "../formatting/syntaxHighlighting";
import { createPluginCatalog } from "./catalog";
import { stylesheetIntegrationCapability, stylesheetIntegrationCapabilityToken } from "./styles";
import type { QualifiedStylesheetContribution, StylesheetContribution } from "./types";
import { createPluginBackend } from "./pluginPeer";
import type { ContentRenderRequest, DisplayedMessageActionAvailabilityContext, DisplayedMessageActionContext, MessageActionAvailabilityContext, MessageActionContext, MessageActionContribution, MessageActionResult, PluginSelectionSnapshot } from "../../../plugin-api";
import { availableDisplayedMessageActions, availableMessageActions, type RegisteredMessageAction } from "./messageActions";
import { PluginSelectionHost } from "./selection";
import { PromptChipStore, type PromptChipTarget } from "../promptChips";
import type { PluginPromptEditor } from "../../../plugin-api";
import { contentRendererMatches, snapshotContentRenderer, type ContentRendererChoice, type RegisteredContentRenderer } from "./contentRenderers";
import { createContentRenderingCapability, createContentRenderingService, contentRenderingCapabilityToken, type ChatContentRendering } from "../formatting/contentRendering";
import { requirePluginBackendRevision } from "../../../shared/pluginBackendProtocol";
import type { ApplicationPanelContext, ApplicationPanelContribution, QualifiedApplicationPanelContribution, PiWebPluginRegistration, PiWebPluginRegistrationDeclaration, PluginAction, PluginActivationContext, PluginActivationResult, PluginCapability, PluginCapabilityProvision, PluginContributions, PluginRuntimeContext, PluginStartContext, QualifiedContributionId, QualifiedPluginAction, QualifiedThemeContribution, QualifiedThemePairContribution, QualifiedWorkspaceLabelContribution, QualifiedWorkspacePanelContribution, QualifiedSessionLabelContribution, SessionLabelContext, SessionLabelContribution, SessionLabelItem, ThemeContribution, ThemePairContribution, WorkspaceInvalidation, WorkspaceLabelContext, WorkspaceLabelContribution, WorkspaceLabelItem, WorkspacePanelContext, WorkspacePanelContribution, WorkspacePluginBinding, WorkspaceResource } from "./types";

const idPattern = /^[a-z][a-z0-9.-]*$/u;
const localIdPattern = /^[a-z][a-z0-9.-]*$/u;
const qualifiedContributionIdPattern = /^[a-z][a-z0-9.-]*:[a-z][a-z0-9.-]*$/u;
const pluginRuntimeScopes = new WeakMap<PluginRuntimeContext, (pluginId: string) => PluginRuntimeContext>();
type WorkspacePanelScope = (
  binding: WorkspacePluginBinding,
  contributionId: QualifiedContributionId,
  sourceContributionId: QualifiedContributionId,
) => WorkspacePanelContext;
const workspacePanelScopes = new WeakMap<WorkspacePanelContext, WorkspacePanelScope>();
const applicationPanelScopes = new WeakMap<ApplicationPanelContext, (pluginId: string) => ApplicationPanelContext>();
const workspaceLabelScopes = new WeakMap<WorkspaceLabelContext, (binding: WorkspacePluginBinding) => WorkspaceLabelContext>();
const sessionLabelScopes = new WeakMap<SessionLabelContext, (binding: WorkspacePluginBinding) => SessionLabelContext>();

export interface PluginRegistryOptions {
  /** Shared UI localization service; isolated services may be supplied by host tests. */
  localization?: LocalizationService;
  /** Request a composer refresh after browser-memory chip staging changes. */
  onPromptChipsChanged?: () => void;
  /** Live public selection projection; standalone registries default to no selection. */
  getSelection?: () => PluginSelectionSnapshot;
  /** Host lifecycle gate for the machine a contribution will act against. */
  isContributionEnabled?: (pluginId: string, effectiveMachineId: string | undefined) => boolean;
  /** Cooperative deadline applied independently to activate, start, and dispose. */
  lifecycleTimeoutMs?: number;
  /** Core-owned capabilities available to every matching browser composition domain. */
  hostCapabilities?: readonly PluginCapabilityProvision[];
}

export type BrowserPluginLifecyclePhase = "import" | "validate" | "activate" | "start" | "dispose";

export interface PluginRegistrationFailure {
  readonly declaration: PiWebPluginRegistrationDeclaration;
  readonly phase: BrowserPluginLifecyclePhase;
  readonly error: unknown;
}

export interface HostPluginCapabilityRequirement {
  readonly registrationPluginId: string;
  readonly capability: PluginCapability;
}

export interface PluginRegistrationBatchOptions {
  /** Validated manifest intent, including entries whose module import failed. */
  declarations?: readonly PiWebPluginRegistrationDeclaration[];
  /** Import failures whose declarations still participate in composition precedence. */
  failures?: readonly PluginRegistrationFailure[];
  /** Host-required values parsed before their owning plugin is published. */
  requiredCapabilities?: readonly HostPluginCapabilityRequirement[];
}

export interface PluginRegistrationBatchResult {
  readonly failures: readonly PluginRegistrationFailure[];
}

type RegisteredPluginAction = Omit<PluginAction, "id"> & {
  id: QualifiedContributionId;
  pluginId: string;
  localId: string;
  machineId?: string;
  sourcePluginId?: string;
};

interface NormalizedPluginDeclaration {
  readonly id: string;
  readonly sourcePluginId: string;
  readonly machineId?: string;
  readonly manifestSource?: string;
  readonly manifestScope?: string;
  readonly machineSpecific: boolean;
}

interface PreparedPluginContributions {
  readonly stylesheets: readonly QualifiedStylesheetContribution[];
  readonly filePreviewers: readonly RegisteredFilePreviewer[];
  readonly contentRenderers: readonly RegisteredContentRenderer[];
  readonly syntaxHighlighters: readonly RegisteredSyntaxHighlighter[];
  readonly ids: ReadonlySet<QualifiedContributionId>;
  readonly actions: readonly RegisteredPluginAction[];
  readonly messageActions: readonly RegisteredMessageAction[];
  readonly workspacePanels: readonly QualifiedWorkspacePanelContribution[];
  readonly applicationPanels: readonly QualifiedApplicationPanelContribution[];
  readonly workspaceLabels: readonly QualifiedWorkspaceLabelContribution[];
  readonly sessionLabels: readonly QualifiedSessionLabelContribution[];
  readonly themes: readonly QualifiedThemeContribution[];
  readonly fileIconThemes: readonly QualifiedFileIconThemeContribution[];
  readonly themePairs: readonly QualifiedThemePairContribution[];
}

interface InternalCapabilityProvision {
  readonly capability: PluginCapability;
  readonly key: string;
  readonly value: unknown;
}

interface InternalHostCapabilitySnapshot<Value = unknown> {
  readonly token: PluginCapability<Value>;
  readonly key: string;
  readonly value: Value;
}

interface LoadedBrowserPlugin {
  readonly apiVersion: 4 | 5;
  readonly name: string;
  readonly requires: readonly PluginCapability[];
  readonly activate: (context: PluginActivationContext) => unknown;
}

interface StagedBrowserPlugin {
  readonly registration: PiWebPluginRegistration;
  readonly declaration: NormalizedPluginDeclaration;
  readonly plugin: LoadedBrowserPlugin;
  readonly activation: PluginActivationResult;
  readonly lifetimeController: AbortController;
  readonly provisions: readonly InternalCapabilityProvision[];
  readonly contributions: PreparedPluginContributions;
}

const DEFAULT_LIFECYCLE_TIMEOUT_MS = 10_000;

export class PluginRegistry {
  readonly promptChips: PromptChipStore;

  /** Plugin identity is host supplied; retained methods never follow later selection. */
  promptChipMethods(pluginId: string, target: PromptChipTarget | undefined): Pick<PluginPromptEditor, "setChip" | "removeChip"> {
    const requireTarget = (): PromptChipTarget => {
      if (target === undefined) throw new Error("Select a ready, non-archived conversation to stage prompt chips");
      if (!this.promptChipOwnerAvailable(pluginId, target.machineId)) throw new Error(`Prompt chips unavailable for plugin ${pluginId} on machine ${target.machineId}`);
      return target;
    };
    return {
      setChip: (chip) => { this.promptChips.set(pluginId, requireTarget(), chip); },
      removeChip: (id) => { this.promptChips.remove(pluginId, requireTarget(), id); },
    };
  }

  promptChipOwnerAvailable(pluginId: string, machineId: string): boolean {
    const declaration = this.declarationsById.get(pluginId);
    return this.hasPlugin(pluginId) && declaration !== undefined
      && this.isContributionActive(pluginId, declaration.machineId, machineId, declaration.sourcePluginId);
  }

  private readonly filePreviewers: RegisteredFilePreviewer[] = [];
  readonly filePreviewing = createFilePreviewingCapability((request) => this.filePreviewers
    .filter((previewer) => !previewer.lifetime.aborted && this.isContributionActive(previewer.pluginId, previewer.machineId, request.machineId, previewer.sourcePluginId))
    .sort((a, b) => this.compareDiscoveryOrder(a, b))
    .filter((previewer) => filePreviewerMatches(previewer, request)));
  private readonly contentRenderers: RegisteredContentRenderer[] = [];
  private readonly syntaxHighlighters: RegisteredSyntaxHighlighter[] = [];
  readonly syntaxHighlighting = createSyntaxHighlightingCapability((request) => this.syntaxHighlightingRevision(request.machineId)
    .filter((highlighter) => contentRendererMatches(highlighter, { ...request, text: "" })).at(-1));

  private compareDiscoveryOrder(a: { pluginId: string }, b: { pluginId: string }): number {
    const ids = [...this.declarationsById.keys()];
    return ids.indexOf(a.pluginId) - ids.indexOf(b.pluginId);
  }
  private readonly syntaxHighlightingViews = new Map<string, readonly RegisteredSyntaxHighlighter[]>();
  private readonly chatContentRenderingViews = new Map<string, {
    choices: readonly ContentRendererChoice[];
    grammars: readonly RegisteredSyntaxHighlighter[];
    rendering: ChatContentRendering;
  }>();

  private syntaxHighlightingRevision(machineId: string): readonly RegisteredSyntaxHighlighter[] {
    const active = this.syntaxHighlighters
      .filter((highlighter) => this.isContributionActive(highlighter.pluginId, highlighter.machineId, machineId, highlighter.sourcePluginId))
      .sort((a, b) => this.compareDiscoveryOrder(a, b));
    const previous = this.syntaxHighlightingViews.get(machineId);
    if (previous?.length === active.length && active.every((highlighter, index) => highlighter === previous[index])) return previous;
    this.syntaxHighlightingViews.set(machineId, active);
    return active;
  }

  // Plugins retain one live capability; chat receives a reactive rendering snapshot.
  readonly contentRendering = createContentRenderingCapability(
    (request) => this.matchContentRenderers(request),
    (request) => this.syntaxHighlightingRevision(request.machineId),
  );

  /** Stable input while this machine's eligible renderers are unchanged. */
  getChatContentRendering(machineId: string): ChatContentRendering {
    const choices = this.activeContentRendererChoices(machineId);
    const grammars = this.syntaxHighlightingRevision(machineId);
    const previous = this.chatContentRenderingViews.get(machineId);
    if (previous?.grammars === grammars && previous.choices.length === choices.length
      && choices.every((choice, index) => choice.renderer === previous.choices[index]?.renderer)) return previous.rendering;
    const rendering = createContentRenderingService(
      (request) => request.machineId === machineId ? choices.filter(({ renderer }) => contentRendererMatches(renderer, request)) : [],
      () => grammars,
    );
    this.chatContentRenderingViews.set(machineId, { choices, grammars, rendering });
    return rendering;
  }

  matchContentRenderers(request: ContentRenderRequest): readonly ContentRendererChoice[] {
    return this.activeContentRendererChoices(request.machineId).filter(({ renderer }) => contentRendererMatches(renderer, request));
  }

  private activeContentRendererChoices(machineId: string): readonly ContentRendererChoice[] {
    return this.contentRenderers.filter((renderer) => this.isContributionActive(renderer.pluginId, renderer.machineId, machineId, renderer.sourcePluginId))
      .sort((a, b) => this.compareDiscoveryOrder(a, b))
      .map((renderer) => ({ id: renderer.id, get label() { return renderer.label; }, renderer }));
  }
  private readonly messageActions: RegisteredMessageAction[] = [];
  private messageActionView: readonly RegisteredMessageAction[] = [];

  getMessageActions(machineId: string): readonly RegisteredMessageAction[] {
    const actions = this.messageActions.filter((action) => this.isContributionActive(action.binding.registrationPluginId, action.machineId, machineId, action.binding.sourcePluginId));
    if (actions.length !== this.messageActionView.length || actions.some((action, index) => action !== this.messageActionView[index])) {
      this.messageActionView = actions;
    }
    return this.messageActionView;
  }

  async runMessageAction(
    id: string,
    input: MessageActionAvailabilityContext,
    createContext: (binding: WorkspacePluginBinding) => MessageActionContext,
  ): Promise<MessageActionResult> {
    const actions = this.getMessageActions(input.machine.id).filter((action) => action.id === id);
    const available = availableMessageActions(actions, input)[0];
    if (available?.enabled !== true || available.action.target === "display") return;
    return available.action.run(createContext(available.action.binding));
  }

  async runDisplayedMessageAction(
    id: string,
    input: DisplayedMessageActionAvailabilityContext,
    createContext: (binding: WorkspacePluginBinding) => DisplayedMessageActionContext,
  ): Promise<MessageActionResult> {
    const actions = this.getMessageActions(input.machine.id).filter((action) => action.id === id);
    const available = availableDisplayedMessageActions(actions, input)[0];
    if (available?.enabled !== true || available.action.target !== "display") return;
    return available.action.run(createContext(available.action.binding));
  }

  private readonly actions: RegisteredPluginAction[] = [];
  private readonly workspacePanels: QualifiedWorkspacePanelContribution[] = [];
  private readonly applicationPanels: QualifiedApplicationPanelContribution[] = [];
  private readonly workspaceLabels: QualifiedWorkspaceLabelContribution[] = [];
  private readonly sessionLabels: QualifiedSessionLabelContribution[] = [];
  private readonly stylesheets: QualifiedStylesheetContribution[] = [];
  private readonly themes: QualifiedThemeContribution[] = [];
  private declarativeThemes: readonly QualifiedThemeContribution[] = [];
  private declarativeThemePairs: readonly QualifiedThemePairContribution[] = [];
  private readonly fileIconThemes: QualifiedFileIconThemeContribution[] = [];
  private readonly themePairs: QualifiedThemePairContribution[] = [];
  private readonly pluginIds = new Set<string>();
  private readonly warnedLegacyPluginIds = new Set<string>();

  private readonly warnedRuntimeThemeContributions = new Set<string>();
  private readonly gatewayPluginIds = new Set<string>();
  private readonly gatewayMachineSpecificPluginIds = new Set<string>();
  private readonly remoteMachineSpecificPluginIds = new Map<string, Set<string>>();
  private readonly contributionIds = new Set<QualifiedContributionId>();
  private readonly declarationsById = new Map<string, NormalizedPluginDeclaration>();
  private readonly activeCapabilitiesByRegistration = new Map<string, ReadonlyMap<string, InternalCapabilityProvision>>();
  private readonly hostCapabilitySnapshotsByRegistration = new Map<string, ReadonlyMap<string, InternalHostCapabilitySnapshot>>();
  private readonly hostCapabilitiesByKey = new Map<string, InternalCapabilityProvision>();
  private readonly activatingLifetimes = new Set<AbortController>();
  private activePlugins: StagedBrowserPlugin[] = [];
  private stagedPlugins: StagedBrowserPlugin[] = [];
  private registrationTail: Promise<void> = Promise.resolve();
  private readonly lifecycleTimeoutMs: number;
  private readonly selection: PluginSelectionHost;
  private shuttingDown = false;
  private disposePromise: Promise<void> | undefined;

  constructor(private readonly options: PluginRegistryOptions = {}) {
    this.promptChips = new PromptChipStore(options.onPromptChipsChanged);
    this.selection = new PluginSelectionHost(options.getSelection ?? (() => ({})));
    this.lifecycleTimeoutMs = positiveInteger(options.lifecycleTimeoutMs, DEFAULT_LIFECYCLE_TIMEOUT_MS, "lifecycleTimeoutMs");
    for (const provision of snapshotCapabilityProvisions([
      { capability: filePreviewingCapabilityToken, value: this.filePreviewing },
      { capability: contentRenderingCapabilityToken, value: this.contentRendering },
      { capability: syntaxHighlightingCapabilityToken, value: this.syntaxHighlighting },
      { capability: stylesheetIntegrationCapabilityToken, value: stylesheetIntegrationCapability },
      ...(options.hostCapabilities ?? []),
    ], undefined, "Browser host capability provisions")) {
      const internal = internalCapabilityProvision(provision);
      if (this.hostCapabilitiesByKey.has(internal.key)) {
        throw new BrowserPluginIncompatibleError(`Browser capability ${formatCapability(internal.capability)} is provided more than once by the host`);
      }
      this.hostCapabilitiesByKey.set(internal.key, internal);
    }
  }

  /** Publish host selection changes independently of contribution rendering. */
  notifySelectionChanged(): void {
    this.selection.notifyChanged();
  }

  /** Registers one plugin as a serialized single-entry batch and throws its attributed failure. */
  async register(registration: PiWebPluginRegistration): Promise<void> {
    const result = await this.registerBatch([registration]);
    const failure = result.failures.find(({ declaration }) => declaration.id === registration.id);
    if (failure !== undefined) throw failure.error;
  }

  /** Stages a complete attempted scope, then starts and publishes independent dependency graphs transactionally. */
  registerBatch(
    registrations: readonly PiWebPluginRegistration[],
    options: PluginRegistrationBatchOptions = {},
  ): Promise<PluginRegistrationBatchResult> {
    const registrationsSnapshot = [...registrations];
    const declarationsSnapshot = [...(options.declarations ?? registrations.map(registrationDeclaration))];
    const failuresSnapshot = [...(options.failures ?? [])];
    const requiredCapabilitiesSnapshot = [...(options.requiredCapabilities ?? [])];
    const run = this.registrationTail.then(async () => this.performRegistrationBatch(
      registrationsSnapshot,
      declarationsSnapshot,
      failuresSnapshot,
      requiredCapabilitiesSnapshot,
    ));
    this.registrationTail = run.then(() => undefined, () => undefined);
    return run;
  }

  /** Cancels every plugin lifetime before reverse dependency/start-order disposal. */
  beginShutdown(): void {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.promptChips.clear();
    const reason = new DOMException("Browser plugin host is shutting down", "AbortError");
    for (const controller of this.activatingLifetimes) abortLifetime(controller, reason);
    for (const plugin of [...this.activePlugins, ...this.stagedPlugins]) abortLifetime(plugin.lifetimeController, reason);
  }

  dispose(): Promise<void> {
    if (this.disposePromise !== undefined) return this.disposePromise;
    this.beginShutdown();
    this.disposePromise = this.performDispose();
    return this.disposePromise;
  }

  private async performDispose(): Promise<void> {
    await this.registrationTail;
    const plugins = [...this.activePlugins, ...this.stagedPlugins].reverse();
    this.activePlugins = [];
    this.stagedPlugins = [];
    this.activeCapabilitiesByRegistration.clear();
    this.hostCapabilitySnapshotsByRegistration.clear();
    this.pluginIds.clear();
    this.actions.splice(0);
    this.messageActions.splice(0);
    this.filePreviewers.splice(0);
    this.contentRenderers.splice(0);
    this.syntaxHighlighters.splice(0);
    this.chatContentRenderingViews.clear();
    this.syntaxHighlightingViews.clear();
    this.workspacePanels.splice(0);
    this.applicationPanels.splice(0);
    this.workspaceLabels.splice(0);
    this.sessionLabels.splice(0);
    this.stylesheets.splice(0);
    this.themes.splice(0);
    this.fileIconThemes.splice(0);
    this.themePairs.splice(0);
    this.contributionIds.clear();
    for (const plugin of plugins) {
      const dispose = plugin.activation.dispose?.bind(plugin.activation);
      if (dispose === undefined) continue;
      try {
        await runBounded(plugin.registration.id, "dispose", this.lifecycleTimeoutMs, undefined, (signal) => dispose(signal));
      } catch (error) {
        console.warn(`Failed to dispose PI WEB plugin ${plugin.registration.id}`, error);
      }
    }
  }

  /** Resolves one exact active capability from a concrete local or machine-qualified registration. */
  resolveCapability<Value>(registrationPluginId: string, capability: PluginCapability<Value>): Value {
    const parsed = snapshotTypedCapability(capability, "Browser host capability request");
    const key = capabilityKey(parsed);
    const provision = this.activeCapabilitiesByRegistration.get(registrationPluginId)?.get(key);
    if (provision === undefined) {
      throw new Error(`Browser capability ${formatCapability(parsed)} is not active for ${registrationPluginId}`);
    }
    const hostSnapshot = this.hostCapabilitySnapshotsByRegistration.get(registrationPluginId)?.get(key);
    if (hostSnapshot !== undefined && matchesHostCapability(hostSnapshot, capability)) return hostSnapshot.value;
    return parseCapabilityValue(parsed, provision.value, `Browser capability ${formatCapability(parsed)} for ${registrationPluginId}`);
  }

  private async performRegistrationBatch(
    registrations: readonly PiWebPluginRegistration[],
    declarations: readonly PiWebPluginRegistrationDeclaration[],
    initialFailures: readonly PluginRegistrationFailure[],
    requiredCapabilities: readonly HostPluginCapabilityRequirement[],
  ): Promise<PluginRegistrationBatchResult> {
    if (this.shuttingDown) throw new Error("Browser plugin registry is shutting down");
    const failures: PluginRegistrationFailure[] = [...initialFailures];
    const acceptedIds = new Set<string>();
    const seenDeclarations = new Set<string>();
    for (const declarationValue of declarations) {
      try {
        const declaration = this.normalizeDeclaration(declarationValue);
        if (seenDeclarations.has(declaration.id)) throw new Error(`Duplicate plugin id: ${declaration.id}`);
        seenDeclarations.add(declaration.id);
        if (this.recordDeclaration(declaration)) acceptedIds.add(declaration.id);
      } catch (error) {
        failures.push(failureFor(declarationValue, "validate", error));
      }
    }

    const stagedById = new Map<string, StagedBrowserPlugin>();
    const seenRegistrations = new Set<string>();
    for (const registration of [...registrations].sort((left, right) => left.id.localeCompare(right.id))) {
      const declarationValue = registrationDeclaration(registration);
      if (!seenDeclarations.has(registration.id)) {
        failures.push(failureFor(declarationValue, "validate", new Error(`Plugin ${registration.id} has no registration declaration`)));
        continue;
      }
      if (!acceptedIds.has(registration.id)) continue;
      if (this.shutdownHasStarted()) {
        failures.push(failureFor(declarationValue, "activate", browserPluginShutdownError()));
        continue;
      }
      try {
        if (seenRegistrations.has(registration.id) || this.pluginIds.has(registration.id)) {
          throw new Error(`Duplicate plugin id: ${registration.id}`);
        }
        seenRegistrations.add(registration.id);
        const declaration = this.declarationsById.get(registration.id);
        if (declaration === undefined) throw new Error(`Plugin ${registration.id} has no valid registration declaration`);
        const registrationScope = this.normalizeDeclaration(declarationValue);
        if (!sameDeclaration(declaration, registrationScope)) {
          throw new Error(`Plugin registration topology does not match its declaration: ${registration.id}`);
        }
        const staged = await this.stageRegistration(registration, declaration);
        stagedById.set(registration.id, staged);
        this.stagedPlugins.push(staged);
      } catch (error) {
        failures.push(failureFor(declarationValue, lifecyclePhase(error, "validate"), error));
      }
    }

    const pending = new Map(stagedById);
    while (pending.size > 0) {
      let progressed = false;
      const candidates = [...pending.values()].sort((left, right) => left.registration.id.localeCompare(right.registration.id));
      for (const staged of candidates) {
        const dependencyFailure = this.dependencyFailure(staged, pending, stagedById);
        if (dependencyFailure !== undefined) {
          pending.delete(staged.registration.id);
          failures.push(await this.failBeforeStart(staged, dependencyFailure));
          progressed = true;
          continue;
        }
        if (this.waitingForDependencies(staged, pending, stagedById)) continue;
        pending.delete(staged.registration.id);
        const failure = await this.startStagedPlugin(staged, requiredCapabilities);
        if (failure !== undefined) failures.push(failure);
        progressed = true;
      }
      if (progressed) continue;

      const cycle = this.findCapabilityCycle(pending, stagedById);
      const cycleIds = cycle.length === 0
        ? [candidates[0]?.registration.id].filter((id): id is string => id !== undefined)
        : cycle;
      for (const pluginId of cycleIds) {
        const staged = pending.get(pluginId);
        if (staged === undefined) continue;
        pending.delete(pluginId);
        const error = new Error(`Browser plugin ${pluginId} has an unresolved capability dependency cycle`);
        failures.push(await this.failBeforeStart(staged, error));
      }
    }

    return Object.freeze({ failures: Object.freeze(failures) });
  }

  private shutdownHasStarted(): boolean {
    return this.shuttingDown;
  }

  private async stageRegistration(
    registration: PiWebPluginRegistration,
    declaration: NormalizedPluginDeclaration,
  ): Promise<StagedBrowserPlugin> {
    const backendRevision = this.parseBackendRevision(registration.id, registration.backendRevision);
    const pairedRequestVersion = this.parsePairedCapabilityVersion(registration.id, "request", registration.pairedRequestVersion, backendRevision);
    const pairedChannelVersion = this.parsePairedCapabilityVersion(registration.id, "channel", registration.pairedChannelVersion, backendRevision);
    const pairedResourceVersion = this.parsePairedCapabilityVersion(registration.id, "resource", registration.pairedResourceVersion, backendRevision);
    const plugin = parseBrowserPlugin(registration.plugin, declaration.sourcePluginId);
    if (plugin.apiVersion === 4 && !this.warnedLegacyPluginIds.has(declaration.sourcePluginId)) {
      this.warnedLegacyPluginIds.add(declaration.sourcePluginId);
      console.warn(`Browser plugin ${declaration.sourcePluginId} uses deprecated API v4; migrate to API v5`);
    }
    const lifetimeController = new AbortController();
    this.activatingLifetimes.add(lifetimeController);
    let phase: BrowserPluginLifecyclePhase = "activate";
    let rollbackDispose: ((signal: AbortSignal) => Promise<void>) | undefined;
    try {
      const activationValue = await runBounded(
        registration.id,
        phase,
        this.lifecycleTimeoutMs,
        lifetimeController.signal,
        (signal) => plugin.activate(Object.freeze({
          apiVersion: plugin.apiVersion,
          pluginId: declaration.sourcePluginId,
          runtimePluginId: registration.id,
          html,
          svg,
          signal,
          lifetimeSignal: lifetimeController.signal,
          localization: createPluginLocalization(this.options.localization ?? localization, declaration.sourcePluginId, registration.id, lifetimeController.signal),
          selection: this.selection.forPlugin(registration.id, lifetimeController.signal),
        })),
      );
      rollbackDispose = activationDisposeForRollback(activationValue);
      phase = "validate";
      const activation = parseBrowserActivation(activationValue, registration.id, declaration.sourcePluginId);
      const provisions = (activation.provides ?? []).map(internalCapabilityProvision);
      const versionedContributions = contributionsForVersion(activation.contributions, plugin.apiVersion);
      const contributions = this.prepareContributions(
        registration,
        plugin.apiVersion === 5
          ? withV5Services(versionedContributions, registration, workspacePluginBinding(registration.id, declaration.sourcePluginId, backendRevision, pairedRequestVersion, pairedChannelVersion, pairedResourceVersion), lifetimeController.signal)
          : versionedContributions,
        backendRevision,
        pairedRequestVersion,
        pairedChannelVersion,
        pairedResourceVersion,
        lifetimeController.signal,
      );
      if (this.shuttingDown) throw new Error("Browser plugin registry is shutting down");
      return Object.freeze({ registration, declaration, plugin, activation, lifetimeController, provisions, contributions });
    } catch (error) {
      abortLifetime(lifetimeController, new DOMException(`Browser plugin ${registration.id} activation failed`, "AbortError"));
      const rollbackError = rollbackDispose === undefined ? undefined : await this.runRollbackDispose(registration.id, rollbackDispose);
      throw lifecycleError(phase, withRollbackError(error, rollbackError));
    } finally {
      this.activatingLifetimes.delete(lifetimeController);
    }
  }

  private prepareContributions(
    registration: PiWebPluginRegistration,
    contributions: PluginContributions,
    backendRevision: string | undefined,
    pairedRequestVersion: 1 | undefined,
    pairedChannelVersion: 1 | undefined,
    pairedResourceVersion: 1 | undefined,
    lifetimeSignal: AbortSignal,
  ): PreparedPluginContributions {
    const runtimePluginId = registration.id;
    const contributionIds = new Set<QualifiedContributionId>();
    const filePreviewers = (contributions.filePreviewers ?? []).map((value): RegisteredFilePreviewer => {
      const snapshot = snapshotFilePreviewer(value);
      return Object.freeze(snapshotDisplayMetadata(snapshot, {
        ...snapshot, id: this.qualify(runtimePluginId, snapshot.id, contributionIds), pluginId: runtimePluginId,
        binding: workspacePluginBinding(runtimePluginId, registration.sourcePluginId, backendRevision, pairedRequestVersion, pairedChannelVersion, pairedResourceVersion),
        lifetime: lifetimeSignal,
        ...(registration.machineId === undefined ? {} : { machineId: registration.machineId }),
        ...(registration.sourcePluginId === undefined ? {} : { sourcePluginId: registration.sourcePluginId }),
      }));
    });
    const contentRenderers = (contributions.contentRenderers ?? []).map((renderer): RegisteredContentRenderer => {
      const snapshot = snapshotContentRenderer(renderer);
      const supports = snapshot.supports?.bind(snapshot);
      return snapshotDisplayMetadata<RegisteredContentRenderer>(snapshot, {
        ...snapshot,
        id: this.qualify(runtimePluginId, renderer.id, contributionIds),
        pluginId: runtimePluginId,
        localId: renderer.id,
        get label() { return snapshot.title ?? `${registration.sourcePluginId ?? runtimePluginId} / ${snapshot.id}`; },
        ...(supports === undefined ? {} : { supports: (request: Readonly<ContentRenderRequest>) => !lifetimeSignal.aborted && supports(request) }),
        ...(registration.machineId === undefined ? {} : { machineId: registration.machineId }),
        ...(registration.sourcePluginId === undefined ? {} : { sourcePluginId: registration.sourcePluginId }),
        render: (input) => {
          const signal = AbortSignal.any([input.signal, lifetimeSignal]);
          return snapshot.render({ ...input, signal, fail: (error) => { if (!signal.aborted) input.fail(error); } });
        },
      });
    });
    filePreviewers.push(...contentRenderers.map((renderer) => textFilePreviewer(renderer, this.contentRendering,
      workspacePluginBinding(runtimePluginId, registration.sourcePluginId, backendRevision, pairedRequestVersion, pairedChannelVersion, pairedResourceVersion), lifetimeSignal)));
    const syntaxHighlighters = (contributions.syntaxHighlighters ?? []).map((contribution): RegisteredSyntaxHighlighter => {
      const snapshot = snapshotSyntaxHighlighter(contribution);
      const id = this.qualify(runtimePluginId, snapshot.id, contributionIds);
      const highlighter: RegisteredSyntaxHighlighter = Object.freeze({
        ...snapshot,
        id,
        pluginId: runtimePluginId,
        localId: snapshot.id,
        label: `${registration.sourcePluginId ?? runtimePluginId} / ${snapshot.id}`,
        ...(registration.machineId === undefined ? {} : { machineId: registration.machineId }),
        ...(registration.sourcePluginId === undefined ? {} : { sourcePluginId: registration.sourcePluginId }),
        highlight: (input: { text: string; signal: AbortSignal }) => runSyntaxHighlighter(
          { ...snapshot, id }, input.text, AbortSignal.any([input.signal, lifetimeSignal]),
        ),
      });
      return highlighter;
    });
    const messageActions = (contributions.messageActions ?? []).map((action): RegisteredMessageAction => Object.freeze(snapshotDisplayMetadata<RegisteredMessageAction>(action, {
      ...action,
      id: this.qualify(runtimePluginId, action.id, contributionIds),
      binding: workspacePluginBinding(runtimePluginId, registration.sourcePluginId, backendRevision, pairedRequestVersion, pairedChannelVersion, pairedResourceVersion),
      ...(registration.machineId === undefined ? {} : { machineId: registration.machineId }),
    })));
    const actions = (contributions.actions ?? []).map((action) => this.qualifyAction(runtimePluginId, action, registration.machineId, registration.sourcePluginId, contributionIds));
    const applicationPanels = (contributions.applicationPanels ?? []).map((panel) => this.qualifyApplicationPanel(runtimePluginId, panel, registration.machineId, registration.sourcePluginId, contributionIds));
    const workspacePanels = (contributions.workspacePanels ?? []).map((panel) => this.qualifyWorkspacePanel(runtimePluginId, panel, registration.machineId, registration.sourcePluginId, backendRevision, pairedRequestVersion, pairedChannelVersion, pairedResourceVersion, contributionIds));
    const workspaceLabels = (contributions.workspaceLabels ?? []).map((contribution) => this.qualifyWorkspaceLabelContribution(runtimePluginId, contribution, registration.machineId, registration.sourcePluginId, backendRevision, pairedRequestVersion, pairedChannelVersion, pairedResourceVersion, contributionIds));
    const sessionLabels = (contributions.sessionLabels ?? []).map((contribution) => this.qualifySessionLabelContribution(runtimePluginId, contribution, registration.machineId, registration.sourcePluginId, backendRevision, pairedRequestVersion, pairedChannelVersion, pairedResourceVersion, contributionIds));
    const stylesheets = (contributions.stylesheets ?? []).map((style) => ({
      ...this.qualifyStylesheet(runtimePluginId, style, contributionIds),
      ...(registration.machineId === undefined ? {} : { machineId: registration.machineId }),
      ...(registration.sourcePluginId === undefined ? {} : { sourcePluginId: registration.sourcePluginId }),
    }));
    const themes = registration.machineId === undefined
      ? (contributions.themes ?? []).map((theme) => this.qualifyTheme(runtimePluginId, theme, contributionIds))
      : [];
    const fileIconThemes = registration.machineId === undefined
      ? (contributions.fileIconThemes ?? []).map((theme) => {
        const snapshot = snapshotFileIconTheme(theme);
        const id = this.qualify(runtimePluginId, snapshot.id, contributionIds);
        return Object.freeze(snapshotDisplayMetadata(theme, { ...snapshot, id, pluginId: runtimePluginId, localId: snapshot.id }));
      })
      : [];
    const themePairs = registration.machineId === undefined
      ? (contributions.themePairs ?? []).map((pair) => this.qualifyThemePair(runtimePluginId, pair, contributionIds))
      : [];
    return Object.freeze({ ids: contributionIds, filePreviewers, contentRenderers, syntaxHighlighters, actions, messageActions, applicationPanels, workspacePanels, workspaceLabels, sessionLabels, stylesheets, themes, fileIconThemes, themePairs });
  }

  private dependencyFailure(
    staged: StagedBrowserPlugin,
    pending: ReadonlyMap<string, StagedBrowserPlugin>,
    stagedById: ReadonlyMap<string, StagedBrowserPlugin>,
  ): Error | undefined {
    for (const requirement of staged.plugin.requires) {
      if (this.hostCapabilitiesByKey.has(capabilityKey(requirement))) continue;
      const provider = this.providerDeclaration(staged.declaration, requirement.pluginId);
      if (provider === undefined) {
        return new Error(`Browser plugin ${staged.registration.id} requires unavailable capability ${formatCapability(requirement)}`);
      }
      const active = this.activeCapabilitiesByRegistration.get(provider.id);
      if (active?.has(capabilityKey(requirement)) === true) continue;
      if (active !== undefined) {
        return new Error(`Browser plugin ${staged.registration.id} requires unavailable capability ${formatCapability(requirement)} from ${provider.id}`);
      }
      const providerStage = stagedById.get(provider.id);
      if (providerStage !== undefined && !providerStage.provisions.some(({ key }) => key === capabilityKey(requirement))) {
        return new Error(`Browser plugin ${staged.registration.id} requires unavailable capability ${formatCapability(requirement)} from ${provider.id}`);
      }
      if (!pending.has(provider.id)) {
        return new Error(`Browser plugin ${staged.registration.id} requires ${formatCapability(requirement)}, but provider plugin ${provider.id} did not start`);
      }
    }
    return undefined;
  }

  private waitingForDependencies(
    staged: StagedBrowserPlugin,
    pending: ReadonlyMap<string, StagedBrowserPlugin>,
    stagedById: ReadonlyMap<string, StagedBrowserPlugin>,
  ): boolean {
    return staged.plugin.requires.some((requirement) => {
      if (this.hostCapabilitiesByKey.has(capabilityKey(requirement))) return false;
      const provider = this.providerDeclaration(staged.declaration, requirement.pluginId);
      if (provider === undefined) return false;
      if (this.activeCapabilitiesByRegistration.get(provider.id)?.has(capabilityKey(requirement)) === true) return false;
      return pending.has(provider.id) && stagedById.get(provider.id)?.provisions.some(({ key }) => key === capabilityKey(requirement)) === true;
    });
  }

  private async startStagedPlugin(
    staged: StagedBrowserPlugin,
    hostRequirements: readonly HostPluginCapabilityRequirement[],
  ): Promise<PluginRegistrationFailure | undefined> {
    try {
      const start = staged.activation.start?.bind(staged.activation);
      if (start !== undefined) {
        const capabilities = this.capabilityResolver(staged);
        await runBounded(staged.registration.id, "start", this.lifecycleTimeoutMs, staged.lifetimeController.signal, (signal) => start(Object.freeze({ capabilities, signal })));
      }
    } catch (error) {
      return await this.failBeforeStart(staged, error, "start");
    }

    const hostSnapshots: InternalHostCapabilitySnapshot[] = [];
    try {
      for (const requirement of hostRequirements) {
        if (requirement.registrationPluginId !== staged.registration.id) continue;
        const capability = snapshotTypedCapability(requirement.capability, `Host requirement for browser plugin ${staged.registration.id}`);
        const key = capabilityKey(capability);
        if (hostSnapshots.some((snapshot) => snapshot.key === key)) {
          throw new Error(`Host requires ${formatCapability(capability)} from browser plugin ${staged.registration.id} more than once`);
        }
        const provision = staged.provisions.find((candidate) => candidate.key === key);
        if (provision === undefined) {
          throw new Error(`Browser plugin ${staged.registration.id} did not provide required capability ${formatCapability(capability)}`);
        }
        const value = parseCapabilityValue(capability, provision.value, `Required host capability ${formatCapability(capability)} from browser plugin ${staged.registration.id}`);
        hostSnapshots.push(Object.freeze({ token: requirement.capability, key, value }));
      }
    } catch (error) {
      return await this.failBeforeStart(staged, error, "validate");
    }

    if (this.shuttingDown) return await this.failBeforeStart(staged, browserPluginShutdownError(), "start");
    this.publish(staged, hostSnapshots);
    return undefined;
  }

  private capabilityResolver(staged: StagedBrowserPlugin): PluginStartContext["capabilities"] {
    const resolved = new Map<string, unknown>();
    for (const requirement of staged.plugin.requires) {
      const key = capabilityKey(requirement);
      const host = this.hostCapabilitiesByKey.get(key);
      const provider = host === undefined ? this.providerDeclaration(staged.declaration, requirement.pluginId) : undefined;
      const provision = host ?? (provider === undefined ? undefined : this.activeCapabilitiesByRegistration.get(provider.id)?.get(key));
      if (provision === undefined) throw new Error(`Browser plugin ${staged.registration.id} requires inactive capability ${formatCapability(requirement)}`);
      // Validate the declared requirement before start, but retain the provider value:
      // resolve() may supply a different parser for this same capability key.
      parseCapabilityValue(requirement, provision.value, `Required capability ${formatCapability(requirement)} for browser plugin ${staged.registration.id}`);
      resolved.set(key, provision.value);
    }
    return createCapabilityResolver(staged.registration.id, resolved);
  }

  private publish(staged: StagedBrowserPlugin, hostSnapshots: readonly InternalHostCapabilitySnapshot[]): void {
    this.removeStaged(staged.registration.id);
    this.activePlugins.push(staged);
    this.pluginIds.add(staged.registration.id);
    for (const contributionId of staged.contributions.ids) this.contributionIds.add(contributionId);
    this.filePreviewers.push(...staged.contributions.filePreviewers);
    this.contentRenderers.push(...staged.contributions.contentRenderers);
    this.syntaxHighlighters.push(...staged.contributions.syntaxHighlighters);
    this.actions.push(...staged.contributions.actions);
    this.messageActions.push(...staged.contributions.messageActions);
    this.workspacePanels.push(...staged.contributions.workspacePanels);
    this.applicationPanels.push(...staged.contributions.applicationPanels);
    this.workspaceLabels.push(...staged.contributions.workspaceLabels);
    this.sessionLabels.push(...staged.contributions.sessionLabels);
    this.stylesheets.push(...staged.contributions.stylesheets);
    this.themes.push(...staged.contributions.themes);
    this.fileIconThemes.push(...staged.contributions.fileIconThemes);
    this.themePairs.push(...staged.contributions.themePairs);
    for (const kind of ["themes", "themePairs"] as const) {
      for (const contribution of staged.contributions[kind]) {
        const key = `${kind}:${contribution.id}`;
        if (this.warnedRuntimeThemeContributions.has(key)) continue;
        this.warnedRuntimeThemeContributions.add(key);
        console.warn(`Browser plugin ${staged.registration.id} registers deprecated runtime ${kind} contribution ${contribution.id}; move it to piWeb.plugins[].${kind} in package.json (use browserRoot and stylesheet paths for static themes). Runtime contributions remain supported for compatibility.`);
      }
    }
    this.activeCapabilitiesByRegistration.set(staged.registration.id, new Map(staged.provisions.map((provision) => [provision.key, provision])));
    if (hostSnapshots.length > 0) {
      this.hostCapabilitySnapshotsByRegistration.set(staged.registration.id, new Map(hostSnapshots.map((snapshot) => [snapshot.key, snapshot])));
    }
    if (staged.declaration.machineId === undefined) {
      this.gatewayPluginIds.add(staged.registration.id);
      if (staged.declaration.machineSpecific) this.gatewayMachineSpecificPluginIds.add(staged.registration.id);
    }
  }

  private async failBeforeStart(
    staged: StagedBrowserPlugin,
    error: unknown,
    phase: BrowserPluginLifecyclePhase = "start",
  ): Promise<PluginRegistrationFailure> {
    abortLifetime(staged.lifetimeController, new DOMException(`Browser plugin ${staged.registration.id} startup failed`, "AbortError"));
    this.removeStaged(staged.registration.id);
    const dispose = staged.activation.dispose?.bind(staged.activation);
    const rollbackError = dispose === undefined ? undefined : await this.runRollbackDispose(staged.registration.id, dispose);
    return failureFor(registrationDeclaration(staged.registration), phase, withRollbackError(error, rollbackError));
  }

  private async runRollbackDispose(pluginId: string, dispose: (signal: AbortSignal) => Promise<void> | void): Promise<unknown> {
    try {
      await runBounded(pluginId, "dispose", this.lifecycleTimeoutMs, undefined, (signal) => dispose(signal));
      return undefined;
    } catch (error) {
      return error;
    }
  }

  private removeStaged(pluginId: string): void {
    this.stagedPlugins = this.stagedPlugins.filter(({ registration }) => registration.id !== pluginId);
  }

  private providerDeclaration(consumer: NormalizedPluginDeclaration, sourcePluginId: string): NormalizedPluginDeclaration | undefined {
    const candidates = [...this.declarationsById.values()].filter((declaration) => declaration.sourcePluginId === sourcePluginId);
    if (consumer.machineId === undefined && !consumer.machineSpecific) {
      return candidates.find((candidate) => candidate.machineId === undefined && !candidate.machineSpecific);
    }
    const sameMachine = consumer.machineId === undefined
      ? candidates.find((candidate) => candidate.machineId === undefined && candidate.machineSpecific)
      : candidates.find((candidate) => candidate.machineId === consumer.machineId);
    return sameMachine ?? candidates.find((candidate) => candidate.machineId === undefined && !candidate.machineSpecific);
  }

  private findCapabilityCycle(
    pending: ReadonlyMap<string, StagedBrowserPlugin>,
    stagedById: ReadonlyMap<string, StagedBrowserPlugin>,
  ): string[] {
    const state = new Map<string, "visiting" | "visited">();
    const stack: string[] = [];
    const visit = (pluginId: string): string[] | undefined => {
      state.set(pluginId, "visiting");
      stack.push(pluginId);
      const plugin = pending.get(pluginId);
      const providers = (plugin?.plugin.requires ?? []).flatMap((requirement) => {
        if (this.hostCapabilitiesByKey.has(capabilityKey(requirement)) || plugin === undefined) return [];
        const provider = this.providerDeclaration(plugin.declaration, requirement.pluginId);
        return provider !== undefined && pending.has(provider.id) && stagedById.get(provider.id)?.provisions.some(({ key }) => key === capabilityKey(requirement)) === true
          ? [provider.id]
          : [];
      }).sort((left, right) => left.localeCompare(right));
      for (const providerId of providers) {
        if (state.get(providerId) === "visiting") return stack.slice(stack.indexOf(providerId));
        if (state.get(providerId) !== "visited") {
          const cycle = visit(providerId);
          if (cycle !== undefined) return cycle;
        }
      }
      stack.pop();
      state.set(pluginId, "visited");
      return undefined;
    };
    for (const pluginId of [...pending.keys()].sort((left, right) => left.localeCompare(right))) {
      if (state.has(pluginId)) continue;
      const cycle = visit(pluginId);
      if (cycle !== undefined) return cycle;
    }
    return [];
  }

  private normalizeDeclaration(value: PiWebPluginRegistrationDeclaration): NormalizedPluginDeclaration {
    this.validatePluginId(value.id);
    const sourcePluginId = value.sourcePluginId ?? value.id;
    this.validatePluginId(sourcePluginId);
    const machineSpecific = this.parseMachineSpecific(value.id, value.machineSpecific);
    if (value.machineId !== undefined && value.machineId === "") throw new Error(`Invalid plugin machine id for ${value.id}`);
    return Object.freeze({
      id: value.id,
      sourcePluginId,
      ...(value.machineId === undefined ? {} : { machineId: value.machineId }),
      ...(value.manifestSource === undefined ? {} : { manifestSource: value.manifestSource }),
      ...(value.manifestScope === undefined ? {} : { manifestScope: value.manifestScope }),
      machineSpecific,
    });
  }

  private recordDeclaration(declaration: NormalizedPluginDeclaration): boolean {
    if (this.isRemoteDuplicateHiddenByGateway(
      declaration.sourcePluginId === declaration.id ? undefined : declaration.sourcePluginId,
      declaration.machineId,
      declaration.machineSpecific,
    )) return false;
    const existing = this.declarationsById.get(declaration.id);
    if (existing !== undefined && !sameDeclaration(existing, declaration)) {
      throw new Error(`Plugin registration scope changed for ${declaration.id}; reload PI WEB before activating a replacement`);
    }
    this.declarationsById.set(declaration.id, declaration);
    // A declared machine-specific remote shadows portable composition even
    // when import or startup fails. Gateway loading decisions remain based on
    // successfully published registrations so failed entries can recover.
    if (declaration.machineId !== undefined && declaration.machineSpecific) {
      addMappedSetValue(this.remoteMachineSpecificPluginIds, declaration.sourcePluginId, declaration.machineId);
    }
    return true;
  }

  hasPlugin(pluginId: string): boolean {
    return this.pluginIds.has(pluginId);
  }

  shouldLoadRemotePlugin(sourcePluginId: string, machineSpecific = false): boolean {
    return !this.gatewayPluginIds.has(sourcePluginId) || this.gatewayMachineSpecificPluginIds.has(sourcePluginId) || machineSpecific;
  }

  getActions(context: PluginRuntimeContext): QualifiedPluginAction[] {
    const selectedMachineId = runtimeContextMachineId(context);
    return this.actions.filter((action) => this.isContributionActive(action.pluginId, action.machineId, selectedMachineId, action.sourcePluginId)).map((action) => {
      const scopedContext = pluginRuntimeContextFor(context, action.pluginId);
      const enabled = action.enabled?.(scopedContext);
      const disabledReason = enabled === false ? action.disabledReason?.(scopedContext) : undefined;
      const qualified = snapshotDisplayMetadata<QualifiedPluginAction>(action, {
        id: action.id,
        pluginId: action.pluginId,
        localId: action.localId,
        ...(action.machineId === undefined ? {} : { machineId: action.machineId }),
        get title() { return action.title; },
        ...(action.description === undefined ? {} : { description: action.description }),
        ...(action.group === undefined ? {} : { group: action.group }),
        run: () => this.isContributionActive(action.pluginId, action.machineId, runtimeContextMachineId(context), action.sourcePluginId)
          ? action.run(pluginRuntimeContextFor(context, action.pluginId))
          : undefined,
      });
      if (action.shortcut !== undefined) qualified.shortcut = action.shortcut;
      if (action.shortcutAliases !== undefined) qualified.shortcutAliases = [...action.shortcutAliases];
      if (enabled !== undefined) qualified.enabled = enabled;
      if (disabledReason !== undefined && disabledReason !== "") {
        Object.defineProperty(qualified, "disabledReason", { enumerable: true, get: () => action.disabledReason?.(scopedContext) });
      }
      return qualified;
    });
  }

  getApplicationPanels(): QualifiedApplicationPanelContribution[] {
    return [...this.applicationPanels].sort((left, right) => (left.order ?? 1000) - (right.order ?? 1000) || left.title.localeCompare(right.title));
  }

  getWorkspacePanels(): QualifiedWorkspacePanelContribution[] {
    return [...this.workspacePanels].sort((left, right) => (left.order ?? 1000) - (right.order ?? 1000) || left.title.localeCompare(right.title));
  }

  resolveWorkspaceFileOpen(context: WorkspacePanelContext, path: string) {
    for (const panel of this.getWorkspacePanels()) {
      if (panel.visible?.(context) === false) continue;
      const query = panel.fileOpenQuery?.(context, path);
      if (query !== undefined) return { contributionId: panel.id, sourceContributionId: panel.sourceContributionId, query };
    }
    return undefined;
  }

  resolveWorkspacePanelRouteId(value: string, selectedMachineId: string): QualifiedContributionId | undefined {
    const activePanels = [...this.workspacePanels, ...this.applicationPanels].filter((panel) => this.isContributionActive(panel.pluginId, panel.machineId, selectedMachineId, panel.sourcePluginId));
    const exact = activePanels.find((panel) => panel.id === value);
    if (exact !== undefined) return exact.id;
    const sourceMatches = activePanels.filter((panel) => panel.sourceContributionId === value);
    if (sourceMatches.length === 1) return sourceMatches[0]?.id;
    if (sourceMatches.length > 1) console.warn(`Ambiguous PI WEB workspace panel source identity: ${value}`);
    return undefined;
  }

  async invalidateWorkspacePanels(context: WorkspacePanelContext, panelId?: QualifiedContributionId): Promise<void> {
    await this.invalidateMatchingWorkspacePanels(
      context,
      (panel) => panelId === undefined || panel.id === panelId,
    );
  }

  async invalidateWorkspaceResources(context: WorkspacePanelContext, invalidation: WorkspaceInvalidation): Promise<void> {
    const resources = new Set(invalidation.resources);
    await this.invalidateMatchingWorkspacePanels(
      context,
      (panel) => panel.invalidationResources?.some((resource) => resources.has(resource)) === true,
      invalidation,
    );
  }

  private async invalidateMatchingWorkspacePanels(
    context: WorkspacePanelContext,
    matches: (panel: QualifiedWorkspacePanelContribution) => boolean,
    invalidation?: WorkspaceInvalidation,
  ): Promise<void> {
    await Promise.all(this.workspacePanels.map(async (panel) => {
      if (panel.onInvalidate === undefined || !matches(panel)) return;
      try {
        if (invalidation === undefined) await panel.onInvalidate(context);
        else await panel.onInvalidate(context, invalidation);
      } catch (error) {
        console.warn(`Failed to invalidate PI WEB plugin panel ${panel.id}`, error);
      }
    }));
  }

  getStylesheets(selectedMachineId: string): QualifiedStylesheetContribution[] {
    return this.stylesheets.filter((style) => this.isContributionActive(style.pluginId, style.machineId, selectedMachineId, style.sourcePluginId));
  }

  getFileIconThemes(): QualifiedFileIconThemeContribution[] {
    return this.fileIconThemes
      .filter((theme) => this.isContributionEnabled(theme.pluginId, undefined))
      .sort((left, right) => (left.order ?? 1000) - (right.order ?? 1000) || left.name.localeCompare(right.name));
  }

  /** Backend-validated, enabled declarations do not depend on browser activation. */
  setDeclarativeThemes(themes: readonly QualifiedThemeContribution[], pairs: readonly QualifiedThemePairContribution[]): void {
    const runtimeIds = new Set([...this.themes, ...this.themePairs].map(({ id }) => id));
    for (const contribution of [...themes, ...pairs]) {
      if (runtimeIds.has(contribution.id)) throw new Error(`Theme contribution ${contribution.id} is declared both statically and at runtime`);
    }
    this.declarativeThemes = [...themes];
    this.declarativeThemePairs = [...pairs];
  }

  getThemes(): QualifiedThemeContribution[] {
    return [...this.declarativeThemes, ...this.themes.filter((theme) => this.isContributionEnabled(theme.pluginId, undefined))]
      .sort((left, right) => (left.order ?? 1000) - (right.order ?? 1000) || left.name.localeCompare(right.name));
  }

  getThemePairs(): QualifiedThemePairContribution[] {
    return [...this.declarativeThemePairs, ...this.themePairs.filter((pair) => this.isContributionEnabled(pair.pluginId, undefined))]
      .sort((left, right) => (left.order ?? 1000) - (right.order ?? 1000) || left.name.localeCompare(right.name));
  }

  getWorkspaceLabelItems(context: WorkspaceLabelContext): WorkspaceLabelItem[] {
    return [...this.workspaceLabels]
      .sort((left, right) => (left.order ?? 1000) - (right.order ?? 1000) || left.id.localeCompare(right.id))
      .flatMap((contribution) => {
        if (contribution.visible?.(context) === false) return [];
        return contribution.items(context);
      });
  }

  getSessionLabelItems(context: SessionLabelContext): SessionLabelItem[] {
    return [...this.sessionLabels]
      .sort((left, right) => (left.order ?? 1000) - (right.order ?? 1000) || left.id.localeCompare(right.id))
      .flatMap((contribution) => {
        const reportFailure = (phase: string, error: unknown) => {
          console.warn(`PI WEB plugin session label ${contribution.id} ${phase} failed for session ${context.session.id} on machine ${context.machine.id}`, error);
        };
        let phase = "visible";
        try {
          if (contribution.visible?.(context) === false) return [];
          phase = "items";
          return contribution.items(context).flatMap((item): SessionLabelItem[] => {
            if (item.type !== "render") return [item];
            try {
              // Resolve plugin templates while their owner is known, so a failed
              // item is omitted before the list adds separators or renders rows.
              const template = item.render();
              return [{ ...item, render: () => template }];
            } catch (error) {
              reportFailure("render", error);
              return [];
            }
          });
        } catch (error) {
          reportFailure(phase, error);
          return [];
        }
      });
  }

  private qualifyAction(
    pluginId: string,
    action: PluginAction,
    machineId: string | undefined,
    sourcePluginId: string | undefined,
    contributionIds: Set<QualifiedContributionId>,
  ): RegisteredPluginAction {
    const id = this.qualify(pluginId, action.id, contributionIds);
    const sourceId = `${sourcePluginId ?? pluginId}:${action.id}`;
    const shortcutAliases = this.parseShortcutAliases(id, action.shortcutAliases, sourceId);
    return snapshotDisplayMetadata<RegisteredPluginAction>(action, {
      ...action,
      id,
      pluginId,
      localId: action.id,
      ...(shortcutAliases.length === 0 ? {} : { shortcutAliases }),
      ...(machineId === undefined ? {} : { machineId }),
      ...(sourcePluginId === undefined ? {} : { sourcePluginId }),
    });
  }

  private qualifyApplicationPanel(
    pluginId: string,
    panel: ApplicationPanelContribution,
    machineId: string | undefined,
    sourcePluginId: string | undefined,
    contributionIds: Set<QualifiedContributionId>,
  ): QualifiedApplicationPanelContribution {
    const id = this.qualify(pluginId, panel.id, contributionIds);
    this.rejectPanelAliases(panel, id);
    const sourceContributionId: QualifiedContributionId = `${sourcePluginId ?? pluginId}:${panel.id}`;
    const scopedContext = (context: ApplicationPanelContext) => applicationPanelScopes.get(context)?.(pluginId) ?? context;
    return snapshotDisplayMetadata<QualifiedApplicationPanelContribution>(panel, {
      ...panel, id, sourceContributionId, pluginId, localId: panel.id,
      ...(machineId === undefined ? {} : { machineId }),
      ...(sourcePluginId === undefined ? {} : { sourcePluginId }),
      visible: (context) => this.isContributionActive(pluginId, machineId, context.machine.id, sourcePluginId)
        && (panel.visible?.(scopedContext(context)) ?? true),
      ...(panel.badge === undefined ? {} : { badge: (context: ApplicationPanelContext) => this.isContributionActive(pluginId, machineId, context.machine.id, sourcePluginId)
        ? panel.badge?.(scopedContext(context)) : undefined }),
      ...(panel.onInvalidate === undefined ? {} : { onInvalidate: (context: ApplicationPanelContext) => this.isContributionActive(pluginId, machineId, context.machine.id, sourcePluginId)
        ? panel.onInvalidate?.(scopedContext(context)) : undefined }),
      render: (context) => this.isContributionActive(pluginId, machineId, context.machine.id, sourcePluginId)
        ? panel.render(scopedContext(context)) : html``,
    });
  }

  private qualifyWorkspacePanel(
    pluginId: string,
    panel: WorkspacePanelContribution,
    machineId: string | undefined,
    sourcePluginId: string | undefined,
    backendRevision: string | undefined,
    pairedRequestVersion: 1 | undefined,
    pairedChannelVersion: 1 | undefined,
    pairedResourceVersion: 1 | undefined,
    contributionIds: Set<QualifiedContributionId>,
  ): QualifiedWorkspacePanelContribution {
    const id = this.qualify(pluginId, panel.id, contributionIds);
    const fileOpenQuery = panel.fileOpenQuery;
    const badge = panel.badge;
    const visible = panel.visible;
    const onInvalidate = panel.onInvalidate;
    const binding = workspacePluginBinding(pluginId, sourcePluginId, backendRevision, pairedRequestVersion, pairedChannelVersion, pairedResourceVersion);
    this.rejectPanelAliases(panel, id);
    const sourceContributionId: QualifiedContributionId = `${sourcePluginId ?? pluginId}:${panel.id}`;
    const invalidationResources = this.parseInvalidationResources(id, panel.invalidationResources);
    const scopedContext = (context: WorkspacePanelContext) => workspacePanelContextFor(context, binding, id, sourceContributionId);
    return snapshotDisplayMetadata<QualifiedWorkspacePanelContribution>(panel, {
      ...panel,
      id,
      pluginId,
      localId: panel.id,
      sourceContributionId,
      ...(panel.invalidationResources === undefined ? {} : { invalidationResources }),
      ...(machineId === undefined ? {} : { machineId }),
      ...(sourcePluginId === undefined ? {} : { sourcePluginId }),
      visible: (context: WorkspacePanelContext) => this.isContributionActive(pluginId, machineId, context.machine.id, sourcePluginId) && (visible?.(scopedContext(context)) ?? true),
      ...(fileOpenQuery === undefined ? {} : { fileOpenQuery: (context: WorkspacePanelContext, path: string) => this.isContributionActive(pluginId, machineId, context.machine.id, sourcePluginId) ? fileOpenQuery(scopedContext(context), path) : undefined }),
      ...(badge === undefined ? {} : { badge: (context: WorkspacePanelContext) => this.isContributionActive(pluginId, machineId, context.machine.id, sourcePluginId) ? badge(scopedContext(context)) : undefined }),
      ...(onInvalidate === undefined ? {} : { onInvalidate: (context: WorkspacePanelContext, invalidation?: WorkspaceInvalidation) => {
        if (!this.isContributionActive(pluginId, machineId, context.machine.id, sourcePluginId)) return undefined;
        const contextForPanel = scopedContext(context);
        return invalidation === undefined ? onInvalidate(contextForPanel) : onInvalidate(contextForPanel, invalidation);
      } }),
      render: (context: WorkspacePanelContext) => this.isContributionActive(pluginId, machineId, context.machine.id, sourcePluginId)
        ? panel.render(scopedContext(context))
        : html``,
    });
  }

  private qualifyWorkspaceLabelContribution(
    pluginId: string,
    contribution: WorkspaceLabelContribution,
    machineId: string | undefined,
    sourcePluginId: string | undefined,
    backendRevision: string | undefined,
    pairedRequestVersion: 1 | undefined,
    pairedChannelVersion: 1 | undefined,
    pairedResourceVersion: 1 | undefined,
    contributionIds: Set<QualifiedContributionId>,
  ): QualifiedWorkspaceLabelContribution {
    const id = this.qualify(pluginId, contribution.id, contributionIds);
    const visible = contribution.visible;
    const items = contribution.items;
    const binding = workspacePluginBinding(pluginId, sourcePluginId, backendRevision, pairedRequestVersion, pairedChannelVersion, pairedResourceVersion);
    return {
      ...contribution,
      id,
      pluginId,
      localId: contribution.id,
      ...(machineId === undefined ? {} : { machineId }),
      visible: (context) => this.isContributionActive(pluginId, machineId, context.machine.id, sourcePluginId) && (visible?.(workspaceLabelContextFor(context, binding)) ?? true),
      items: (context) => this.isContributionActive(pluginId, machineId, context.machine.id, sourcePluginId) ? items(workspaceLabelContextFor(context, binding)) : [],
    };
  }

  private qualifySessionLabelContribution(
    pluginId: string,
    contribution: SessionLabelContribution,
    machineId: string | undefined,
    sourcePluginId: string | undefined,
    backendRevision: string | undefined,
    pairedRequestVersion: 1 | undefined,
    pairedChannelVersion: 1 | undefined,
    pairedResourceVersion: 1 | undefined,
    contributionIds: Set<QualifiedContributionId>,
  ): QualifiedSessionLabelContribution {
    const id = this.qualify(pluginId, contribution.id, contributionIds);
    const visible = contribution.visible;
    const items = contribution.items;
    const binding = workspacePluginBinding(pluginId, sourcePluginId, backendRevision, pairedRequestVersion, pairedChannelVersion, pairedResourceVersion);
    const scopedContext = (context: SessionLabelContext) => sessionLabelScopes.get(context)?.(binding) ?? context;
    return {
      ...contribution,
      id,
      pluginId,
      localId: contribution.id,
      ...(machineId === undefined ? {} : { machineId }),
      visible: (context) => this.isContributionActive(pluginId, machineId, context.machine.id, sourcePluginId)
        && (visible?.(scopedContext(context)) ?? true),
      items: (context) => this.isContributionActive(pluginId, machineId, context.machine.id, sourcePluginId)
        ? items(scopedContext(context)) : [],
    };
  }

  private qualifyStylesheet(pluginId: string, style: StylesheetContribution, contributionIds: Set<QualifiedContributionId>): QualifiedStylesheetContribution {
    const id = this.qualify(pluginId, style.id, contributionIds);
    if (typeof style.url !== "string") throw new Error(`Stylesheet ${id} requires a file URL`);
    const url = new URL(style.url);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`Stylesheet ${id} requires an HTTP(S) file URL`);
    if (style.order !== undefined && !Number.isFinite(style.order)) throw new Error(`Stylesheet ${id} order must be finite`);
    return Object.freeze({ id, pluginId, url: url.href, ...(style.order === undefined ? {} : { order: style.order }) });
  }

  private qualifyTheme(pluginId: string, theme: ThemeContribution, contributionIds: Set<QualifiedContributionId>): QualifiedThemeContribution {
    const id = this.qualify(pluginId, theme.id, contributionIds);
    if ([...this.declarativeThemes, ...this.declarativeThemePairs].some((declared) => declared.id === id)) throw new Error(`Theme ${id} is declared both statically and at runtime`);
    const stylesheetIds = new Set<QualifiedContributionId>();
    const stylesheets = theme.stylesheets?.map((style) => this.qualifyStylesheet(`${pluginId}:${theme.id}`, style, stylesheetIds));
    return snapshotDisplayMetadata<QualifiedThemeContribution>(theme, { ...theme, id, pluginId, localId: theme.id,
      ...(theme.tokens === undefined ? {} : { tokens: Object.freeze({ ...theme.tokens }) }),
      ...(stylesheets === undefined ? {} : { stylesheets }) });
  }

  private qualifyThemePair(pluginId: string, pair: ThemePairContribution, contributionIds: Set<QualifiedContributionId>): QualifiedThemePairContribution {
    const id = this.qualify(pluginId, pair.id, contributionIds);
    if ([...this.declarativeThemes, ...this.declarativeThemePairs].some((declared) => declared.id === id)) throw new Error(`Theme pair ${id} is declared both statically and at runtime`);
    return snapshotDisplayMetadata<QualifiedThemePairContribution>(pair, {
      ...pair,
      id,
      pluginId,
      localId: pair.id,
      light: this.qualifyReference(pluginId, pair.light),
      dark: this.qualifyReference(pluginId, pair.dark),
    });
  }

  private qualify(pluginId: string, localId: string, contributionIds: Set<QualifiedContributionId>): QualifiedContributionId {
    this.validateLocalId(localId);
    const qualified: QualifiedContributionId = `${pluginId}:${localId}`;
    if (this.contributionIds.has(qualified) || contributionIds.has(qualified)) throw new Error(`Duplicate contribution id: ${qualified}`);
    contributionIds.add(qualified);
    return qualified;
  }

  private qualifyReference(pluginId: string, localId: string): QualifiedContributionId {
    this.validateLocalId(localId);
    return `${pluginId}:${localId}`;
  }

  private isContributionActive(pluginId: string, machineId: string | undefined, selectedMachineId: string, sourcePluginId: string | undefined): boolean {
    // Portable gateway registrations still use selected-machine helpers, so
    // their lifecycle gate follows that effective machine rather than local.
    if (!this.isContributionEnabled(pluginId, machineId ?? selectedMachineId)) return false;
    if (machineId === undefined) return !this.isGatewayPluginHiddenForMachine(pluginId, selectedMachineId);
    return machineId === selectedMachineId && !this.isRemotePluginHiddenByGateway(sourcePluginId, machineId);
  }

  private isContributionEnabled(pluginId: string, machineId: string | undefined): boolean {
    return !this.shuttingDown && (this.options.isContributionEnabled?.(pluginId, machineId) ?? true);
  }

  private isRemoteDuplicateHiddenByGateway(sourcePluginId: string | undefined, machineId: string | undefined, machineSpecific: boolean): boolean {
    return sourcePluginId !== undefined
      && machineId !== undefined
      && this.gatewayPluginIds.has(sourcePluginId)
      && !this.gatewayMachineSpecificPluginIds.has(sourcePluginId)
      && !machineSpecific;
  }

  private isRemotePluginHiddenByGateway(sourcePluginId: string | undefined, machineId: string): boolean {
    if (sourcePluginId === undefined) return false;
    if (this.gatewayMachineSpecificPluginIds.has(sourcePluginId)) return false;
    if (this.remoteMachineSpecificPluginIds.get(sourcePluginId)?.has(machineId) === true) return false;
    return this.gatewayPluginIds.has(sourcePluginId);
  }

  private isGatewayPluginHiddenForMachine(pluginId: string, machineId: string): boolean {
    return machineId !== "local" && (
      this.gatewayMachineSpecificPluginIds.has(pluginId)
      || this.remoteMachineSpecificPluginIds.get(pluginId)?.has(machineId) === true
    );
  }

  private parseShortcutAliases(id: QualifiedContributionId, aliases: readonly string[] | undefined, sourceId: string): QualifiedContributionId[] {
    const parsed = [...new Set([...(aliases ?? []), sourceId])].filter((alias) => alias !== id);
    const invalid = parsed.find((alias) => !isQualifiedContributionId(alias));
    if (invalid !== undefined) throw new Error(`Invalid shortcut alias for ${id}: ${invalid}`);
    return parsed.filter(isQualifiedContributionId);
  }

  private rejectPanelAliases(panel: ApplicationPanelContribution | WorkspacePanelContribution, id: QualifiedContributionId): void {
    if (Reflect.get(panel, "routeAliases") !== undefined || Reflect.get(panel, "navigationAliases") !== undefined) {
      throw new BrowserPluginIncompatibleError(`Panel aliases were removed for ${id}; remove routeAliases and navigationAliases and use the current contribution ID`);
    }
  }

  private parseInvalidationResources(id: QualifiedContributionId, value: unknown): WorkspaceResource[] {
    if (value === undefined) return [];
    if (!isUnknownArray(value)) throw new Error(`Invalid workspace-panel invalidation resources for ${id}`);
    const resources: WorkspaceResource[] = [];
    for (const resource of value) {
      if (resource !== "workspace.files") throw new Error(`Invalid workspace-panel invalidation resource for ${id}: ${formatUnknownValue(resource)}`);
      if (!resources.includes(resource)) resources.push(resource);
    }
    return resources;
  }

  private validatePluginId(pluginId: string): void {
    if (!idPattern.test(pluginId)) throw new Error(`Invalid plugin id: ${pluginId}`);
  }

  private validateLocalId(localId: string): void {
    if (!localIdPattern.test(localId)) throw new Error(`Invalid contribution id: ${localId}`);
  }

  private parseBackendRevision(pluginId: string, value: unknown): string | undefined {
    if (value === undefined) return undefined;
    try {
      return requirePluginBackendRevision(value);
    } catch {
      throw new Error(`Invalid plugin backend revision for ${pluginId}`);
    }
  }

  private parsePairedCapabilityVersion(
    pluginId: string,
    capability: "request" | "channel" | "resource",
    value: unknown,
    backendRevision: string | undefined,
  ): 1 | undefined {
    if (value === undefined) return undefined;
    if (value !== 1 || backendRevision === undefined) {
      throw new Error(`Invalid plugin paired backend ${capability} version for ${pluginId}`);
    }
    return value;
  }

  private parseMachineSpecific(pluginId: string, value: unknown): boolean {
    if (value === undefined) return false;
    if (typeof value !== "boolean") throw new Error(`Invalid plugin machineSpecific value for ${pluginId}: ${formatUnknownValue(value)}`);
    return value;
  }
}

function pluginRuntimeContextFor(context: PluginRuntimeContext, pluginId: string): PluginRuntimeContext {
  return pluginRuntimeScopes.get(context)?.(pluginId) ?? context;
}

function workspacePanelContextFor(
  context: WorkspacePanelContext,
  binding: WorkspacePluginBinding,
  contributionId: QualifiedContributionId,
  sourceContributionId: QualifiedContributionId,
): WorkspacePanelContext {
  return workspacePanelScopes.get(context)?.(binding, contributionId, sourceContributionId) ?? context;
}

function workspaceLabelContextFor(context: WorkspaceLabelContext, binding: WorkspacePluginBinding): WorkspaceLabelContext {
  return workspaceLabelScopes.get(context)?.(binding) ?? context;
}

export function installPluginRuntimeScope(context: PluginRuntimeContext, scope: (pluginId: string) => PluginRuntimeContext): PluginRuntimeContext {
  pluginRuntimeScopes.set(context, scope);
  return context;
}

export function installApplicationPanelScope(
  context: ApplicationPanelContext,
  scope: (pluginId: string) => ApplicationPanelContext,
): ApplicationPanelContext {
  applicationPanelScopes.set(context, scope);
  return context;
}

export function installWorkspacePanelScope(
  context: WorkspacePanelContext,
  scope: WorkspacePanelScope,
): WorkspacePanelContext {
  workspacePanelScopes.set(context, scope);
  return context;
}

export function installWorkspaceLabelScope(
  context: WorkspaceLabelContext,
  scope: (binding: WorkspacePluginBinding) => WorkspaceLabelContext,
): WorkspaceLabelContext {
  workspaceLabelScopes.set(context, scope);
  return context;
}

export function installSessionLabelScope(
  context: SessionLabelContext,
  scope: (binding: WorkspacePluginBinding) => SessionLabelContext,
): SessionLabelContext {
  sessionLabelScopes.set(context, scope);
  return context;
}

function workspacePluginBinding(
  registrationPluginId: string,
  sourcePluginId: string | undefined,
  backendRevision: string | undefined,
  pairedRequestVersion: 1 | undefined,
  pairedChannelVersion: 1 | undefined,
  pairedResourceVersion: 1 | undefined,
): WorkspacePluginBinding {
  return Object.freeze({
    registrationPluginId,
    sourcePluginId: sourcePluginId ?? registrationPluginId,
    ...(backendRevision === undefined ? {} : { backendRevision }),
    ...(pairedRequestVersion === undefined ? {} : { pairedRequestVersion }),
    ...(pairedChannelVersion === undefined ? {} : { pairedChannelVersion }),
    ...(pairedResourceVersion === undefined ? {} : { pairedResourceVersion }),
  });
}

function addMappedSetValue(map: Map<string, Set<string>>, key: string, value: string): void {
  const existing = map.get(key);
  if (existing === undefined) map.set(key, new Set([value]));
  else existing.add(value);
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function isQualifiedContributionId(value: string): value is QualifiedContributionId {
  return qualifiedContributionIdPattern.test(value);
}

function formatUnknownValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint" || typeof value === "symbol" || typeof value === "function" || value === null || value === undefined) return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

function runtimeContextMachineId(context: PluginRuntimeContext): string {
  return context.state.selectedMachine?.id ?? "local";
}

function registrationDeclaration(registration: PiWebPluginRegistration): PiWebPluginRegistrationDeclaration {
  return Object.freeze({
    id: registration.id,
    ...(registration.machineId === undefined ? {} : { machineId: registration.machineId }),
    ...(registration.sourcePluginId === undefined ? {} : { sourcePluginId: registration.sourcePluginId }),
    ...(registration.manifestSource === undefined ? {} : { manifestSource: registration.manifestSource }),
    ...(registration.manifestScope === undefined ? {} : { manifestScope: registration.manifestScope }),
    ...(registration.machineSpecific === undefined ? {} : { machineSpecific: registration.machineSpecific }),
  });
}

function failureFor(
  declaration: PiWebPluginRegistrationDeclaration,
  phase: BrowserPluginLifecyclePhase,
  error: unknown,
): PluginRegistrationFailure {
  return Object.freeze({ declaration: registrationDeclarationFromValue(declaration), phase, error });
}

function registrationDeclarationFromValue(value: PiWebPluginRegistrationDeclaration): PiWebPluginRegistrationDeclaration {
  return Object.freeze({
    id: value.id,
    ...(value.machineId === undefined ? {} : { machineId: value.machineId }),
    ...(value.sourcePluginId === undefined ? {} : { sourcePluginId: value.sourcePluginId }),
    ...(value.manifestSource === undefined ? {} : { manifestSource: value.manifestSource }),
    ...(value.manifestScope === undefined ? {} : { manifestScope: value.manifestScope }),
    ...(value.machineSpecific === undefined ? {} : { machineSpecific: value.machineSpecific }),
  });
}

function sameDeclaration(left: NormalizedPluginDeclaration, right: NormalizedPluginDeclaration): boolean {
  return left.id === right.id
    && left.sourcePluginId === right.sourcePluginId
    && left.machineId === right.machineId
    && left.manifestSource === right.manifestSource
    && left.manifestScope === right.manifestScope
    && left.machineSpecific === right.machineSpecific;
}

/** Freeze legacy entrypoint shapes; independently versioned capabilities remain available to both versions. */
function contributionsForVersion(contributions: PluginContributions, apiVersion: 4 | 5): PluginContributions {
  if (apiVersion === 5) {
    if (contributions.themes?.some((theme) => theme.tokens !== undefined) === true) {
      throw new BrowserPluginIncompatibleError("Browser API v5 themes use stylesheets, not tokens");
    }
    return contributions;
  }
  if (contributions.fileIconThemes !== undefined) {
    throw new BrowserPluginIncompatibleError("File icon theme contributions require browser API v5");
  }
  if (contributions.filePreviewers !== undefined || contributions.stylesheets !== undefined || contributions.syntaxHighlighters !== undefined
    || contributions.contentRenderers?.some((renderer) => renderer.title !== undefined || renderer.supports !== undefined) === true
    || contributions.themes?.some((theme) => theme.stylesheets !== undefined) === true) {
    throw new BrowserPluginIncompatibleError("Stylesheet, syntax-highlighter and extended renderer contributions require browser API v5");
  }
  if (contributions.themes?.some((theme) => !isRecord(theme.tokens) || Object.values(theme.tokens).some((value) => typeof value !== "string")) === true) {
    throw new BrowserPluginIncompatibleError("Browser API v4 themes require string palette tokens");
  }
  const legacyContext = <Context extends MessageActionAvailabilityContext>(context: Context): Context => {
    const { entryId, role, text } = context.message;
    return { ...context, message: { entryId, role, text } };
  };
  return {
    ...contributions,
    ...(contributions.contentRenderers === undefined ? {} : { contentRenderers: contributions.contentRenderers.map((renderer) => ({
      ...renderer,
      render: ({ text, signal, fail }) => renderer.render({ text, signal, fail }),
    })) }),
    ...(contributions.messageActions === undefined ? {} : { messageActions: contributions.messageActions.map((action) => {
      if (action.target === "display") return action;
      const { visible, enabled, ariaLabel, run } = action;
      return snapshotDisplayMetadata<MessageActionContribution>(action, {
        ...action,
        ...(visible === undefined ? {} : { visible: (context: MessageActionAvailabilityContext) => visible(legacyContext(context)) }),
        ...(enabled === undefined ? {} : { enabled: (context: MessageActionAvailabilityContext) => enabled(legacyContext(context)) }),
        ...(ariaLabel === undefined ? {} : { ariaLabel: (context: MessageActionAvailabilityContext) => ariaLabel(legacyContext(context)) }),
        run: (context: MessageActionContext) => run(legacyContext(context)),
      });
    }) }),
  };
}

/** Wrap invocation callbacks, not availability probes or activation: portable plugins may change machines. */
function withV5Services(
  contributions: PluginContributions,
  registration: PiWebPluginRegistration,
  binding: WorkspacePluginBinding,
  lifetimeSignal: AbortSignal,
): PluginContributions {
  interface MachineContext {
    machine?: { id: string } | undefined;
    state?: { selectedMachine?: { id: string } | undefined } | undefined;
  }
  const ownerMachineId = registration.machineId ?? (registration.machineSpecific === true ? "local" : undefined);
  const services = <Context extends MachineContext>(context: Context): Context => {
    const machineId = context.machine?.id ?? context.state?.selectedMachine?.id ?? "local";
    const backend = ownerMachineId === machineId ? createPluginBackend(binding, machineId, lifetimeSignal) : undefined;
    // Never reuse a context's backend: it may belong to another plugin or machine.
    return { ...context, catalog: createPluginCatalog(machineId, lifetimeSignal), backend };
  };
  const wrap = <Context extends MachineContext, Args extends unknown[], Result>(callback: (context: Context, ...args: Args) => Result) =>
    (context: Context, ...args: Args): Result => callback(services(context), ...args);
  return {
    ...contributions,
    ...(contributions.actions === undefined ? {} : { actions: contributions.actions.map((action) => {
      const { enabled, disabledReason, run } = action;
      return snapshotDisplayMetadata<PluginAction>(action, {
        ...action,
        ...(enabled === undefined ? {} : { enabled: wrap(enabled) }),
        ...(disabledReason === undefined ? {} : { disabledReason: wrap(disabledReason) }),
        run: wrap(run),
      });
    }) }),
    ...(contributions.applicationPanels === undefined ? {} : { applicationPanels: contributions.applicationPanels.map((panel) => {
      const { visible, badge, onInvalidate, render } = panel;
      return snapshotDisplayMetadata<ApplicationPanelContribution>(panel, {
        ...panel,
        ...(visible === undefined ? {} : { visible: wrap(visible) }),
        ...(badge === undefined ? {} : { badge: wrap(badge) }),
        ...(onInvalidate === undefined ? {} : { onInvalidate: wrap(onInvalidate) }),
        render: wrap(render),
      });
    }) }),
    ...(contributions.workspacePanels === undefined ? {} : { workspacePanels: contributions.workspacePanels.map((panel) => {
      const { visible, fileOpenQuery, badge, onInvalidate, render } = panel;
      return snapshotDisplayMetadata<WorkspacePanelContribution>(panel, {
        ...panel,
        ...(visible === undefined ? {} : { visible: wrap(visible) }),
        ...(fileOpenQuery === undefined ? {} : { fileOpenQuery: wrap(fileOpenQuery) }),
        ...(badge === undefined ? {} : { badge: wrap(badge) }),
        ...(onInvalidate === undefined ? {} : { onInvalidate: wrap(onInvalidate) }),
        render: wrap(render),
      });
    }) }),
    ...(contributions.workspaceLabels === undefined ? {} : { workspaceLabels: contributions.workspaceLabels.map(({ visible, items, ...label }) => ({
      ...label,
      ...(visible === undefined ? {} : { visible: wrap(visible) }),
      items: wrap(items),
    })) }),
    ...(contributions.sessionLabels === undefined ? {} : { sessionLabels: contributions.sessionLabels.map(({ visible, items, ...label }) => ({
      ...label,
      ...(visible === undefined ? {} : { visible: wrap(visible) }),
      items: wrap(items),
    })) }),
    ...(contributions.messageActions === undefined ? {} : { messageActions: contributions.messageActions.map((action) => action.target === "display"
      ? snapshotDisplayMetadata<MessageActionContribution>(action, { ...action, run: wrap(action.run) })
      : snapshotDisplayMetadata<MessageActionContribution>(action, { ...action, run: wrap(action.run) })) }),
  };
}

function parseBrowserPlugin(value: unknown, sourcePluginId: string): LoadedBrowserPlugin {
  if (!isRecord(value)) throw new BrowserPluginIncompatibleError(`Browser plugin ${sourcePluginId} must export an object`);
  const apiVersion = value["apiVersion"];
  if (apiVersion !== 4 && apiVersion !== 5) {
    throw new BrowserPluginIncompatibleError(`Unsupported browser plugin API version for ${sourcePluginId}: ${String(apiVersion)} (expected 4 or 5)`);
  }
  const name = value["name"];
  const activate = value["activate"];
  if (typeof name !== "string" || name === "") throw new BrowserPluginIncompatibleError(`Browser plugin ${sourcePluginId} name must be a non-empty string`);
  if (typeof activate !== "function") throw new BrowserPluginIncompatibleError(`Browser plugin ${sourcePluginId} activate must be a function`);
  const requires = snapshotCapabilityRequirements(value["requires"], `Browser plugin ${sourcePluginId} requirements`);
  return Object.freeze({
    apiVersion,
    name,
    requires,
    activate(context: PluginActivationContext): unknown {
      return Reflect.apply(activate, value, [context]);
    },
  });
}

function parseBrowserActivation(value: unknown, runtimePluginId: string, sourcePluginId: string): PluginActivationResult {
  if (!isRecord(value)) throw new BrowserPluginIncompatibleError(`Browser plugin ${runtimePluginId} activation must be an object`);
  if (value["requiredTerminalFacade"] !== undefined) {
    throw new BrowserPluginIncompatibleError("requiredTerminalFacade was removed in browser plugin API v4; use a typed capability provision");
  }
  const contributions = value["contributions"];
  if (!isPluginContributions(contributions)) throw new BrowserPluginIncompatibleError(`Browser plugin ${runtimePluginId} contributions must contain contribution arrays`);
  for (const key of Object.keys(contributions)) {
    if (!contributionNames.includes(key)) console.warn(`PI WEB plugin ${runtimePluginId} has unknown contribution: ${key}`);
  }
  const provides = snapshotCapabilityProvisions(value["provides"], sourcePluginId, `Browser plugin ${runtimePluginId} provisions`);
  const startValue = value["start"];
  const disposeValue = value["dispose"];
  if (startValue !== undefined && typeof startValue !== "function") throw new BrowserPluginIncompatibleError(`Browser plugin ${runtimePluginId} start must be a function`);
  if (disposeValue !== undefined && typeof disposeValue !== "function") throw new BrowserPluginIncompatibleError(`Browser plugin ${runtimePluginId} dispose must be a function`);
  return Object.freeze({
    contributions,
    ...(provides.length === 0 ? {} : { provides }),
    ...(startValue === undefined ? {} : { start: async (context: PluginStartContext) => {
      const result: unknown = Reflect.apply(startValue, value, [context]);
      await result;
    } }),
    ...(disposeValue === undefined ? {} : { dispose: async (signal: AbortSignal) => {
      const result: unknown = Reflect.apply(disposeValue, value, [signal]);
      await result;
    } }),
  });
}

function activationDisposeForRollback(value: unknown): ((signal: AbortSignal) => Promise<void>) | undefined {
  if (!isRecord(value) || typeof value["dispose"] !== "function") return undefined;
  const dispose = value["dispose"];
  return async (signal: AbortSignal): Promise<void> => {
    await Reflect.apply(dispose, value, [signal]);
  };
}

function snapshotCapabilityRequirements(value: unknown, label: string): readonly PluginCapability[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) throw new BrowserPluginIncompatibleError(`${label} must be an array`);
  const seen = new Set<string>();
  const requirements: PluginCapability[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) throw new BrowserPluginIncompatibleError(`${label} must not be sparse`);
    const capability = snapshotUnknownCapability(value[index], `${label}[${String(index)}]`);
    const key = capabilityKey(capability);
    if (seen.has(key)) throw new BrowserPluginIncompatibleError(`${label} declares ${formatCapability(capability)} more than once`);
    seen.add(key);
    requirements.push(capability);
  }
  return Object.freeze(requirements);
}

function snapshotCapabilityProvisions(
  value: unknown,
  ownerPluginId: string | undefined,
  label: string,
): readonly PluginCapabilityProvision[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) throw new BrowserPluginIncompatibleError(`${label} must be an array`);
  const seen = new Set<string>();
  const provisions: PluginCapabilityProvision[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) throw new BrowserPluginIncompatibleError(`${label} must not be sparse`);
    const candidate: unknown = value[index];
    if (!isRecord(candidate)) throw new BrowserPluginIncompatibleError(`${label}[${String(index)}] must be an object`);
    const capability = snapshotUnknownCapability(candidate["capability"], `${label}[${String(index)}].capability`);
    if (ownerPluginId !== undefined && capability.pluginId !== ownerPluginId) {
      throw new BrowserPluginIncompatibleError(`Browser plugin ${ownerPluginId} cannot provide capability owned by ${capability.pluginId}`);
    }
    const key = capabilityKey(capability);
    if (seen.has(key)) throw new BrowserPluginIncompatibleError(`${label} publishes ${formatCapability(capability)} more than once`);
    seen.add(key);
    const parsedValue = parseCapabilityValue(capability, candidate["value"], `Provided capability ${formatCapability(capability)}`);
    provisions.push(Object.freeze({ capability, value: parsedValue }));
  }
  return Object.freeze(provisions);
}

function snapshotUnknownCapability(value: unknown, label: string): PluginCapability {
  if (!isRecord(value)) throw new BrowserPluginIncompatibleError(`${label} must be an object`);
  const validated = validateCapabilityFields(value["pluginId"], value["id"], value["version"], value["parse"], label);
  return Object.freeze({
    pluginId: validated.pluginId,
    id: validated.id,
    version: validated.version,
    parse(input: unknown): unknown {
      return Reflect.apply(validated.parse, value, [input]);
    },
  });
}

function snapshotTypedCapability<Value>(value: PluginCapability<Value>, label: string): PluginCapability<Value> {
  validateCapabilityFields(value.pluginId, value.id, value.version, value.parse, label);
  return Object.freeze({
    pluginId: value.pluginId,
    id: value.id,
    version: value.version,
    parse: (input: unknown): Value => value.parse(input),
  });
}

function validateCapabilityFields(
  pluginId: unknown,
  id: unknown,
  version: unknown,
  parse: unknown,
  label: string,
): { pluginId: string; id: string; version: number; parse: (value: unknown) => unknown } {
  if (typeof pluginId !== "string" || !idPattern.test(pluginId)) throw new BrowserPluginIncompatibleError(`${label} pluginId must be a valid plugin id`);
  if (typeof id !== "string" || !localIdPattern.test(id)) throw new BrowserPluginIncompatibleError(`${label} id must be a valid local id`);
  if (typeof version !== "number" || !Number.isInteger(version) || version <= 0) throw new BrowserPluginIncompatibleError(`${label} version must be a positive integer`);
  if (!isCapabilityParser(parse)) throw new BrowserPluginIncompatibleError(`${label} parse must be a function`);
  return { pluginId, id, version, parse };
}

function isCapabilityParser(value: unknown): value is (input: unknown) => unknown {
  return typeof value === "function";
}

function internalCapabilityProvision(provision: PluginCapabilityProvision): InternalCapabilityProvision {
  return Object.freeze({ capability: provision.capability, key: capabilityKey(provision.capability), value: provision.value });
}

function matchesHostCapability<Value>(
  snapshot: InternalHostCapabilitySnapshot,
  capability: PluginCapability<Value>,
): snapshot is InternalHostCapabilitySnapshot<Value> {
  return snapshot.token === capability;
}

function parseCapabilityValue<Value>(capability: PluginCapability<Value>, value: unknown, label: string): Value {
  try {
    return capability.parse(value);
  } catch (error) {
    throw new BrowserPluginIncompatibleError(`${label} is invalid: ${errorMessage(error)}`, { cause: error });
  }
}

function capabilityKey(capability: Pick<PluginCapability, "pluginId" | "id" | "version">): string {
  return JSON.stringify([capability.pluginId, capability.id, capability.version]);
}

function formatCapability(capability: Pick<PluginCapability, "pluginId" | "id" | "version">): string {
  return `${capability.pluginId}/${capability.id} v${String(capability.version)}`;
}

function createCapabilityResolver(pluginId: string, resolved: ReadonlyMap<string, unknown>): PluginStartContext["capabilities"] {
  return Object.freeze({
    resolve<Value>(value: PluginCapability<Value>): Value {
      const capability = snapshotTypedCapability(value, `Capability request from browser plugin ${pluginId}`);
      const key = capabilityKey(capability);
      if (!resolved.has(key)) throw new Error(`Browser plugin ${pluginId} did not declare required capability ${formatCapability(capability)}`);
      return parseCapabilityValue(capability, resolved.get(key), `Required capability ${formatCapability(capability)} for browser plugin ${pluginId}`);
    },
  });
}

async function runBounded<T>(
  pluginId: string,
  phase: BrowserPluginLifecyclePhase,
  timeoutMs: number,
  stopSignal: AbortSignal | undefined,
  operation: (signal: AbortSignal) => T | Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timeoutError = new BrowserPluginTimeoutError(`Browser plugin ${pluginId} ${phase} timed out after ${String(timeoutMs)}ms`);
  const deadline = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener("abort", () => { reject(abortError(controller.signal)); }, { once: true });
  });
  const timeout = globalThis.setTimeout(() => { controller.abort(timeoutError); }, timeoutMs);
  const stop = (): void => { controller.abort(abortError(stopSignal)); };
  if (stopSignal?.aborted === true) stop();
  else stopSignal?.addEventListener("abort", stop, { once: true });
  try {
    const result = Promise.resolve().then(() => {
      if (controller.signal.aborted) throw abortError(controller.signal);
      return operation(controller.signal);
    });
    return await Promise.race([result, deadline]);
  } finally {
    globalThis.clearTimeout(timeout);
    stopSignal?.removeEventListener("abort", stop);
    if (!controller.signal.aborted) controller.abort(new DOMException("Browser plugin operation completed", "AbortError"));
  }
}

function abortLifetime(controller: AbortController, reason: unknown): void {
  if (!controller.signal.aborted) controller.abort(reason);
}

function browserPluginShutdownError(): DOMException {
  return new DOMException("Browser plugin host is shutting down", "AbortError");
}

function abortError(signal: AbortSignal | undefined): Error {
  const reason: unknown = signal?.reason;
  return reason instanceof Error ? reason : new Error("Browser plugin operation aborted", { cause: reason });
}

function withRollbackError(error: unknown, rollbackError: unknown): unknown {
  return rollbackError === undefined
    ? error
    : new Error(`${errorMessage(error)}; startup rollback failed: ${errorMessage(rollbackError)}`, { cause: error });
}

function lifecycleError(phase: BrowserPluginLifecyclePhase, error: unknown): BrowserPluginLifecycleError {
  return new BrowserPluginLifecycleError(phase, errorMessage(error), { cause: error });
}

function lifecyclePhase(error: unknown, fallback: BrowserPluginLifecyclePhase): BrowserPluginLifecyclePhase {
  return error instanceof BrowserPluginLifecycleError ? error.phase : fallback;
}

class BrowserPluginLifecycleError extends Error {
  constructor(readonly phase: BrowserPluginLifecyclePhase, message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

class BrowserPluginIncompatibleError extends Error {
  override name = "BrowserPluginIncompatibleError";
}

class BrowserPluginTimeoutError extends Error {
  override name = "TimeoutError";
}

function positiveInteger(value: number | undefined, fallback: number, key: string): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved <= 0) throw new Error(`${key} must be a positive integer`);
  return resolved;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const contributionNames: readonly string[] = ["actions", "applicationPanels", "workspacePanels", "workspaceLabels", "sessionLabels", "stylesheets", "themes", "fileIconThemes", "themePairs", "contentRenderers", "syntaxHighlighters", "filePreviewers", "messageActions"];

function isPluginContributions(value: unknown): value is PluginContributions {
  if (!isRecord(value)) return false;
  return contributionNames
    .every((key) => value[key] === undefined || Array.isArray(value[key]));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
