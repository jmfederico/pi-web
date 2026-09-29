import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { isPiWebPluginId } from "../../shared/pluginIds.js";
import { pathToFileURL } from "node:url";
import type {
  JsonObject,
  JsonValue,
  PluginCapability,
  PluginCapabilityProvision,
  ServerPluginPeer,
  ServerPluginPeerChannel,
  ServerPluginPeerChannelCloseContext,
  ServerPluginPeerChannelOpenContext,
  ServerPluginPeerRequestContext,
  ProjectInput,
  ProviderRemoveContext,
  ServerPluginActivation,
  ServerPluginActivationContext,
  ServerPluginExecFileRequest,
  ServerPluginExecFileResult,
  ServerPluginHealth,
  ServerPluginLogger,
  ServerPluginNoticeInput,
  ServerPluginNoticeReporterV1,
  ServerPluginStartContext,
  WorkspaceProvider,
} from "../../server-plugin-api.js";
import type { PiWebPluginScope } from "../../shared/apiTypes.js";
import {
  parseServerNoticeScope,
  SERVER_PLUGIN_NOTICE_CONTEXT_MAX_BYTES,
  SERVER_PLUGIN_NOTICE_CONTEXT_MAX_DEPTH,
  SERVER_PLUGIN_NOTICE_MESSAGE_MAX_BYTES,
  SERVER_PLUGIN_NOTICE_SOURCE_PREFIX,
  serverNoticeStringExceedsUtf8ByteLimit,
} from "../../shared/serverNoticeContract.js";
import {
  REQUIRED_TERMINAL_PLUGIN_ID,
  REQUIRED_TERMINAL_RECOVERY_GUIDANCE,
} from "../../shared/requiredTerminalPlugin.js";
import type { ServerPluginSafeStart } from "../../serverPluginRecovery.js";
import { REQUIRED_TERMINAL_SERVICE_CAPABILITY } from "../terminals/requiredTerminalService.js";
import type {
  PiWebPluginCatalog,
  PiWebPluginCatalogDiagnostic,
  PiWebPluginCatalogEntry,
  PiWebPluginCatalogSnapshot,
} from "../piWebPluginCatalog.js";
import { createServerPluginExecFile } from "./serverPluginExec.js";

export type ServerPluginRuntimeState = "active" | "failed" | "incompatible" | "disabled";
export type ServerPluginLifecyclePhase = "import" | "activate" | "validate" | "start" | "health" | "dispose";

export interface ServerPluginRuntimeRecord {
  pluginId: string;
  source: string;
  scope: PiWebPluginScope;
  moduleRevision: string;
  browserRevision?: string;
  settingsRevision: string;
  machineSpecific: boolean;
  /** Additive browser feature detection for package-paired requests. */
  pairedRequestVersion?: 1;
  /** Additive browser feature detection for package-paired channels. */
  pairedChannelVersion?: 1;
  state: ServerPluginRuntimeState;
  name?: string;
  phase?: ServerPluginLifecyclePhase;
  message?: string;
}

export interface ServerPluginProviderContribution {
  pluginId: string;
  pluginName: string;
  packageRoot: string;
  source: string;
  scope: PiWebPluginScope;
  moduleRevision: string;
  provider: WorkspaceProvider;
}

export interface ServerPluginPairedBackendContribution {
  pluginId: string;
  pluginName: string;
  packageRoot: string;
  source: string;
  scope: PiWebPluginScope;
  moduleRevision: string;
  backend: ServerPluginPeer;
}

export interface ServerPluginHealthInspection {
  pluginId: string;
  health: ServerPluginHealth;
  phase?: "health";
  error?: string;
}

export interface ServerPluginRuntimeLogger {
  debug(details: Record<string, unknown>, message: string): void;
  info(details: Record<string, unknown>, message: string): void;
  warn(details: Record<string, unknown>, message: string): void;
  error(details: Record<string, unknown>, message: string): void;
}

export type ServerPluginModuleImporter = (moduleUrl: string, signal: AbortSignal) => Promise<unknown>;
export type ServerPluginExecFile = (request: ServerPluginExecFileRequest) => Promise<ServerPluginExecFileResult>;

export interface ServerPluginHostCapabilityContext {
  readonly pluginId: string;
  readonly packageRoot: string;
  readonly lifetimeSignal: AbortSignal;
}

export interface ServerPluginHostCapabilityInstance<Value = unknown> {
  readonly value: Value;
  readonly dispose?: (signal: AbortSignal) => void | Promise<void>;
}

/** Host-owned factory materialized once for each plugin declaring the exact capability. */
export interface ServerPluginHostCapabilityFactory<Value = unknown> {
  readonly capability: PluginCapability<Value>;
  readonly create: (context: ServerPluginHostCapabilityContext) => ServerPluginHostCapabilityInstance<Value>;
}

export interface CreateServerPluginRuntimeOptions {
  catalog: Pick<PiWebPluginCatalog, "snapshot">;
  dataDir: string;
  safeStart?: ServerPluginSafeStart;
  logger: ServerPluginRuntimeLogger;
  importer?: ServerPluginModuleImporter;
  execFile?: ServerPluginExecFile;
  lifecycleTimeoutMs?: number;
  /** Core-owned sink; source is host-derived as `plugin:<catalog id>`. */
  noticeSink?: (source: string, input: ServerPluginNoticeInput) => void;
  /** Core-owned global capabilities available before plugin dependency resolution. */
  hostCapabilities?: readonly PluginCapabilityProvision[];
  /** Core-owned capabilities materialized separately for each exact declaring plugin. */
  hostCapabilityFactories?: readonly ServerPluginHostCapabilityFactory[];
  /**
   * Exact host capabilities activated together after early workspace-provider
   * topology is complete. Plugins requiring one remain staged until resume.
   */
  lateHostCapabilities?: readonly PluginCapability[];
  /** Isolated unit/package tests may opt out; production always enforces Terminal. */
  enforceRequiredTerminal?: boolean;
}

interface LoadedServerPlugin {
  readonly name: string;
  readonly requires?: readonly PluginCapability[];
  readonly activate: (context: ServerPluginActivationContext) => unknown;
}

interface StagedServerPlugin {
  entry: PiWebPluginCatalogEntry;
  plugin: LoadedServerPlugin;
  activation: ServerPluginActivation;
  lifetimeController: AbortController;
  noticeReporter?: ScopedNoticeReporter;
  provisions: readonly InternalCapabilityProvision[];
  hostCapabilityInstances: InternalHostCapabilityInstance[];
}

interface ActiveServerPlugin extends StagedServerPlugin {
  providerContribution?: ServerPluginProviderContribution;
  pairedBackendContribution?: ServerPluginPairedBackendContribution;
}

interface InternalCapabilityProvision {
  capability: PluginCapability;
  key: string;
  value: unknown;
  source: "host" | "plugin";
}

interface InternalHostCapabilityFactory {
  capability: PluginCapability;
  key: string;
  source: "host-factory";
  create: (context: ServerPluginHostCapabilityContext) => ServerPluginHostCapabilityInstance;
}

interface InternalLateHostCapability {
  capability: PluginCapability;
  key: string;
  source: "late-host";
}

type InternalCapabilityDeclaration = InternalCapabilityProvision | InternalHostCapabilityFactory | InternalLateHostCapability;

type InternalHostCapabilityInstance = ServerPluginHostCapabilityInstance;

interface ResolvedCapabilityRequirement {
  provisionValue: unknown;
}

interface ScopedNoticeReporter {
  readonly reporter: ServerPluginNoticeReporterV1;
  revoke(): void;
}

const DEFAULT_LIFECYCLE_TIMEOUT_MS = 10_000;

/**
 * Resolves exactly one desired catalog snapshot and activates its server
 * entries. The resulting runtime is immutable except for explicit shutdown;
 * this lifecycle intentionally has no hot reload or unload path.
 */
export async function createServerPluginRuntime(
  options: CreateServerPluginRuntimeOptions,
): Promise<ServerPluginRuntime> {
  if (options.safeStart === "none") {
    return await ServerPluginRuntime.activate({ plugins: [], diagnostics: [] }, options);
  }
  const snapshot = await options.catalog.snapshot(options.safeStart === "bundled-only" ? { scope: "bundled" } : undefined);
  if (options.enforceRequiredTerminal !== false) requireTerminalCatalogEntry(snapshot);
  return await ServerPluginRuntime.activate(snapshot, options);
}

export class ServerPluginRuntime {
  private readonly recordsById = new Map<string, ServerPluginRuntimeRecord>();
  private readonly declaredCapabilitiesByKey = new Map<string, InternalCapabilityDeclaration>();
  private readonly activeCapabilitiesByKey = new Map<string, InternalCapabilityProvision>();
  private activePlugins: ActiveServerPlugin[] = [];
  private stagedPlugins: StagedServerPlugin[] = [];
  private lifetimesAborted = false;
  private lateHostCapabilitiesResumed = false;
  private stopped = false;

  private constructor(
    private readonly dataDir: string,
    private readonly safeStart: ServerPluginSafeStart | undefined,
    private readonly diagnostics: readonly PiWebPluginCatalogDiagnostic[],
    private readonly logger: ServerPluginRuntimeLogger,
    private readonly importer: ServerPluginModuleImporter,
    private readonly execFile: ServerPluginExecFile,
    private readonly lifecycleTimeoutMs: number,
    private readonly noticeSink: ((source: string, input: ServerPluginNoticeInput) => void) | undefined,
    hostCapabilities: readonly InternalCapabilityProvision[],
    hostCapabilityFactories: readonly InternalHostCapabilityFactory[],
    lateHostCapabilities: readonly InternalLateHostCapability[],
    private readonly enforceRequiredTerminal: boolean,
  ) {
    for (const provision of hostCapabilities) {
      this.registerHostCapability(provision);
      this.activeCapabilitiesByKey.set(provision.key, provision);
    }
    for (const factory of hostCapabilityFactories) this.registerHostCapability(factory);
    for (const capability of lateHostCapabilities) this.registerHostCapability(capability);
  }

  static async activate(
    snapshot: PiWebPluginCatalogSnapshot,
    options: Omit<CreateServerPluginRuntimeOptions, "catalog">,
  ): Promise<ServerPluginRuntime> {
    const runtime = new ServerPluginRuntime(
      resolve(options.dataDir),
      options.safeStart,
      Object.freeze(snapshot.diagnostics.map((diagnostic) => Object.freeze({ ...diagnostic }))),
      options.logger,
      options.importer ?? importServerPluginModule,
      options.execFile ?? createServerPluginExecFile(),
      positiveInteger(options.lifecycleTimeoutMs, DEFAULT_LIFECYCLE_TIMEOUT_MS, "lifecycleTimeoutMs"),
      options.noticeSink,
      snapshotHostCapabilities(options.hostCapabilities),
      snapshotHostCapabilityFactories(options.hostCapabilityFactories),
      snapshotLateHostCapabilities(options.lateHostCapabilities),
      options.enforceRequiredTerminal !== false && options.safeStart !== "none",
    );
    try {
      await runtime.start(snapshot.plugins);
      return runtime;
    } catch (error) {
      await runtime.stop();
      throw error;
    }
  }

  private registerHostCapability(declaration: InternalCapabilityDeclaration): void {
    if (this.declaredCapabilitiesByKey.has(declaration.key)) {
      throw new Error(`Host capability ${formatCapability(declaration.capability)} is configured more than once`);
    }
    this.declaredCapabilitiesByKey.set(declaration.key, declaration);
  }

  safeStartLevel(): ServerPluginSafeStart | undefined {
    return this.safeStart;
  }

  catalogDiagnostics(): readonly PiWebPluginCatalogDiagnostic[] {
    return this.diagnostics;
  }

  healthRecords(): readonly ServerPluginRuntimeRecord[] {
    return Object.freeze([...this.recordsById.values()]
      .sort((left, right) => left.pluginId.localeCompare(right.pluginId))
      .map((record) => Object.freeze({ ...record })));
  }

  providerContributions(): readonly ServerPluginProviderContribution[] {
    return Object.freeze(this.activePlugins.flatMap((active) => active.providerContribution === undefined ? [] : [active.providerContribution]));
  }

  pairedBackendContributions(): readonly ServerPluginPairedBackendContribution[] {
    return Object.freeze(this.activePlugins.flatMap((active) => active.pairedBackendContribution === undefined ? [] : [active.pairedBackendContribution]));
  }

  /** Resolves one exact active capability for a core host consumer. */
  resolve<Value>(capability: PluginCapability<Value>): Value {
    const parsed = snapshotTypedCapability(capability, "Host capability request");
    const provision = this.activeCapabilitiesByKey.get(capabilityKey(parsed));
    if (provision === undefined) {
      throw new Error(`Server capability ${formatCapability(parsed)} is not active`);
    }
    return parseCapabilityValue(parsed, provision.value, `Server capability ${formatCapability(parsed)}`);
  }

  /**
   * Registers every declared late host factory atomically, then resumes the
   * plugins staged on those capabilities. This boundary is intentionally one-shot.
   */
  async resumeWithHostCapabilityFactories(
    factories: readonly ServerPluginHostCapabilityFactory[],
  ): Promise<void> {
    if (this.stopped || this.lifetimesAborted) {
      throw new Error("Server plugin runtime cannot resume after shutdown begins");
    }
    if (this.lateHostCapabilitiesResumed) {
      throw new Error("Server plugin late host capabilities have already resumed");
    }

    const snapshottedFactories = snapshotHostCapabilityFactories(factories);
    const lateDeclarations = [...this.declaredCapabilitiesByKey.values()]
      .filter((declaration): declaration is InternalLateHostCapability => declaration.source === "late-host");
    const factoriesByKey = new Map(snapshottedFactories.map((factory) => [factory.key, factory]));
    for (const factory of snapshottedFactories) {
      if (!lateDeclarations.some(({ key }) => key === factory.key)) {
        throw new Error(`Host capability ${formatCapability(factory.capability)} was not declared for late registration`);
      }
    }
    for (const declaration of lateDeclarations) {
      if (!factoriesByKey.has(declaration.key)) {
        throw new Error(`Late host capability ${formatCapability(declaration.capability)} was not registered`);
      }
    }

    this.lateHostCapabilitiesResumed = true;
    for (const factory of snapshottedFactories) this.declaredCapabilitiesByKey.set(factory.key, factory);
    await this.startStagedPlugins(false);
  }

  /** Cancels plugin lifetimes while retaining publications for consumer cleanup. */
  beginShutdown(): void {
    if (this.lifetimesAborted) return;
    this.lifetimesAborted = true;
    const reason = new DOMException("Server plugin host is shutting down", "AbortError");
    for (const plugin of [...this.activePlugins, ...this.stagedPlugins]) {
      if (!plugin.lifetimeController.signal.aborted) plugin.lifetimeController.abort(reason);
    }
  }

  async inspectHealth(pluginIds?: readonly string[]): Promise<readonly ServerPluginHealthInspection[]> {
    const selectedPluginIds = pluginIds === undefined ? undefined : new Set(pluginIds);
    const inspections: ServerPluginHealthInspection[] = [];
    for (const active of this.activePlugins) {
      if (selectedPluginIds !== undefined && !selectedPluginIds.has(active.entry.id)) continue;
      const callback = active.activation.health?.bind(active.activation);
      if (callback === undefined) {
        inspections.push(Object.freeze({ pluginId: active.entry.id, health: Object.freeze({ status: "healthy" }) }));
        continue;
      }
      try {
        const result = await runBounded(
          active.entry.id,
          "health",
          this.lifecycleTimeoutMs,
          (signal) => callback(signal),
        );
        inspections.push(Object.freeze({ pluginId: active.entry.id, health: parseHealth(result) }));
      } catch (error) {
        const message = errorMessage(error);
        inspections.push(Object.freeze({
          pluginId: active.entry.id,
          health: Object.freeze({ status: "unhealthy", message }),
          phase: "health",
          error: message,
        }));
        this.logger.warn({ err: error, pluginId: active.entry.id, phase: "health" }, "server plugin health check failed");
      }
    }
    return Object.freeze(inspections);
  }

  /** Disposes published plugins in reverse dependency/start order. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.beginShutdown();
    this.stopped = true;

    // During failed construction, activated entries may not have reached start.
    // Dispose those first while any started providers remain published.
    const stagedPlugins = [...this.stagedPlugins].reverse();
    this.stagedPlugins = [];
    for (const staged of stagedPlugins) {
      await this.disposeForShutdown(staged);
    }

    const activePlugins = [...this.activePlugins].reverse();
    this.activePlugins = [];
    this.activeCapabilitiesByKey.clear();
    for (const active of activePlugins) {
      await this.disposeForShutdown(active);
    }
  }

  private async start(entries: readonly PiWebPluginCatalogEntry[]): Promise<void> {
    const serverEntries = entries
      .filter((entry) => entry.serverModule !== undefined)
      .sort(requiredTerminalFirst);
    for (const entry of serverEntries) await this.stageEntry(entry);
    await this.startStagedPlugins(true);

    if (this.enforceRequiredTerminal) {
      try {
        this.resolve(REQUIRED_TERMINAL_SERVICE_CAPABILITY);
      } catch (error) {
        throw requiredTerminalError("Required Terminal service capability is not active", error);
      }
    }
  }

  private async stageEntry(entry: PiWebPluginCatalogEntry): Promise<void> {
    const disabledMessage = disabledReason(entry, this.safeStart);
    if (disabledMessage !== undefined) {
      this.recordsById.set(entry.id, recordFor(entry, { state: "disabled", message: disabledMessage }));
      this.logger.info({ pluginId: entry.id, reason: disabledMessage }, "server plugin skipped");
      return;
    }

    let phase: ServerPluginLifecyclePhase = "validate";
    let plugin: LoadedServerPlugin | undefined;
    let rollbackDispose: ((signal: AbortSignal) => Promise<void>) | undefined;
    let noticeReporter: ScopedNoticeReporter | undefined;
    const lifetimeController = new AbortController();
    try {
      const settings = cloneJsonObject(entry.settings, `settings for server plugin ${entry.id}`);
      phase = "import";
      const moduleUrl = serverModuleUrl(entry);
      const imported = await runBounded(entry.id, phase, this.lifecycleTimeoutMs, (signal) => this.importer(moduleUrl, signal));
      phase = "validate";
      const loadedPlugin = parsePluginExport(imported);
      plugin = loadedPlugin;
      phase = "activate";
      if (!isPiWebPluginId(entry.id)) throw new Error(`Invalid PI WEB plugin id: ${entry.id}`);
      const dataDirectory = resolve(this.dataDir, "plugin-data", entry.id);
      await mkdir(dataDirectory, { recursive: true });
      const scopedLogger = createScopedLogger(entry.id, this.logger);
      noticeReporter = createScopedNoticeReporter(entry.id, this.noticeSink);
      const activationValue = await runBounded(entry.id, phase, this.lifecycleTimeoutMs, (signal) => loadedPlugin.activate(Object.freeze({
        apiVersion: 3,
        pluginId: entry.id,
        packageRoot: entry.packageRoot,
        dataDirectory,
        logger: scopedLogger,
        settings,
        ...(noticeReporter === undefined ? {} : { notices: noticeReporter.reporter }),
        execFile: this.execFile,
        signal,
        lifetimeSignal: lifetimeController.signal,
      })));
      rollbackDispose = activationDisposeForRollback(activationValue);
      phase = "validate";
      const loadedActivation = parseActivation(activationValue, entry.id);
      if (this.enforceRequiredTerminal && entry.id === REQUIRED_TERMINAL_PLUGIN_ID) {
        requireTerminalActivation(loadedActivation);
      }
      const provisions = internalProvisions(loadedActivation, "plugin");
      for (const provision of provisions) {
        if (this.declaredCapabilitiesByKey.has(provision.key)) {
          throw new IncompatibleServerPluginError(`Server capability ${formatCapability(provision.capability)} is provided more than once`);
        }
      }
      const staged = Object.freeze({
        entry,
        plugin: loadedPlugin,
        activation: loadedActivation,
        lifetimeController,
        ...(noticeReporter === undefined ? {} : { noticeReporter }),
        provisions,
        hostCapabilityInstances: [],
      });
      this.stagedPlugins.push(staged);
      for (const provision of provisions) this.declaredCapabilitiesByKey.set(provision.key, provision);
    } catch (error) {
      abortPluginLifetime(lifetimeController, entry.id, "activation failed");
      noticeReporter?.revoke();
      const rollbackError = rollbackDispose === undefined
        ? undefined
        : await this.runDispose(entry.id, rollbackDispose);
      const message = withRollbackError(errorMessage(error), rollbackError);
      const state: ServerPluginRuntimeState = error instanceof IncompatibleServerPluginError ? "incompatible" : "failed";
      this.recordsById.set(entry.id, recordFor(entry, {
        state,
        ...(plugin === undefined ? {} : { name: plugin.name }),
        phase,
        message,
      }));
      const details = { err: error, pluginId: entry.id, phase, ...(rollbackError === undefined ? {} : { rollbackError }) };
      if (state === "incompatible") this.logger.warn(details, "server plugin is incompatible");
      else this.logger.error(details, "server plugin activation failed");
      if (this.enforceRequiredTerminal && entry.id === REQUIRED_TERMINAL_PLUGIN_ID) {
        throw requiredTerminalError(`Required Terminal server entry failed during ${phase}: ${message}`, error);
      }
    }
  }

  private async startStagedPlugins(allowLateHostWait: boolean): Promise<void> {
    const pending = new Map(this.stagedPlugins.map((plugin) => [plugin.entry.id, plugin]));
    while (pending.size > 0) {
      let progressed = false;
      const candidates = [...pending.values()].sort((left, right) => requiredTerminalFirst(left.entry, right.entry));
      for (const staged of candidates) {
        const dependencyFailure = this.dependencyFailure(staged, pending);
        if (dependencyFailure !== undefined) {
          pending.delete(staged.entry.id);
          const message = await this.failBeforeStart(staged, dependencyFailure);
          progressed = true;
          if (this.enforceRequiredTerminal && staged.entry.id === REQUIRED_TERMINAL_PLUGIN_ID) {
            throw requiredTerminalError(`Required Terminal server entry failed during start: ${message}`, dependencyFailure);
          }
          continue;
        }
        if (this.waitingForDependencies(staged)) continue;

        pending.delete(staged.entry.id);
        const startError = await this.startStagedPlugin(staged);
        progressed = true;
        if (startError !== undefined && this.enforceRequiredTerminal && staged.entry.id === REQUIRED_TERMINAL_PLUGIN_ID) {
          const record = this.recordsById.get(staged.entry.id);
          throw requiredTerminalError(`Required Terminal server entry failed during start: ${record?.message ?? errorMessage(startError)}`, startError);
        }
      }
      if (progressed) continue;

      const cycleIds = findCapabilityCycle(pending, this.declaredCapabilitiesByKey);
      if (cycleIds.length > 0) {
        for (const pluginId of cycleIds) {
          const staged = pending.get(pluginId);
          if (staged === undefined) continue;
          pending.delete(pluginId);
          const cyclicRequirement = (staged.plugin.requires ?? []).find((requirement) => cycleIds.includes(requirement.pluginId));
          const error = new Error(cyclicRequirement === undefined
            ? `Server plugin ${pluginId} has an unresolved capability dependency cycle`
            : `Server plugin ${pluginId} requires ${formatCapability(cyclicRequirement)} in a capability dependency cycle`);
          const message = await this.failBeforeStart(staged, error);
          if (this.enforceRequiredTerminal && pluginId === REQUIRED_TERMINAL_PLUGIN_ID) {
            throw requiredTerminalError(`Required Terminal server entry failed during start: ${message}`, error);
          }
        }
        continue;
      }

      if (allowLateHostWait) {
        const providerCycles = candidates.flatMap((staged) => {
          if (staged.activation.workspaceProvider === undefined) return [];
          const lateCapability = findLateHostDependency(staged, pending, this.declaredCapabilitiesByKey);
          return lateCapability === undefined ? [] : [{ staged, lateCapability }];
        });
        if (providerCycles.length > 0) {
          for (const { staged, lateCapability } of providerCycles) {
            pending.delete(staged.entry.id);
            const error = new Error(
              `Server plugin ${staged.entry.id} contributes a workspace provider that depends on late host capability ${formatCapability(lateCapability)} in a capability dependency cycle`,
            );
            const message = await this.failBeforeStart(staged, error);
            if (this.enforceRequiredTerminal && staged.entry.id === REQUIRED_TERMINAL_PLUGIN_ID) {
              throw requiredTerminalError(`Required Terminal server entry failed during start: ${message}`, error);
            }
          }
          continue;
        }
        if (candidates.every((staged) => (
          findLateHostDependency(staged, pending, this.declaredCapabilitiesByKey) !== undefined
        ))) return;
      }

      const unresolved = candidates[0];
      if (unresolved === undefined) return;
      pending.delete(unresolved.entry.id);
      const error = new Error(`Server plugin ${unresolved.entry.id} has an unresolved capability dependency cycle`);
      const message = await this.failBeforeStart(unresolved, error);
      if (this.enforceRequiredTerminal && unresolved.entry.id === REQUIRED_TERMINAL_PLUGIN_ID) {
        throw requiredTerminalError(`Required Terminal server entry failed during start: ${message}`, error);
      }
    }
  }

  private dependencyFailure(
    staged: StagedServerPlugin,
    pending: ReadonlyMap<string, StagedServerPlugin>,
  ): Error | undefined {
    for (const requirement of staged.plugin.requires ?? []) {
      const key = capabilityKey(requirement);
      const provision = this.declaredCapabilitiesByKey.get(key);
      if (provision === undefined) {
        return new Error(`Server plugin ${staged.entry.id} requires unavailable capability ${formatCapability(requirement)}`);
      }
      if (this.activeCapabilitiesByKey.has(key)
        || provision.source === "host"
        || provision.source === "host-factory"
        || provision.source === "late-host") continue;
      if (!pending.has(requirement.pluginId)) {
        return new Error(`Server plugin ${staged.entry.id} requires ${formatCapability(requirement)}, but provider plugin ${requirement.pluginId} did not start`);
      }
    }
    return undefined;
  }

  private waitingForDependencies(staged: StagedServerPlugin): boolean {
    return (staged.plugin.requires ?? []).some((requirement) => {
      const key = capabilityKey(requirement);
      return this.declaredCapabilitiesByKey.get(key)?.source !== "host-factory"
        && !this.activeCapabilitiesByKey.has(key);
    });
  }

  private async startStagedPlugin(staged: StagedServerPlugin): Promise<unknown> {
    try {
      const capabilities = this.capabilityResolver(staged);
      const start = staged.activation.start?.bind(staged.activation);
      if (start !== undefined) {
        await runBounded(staged.entry.id, "start", this.lifecycleTimeoutMs, (signal) => start(Object.freeze({
          capabilities,
          signal,
        })));
      }
      if (this.enforceRequiredTerminal && staged.entry.id === REQUIRED_TERMINAL_PLUGIN_ID) {
        await this.requireHealthyTerminal(staged);
      }
      this.publish(staged);
      return undefined;
    } catch (error) {
      await this.failBeforeStart(staged, error);
      return error;
    }
  }

  private capabilityResolver(staged: StagedServerPlugin): ServerPluginStartContext["capabilities"] {
    const resolved = new Map<string, ResolvedCapabilityRequirement>();
    for (const requirement of staged.plugin.requires ?? []) {
      const key = capabilityKey(requirement);
      const activeProvision = this.activeCapabilitiesByKey.get(key);
      const declaration = this.declaredCapabilitiesByKey.get(key);
      let provisionValue: unknown;
      if (activeProvision !== undefined) {
        provisionValue = activeProvision.value;
      } else if (declaration?.source === "host-factory") {
        provisionValue = this.createHostCapabilityValue(staged, declaration);
      } else {
        throw new Error(`Server plugin ${staged.entry.id} requires inactive capability ${formatCapability(requirement)}`);
      }
      // Validate the declared requirement before start, but retain the provider value:
      // resolve() may supply a different parser for this same capability key.
      parseCapabilityValue(
        requirement,
        provisionValue,
        `Required capability ${formatCapability(requirement)} for server plugin ${staged.entry.id}`,
      );
      resolved.set(key, { provisionValue });
    }
    return createCapabilityResolver(staged.entry.id, resolved);
  }

  private createHostCapabilityValue(
    staged: StagedServerPlugin,
    factory: InternalHostCapabilityFactory,
  ): unknown {
    const context: ServerPluginHostCapabilityContext = Object.freeze({
      pluginId: staged.entry.id,
      packageRoot: staged.entry.packageRoot,
      lifetimeSignal: staged.lifetimeController.signal,
    });
    const instance = factory.create(context);
    staged.hostCapabilityInstances.push(instance);
    return parseCapabilityValue(
      factory.capability,
      instance.value,
      `Host capability ${formatCapability(factory.capability)} for server plugin ${staged.entry.id}`,
    );
  }

  private async requireHealthyTerminal(staged: StagedServerPlugin): Promise<void> {
    const health = staged.activation.health?.bind(staged.activation);
    if (health === undefined) return;
    const result = await runBounded(staged.entry.id, "health", this.lifecycleTimeoutMs, (signal) => health(signal));
    const parsed = parseHealth(result);
    if (parsed.status === "unhealthy") {
      throw new Error(`Required Terminal server entry is unhealthy: ${parsed.message ?? "health check failed"}`);
    }
  }

  private publish(staged: StagedServerPlugin): void {
    const providerContribution = staged.activation.workspaceProvider === undefined
      ? undefined
      : Object.freeze({
          pluginId: staged.entry.id,
          pluginName: staged.plugin.name,
          packageRoot: staged.entry.packageRoot,
          source: staged.entry.source,
          scope: staged.entry.scope,
          moduleRevision: requireServerModule(staged.entry).revision,
          provider: staged.activation.workspaceProvider,
        });
    const pairedBackendContribution = staged.activation.peer === undefined
      ? undefined
      : Object.freeze({
          pluginId: staged.entry.id,
          pluginName: staged.plugin.name,
          packageRoot: staged.entry.packageRoot,
          source: staged.entry.source,
          scope: staged.entry.scope,
          moduleRevision: requireServerModule(staged.entry).revision,
          backend: staged.activation.peer,
        });
    const active = Object.freeze({
      ...staged,
      ...(providerContribution === undefined ? {} : { providerContribution }),
      ...(pairedBackendContribution === undefined ? {} : { pairedBackendContribution }),
    });
    this.removeStaged(staged.entry.id);
    this.activePlugins.push(active);
    for (const provision of staged.provisions) this.activeCapabilitiesByKey.set(provision.key, provision);
    this.recordsById.set(staged.entry.id, recordFor(staged.entry, {
      state: "active",
      name: staged.plugin.name,
      ...(pairedBackendContribution?.backend.request === undefined ? {} : { pairedRequestVersion: 1 }),
      ...(pairedBackendContribution?.backend.openChannel === undefined ? {} : { pairedChannelVersion: 1 }),
    }));
    this.logger.info({ pluginId: staged.entry.id, pluginName: staged.plugin.name }, "server plugin activated");
  }

  private async failBeforeStart(staged: StagedServerPlugin, error: unknown): Promise<string> {
    abortPluginLifetime(staged.lifetimeController, staged.entry.id, "startup failed");
    staged.noticeReporter?.revoke();
    this.removeStaged(staged.entry.id);
    const dispose = staged.activation.dispose?.bind(staged.activation);
    const rollbackError = dispose === undefined ? undefined : await this.runDispose(staged.entry.id, dispose);
    const hostCleanupError = await this.disposeHostCapabilityInstances(staged);
    const message = withHostCleanupError(withRollbackError(errorMessage(error), rollbackError), hostCleanupError);
    this.recordsById.set(staged.entry.id, recordFor(staged.entry, {
      state: "failed",
      name: staged.plugin.name,
      phase: "start",
      message,
    }));
    this.logger.error(
      {
        err: error,
        pluginId: staged.entry.id,
        phase: "start",
        ...(rollbackError === undefined ? {} : { rollbackError }),
        ...(hostCleanupError === undefined ? {} : { hostCleanupError }),
      },
      "server plugin start failed",
    );
    return message;
  }

  private removeStaged(pluginId: string): void {
    this.stagedPlugins = this.stagedPlugins.filter(({ entry }) => entry.id !== pluginId);
  }

  private async disposeForShutdown(plugin: StagedServerPlugin): Promise<void> {
    plugin.noticeReporter?.revoke();
    const dispose = plugin.activation.dispose?.bind(plugin.activation);
    const pluginDisposeError = dispose === undefined ? undefined : await this.runDispose(plugin.entry.id, dispose);
    const hostCleanupError = await this.disposeHostCapabilityInstances(plugin);
    const error = combinedDisposalError(pluginDisposeError, hostCleanupError);
    if (error === undefined) return;
    this.recordsById.set(plugin.entry.id, recordFor(plugin.entry, {
      state: "failed",
      name: plugin.plugin.name,
      phase: "dispose",
      message: errorMessage(error),
      ...(plugin.activation.peer?.request === undefined ? {} : { pairedRequestVersion: 1 }),
      ...(plugin.activation.peer?.openChannel === undefined ? {} : { pairedChannelVersion: 1 }),
    }));
    this.logger.error(
      {
        err: error,
        pluginId: plugin.entry.id,
        phase: "dispose",
        ...(hostCleanupError === undefined ? {} : { hostCleanupError }),
      },
      "server plugin disposal failed",
    );
  }

  private async disposeHostCapabilityInstances(plugin: StagedServerPlugin): Promise<unknown> {
    const instances = plugin.hostCapabilityInstances.splice(0).reverse();
    const errors: unknown[] = [];
    for (const instance of instances) {
      if (instance.dispose === undefined) continue;
      const error = await this.runDispose(plugin.entry.id, instance.dispose);
      if (error !== undefined) errors.push(error);
    }
    if (errors.length === 0) return undefined;
    if (errors.length === 1) return errors[0];
    return new AggregateError(errors, "Multiple host capability cleanup operations failed");
  }

  private async runDispose(pluginId: string, dispose: (signal: AbortSignal) => Promise<void> | void): Promise<unknown> {
    try {
      await runBounded(pluginId, "dispose", this.lifecycleTimeoutMs, (signal) => dispose(signal));
      return undefined;
    } catch (error) {
      return error;
    }
  }
}

function requireTerminalCatalogEntry(snapshot: PiWebPluginCatalogSnapshot): PiWebPluginCatalogEntry {
  const entry = snapshot.plugins.find(({ id }) => id === REQUIRED_TERMINAL_PLUGIN_ID);
  if (entry === undefined) throw requiredTerminalError("Required bundled Terminal package is missing");
  if (entry.scope !== "bundled" || entry.source !== "bundled") {
    throw requiredTerminalError("Required Terminal package must come from the bundled plugin scope");
  }
  if (entry.browserModule === undefined || entry.serverModule === undefined || !entry.machineSpecific) {
    throw requiredTerminalError("Required Terminal package must provide machine-specific browser and server entries");
  }
  if (!entry.enabled) throw requiredTerminalError("Required Terminal package cannot be disabled in normal startup");
  return entry;
}

function requireTerminalActivation(activation: ServerPluginActivation): void {
  if (activation.peer?.request === undefined || activation.peer.openChannel === undefined) {
    throw new IncompatibleServerPluginError("Required Terminal server entry must expose peer request and channel capabilities");
  }
  const requiredKey = capabilityKey(REQUIRED_TERMINAL_SERVICE_CAPABILITY);
  const provision = activation.provides?.find(({ capability }) => capabilityKey(capability) === requiredKey);
  if (provision === undefined) {
    throw new IncompatibleServerPluginError(`Required Terminal server entry must provide ${formatCapability(REQUIRED_TERMINAL_SERVICE_CAPABILITY)}`);
  }
  try {
    REQUIRED_TERMINAL_SERVICE_CAPABILITY.parse(provision.value);
  } catch (error) {
    throw new IncompatibleServerPluginError(errorMessage(error), { cause: error });
  }
}

function requiredTerminalFirst(left: PiWebPluginCatalogEntry, right: PiWebPluginCatalogEntry): number {
  if (left.id === REQUIRED_TERMINAL_PLUGIN_ID) return right.id === REQUIRED_TERMINAL_PLUGIN_ID ? 0 : -1;
  if (right.id === REQUIRED_TERMINAL_PLUGIN_ID) return 1;
  return left.id.localeCompare(right.id);
}

function requiredTerminalError(message: string, cause?: unknown): RequiredTerminalPluginError {
  return new RequiredTerminalPluginError(
    `${message}. ${REQUIRED_TERMINAL_RECOVERY_GUIDANCE}`,
    cause === undefined ? {} : { cause },
  );
}

function disabledReason(entry: PiWebPluginCatalogEntry, safeStart: ServerPluginSafeStart | undefined): string | undefined {
  if (!entry.enabled) return "disabled in PI WEB config";
  if (safeStart === "none") return "disabled by no-server-plugin safe start";
  if (safeStart === "bundled-only" && entry.scope !== "bundled") return "disabled by bundled-only safe start";
  return undefined;
}

function recordFor(
  entry: PiWebPluginCatalogEntry,
  status: Pick<ServerPluginRuntimeRecord, "state"> & Partial<Pick<ServerPluginRuntimeRecord, "name" | "phase" | "message" | "pairedRequestVersion" | "pairedChannelVersion">>,
): ServerPluginRuntimeRecord {
  return Object.freeze({
    pluginId: entry.id,
    source: entry.source,
    scope: entry.scope,
    moduleRevision: requireServerModule(entry).revision,
    ...(entry.browserModule === undefined ? {} : { browserRevision: entry.browserModule.revision }),
    settingsRevision: entry.settingsRevision,
    machineSpecific: entry.machineSpecific,
    ...(status.pairedRequestVersion === undefined ? {} : { pairedRequestVersion: status.pairedRequestVersion }),
    ...(status.pairedChannelVersion === undefined ? {} : { pairedChannelVersion: status.pairedChannelVersion }),
    state: status.state,
    ...(status.name === undefined ? {} : { name: status.name }),
    ...(status.phase === undefined ? {} : { phase: status.phase }),
    ...(status.message === undefined ? {} : { message: status.message }),
  });
}

function requireServerModule(entry: PiWebPluginCatalogEntry): NonNullable<PiWebPluginCatalogEntry["serverModule"]> {
  const serverModule = entry.serverModule;
  if (serverModule === undefined) throw new Error(`PI WEB plugin has no server module: ${entry.id}`);
  return serverModule;
}

function serverModuleUrl(entry: PiWebPluginCatalogEntry): string {
  const serverModule = requireServerModule(entry);
  const url = pathToFileURL(serverModule.filePath);
  url.searchParams.set("piWebRevision", serverModule.revision);
  return url.href;
}

async function importServerPluginModule(moduleUrl: string): Promise<unknown> {
  const imported: unknown = await import(moduleUrl);
  return imported;
}

function parsePluginExport(imported: unknown): LoadedServerPlugin {
  if (!isRecord(imported)) throw new IncompatibleServerPluginError("Server plugin module must export a default plugin object");
  const plugin = imported["default"];
  if (!isRecord(plugin)) throw new IncompatibleServerPluginError("Server plugin module must export a default plugin object");
  const apiVersion = plugin["apiVersion"];
  const name = plugin["name"];
  const activateValue = plugin["activate"];
  if (apiVersion !== 3) {
    throw new IncompatibleServerPluginError(`Unsupported server plugin API version: ${formatUnknown(apiVersion)}`);
  }
  if (typeof name !== "string" || name === "") {
    throw new IncompatibleServerPluginError("Server plugin name must be a non-empty string");
  }
  if (typeof activateValue !== "function") {
    throw new IncompatibleServerPluginError("Server plugin activate must be a function");
  }
  const requires = snapshotCapabilityRequirements(plugin["requires"], `Server plugin ${name} requirements`);
  return Object.freeze({
    name,
    ...(requires.length === 0 ? {} : { requires }),
    activate(context: ServerPluginActivationContext): unknown {
      const result: unknown = Reflect.apply(activateValue, plugin, [context]);
      return result;
    },
  });
}

function activationDisposeForRollback(value: unknown): ((signal: AbortSignal) => Promise<void>) | undefined {
  if (!isRecord(value)) return undefined;
  const dispose = value["dispose"];
  if (typeof dispose !== "function") return undefined;
  return async (signal: AbortSignal): Promise<void> => {
    await Reflect.apply(dispose, value, [signal]);
  };
}

function parseActivation(value: unknown, pluginId: string): ServerPluginActivation {
  if (!isRecord(value)) throw new IncompatibleServerPluginError("Server plugin activation must be an object");
  if (value["workspaceProviders"] !== undefined) {
    throw new IncompatibleServerPluginError("Server plugins may contribute only one workspaceProvider");
  }
  if (value["requiredTerminalService"] !== undefined) {
    throw new IncompatibleServerPluginError("requiredTerminalService was removed in server plugin API v3; use a typed capability provision");
  }
  if (value["stop"] !== undefined) {
    throw new IncompatibleServerPluginError("Server plugin stop was removed in API v3; use dispose");
  }
  const workspaceProviderValue = value["workspaceProvider"];
  const peerValue = value["peer"];
  const provides = snapshotCapabilityProvisions(value["provides"], pluginId, `Server plugin ${pluginId} provisions`);
  const candidate = {
    workspaceProvider: workspaceProviderValue === undefined ? undefined : snapshotWorkspaceProvider(workspaceProviderValue),
    peer: peerValue === undefined ? undefined : snapshotPluginPeer(peerValue),
    provides,
    start: value["start"],
    dispose: value["dispose"],
    health: value["health"],
  };
  for (const callback of ["start", "dispose", "health"] as const) {
    const callbackValue = candidate[callback];
    if (callbackValue !== undefined && typeof callbackValue !== "function") {
      throw new IncompatibleServerPluginError(`Server plugin ${callback} must be a function`);
    }
  }
  if (!isServerPluginActivation(candidate)) throw new IncompatibleServerPluginError("Server plugin activation is invalid");
  const start = candidate.start?.bind(value);
  const dispose = candidate.dispose?.bind(value);
  const health = candidate.health?.bind(value);
  return Object.freeze({
    ...(candidate.workspaceProvider === undefined ? {} : { workspaceProvider: candidate.workspaceProvider }),
    ...(candidate.peer === undefined ? {} : { peer: candidate.peer }),
    ...(provides.length === 0 ? {} : { provides }),
    ...(start === undefined ? {} : { start: (context: ServerPluginStartContext) => start(context) }),
    ...(dispose === undefined ? {} : { dispose: (signal: AbortSignal) => dispose(signal) }),
    ...(health === undefined ? {} : { health: (signal: AbortSignal) => health(signal) }),
  });
}

function isServerPluginActivation(value: unknown): value is ServerPluginActivation {
  if (!isRecord(value)) return false;
  const workspaceProvider = value["workspaceProvider"];
  const peer = value["peer"];
  const provides = value["provides"];
  const start = value["start"];
  const dispose = value["dispose"];
  const health = value["health"];
  return (workspaceProvider === undefined || isWorkspaceProvider(workspaceProvider))
    && (peer === undefined || isPluginPeer(peer))
    && (provides === undefined || Array.isArray(provides))
    && (start === undefined || typeof start === "function")
    && (dispose === undefined || typeof dispose === "function")
    && (health === undefined || typeof health === "function");
}

function snapshotCapabilityRequirements(value: unknown, label: string): readonly PluginCapability[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) throw new IncompatibleServerPluginError(`${label} must be an array`);
  const seen = new Set<string>();
  const requirements: PluginCapability[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) throw new IncompatibleServerPluginError(`${label} must not be sparse`);
    const capability = snapshotUnknownCapability(value[index], `${label}[${String(index)}]`);
    const key = capabilityKey(capability);
    if (seen.has(key)) throw new IncompatibleServerPluginError(`${label} declares ${formatCapability(capability)} more than once`);
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
  if (!Array.isArray(value)) throw new IncompatibleServerPluginError(`${label} must be an array`);
  const seen = new Set<string>();
  const provisions: PluginCapabilityProvision[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) throw new IncompatibleServerPluginError(`${label} must not be sparse`);
    const candidate: unknown = value[index];
    if (!isRecord(candidate)) throw new IncompatibleServerPluginError(`${label}[${String(index)}] must be an object`);
    const capability = snapshotUnknownCapability(candidate["capability"], `${label}[${String(index)}].capability`);
    if (ownerPluginId !== undefined && capability.pluginId !== ownerPluginId) {
      throw new IncompatibleServerPluginError(`Server plugin ${ownerPluginId} cannot provide capability owned by ${capability.pluginId}`);
    }
    const key = capabilityKey(capability);
    if (seen.has(key)) throw new IncompatibleServerPluginError(`${label} publishes ${formatCapability(capability)} more than once`);
    seen.add(key);
    const parsedValue = parseCapabilityValue(capability, candidate["value"], `Provided capability ${formatCapability(capability)}`);
    provisions.push(Object.freeze({ capability, value: parsedValue }));
  }
  return Object.freeze(provisions);
}

function snapshotHostCapabilities(value: readonly PluginCapabilityProvision[] | undefined): readonly InternalCapabilityProvision[] {
  const provisions = snapshotCapabilityProvisions(value, undefined, "Host capability provisions");
  return internalProvisions({ provides: provisions }, "host");
}

function snapshotLateHostCapabilities(
  value: readonly PluginCapability[] | undefined,
): readonly InternalLateHostCapability[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) throw new Error("Late host capabilities must be an array");
  const seen = new Set<string>();
  const capabilities: InternalLateHostCapability[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) throw new Error("Late host capabilities must not be sparse");
    const capability = snapshotUnknownCapability(value[index], `Late host capabilities[${String(index)}]`);
    const key = capabilityKey(capability);
    if (seen.has(key)) throw new Error(`Late host capability ${formatCapability(capability)} is configured more than once`);
    seen.add(key);
    capabilities.push(Object.freeze({ capability, key, source: "late-host" as const }));
  }
  return Object.freeze(capabilities);
}

function snapshotHostCapabilityFactories(
  value: readonly ServerPluginHostCapabilityFactory[] | undefined,
): readonly InternalHostCapabilityFactory[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) throw new Error("Host capability factories must be an array");
  const seen = new Set<string>();
  const factories: InternalHostCapabilityFactory[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) throw new Error("Host capability factories must not be sparse");
    const candidate: unknown = value[index];
    if (!isRecord(candidate)) throw new Error(`Host capability factories[${String(index)}] must be an object`);
    const capability = snapshotUnknownCapability(
      candidate["capability"],
      `Host capability factories[${String(index)}].capability`,
    );
    const key = capabilityKey(capability);
    if (seen.has(key)) throw new Error(`Host capability factory for ${formatCapability(capability)} is configured more than once`);
    const create = candidate["create"];
    if (typeof create !== "function") throw new Error(`Host capability factory for ${formatCapability(capability)} must expose create`);
    seen.add(key);
    factories.push(Object.freeze({
      capability,
      key,
      source: "host-factory" as const,
      create(context: ServerPluginHostCapabilityContext): ServerPluginHostCapabilityInstance {
        const result: unknown = Reflect.apply(create, candidate, [context]);
        return snapshotHostCapabilityInstance(result, `Host capability ${formatCapability(capability)}`);
      },
    }));
  }
  return Object.freeze(factories);
}

function snapshotHostCapabilityInstance(value: unknown, label: string): ServerPluginHostCapabilityInstance {
  if (!isRecord(value) || !Object.hasOwn(value, "value")) {
    throw new Error(`${label} factory must return an object containing value`);
  }
  const dispose = value["dispose"];
  if (dispose !== undefined && typeof dispose !== "function") {
    throw new Error(`${label} factory dispose must be a function`);
  }
  return Object.freeze({
    value: value["value"],
    ...(dispose === undefined
      ? {}
      : { dispose: async (signal: AbortSignal): Promise<void> => { await Reflect.apply(dispose, value, [signal]); } }),
  });
}

function internalProvisions(
  activation: Pick<ServerPluginActivation, "provides">,
  source: InternalCapabilityProvision["source"],
): readonly InternalCapabilityProvision[] {
  return Object.freeze((activation.provides ?? []).map((provision) => Object.freeze({
    capability: provision.capability,
    key: capabilityKey(provision.capability),
    value: provision.value,
    source,
  })));
}

function snapshotUnknownCapability(value: unknown, label: string): PluginCapability {
  if (!isRecord(value)) throw new IncompatibleServerPluginError(`${label} must be an object`);
  const pluginId = value["pluginId"];
  const id = value["id"];
  const version = value["version"];
  const parse = value["parse"];
  const validated = validateCapabilityFields(pluginId, id, version, parse, label);
  return Object.freeze({
    pluginId: validated.pluginId,
    id: validated.id,
    version: validated.version,
    parse(input: unknown): unknown {
      const result: unknown = Reflect.apply(validated.parse, value, [input]);
      return result;
    },
  });
}

function snapshotTypedCapability<Value>(value: PluginCapability<Value>, label: string): PluginCapability<Value> {
  const validated = validateCapabilityFields(value.pluginId, value.id, value.version, value.parse, label);
  const parse = value.parse.bind(value);
  return Object.freeze({
    pluginId: validated.pluginId,
    id: validated.id,
    version: validated.version,
    parse: (input: unknown): Value => parse(input),
  });
}

function validateCapabilityFields(
  pluginId: unknown,
  id: unknown,
  version: unknown,
  parse: unknown,
  label: string,
): { pluginId: string; id: string; version: number; parse: (value: unknown) => unknown } {
  if (typeof pluginId !== "string" || pluginId.trim() === "") {
    throw new IncompatibleServerPluginError(`${label} pluginId must be a non-empty string`);
  }
  if (typeof id !== "string" || id.trim() === "") {
    throw new IncompatibleServerPluginError(`${label} id must be a non-empty string`);
  }
  if (typeof version !== "number" || !Number.isInteger(version) || version <= 0) {
    throw new IncompatibleServerPluginError(`${label} version must be a positive integer`);
  }
  if (!isCapabilityParser(parse)) throw new IncompatibleServerPluginError(`${label} parse must be a function`);
  return { pluginId, id, version, parse };
}

function isCapabilityParser(value: unknown): value is (input: unknown) => unknown {
  return typeof value === "function";
}

function parseCapabilityValue<Value>(capability: PluginCapability<Value>, value: unknown, label: string): Value {
  try {
    return capability.parse(value);
  } catch (error) {
    throw new IncompatibleServerPluginError(`${label} is invalid: ${errorMessage(error)}`, { cause: error });
  }
}

function capabilityKey(capability: Pick<PluginCapability, "pluginId" | "id" | "version">): string {
  return JSON.stringify([capability.pluginId, capability.id, capability.version]);
}

function formatCapability(capability: Pick<PluginCapability, "pluginId" | "id" | "version">): string {
  return `${capability.pluginId}/${capability.id} v${String(capability.version)}`;
}

function createCapabilityResolver(
  pluginId: string,
  resolved: ReadonlyMap<string, ResolvedCapabilityRequirement>,
): ServerPluginStartContext["capabilities"] {
  return Object.freeze({
    resolve<Value>(value: PluginCapability<Value>): Value {
      const capability = snapshotTypedCapability(value, `Capability request from server plugin ${pluginId}`);
      const requirement = resolved.get(capabilityKey(capability));
      if (requirement === undefined) {
        throw new Error(`Server plugin ${pluginId} did not declare required capability ${formatCapability(capability)}`);
      }
      return parseCapabilityValue(
        capability,
        requirement.provisionValue,
        `Required capability ${formatCapability(capability)} for server plugin ${pluginId}`,
      );
    },
  });
}

function findLateHostDependency(
  staged: StagedServerPlugin,
  pending: ReadonlyMap<string, StagedServerPlugin>,
  declared: ReadonlyMap<string, InternalCapabilityDeclaration>,
  visiting: ReadonlySet<string> = new Set<string>(),
): PluginCapability | undefined {
  if (visiting.has(staged.entry.id)) return undefined;
  const nextVisiting = new Set(visiting);
  nextVisiting.add(staged.entry.id);
  for (const requirement of staged.plugin.requires ?? []) {
    const declaration = declared.get(capabilityKey(requirement));
    if (declaration?.source === "late-host") return declaration.capability;
    if (declaration?.source !== "plugin") continue;
    const provider = pending.get(requirement.pluginId);
    if (provider === undefined) continue;
    const lateCapability = findLateHostDependency(provider, pending, declared, nextVisiting);
    if (lateCapability !== undefined) return lateCapability;
  }
  return undefined;
}

function findCapabilityCycle(
  pending: ReadonlyMap<string, StagedServerPlugin>,
  declared: ReadonlyMap<string, InternalCapabilityDeclaration>,
): string[] {
  const state = new Map<string, "visiting" | "visited">();
  const stack: string[] = [];
  const visit = (pluginId: string): string[] | undefined => {
    state.set(pluginId, "visiting");
    stack.push(pluginId);
    const plugin = pending.get(pluginId);
    const providers = (plugin?.plugin.requires ?? [])
      .filter((requirement) => declared.get(capabilityKey(requirement))?.source === "plugin" && pending.has(requirement.pluginId))
      .map((requirement) => requirement.pluginId)
      .sort((left, right) => left.localeCompare(right));
    for (const providerId of providers) {
      if (state.get(providerId) === "visiting") {
        const start = stack.indexOf(providerId);
        return stack.slice(start);
      }
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

function abortPluginLifetime(controller: AbortController, pluginId: string, outcome: string): void {
  if (!controller.signal.aborted) {
    controller.abort(new DOMException(`Server plugin ${pluginId} ${outcome}`, "AbortError"));
  }
}

function withRollbackError(message: string, rollbackError: unknown): string {
  return rollbackError === undefined
    ? message
    : `${message}; startup rollback failed: ${errorMessage(rollbackError)}`;
}

function withHostCleanupError(message: string, cleanupError: unknown): string {
  return cleanupError === undefined
    ? message
    : `${message}; host capability cleanup failed: ${errorMessage(cleanupError)}`;
}

function combinedDisposalError(pluginError: unknown, hostCleanupError: unknown): unknown {
  if (pluginError === undefined) return hostCleanupError;
  if (hostCleanupError === undefined) return pluginError;
  return new AggregateError(
    [pluginError, hostCleanupError],
    `${errorMessage(pluginError)}; host capability cleanup failed: ${errorMessage(hostCleanupError)}`,
  );
}

function snapshotPluginPeer(value: unknown): ServerPluginPeer {
  if (!isPluginPeer(value)) {
    throw new IncompatibleServerPluginError("Server plugin peer must include a request or channel handler");
  }
  const request = value.request?.bind(value);
  const openChannel = value.openChannel?.bind(value);
  const snapshotRequest = request === undefined
    ? undefined
    : (context: ServerPluginPeerRequestContext): JsonValue | Promise<JsonValue> => request(context);
  const snapshotOpenChannel = openChannel === undefined
    ? undefined
    : async (context: ServerPluginPeerChannelOpenContext): Promise<ServerPluginPeerChannel> => (
        snapshotPluginPeerChannel(await openChannel(context))
      );
  if (snapshotRequest !== undefined && snapshotOpenChannel !== undefined) {
    return Object.freeze({ request: snapshotRequest, openChannel: snapshotOpenChannel });
  }
  if (snapshotRequest !== undefined) return Object.freeze({ request: snapshotRequest });
  if (snapshotOpenChannel !== undefined) return Object.freeze({ openChannel: snapshotOpenChannel });
  throw new IncompatibleServerPluginError("Server plugin peer must include a request or channel handler");
}

function isPluginPeer(value: unknown): value is ServerPluginPeer {
  if (!isRecord(value)) return false;
  const request = value["request"];
  const openChannel = value["openChannel"];
  return (typeof request === "function" || typeof openChannel === "function")
    && (request === undefined || typeof request === "function")
    && (openChannel === undefined || typeof openChannel === "function");
}

function snapshotPluginPeerChannel(value: unknown): ServerPluginPeerChannel {
  if (!isPluginPeerChannel(value)) {
    throw new Error("Server plugin openChannel must return a channel with receive, optional completion, and optional close callbacks");
  }
  const receive = value.receive.bind(value);
  const closed = value.closed === undefined ? undefined : Promise.resolve(value.closed);
  const close = value.close?.bind(value);
  return Object.freeze({
    receive: (data: JsonValue, signal: AbortSignal) => receive(data, signal),
    ...(closed === undefined ? {} : { closed }),
    ...(close === undefined ? {} : { close: (context: ServerPluginPeerChannelCloseContext) => close(context) }),
  });
}

function isPluginPeerChannel(value: unknown): value is ServerPluginPeerChannel {
  return isRecord(value)
    && typeof value["receive"] === "function"
    && (value["closed"] === undefined || isPromiseLike(value["closed"]))
    && (value["close"] === undefined || typeof value["close"] === "function");
}

function isPromiseLike(value: unknown): value is PromiseLike<void> {
  return isRecord(value) && typeof value["then"] === "function";
}

function snapshotWorkspaceProvider(value: unknown): WorkspaceProvider {
  if (!isRecord(value)) throw new IncompatibleServerPluginError("Server plugin workspaceProvider is invalid");
  const candidate = {
    fallback: value["fallback"],
    probe: value["probe"],
    list: value["list"],
    prepareRemove: value["prepareRemove"],
  };
  if (!isWorkspaceProvider(candidate)) throw new IncompatibleServerPluginError("Server plugin workspaceProvider is invalid");
  const probe = candidate.probe.bind(value);
  const list = candidate.list.bind(value);
  const prepareRemove = candidate.prepareRemove?.bind(value);
  return Object.freeze({
    ...(candidate.fallback === undefined ? {} : { fallback: candidate.fallback }),
    probe: (project: ProjectInput, signal: AbortSignal) => probe(project, signal),
    list: (project: ProjectInput, signal: AbortSignal) => list(project, signal),
    ...(prepareRemove === undefined ? {} : { prepareRemove: (context: ProviderRemoveContext) => prepareRemove(context) }),
  });
}

function isWorkspaceProvider(value: unknown): value is WorkspaceProvider {
  if (!isRecord(value)) return false;
  const fallback = value["fallback"];
  const probe = value["probe"];
  const list = value["list"];
  const prepareRemove = value["prepareRemove"];
  return (fallback === undefined || typeof fallback === "boolean")
    && typeof probe === "function"
    && typeof list === "function"
    && (prepareRemove === undefined || typeof prepareRemove === "function");
}

function parseHealth(value: unknown): ServerPluginHealth {
  if (!isRecord(value)) throw new IncompatibleServerPluginError("Server plugin health must be an object");
  const status = value["status"];
  const message = value["message"];
  const details = value["details"];
  if (status !== "healthy" && status !== "degraded" && status !== "unhealthy") {
    throw new IncompatibleServerPluginError("Server plugin health status is invalid");
  }
  if (message !== undefined && typeof message !== "string") {
    throw new IncompatibleServerPluginError("Server plugin health message must be a string");
  }
  const clonedDetails = details === undefined ? undefined : cloneJsonObject(details, "server plugin health details");
  return Object.freeze({
    status,
    ...(message === undefined ? {} : { message }),
    ...(clonedDetails === undefined ? {} : { details: clonedDetails }),
  });
}

function createScopedNoticeReporter(
  pluginId: string,
  sink: CreateServerPluginRuntimeOptions["noticeSink"],
): ScopedNoticeReporter | undefined {
  if (sink === undefined) return undefined;
  const source = `${SERVER_PLUGIN_NOTICE_SOURCE_PREFIX}${pluginId}`;
  let active = true;
  const reporter: ServerPluginNoticeReporterV1 = Object.freeze({
    version: 1,
    record(input: ServerPluginNoticeInput): void {
      if (!active) throw new Error(`Server plugin notice reporter for ${pluginId} is no longer active`);
      sink(source, parseServerPluginNoticeInput(input));
    },
  });
  return Object.freeze({
    reporter,
    revoke(): void { active = false; },
  });
}

function parseServerPluginNoticeInput(value: unknown): ServerPluginNoticeInput {
  if (!isPlainRecord(value)) throw new Error("Server plugin notice input must be an object");
  if ("source" in value) throw new Error("Server plugin notices cannot set their source");
  for (const key in value) {
    if (!Object.hasOwn(value, key)) continue;
    if (key !== "severity" && key !== "message" && key !== "scope" && key !== "context") {
      throw new Error(`Unsupported server plugin notice field: ${key}`);
    }
  }
  const severity = value["severity"];
  if (severity !== "info" && severity !== "warning" && severity !== "error") {
    throw new Error("Server plugin notice severity must be info, warning, or error");
  }
  const message = value["message"];
  if (typeof message !== "string") {
    throw new Error("Server plugin notice message must be a non-empty string");
  }
  if (serverNoticeStringExceedsUtf8ByteLimit(message, SERVER_PLUGIN_NOTICE_MESSAGE_MAX_BYTES)) {
    throw new Error(`Server plugin notice message exceeds the ${String(SERVER_PLUGIN_NOTICE_MESSAGE_MAX_BYTES)} byte limit`);
  }
  // This scan and allocation are bounded because the UTF-8 limit passed first.
  if (message.trim() === "") {
    throw new Error("Server plugin notice message must be a non-empty string");
  }
  const scope = value["scope"] === undefined
    ? undefined
    : parseServerNoticeScope(value["scope"], "Server plugin notice scope");
  const context = value["context"] === undefined
    ? undefined
    : cloneJsonObject(value["context"], "server plugin notice context", {
        maxDepth: SERVER_PLUGIN_NOTICE_CONTEXT_MAX_DEPTH,
        maxBytes: SERVER_PLUGIN_NOTICE_CONTEXT_MAX_BYTES,
      });
  return Object.freeze({
    severity,
    message,
    ...(scope === undefined ? {} : { scope }),
    ...(context === undefined ? {} : { context }),
  });
}

function createScopedLogger(pluginId: string, logger: ServerPluginRuntimeLogger): ServerPluginLogger {
  return Object.freeze({
    debug(message: string, details?: JsonObject): void {
      logger.debug({ pluginId, ...(details ?? {}) }, message);
    },
    info(message: string, details?: JsonObject): void {
      logger.info({ pluginId, ...(details ?? {}) }, message);
    },
    warn(message: string, details?: JsonObject): void {
      logger.warn({ pluginId, ...(details ?? {}) }, message);
    },
    error(message: string, details?: JsonObject): void {
      logger.error({ pluginId, ...(details ?? {}) }, message);
    },
  });
}

async function runBounded<T>(
  pluginId: string,
  phase: ServerPluginLifecyclePhase,
  timeoutMs: number,
  operation: (signal: AbortSignal) => T | Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timeoutError = new ServerPluginTimeoutError(`Server plugin ${pluginId} ${phase} timed out after ${String(timeoutMs)}ms`);
  const timeout = setTimeout(() => { controller.abort(timeoutError); }, timeoutMs);
  timeout.unref();
  const deadline = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener("abort", () => { reject(abortError(controller.signal)); }, { once: true });
  });
  const result = Promise.resolve().then(() => operation(controller.signal));
  try {
    return await Promise.race([result, deadline]);
  } finally {
    clearTimeout(timeout);
    if (!controller.signal.aborted) controller.abort(new DOMException("Server plugin operation completed", "AbortError"));
  }
}

interface JsonCloneLimits {
  readonly maxDepth?: number;
  readonly maxBytes?: number;
}

interface JsonCloneByteBudget {
  readonly label: string;
  readonly maxBytes: number;
  remaining: number;
}

function cloneJsonObject(value: unknown, label: string, limits: JsonCloneLimits = {}): JsonObject {
  if (!isPlainRecord(value)) throw new IncompatibleServerPluginError(`${label} must be a JSON object`);
  const byteBudget = limits.maxBytes === undefined
    ? undefined
    : { label, maxBytes: limits.maxBytes, remaining: limits.maxBytes };
  return cloneJsonRecord(value, new Set<object>(), label, 0, limits.maxDepth, byteBudget);
}

function cloneJsonRecord(
  value: Record<string, unknown>,
  ancestors: Set<object>,
  label: string,
  depth: number,
  maxDepth: number | undefined,
  byteBudget: JsonCloneByteBudget | undefined,
): JsonObject {
  requireJsonDepth(depth, maxDepth, label);
  if (ancestors.has(value)) throw new IncompatibleServerPluginError(`${label} must not contain cycles`);
  consumeJsonBytes(byteBudget, 2); // Opening and closing braces.
  ancestors.add(value);
  const output: Record<string, JsonValue> = {};
  let propertyCount = 0;
  for (const key in value) {
    if (!Object.hasOwn(value, key)) continue;
    if (propertyCount > 0) consumeJsonBytes(byteBudget, 1); // Comma.
    consumeJsonStringBytes(byteBudget, key);
    consumeJsonBytes(byteBudget, 1); // Colon.
    defineJsonProperty(
      output,
      key,
      cloneJsonValue(value[key], ancestors, label, depth + 1, maxDepth, byteBudget),
    );
    propertyCount += 1;
  }
  ancestors.delete(value);
  return Object.freeze(output);
}

function cloneJsonValue(
  value: unknown,
  ancestors: Set<object>,
  label: string,
  depth: number,
  maxDepth: number | undefined,
  byteBudget: JsonCloneByteBudget | undefined,
): JsonValue {
  requireJsonDepth(depth, maxDepth, label);
  if (value === null) {
    consumeJsonBytes(byteBudget, 4);
    return value;
  }
  if (typeof value === "string") {
    consumeJsonStringBytes(byteBudget, value);
    return value;
  }
  if (typeof value === "boolean") {
    consumeJsonBytes(byteBudget, value ? 4 : 5);
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new IncompatibleServerPluginError(`${label} must contain only finite JSON numbers`);
    consumeJsonBytes(byteBudget, String(value).length);
    return value;
  }
  if (Array.isArray(value)) return cloneJsonArray(value, ancestors, label, depth, maxDepth, byteBudget);
  if (isPlainRecord(value)) return cloneJsonRecord(value, ancestors, label, depth, maxDepth, byteBudget);
  throw new IncompatibleServerPluginError(`${label} must contain only JSON values`);
}

function cloneJsonArray(
  value: unknown[],
  ancestors: Set<object>,
  label: string,
  depth: number,
  maxDepth: number | undefined,
  byteBudget: JsonCloneByteBudget | undefined,
): readonly JsonValue[] {
  requireJsonDepth(depth, maxDepth, label);
  if (ancestors.has(value)) throw new IncompatibleServerPluginError(`${label} must not contain cycles`);
  consumeJsonBytes(byteBudget, 2); // Opening and closing brackets.
  ancestors.add(value);
  try {
    const output: JsonValue[] = [];
    const length = value.length;
    // Plugin-owned arrays may override iteration helpers; inspect each dense element directly.
    for (let index = 0; index < length; index += 1) {
      if (!Object.hasOwn(value, index)) {
        throw new IncompatibleServerPluginError(`${label} must not contain sparse arrays`);
      }
      if (index > 0) consumeJsonBytes(byteBudget, 1); // Comma.
      output[index] = cloneJsonValue(value[index], ancestors, label, depth + 1, maxDepth, byteBudget);
    }
    return Object.freeze(output);
  } finally {
    ancestors.delete(value);
  }
}

function consumeJsonStringBytes(byteBudget: JsonCloneByteBudget | undefined, value: string): void {
  if (byteBudget === undefined) return;
  consumeJsonBytes(byteBudget, 2); // Opening and closing quotes.
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit === 0x22 || codeUnit === 0x5c
      || codeUnit === 0x08 || codeUnit === 0x09 || codeUnit === 0x0a
      || codeUnit === 0x0c || codeUnit === 0x0d) {
      consumeJsonBytes(byteBudget, 2);
    } else if (codeUnit <= 0x1f) {
      consumeJsonBytes(byteBudget, 6);
    } else if (codeUnit <= 0x7f) {
      consumeJsonBytes(byteBudget, 1);
    } else if (codeUnit <= 0x7ff) {
      consumeJsonBytes(byteBudget, 2);
    } else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff
      && index + 1 < value.length
      && value.charCodeAt(index + 1) >= 0xdc00
      && value.charCodeAt(index + 1) <= 0xdfff) {
      consumeJsonBytes(byteBudget, 4);
      index += 1;
    } else if (codeUnit >= 0xd800 && codeUnit <= 0xdfff) {
      // Well-formed JSON.stringify escapes isolated UTF-16 surrogates as \uXXXX.
      consumeJsonBytes(byteBudget, 6);
    } else {
      consumeJsonBytes(byteBudget, 3);
    }
  }
}

function consumeJsonBytes(byteBudget: JsonCloneByteBudget | undefined, count: number): void {
  if (byteBudget === undefined) return;
  byteBudget.remaining -= count;
  if (byteBudget.remaining < 0) {
    throw new Error(`${byteBudget.label} exceeds the ${String(byteBudget.maxBytes)} byte limit`);
  }
}

function requireJsonDepth(depth: number, maxDepth: number | undefined, label: string): void {
  if (maxDepth !== undefined && depth > maxDepth) {
    throw new IncompatibleServerPluginError(`${label} exceeds the maximum JSON depth of ${String(maxDepth)}`);
  }
}

function defineJsonProperty(record: Record<string, JsonValue>, key: string, value: JsonValue): void {
  Object.defineProperty(record, key, { value, enumerable: true, configurable: true, writable: true });
}

function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new Error("Server plugin operation aborted", { cause: reason });
}

class IncompatibleServerPluginError extends Error {
  override name = "IncompatibleServerPluginError";
}

export class RequiredTerminalPluginError extends Error {
  override name = "RequiredTerminalPluginError";
}

class ServerPluginTimeoutError extends Error {
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

function formatUnknown(value: unknown): string {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null || value === undefined) return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
