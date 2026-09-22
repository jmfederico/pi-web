import { html, svg } from "lit";
import type { ContentRenderRequest } from "../../../plugin-api";
import { compareContentRenderers, contentRendererMatches, snapshotContentRenderer, type ContentRendererChoice, type RegisteredContentRenderer } from "./contentRenderers";
import { createContentRenderingService, contentRenderingCapabilityToken } from "../formatting/contentRendering";
import { requirePluginBackendRevision } from "../../../shared/pluginBackendProtocol";
import type { PiWebPluginRegistration, PiWebPluginRegistrationDeclaration, PluginAction, PluginActivationContext, PluginActivationResult, PluginCapability, PluginCapabilityProvision, PluginContributions, PluginRuntimeContext, PluginStartContext, QualifiedContributionId, QualifiedPluginAction, QualifiedThemeContribution, QualifiedThemePairContribution, QualifiedWorkspaceLabelContribution, QualifiedWorkspacePanelContribution, ThemeContribution, ThemePairContribution, WorkspaceInvalidation, WorkspaceLabelContext, WorkspaceLabelContribution, WorkspaceLabelItem, WorkspacePanelContext, WorkspacePanelContribution, WorkspacePluginBinding, WorkspaceResource } from "./types";

const idPattern = /^[a-z][a-z0-9.-]*$/u;
const localIdPattern = /^[a-z][a-z0-9.-]*$/u;
const qualifiedContributionIdPattern = /^[a-z][a-z0-9.-]*:[a-z][a-z0-9.-]*$/u;
const routeAliasPattern = /^[a-z][a-z0-9.-]*(?::[a-z][a-z0-9.-]*)?$/u;
const pluginRuntimeScopes = new WeakMap<PluginRuntimeContext, (pluginId: string) => PluginRuntimeContext>();
type WorkspacePanelScope = (
  binding: WorkspacePluginBinding,
  contributionId: QualifiedContributionId,
  navigationAliases: readonly QualifiedContributionId[],
) => WorkspacePanelContext;
const workspacePanelScopes = new WeakMap<WorkspacePanelContext, WorkspacePanelScope>();
const workspaceLabelScopes = new WeakMap<WorkspaceLabelContext, (binding: WorkspacePluginBinding) => WorkspaceLabelContext>();

export interface PluginRegistryOptions {
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
  readonly contentRenderers: readonly RegisteredContentRenderer[];
  readonly ids: ReadonlySet<QualifiedContributionId>;
  readonly actions: readonly RegisteredPluginAction[];
  readonly workspacePanels: readonly QualifiedWorkspacePanelContribution[];
  readonly workspaceLabels: readonly QualifiedWorkspaceLabelContribution[];
  readonly themes: readonly QualifiedThemeContribution[];
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
  private readonly contentRenderers: RegisteredContentRenderer[] = [];
  readonly chatContentRendering = createContentRenderingService((request) => this.matchContentRenderers(request));
  readonly contentRendering = this.chatContentRendering.capability;

  matchContentRenderers(request: ContentRenderRequest): readonly ContentRendererChoice[] {
    return this.contentRenderers.filter((renderer) => this.isContributionActive(renderer.pluginId, renderer.machineId, request.machineId, renderer.sourcePluginId) && contentRendererMatches(renderer, request))
      .sort(compareContentRenderers)
      .map((renderer) => ({ id: renderer.id, label: renderer.label, renderer }));
  }
  private readonly actions: RegisteredPluginAction[] = [];
  private readonly workspacePanels: QualifiedWorkspacePanelContribution[] = [];
  private readonly workspaceLabels: QualifiedWorkspaceLabelContribution[] = [];
  private readonly themes: QualifiedThemeContribution[] = [];
  private readonly themePairs: QualifiedThemePairContribution[] = [];
  private readonly pluginIds = new Set<string>();
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
  private shuttingDown = false;
  private disposePromise: Promise<void> | undefined;

  constructor(private readonly options: PluginRegistryOptions = {}) {
    this.lifecycleTimeoutMs = positiveInteger(options.lifecycleTimeoutMs, DEFAULT_LIFECYCLE_TIMEOUT_MS, "lifecycleTimeoutMs");
    for (const provision of snapshotCapabilityProvisions([{ capability: contentRenderingCapabilityToken, value: this.contentRendering }, ...(options.hostCapabilities ?? [])], undefined, "Browser host capability provisions")) {
      const internal = internalCapabilityProvision(provision);
      if (this.hostCapabilitiesByKey.has(internal.key)) {
        throw new BrowserPluginIncompatibleError(`Browser capability ${formatCapability(internal.capability)} is provided more than once by the host`);
      }
      this.hostCapabilitiesByKey.set(internal.key, internal);
    }
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
    this.contentRenderers.splice(0);
    this.workspacePanels.splice(0);
    this.workspaceLabels.splice(0);
    this.themes.splice(0);
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
    const plugin = parseBrowserPlugin(registration.plugin, declaration.sourcePluginId);
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
          apiVersion: 4,
          pluginId: declaration.sourcePluginId,
          runtimePluginId: registration.id,
          html,
          svg,
          signal,
          lifetimeSignal: lifetimeController.signal,
        })),
      );
      rollbackDispose = activationDisposeForRollback(activationValue);
      phase = "validate";
      const activation = parseBrowserActivation(activationValue, registration.id, declaration.sourcePluginId);
      const provisions = (activation.provides ?? []).map(internalCapabilityProvision);
      const contributions = this.prepareContributions(
        registration,
        activation.contributions,
        backendRevision,
        pairedRequestVersion,
        pairedChannelVersion,
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
    lifetimeSignal: AbortSignal,
  ): PreparedPluginContributions {
    const runtimePluginId = registration.id;
    const contributionIds = new Set<QualifiedContributionId>();
    const contentRenderers = (contributions.contentRenderers ?? []).map((renderer): RegisteredContentRenderer => {
      const snapshot = snapshotContentRenderer(renderer);
      return {
        ...snapshot,
        id: this.qualify(runtimePluginId, renderer.id, contributionIds),
        pluginId: runtimePluginId,
        localId: renderer.id,
        label: `${registration.sourcePluginId ?? runtimePluginId} / ${renderer.id}`,
        ...(registration.machineId === undefined ? {} : { machineId: registration.machineId }),
        ...(registration.sourcePluginId === undefined ? {} : { sourcePluginId: registration.sourcePluginId }),
        render: (input) => {
          const signal = AbortSignal.any([input.signal, lifetimeSignal]);
          return snapshot.render({ ...input, signal, fail: (error) => { if (!signal.aborted) input.fail(error); } });
        },
      };
    });
    const actions = (contributions.actions ?? []).map((action) => this.qualifyAction(runtimePluginId, action, registration.machineId, registration.sourcePluginId, contributionIds));
    const workspacePanels = (contributions.workspacePanels ?? []).map((panel) => this.qualifyWorkspacePanel(runtimePluginId, panel, registration.machineId, registration.sourcePluginId, backendRevision, pairedRequestVersion, pairedChannelVersion, contributionIds));
    const workspaceLabels = (contributions.workspaceLabels ?? []).map((contribution) => this.qualifyWorkspaceLabelContribution(runtimePluginId, contribution, registration.machineId, registration.sourcePluginId, backendRevision, pairedRequestVersion, pairedChannelVersion, contributionIds));
    const themes = registration.machineId === undefined
      ? (contributions.themes ?? []).map((theme) => this.qualifyTheme(runtimePluginId, theme, contributionIds))
      : [];
    const themePairs = registration.machineId === undefined
      ? (contributions.themePairs ?? []).map((pair) => this.qualifyThemePair(runtimePluginId, pair, contributionIds))
      : [];
    return Object.freeze({ ids: contributionIds, contentRenderers, actions, workspacePanels, workspaceLabels, themes, themePairs });
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
    this.contentRenderers.push(...staged.contributions.contentRenderers);
    this.actions.push(...staged.contributions.actions);
    this.workspacePanels.push(...staged.contributions.workspacePanels);
    this.workspaceLabels.push(...staged.contributions.workspaceLabels);
    this.themes.push(...staged.contributions.themes);
    this.themePairs.push(...staged.contributions.themePairs);
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
      const qualified: QualifiedPluginAction = {
        id: action.id,
        pluginId: action.pluginId,
        localId: action.localId,
        ...(action.machineId === undefined ? {} : { machineId: action.machineId }),
        title: action.title,
        run: () => this.isContributionActive(action.pluginId, action.machineId, runtimeContextMachineId(context), action.sourcePluginId)
          ? action.run(pluginRuntimeContextFor(context, action.pluginId))
          : undefined,
      };
      if (action.description !== undefined) qualified.description = action.description;
      if (action.shortcut !== undefined) qualified.shortcut = action.shortcut;
      if (action.shortcutAliases !== undefined) qualified.shortcutAliases = [...action.shortcutAliases];
      if (action.group !== undefined) qualified.group = action.group;
      if (enabled !== undefined) qualified.enabled = enabled;
      if (disabledReason !== undefined && disabledReason !== "") qualified.disabledReason = disabledReason;
      return qualified;
    });
  }

  getWorkspacePanels(): QualifiedWorkspacePanelContribution[] {
    return [...this.workspacePanels].sort((left, right) => (left.order ?? 1000) - (right.order ?? 1000) || left.title.localeCompare(right.title));
  }

  resolveWorkspaceFileOpen(context: WorkspacePanelContext, path: string) {
    for (const panel of this.getWorkspacePanels()) {
      if (panel.visible?.(context) === false) continue;
      const query = panel.fileOpenQuery?.(context, path);
      if (query !== undefined) return { contributionId: panel.id, navigationAliases: panel.navigationAliases, query };
    }
    return undefined;
  }

  resolveWorkspacePanelRouteId(value: string, selectedMachineId: string): QualifiedContributionId | undefined {
    const activePanels = this.workspacePanels.filter((panel) => this.isContributionActive(panel.pluginId, panel.machineId, selectedMachineId, panel.sourcePluginId));
    const exact = activePanels.find((panel) => panel.id === value);
    if (exact !== undefined) return exact.id;
    const aliases = activePanels.filter((panel) => panel.routeAliases?.includes(value) === true);
    if (aliases.length === 1) return aliases[0]?.id;
    if (aliases.length > 1) console.warn(`Ambiguous PI WEB workspace panel route: ${value}`);
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

  getThemes(): QualifiedThemeContribution[] {
    return this.themes
      .filter((theme) => this.isContributionEnabled(theme.pluginId, undefined))
      .sort((left, right) => (left.order ?? 1000) - (right.order ?? 1000) || left.name.localeCompare(right.name));
  }

  getThemePairs(): QualifiedThemePairContribution[] {
    return this.themePairs
      .filter((pair) => this.isContributionEnabled(pair.pluginId, undefined))
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
    return {
      ...action,
      id,
      pluginId,
      localId: action.id,
      ...(shortcutAliases.length === 0 ? {} : { shortcutAliases }),
      ...(machineId === undefined ? {} : { machineId }),
      ...(sourcePluginId === undefined ? {} : { sourcePluginId }),
    };
  }

  private qualifyWorkspacePanel(
    pluginId: string,
    panel: WorkspacePanelContribution,
    machineId: string | undefined,
    sourcePluginId: string | undefined,
    backendRevision: string | undefined,
    pairedRequestVersion: 1 | undefined,
    pairedChannelVersion: 1 | undefined,
    contributionIds: Set<QualifiedContributionId>,
  ): QualifiedWorkspacePanelContribution {
    const id = this.qualify(pluginId, panel.id, contributionIds);
    const fileOpenQuery = panel.fileOpenQuery;
    const badge = panel.badge;
    const visible = panel.visible;
    const onInvalidate = panel.onInvalidate;
    const binding = workspacePluginBinding(pluginId, sourcePluginId, backendRevision, pairedRequestVersion, pairedChannelVersion);
    const sourceId = `${sourcePluginId ?? pluginId}:${panel.id}`;
    const routeAliases = this.parseRouteAliases(id, panel.routeAliases, sourceId);
    const navigationAliases = this.parseNavigationAliases(id, panel.navigationAliases, sourceId);
    const invalidationResources = this.parseInvalidationResources(id, panel.invalidationResources);
    const scopedContext = (context: WorkspacePanelContext) => workspacePanelContextFor(context, binding, id, navigationAliases);
    return {
      ...panel,
      id,
      pluginId,
      localId: panel.id,
      ...(routeAliases.length === 0 ? {} : { routeAliases }),
      navigationAliases,
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
    };
  }

  private qualifyWorkspaceLabelContribution(
    pluginId: string,
    contribution: WorkspaceLabelContribution,
    machineId: string | undefined,
    sourcePluginId: string | undefined,
    backendRevision: string | undefined,
    pairedRequestVersion: 1 | undefined,
    pairedChannelVersion: 1 | undefined,
    contributionIds: Set<QualifiedContributionId>,
  ): QualifiedWorkspaceLabelContribution {
    const id = this.qualify(pluginId, contribution.id, contributionIds);
    const visible = contribution.visible;
    const items = contribution.items;
    const binding = workspacePluginBinding(pluginId, sourcePluginId, backendRevision, pairedRequestVersion, pairedChannelVersion);
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

  private qualifyTheme(pluginId: string, theme: ThemeContribution, contributionIds: Set<QualifiedContributionId>): QualifiedThemeContribution {
    const id = this.qualify(pluginId, theme.id, contributionIds);
    return { ...theme, id, pluginId, localId: theme.id };
  }

  private qualifyThemePair(pluginId: string, pair: ThemePairContribution, contributionIds: Set<QualifiedContributionId>): QualifiedThemePairContribution {
    const id = this.qualify(pluginId, pair.id, contributionIds);
    return {
      ...pair,
      id,
      pluginId,
      localId: pair.id,
      light: this.qualifyReference(pluginId, pair.light),
      dark: this.qualifyReference(pluginId, pair.dark),
    };
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

  private parseRouteAliases(id: QualifiedContributionId, aliases: readonly string[] | undefined, sourceId: string): string[] {
    const parsed = [...new Set([...(aliases ?? []), sourceId])].filter((alias) => alias !== id);
    for (const alias of parsed) {
      if (!routeAliasPattern.test(alias)) throw new Error(`Invalid workspace panel route alias for ${id}: ${alias}`);
    }
    return parsed;
  }

  private parseNavigationAliases(id: QualifiedContributionId, aliases: readonly string[] | undefined, sourceId: string): QualifiedContributionId[] {
    const parsed = [...new Set([...(aliases ?? []), sourceId])].filter((alias) => alias !== id);
    const invalid = parsed.find((alias) => !isQualifiedContributionId(alias));
    if (invalid !== undefined) throw new Error(`Invalid workspace panel navigation alias for ${id}: ${invalid}`);
    return parsed.filter(isQualifiedContributionId);
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
    capability: "request" | "channel",
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
  navigationAliases: readonly QualifiedContributionId[],
): WorkspacePanelContext {
  return workspacePanelScopes.get(context)?.(binding, contributionId, navigationAliases) ?? context;
}

function workspaceLabelContextFor(context: WorkspaceLabelContext, binding: WorkspacePluginBinding): WorkspaceLabelContext {
  return workspaceLabelScopes.get(context)?.(binding) ?? context;
}

export function installPluginRuntimeScope(context: PluginRuntimeContext, scope: (pluginId: string) => PluginRuntimeContext): PluginRuntimeContext {
  pluginRuntimeScopes.set(context, scope);
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

function workspacePluginBinding(
  registrationPluginId: string,
  sourcePluginId: string | undefined,
  backendRevision: string | undefined,
  pairedRequestVersion: 1 | undefined,
  pairedChannelVersion: 1 | undefined,
): WorkspacePluginBinding {
  return Object.freeze({
    registrationPluginId,
    sourcePluginId: sourcePluginId ?? registrationPluginId,
    ...(backendRevision === undefined ? {} : { backendRevision }),
    ...(pairedRequestVersion === undefined ? {} : { pairedRequestVersion }),
    ...(pairedChannelVersion === undefined ? {} : { pairedChannelVersion }),
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

function parseBrowserPlugin(value: unknown, sourcePluginId: string): LoadedBrowserPlugin {
  if (!isRecord(value)) throw new BrowserPluginIncompatibleError(`Browser plugin ${sourcePluginId} must export an object`);
  const apiVersion = value["apiVersion"];
  if (apiVersion !== 4) {
    throw new BrowserPluginIncompatibleError(`Unsupported browser plugin API version for ${sourcePluginId}: ${String(apiVersion)} (expected 4)`);
  }
  const name = value["name"];
  const activate = value["activate"];
  if (typeof name !== "string" || name === "") throw new BrowserPluginIncompatibleError(`Browser plugin ${sourcePluginId} name must be a non-empty string`);
  if (typeof activate !== "function") throw new BrowserPluginIncompatibleError(`Browser plugin ${sourcePluginId} activate must be a function`);
  const requires = snapshotCapabilityRequirements(value["requires"], `Browser plugin ${sourcePluginId} requirements`);
  return Object.freeze({
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

function isPluginContributions(value: unknown): value is PluginContributions {
  if (!isRecord(value)) return false;
  return ["actions", "workspacePanels", "workspaceLabels", "themes", "themePairs", "contentRenderers"]
    .every((key) => value[key] === undefined || Array.isArray(value[key]));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
