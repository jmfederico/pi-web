import { pathToFileURL } from "node:url";
import type {
  JsonObject,
  JsonValue,
  PairedPluginBackendV1,
  PairedPluginChannel,
  PairedPluginChannelCloseContext,
  PairedPluginChannelOpenContext,
  PairedPluginRequestContext,
  PiWebServerPlugin,
  ProjectInput,
  ProviderRemoveContext,
  ProviderRequestContext,
  ServerPluginActivation,
  ServerPluginActivationContext,
  ServerPluginExecFileRequest,
  ServerPluginExecFileResult,
  ServerPluginHealth,
  ServerPluginLogger,
  ServerPluginNoticeInput,
  ServerPluginNoticeReporterV1,
  WorkspaceProvider,
} from "../../server-plugin-api.js";
import type { PiWebPluginScope } from "../../shared/apiTypes.js";
import {
  REQUIRED_TERMINAL_PLUGIN_ID,
  REQUIRED_TERMINAL_RECOVERY_GUIDANCE,
} from "../../shared/requiredTerminalPlugin.js";
import type { ServerPluginSafeStart } from "../../serverPluginRecovery.js";
import {
  snapshotRequiredTerminalService,
  unavailableRequiredTerminalService,
  type RequiredTerminalService,
} from "../terminals/requiredTerminalService.js";
import type {
  PiWebPluginCatalog,
  PiWebPluginCatalogDiagnostic,
  PiWebPluginCatalogEntry,
  PiWebPluginCatalogSnapshot,
} from "../piWebPluginCatalog.js";
import { createServerPluginExecFile } from "./serverPluginExec.js";

export type ServerPluginRuntimeState = "active" | "failed" | "incompatible" | "disabled";
export type ServerPluginLifecyclePhase = "import" | "activate" | "validate" | "start" | "health" | "stop";

export interface ServerPluginRuntimeRecord {
  pluginId: string;
  source: string;
  scope: PiWebPluginScope;
  moduleRevision: string;
  browserRevision?: string;
  settingsRevision: string;
  machineSpecific: boolean;
  /** Additive browser feature detection for a direct paired request backend. */
  backendCapabilityVersion?: 1;
  /** Additive browser feature detection for bounded paired channels. */
  channelVersion?: 1;
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
  backend: PairedPluginBackendV1;
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

export interface CreateServerPluginRuntimeOptions {
  catalog: Pick<PiWebPluginCatalog, "snapshot">;
  safeStart?: ServerPluginSafeStart;
  logger: ServerPluginRuntimeLogger;
  importer?: ServerPluginModuleImporter;
  execFile?: ServerPluginExecFile;
  lifecycleTimeoutMs?: number;
  /** Core-owned sink; source is host-derived as `plugin:<catalog id>`. */
  noticeSink?: (source: string, input: ServerPluginNoticeInput) => void;
  /** Isolated unit/package tests may opt out; production always enforces Terminal. */
  enforceRequiredTerminal?: boolean;
}

interface InternalServerPluginActivation extends ServerPluginActivation {
  requiredTerminalService?: RequiredTerminalService;
}

interface ActiveServerPlugin {
  entry: PiWebPluginCatalogEntry;
  plugin: PiWebServerPlugin;
  activation: InternalServerPluginActivation;
  providerContribution?: ServerPluginProviderContribution;
  pairedBackendContribution?: ServerPluginPairedBackendContribution;
}

const DEFAULT_LIFECYCLE_TIMEOUT_MS = 10_000;
/** Reserved for host-derived plugin attribution; core notice sources stay outside this namespace. */
const SERVER_PLUGIN_NOTICE_SOURCE_PREFIX = "plugin:";

/**
 * Resolves exactly one desired catalog snapshot and activates its server
 * entries. The resulting runtime is immutable except for explicit shutdown;
 * v1 intentionally has no hot reload or unload path.
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
  private activePlugins: ActiveServerPlugin[] = [];
  private stopped = false;

  private constructor(
    private readonly safeStart: ServerPluginSafeStart | undefined,
    private readonly diagnostics: readonly PiWebPluginCatalogDiagnostic[],
    private readonly logger: ServerPluginRuntimeLogger,
    private readonly importer: ServerPluginModuleImporter,
    private readonly execFile: ServerPluginExecFile,
    private readonly lifecycleTimeoutMs: number,
    private readonly noticeSink: ((source: string, input: ServerPluginNoticeInput) => void) | undefined,
    private readonly enforceRequiredTerminal: boolean,
  ) {}

  static async activate(
    snapshot: PiWebPluginCatalogSnapshot,
    options: Omit<CreateServerPluginRuntimeOptions, "catalog">,
  ): Promise<ServerPluginRuntime> {
    const runtime = new ServerPluginRuntime(
      options.safeStart,
      Object.freeze(snapshot.diagnostics.map((diagnostic) => Object.freeze({ ...diagnostic }))),
      options.logger,
      options.importer ?? importServerPluginModule,
      options.execFile ?? createServerPluginExecFile(),
      positiveInteger(options.lifecycleTimeoutMs, DEFAULT_LIFECYCLE_TIMEOUT_MS, "lifecycleTimeoutMs"),
      options.noticeSink,
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

  requiredTerminalService(): RequiredTerminalService {
    if (this.safeStart === "none") return unavailableRequiredTerminalService();
    const service = this.activePlugins.find(({ entry }) => entry.id === REQUIRED_TERMINAL_PLUGIN_ID)?.activation.requiredTerminalService;
    if (service === undefined) {
      throw requiredTerminalError("Required Terminal service is not active");
    }
    return service;
  }

  async inspectHealth(): Promise<readonly ServerPluginHealthInspection[]> {
    const inspections: ServerPluginHealthInspection[] = [];
    for (const active of this.activePlugins) {
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

  /** Stops every successfully published plugin in reverse activation order. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    const activePlugins = [...this.activePlugins].reverse();
    this.activePlugins = [];
    for (const active of activePlugins) {
      const stop = active.activation.stop?.bind(active.activation);
      if (stop === undefined) continue;
      try {
        await runBounded(
          active.entry.id,
          "stop",
          this.lifecycleTimeoutMs,
          (signal) => stop(signal),
        );
      } catch (error) {
        this.recordsById.set(active.entry.id, recordFor(active.entry, {
          state: "failed",
          name: active.plugin.name,
          phase: "stop",
          message: errorMessage(error),
          ...(active.activation.pairedBackend === undefined ? {} : { backendCapabilityVersion: 1 }),
          ...(active.activation.pairedBackend?.openChannel === undefined ? {} : { channelVersion: 1 }),
        }));
        this.logger.error({ err: error, pluginId: active.entry.id, phase: "stop" }, "server plugin stop failed");
      }
    }
  }

  private async start(entries: readonly PiWebPluginCatalogEntry[]): Promise<void> {
    const serverEntries = entries
      .filter((entry) => entry.serverModule !== undefined)
      .sort(requiredTerminalFirst);
    for (const entry of serverEntries) {
      await this.activateEntry(entry);
      if (this.enforceRequiredTerminal && entry.id === REQUIRED_TERMINAL_PLUGIN_ID) {
        const terminalHealth = (await this.inspectHealth()).find(({ pluginId }) => pluginId === REQUIRED_TERMINAL_PLUGIN_ID);
        if (terminalHealth?.health.status === "unhealthy") {
          throw requiredTerminalError(`Required Terminal server entry is unhealthy: ${terminalHealth.error ?? terminalHealth.health.message ?? "health check failed"}`);
        }
      }
    }
  }

  private async activateEntry(entry: PiWebPluginCatalogEntry): Promise<void> {
    const disabledMessage = disabledReason(entry, this.safeStart);
    if (disabledMessage !== undefined) {
      this.recordsById.set(entry.id, recordFor(entry, { state: "disabled", message: disabledMessage }));
      this.logger.info({ pluginId: entry.id, reason: disabledMessage }, "server plugin skipped");
      return;
    }

    let phase: ServerPluginLifecyclePhase = "validate";
    let plugin: PiWebServerPlugin | undefined;
    let rollbackStop: ((signal: AbortSignal) => Promise<void>) | undefined;
    try {
      const settings = cloneJsonObject(entry.settings, `settings for server plugin ${entry.id}`);
      phase = "import";
      const moduleUrl = serverModuleUrl(entry);
      const imported = await runBounded(entry.id, phase, this.lifecycleTimeoutMs, (signal) => this.importer(moduleUrl, signal));
      phase = "validate";
      const loadedPlugin = parsePluginExport(imported);
      plugin = loadedPlugin;
      phase = "activate";
      const scopedLogger = createScopedLogger(entry.id, this.logger);
      const notices = createScopedNoticeReporter(entry.id, this.noticeSink);
      const activationValue = await runBounded(entry.id, phase, this.lifecycleTimeoutMs, (signal) => loadedPlugin.activate(Object.freeze({
        apiVersion: 1,
        pluginId: entry.id,
        packageRoot: entry.packageRoot,
        logger: scopedLogger,
        settings,
        ...(notices === undefined ? {} : { notices }),
        execFile: this.execFile,
        signal,
      })));
      rollbackStop = activationStopForRollback(activationValue);
      phase = "validate";
      const loadedActivation = parseActivation(activationValue, entry.id);
      if (this.enforceRequiredTerminal && entry.id === REQUIRED_TERMINAL_PLUGIN_ID) {
        requireTerminalActivation(loadedActivation);
      }
      phase = "start";
      const start = loadedActivation.start?.bind(loadedActivation);
      if (start !== undefined) {
        await runBounded(entry.id, phase, this.lifecycleTimeoutMs, (signal) => start(signal));
      }

      const providerContribution = loadedActivation.workspaceProvider === undefined
        ? undefined
        : Object.freeze({
            pluginId: entry.id,
            pluginName: loadedPlugin.name,
            packageRoot: entry.packageRoot,
            source: entry.source,
            scope: entry.scope,
            moduleRevision: requireServerModule(entry).revision,
            provider: loadedActivation.workspaceProvider,
          });
      const pairedBackendContribution = loadedActivation.pairedBackend === undefined
        ? undefined
        : Object.freeze({
            pluginId: entry.id,
            pluginName: loadedPlugin.name,
            packageRoot: entry.packageRoot,
            source: entry.source,
            scope: entry.scope,
            moduleRevision: requireServerModule(entry).revision,
            backend: loadedActivation.pairedBackend,
          });
      this.activePlugins.push(Object.freeze({
        entry,
        plugin: loadedPlugin,
        activation: loadedActivation,
        ...(providerContribution === undefined ? {} : { providerContribution }),
        ...(pairedBackendContribution === undefined ? {} : { pairedBackendContribution }),
      }));
      this.recordsById.set(entry.id, recordFor(entry, {
        state: "active",
        name: loadedPlugin.name,
        ...(pairedBackendContribution === undefined ? {} : { backendCapabilityVersion: 1 }),
        ...(pairedBackendContribution?.backend.openChannel === undefined ? {} : { channelVersion: 1 }),
      }));
      this.logger.info({ pluginId: entry.id, pluginName: loadedPlugin.name }, "server plugin activated");
    } catch (error) {
      const rollbackError = (phase === "validate" || phase === "start") && rollbackStop !== undefined
        ? await this.rollbackStart(entry.id, rollbackStop)
        : undefined;
      const message = rollbackError === undefined
        ? errorMessage(error)
        : `${errorMessage(error)}; startup rollback failed: ${errorMessage(rollbackError)}`;
      const state: ServerPluginRuntimeState = error instanceof IncompatibleServerPluginError ? "incompatible" : "failed";
      this.recordsById.set(entry.id, recordFor(entry, {
        state,
        ...(plugin === undefined ? {} : { name: plugin.name }),
        phase,
        message,
      }));
      const details = { err: error, pluginId: entry.id, phase, ...(rollbackError === undefined ? {} : { rollbackError }) };
      if (state === "incompatible") {
        this.logger.warn(details, "server plugin is incompatible");
      } else {
        this.logger.error(details, "server plugin activation failed");
      }
      if (this.enforceRequiredTerminal && entry.id === REQUIRED_TERMINAL_PLUGIN_ID) {
        throw requiredTerminalError(`Required Terminal server entry failed during ${phase}: ${message}`, error);
      }
    }
  }

  private async rollbackStart(pluginId: string, stop: (signal: AbortSignal) => Promise<void>): Promise<unknown> {
    try {
      await runBounded(pluginId, "stop", this.lifecycleTimeoutMs, (signal) => stop(signal));
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

function requireTerminalActivation(activation: InternalServerPluginActivation): void {
  if (activation.pairedBackend?.openChannel === undefined) {
    throw new IncompatibleServerPluginError("Required Terminal server entry must expose paired request and channel version 1");
  }
  if (activation.requiredTerminalService === undefined) {
    throw new IncompatibleServerPluginError("Required Terminal server entry must expose requiredTerminalService");
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
  status: Pick<ServerPluginRuntimeRecord, "state"> & Partial<Pick<ServerPluginRuntimeRecord, "name" | "phase" | "message" | "backendCapabilityVersion" | "channelVersion">>,
): ServerPluginRuntimeRecord {
  return Object.freeze({
    pluginId: entry.id,
    source: entry.source,
    scope: entry.scope,
    moduleRevision: requireServerModule(entry).revision,
    ...(entry.browserModule === undefined ? {} : { browserRevision: entry.browserModule.revision }),
    settingsRevision: entry.settingsRevision,
    machineSpecific: entry.machineSpecific,
    ...(status.backendCapabilityVersion === undefined ? {} : { backendCapabilityVersion: status.backendCapabilityVersion }),
    ...(status.channelVersion === undefined ? {} : { channelVersion: status.channelVersion }),
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

function parsePluginExport(imported: unknown): PiWebServerPlugin {
  if (!isRecord(imported)) throw new IncompatibleServerPluginError("Server plugin module must export a default plugin object");
  const plugin = imported["default"];
  if (!isRecord(plugin)) throw new IncompatibleServerPluginError("Server plugin module must export a default plugin object");
  const candidate = {
    apiVersion: plugin["apiVersion"],
    name: plugin["name"],
    activate: plugin["activate"],
  };
  if (candidate.apiVersion !== 1) {
    throw new IncompatibleServerPluginError(`Unsupported server plugin API version: ${formatUnknown(candidate.apiVersion)}`);
  }
  if (typeof candidate.name !== "string" || candidate.name === "") {
    throw new IncompatibleServerPluginError("Server plugin name must be a non-empty string");
  }
  if (typeof candidate.activate !== "function" || !isPiWebServerPlugin(candidate)) {
    throw new IncompatibleServerPluginError("Server plugin activate must be a function");
  }
  const activate = candidate.activate.bind(plugin);
  return Object.freeze({ apiVersion: 1, name: candidate.name, activate: (context: ServerPluginActivationContext) => activate(context) });
}

function isPiWebServerPlugin(value: unknown): value is PiWebServerPlugin {
  return isRecord(value)
    && value["apiVersion"] === 1
    && typeof value["name"] === "string"
    && value["name"] !== ""
    && typeof value["activate"] === "function";
}

function activationStopForRollback(value: unknown): ((signal: AbortSignal) => Promise<void>) | undefined {
  if (!isRecord(value)) return undefined;
  const stop = value["stop"];
  if (typeof stop !== "function") return undefined;
  return async (signal: AbortSignal): Promise<void> => {
    await Reflect.apply(stop, value, [signal]);
  };
}

function parseActivation(value: unknown, pluginId: string): InternalServerPluginActivation {
  if (!isRecord(value)) throw new IncompatibleServerPluginError("Server plugin activation must be an object");
  if (value["workspaceProviders"] !== undefined) {
    throw new IncompatibleServerPluginError("Server plugins may contribute only one workspaceProvider");
  }
  const workspaceProviderValue = value["workspaceProvider"];
  const pairedBackendValue = value["pairedBackend"];
  const requiredTerminalServiceValue = value["requiredTerminalService"];
  if (requiredTerminalServiceValue !== undefined && pluginId !== REQUIRED_TERMINAL_PLUGIN_ID) {
    throw new IncompatibleServerPluginError("Only the required Terminal plugin may expose requiredTerminalService");
  }
  let requiredTerminalService: RequiredTerminalService | undefined;
  if (requiredTerminalServiceValue !== undefined) {
    try {
      requiredTerminalService = snapshotRequiredTerminalService(requiredTerminalServiceValue);
    } catch (error) {
      throw new IncompatibleServerPluginError(errorMessage(error), { cause: error });
    }
  }
  const candidate = {
    workspaceProvider: workspaceProviderValue === undefined ? undefined : snapshotWorkspaceProvider(workspaceProviderValue),
    pairedBackend: pairedBackendValue === undefined ? undefined : snapshotPairedPluginBackend(pairedBackendValue),
    start: value["start"],
    stop: value["stop"],
    health: value["health"],
  };
  for (const callback of ["start", "stop", "health"] as const) {
    const callbackValue = candidate[callback];
    if (callbackValue !== undefined && typeof callbackValue !== "function") {
      throw new IncompatibleServerPluginError(`Server plugin ${callback} must be a function`);
    }
  }
  if (!isServerPluginActivation(candidate)) throw new IncompatibleServerPluginError("Server plugin activation is invalid");
  const start = candidate.start?.bind(value);
  const stop = candidate.stop?.bind(value);
  const health = candidate.health?.bind(value);
  return Object.freeze({
    ...(candidate.workspaceProvider === undefined ? {} : { workspaceProvider: candidate.workspaceProvider }),
    ...(candidate.pairedBackend === undefined ? {} : { pairedBackend: candidate.pairedBackend }),
    ...(requiredTerminalService === undefined ? {} : { requiredTerminalService }),
    ...(start === undefined ? {} : { start: (signal: AbortSignal) => start(signal) }),
    ...(stop === undefined ? {} : { stop: (signal: AbortSignal) => stop(signal) }),
    ...(health === undefined ? {} : { health: (signal: AbortSignal) => health(signal) }),
  });
}

function isServerPluginActivation(value: unknown): value is ServerPluginActivation {
  if (!isRecord(value)) return false;
  const workspaceProvider = value["workspaceProvider"];
  const pairedBackend = value["pairedBackend"];
  const start = value["start"];
  const stop = value["stop"];
  const health = value["health"];
  return (workspaceProvider === undefined || isWorkspaceProvider(workspaceProvider))
    && (pairedBackend === undefined || isPairedPluginBackend(pairedBackend))
    && (start === undefined || typeof start === "function")
    && (stop === undefined || typeof stop === "function")
    && (health === undefined || typeof health === "function");
}

function snapshotPairedPluginBackend(value: unknown): PairedPluginBackendV1 {
  if (!isPairedPluginBackend(value)) {
    throw new IncompatibleServerPluginError("Server plugin pairedBackend must be a version 1 request backend with an optional channel opener");
  }
  const request = value.request.bind(value);
  const openChannel = value.openChannel?.bind(value);
  return Object.freeze({
    version: 1,
    request: (context: PairedPluginRequestContext) => request(context),
    ...(openChannel === undefined ? {} : {
      openChannel: async (context: PairedPluginChannelOpenContext) => snapshotPairedPluginChannel(await openChannel(context)),
    }),
  });
}

function isPairedPluginBackend(value: unknown): value is PairedPluginBackendV1 {
  return isRecord(value)
    && value["version"] === 1
    && typeof value["request"] === "function"
    && (value["openChannel"] === undefined || typeof value["openChannel"] === "function");
}

function snapshotPairedPluginChannel(value: unknown): PairedPluginChannel {
  if (!isPairedPluginChannel(value)) {
    throw new Error("Server plugin openChannel must return a channel with receive, optional completion, and optional close callbacks");
  }
  const receive = value.receive.bind(value);
  const closed = value.closed === undefined ? undefined : Promise.resolve(value.closed);
  const close = value.close?.bind(value);
  return Object.freeze({
    receive: (data: JsonValue, signal: AbortSignal) => receive(data, signal),
    ...(closed === undefined ? {} : { closed }),
    ...(close === undefined ? {} : { close: (context: PairedPluginChannelCloseContext) => close(context) }),
  });
}

function isPairedPluginChannel(value: unknown): value is PairedPluginChannel {
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
    request: value["request"],
    prepareRemove: value["prepareRemove"],
  };
  if (!isWorkspaceProvider(candidate)) throw new IncompatibleServerPluginError("Server plugin workspaceProvider is invalid");
  const probe = candidate.probe.bind(value);
  const list = candidate.list.bind(value);
  const request = candidate.request?.bind(value);
  const prepareRemove = candidate.prepareRemove?.bind(value);
  return Object.freeze({
    ...(candidate.fallback === undefined ? {} : { fallback: candidate.fallback }),
    probe: (project: ProjectInput, signal: AbortSignal) => probe(project, signal),
    list: (project: ProjectInput, signal: AbortSignal) => list(project, signal),
    ...(request === undefined ? {} : { request: (context: ProviderRequestContext) => request(context) }),
    ...(prepareRemove === undefined ? {} : { prepareRemove: (context: ProviderRemoveContext) => prepareRemove(context) }),
  });
}

function isWorkspaceProvider(value: unknown): value is WorkspaceProvider {
  if (!isRecord(value)) return false;
  const fallback = value["fallback"];
  const probe = value["probe"];
  const list = value["list"];
  const request = value["request"];
  const prepareRemove = value["prepareRemove"];
  return (fallback === undefined || typeof fallback === "boolean")
    && typeof probe === "function"
    && typeof list === "function"
    && (request === undefined || typeof request === "function")
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
): ServerPluginNoticeReporterV1 | undefined {
  if (sink === undefined) return undefined;
  const source = `${SERVER_PLUGIN_NOTICE_SOURCE_PREFIX}${pluginId}`;
  return Object.freeze({
    version: 1,
    record(input: ServerPluginNoticeInput): void {
      sink(source, parseServerPluginNoticeInput(input));
    },
  });
}

function parseServerPluginNoticeInput(value: unknown): ServerPluginNoticeInput {
  if (!isPlainRecord(value)) throw new Error("Server plugin notice input must be an object");
  if ("source" in value) throw new Error("Server plugin notices cannot set their source");
  const unsupportedKey = Object.keys(value).find((key) => key !== "severity" && key !== "message" && key !== "context");
  if (unsupportedKey !== undefined) throw new Error(`Unsupported server plugin notice field: ${unsupportedKey}`);
  const severity = value["severity"];
  if (severity !== "info" && severity !== "warning" && severity !== "error") {
    throw new Error("Server plugin notice severity must be info, warning, or error");
  }
  const message = value["message"];
  if (typeof message !== "string" || message.trim() === "") {
    throw new Error("Server plugin notice message must be a non-empty string");
  }
  const context = value["context"] === undefined
    ? undefined
    : cloneJsonObject(value["context"], "server plugin notice context");
  return Object.freeze({
    severity,
    message,
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

function cloneJsonObject(value: unknown, label: string): JsonObject {
  if (!isPlainRecord(value)) throw new IncompatibleServerPluginError(`${label} must be a JSON object`);
  return cloneJsonRecord(value, new Set<object>(), label);
}

function cloneJsonRecord(value: Record<string, unknown>, ancestors: Set<object>, label: string): JsonObject {
  if (ancestors.has(value)) throw new IncompatibleServerPluginError(`${label} must not contain cycles`);
  ancestors.add(value);
  const output: Record<string, JsonValue> = {};
  for (const [key, child] of Object.entries(value)) {
    defineJsonProperty(output, key, cloneJsonValue(child, ancestors, label));
  }
  ancestors.delete(value);
  return Object.freeze(output);
}

function cloneJsonValue(value: unknown, ancestors: Set<object>, label: string): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new IncompatibleServerPluginError(`${label} must contain only finite JSON numbers`);
    return value;
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new IncompatibleServerPluginError(`${label} must not contain cycles`);
    ancestors.add(value);
    const output = value.map((child) => cloneJsonValue(child, ancestors, label));
    ancestors.delete(value);
    return Object.freeze(output);
  }
  if (isPlainRecord(value)) return cloneJsonRecord(value, ancestors, label);
  throw new IncompatibleServerPluginError(`${label} must contain only JSON values`);
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
