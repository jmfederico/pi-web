import { PI_WEB_PLUGIN_LIFECYCLE_VERSION, type PiWebPluginSafeStart, type PiWebPluginsResponse, type PiWebPluginScope } from "../shared/apiTypes.js";
import { isPiWebPluginId } from "../shared/pluginIds.js";
import { REQUIRED_TERMINAL_PLUGIN_ID, type TerminalPluginMode } from "../shared/requiredTerminalPlugin.js";
import {
  PiWebPluginCatalog,
  readPiWebPluginPackageArtifact,
  type PiWebPluginCatalogEntry,
  type PiWebPluginCatalogOptions,
  type PiWebPluginPackageEntry,
} from "./piWebPluginCatalog.js";
import { reconcilePiWebPluginLifecycle, type ProviderRuntimeLoadResult } from "./piWebPluginLifecycle.js";
import { WorkspaceCatalogProtocolError, type WorkspaceProviderRuntimeReader } from "./workspaces/workspaceCatalog.js";

export type { PiWebPluginInfo, PiWebPluginsResponse, PiWebPluginScope } from "../shared/apiTypes.js";
export {
  DefaultPiPackageProvider,
  PiWebPluginCatalog,
  type ConfiguredPiPackage,
  type LocalPluginRoot,
  type PiPackageProvider,
  type PiWebPluginCatalogDiagnostic,
  type PiWebPluginCatalogBrowserRoot,
  type PiWebPluginCatalogDiagnosticCode,
  type PiWebPluginCatalogEntry,
  type PiWebPluginCatalogModule,
  type PiWebPluginCatalogOptions,
  type PiWebPluginCatalogSnapshot,
  type PiWebPluginPackageEntry,
} from "./piWebPluginCatalog.js";

export interface PiWebPluginManifest {
  lifecycleVersion: typeof PI_WEB_PLUGIN_LIFECYCLE_VERSION;
  terminalMode: TerminalPluginMode;
  plugins: PiWebPluginManifestEntry[];
}

export class PiWebPluginManifestRuntimeError extends Error {
  override name = "PiWebPluginManifestRuntimeError";
  readonly statusCode: 409 | 503;

  constructor(readonly runtimeStatus: "unavailable" | "incompatible", message: string) {
    super(message);
    this.statusCode = runtimeStatus === "unavailable" ? 503 : 409;
  }
}

export interface PiWebPluginManifestEntry {
  id: string;
  module: string;
  /** Active compatible server revision from sessiond's immutable startup snapshot. */
  backendRevision?: string;
  /** Versioned direct paired-request capability exposed as `context.backend.capabilityVersion`. */
  backendCapabilityVersion?: 1;
  /** Versioned bounded channel capability exposed as `context.backend.channelVersion`. */
  channelVersion?: 1;
  source: string;
  scope: PiWebPluginScope;
  machineSpecific: boolean;
}

interface CachedBrowserArtifact {
  pluginId: string;
  revision: string;
  entryPath: string;
  entryFilePath: string;
  browserRootPath: string;
  browserRootDirectoryPath: string;
  packageRoot: string;
  backendRevision?: string;
  files: ReadonlyMap<string, Buffer>;
  byteLength: number;
}

const BROWSER_ARTIFACT_CACHE_MAX_ENTRIES = 32;
const BROWSER_ARTIFACT_CACHE_MAX_BYTES = 64 * 1024 * 1024;

export interface PiWebPluginServiceOptions extends PiWebPluginCatalogOptions {
  catalog?: PiWebPluginCatalog;
  runtimeProvider?: WorkspaceProviderRuntimeReader;
  recoveryProvider?: () => { safeStart?: PiWebPluginSafeStart } | Promise<{ safeStart?: PiWebPluginSafeStart }>;
}

/** Browser manifest and asset adapter over the process-neutral package catalog. */
export class PiWebPluginService {
  private readonly catalog: PiWebPluginCatalog;
  private readonly runtimeProvider: WorkspaceProviderRuntimeReader | undefined;
  private readonly recoveryProvider: PiWebPluginServiceOptions["recoveryProvider"];
  private readonly browserArtifacts = new Map<string, CachedBrowserArtifact>();
  private browserArtifactBytes = 0;

  constructor(options: PiWebPluginServiceOptions = {}) {
    this.catalog = options.catalog ?? new PiWebPluginCatalog(options);
    this.runtimeProvider = options.runtimeProvider;
    this.recoveryProvider = options.recoveryProvider;
  }

  async manifest(): Promise<PiWebPluginManifest> {
    const lifecycle = await this.lifecycle();
    const runtime = lifecycle.response.serverRuntime;
    if (runtime.status !== "available") {
      throw new PiWebPluginManifestRuntimeError(
        runtime.status,
        requiredRuntimeFailureMessage(runtime.status, runtime.message),
      );
    }
    const plugins: PiWebPluginManifestEntry[] = [];
    for (const { plugin, backendRevision, backendCapabilityVersion, channelVersion } of lifecycle.browserPlugins) {
      const artifact = await this.captureBrowserArtifact(plugin, backendRevision);
      if (artifact === undefined) continue;
      plugins.push({
        id: plugin.id,
        module: browserModuleUrl(plugin),
        ...(backendRevision === undefined ? {} : { backendRevision }),
        ...(backendCapabilityVersion === undefined ? {} : { backendCapabilityVersion }),
        ...(channelVersion === undefined ? {} : { channelVersion }),
        source: plugin.source,
        scope: plugin.scope,
        machineSpecific: plugin.machineSpecific,
      });
    }
    const terminalMode = lifecycle.response.serverRuntime.terminalMode;
    if (terminalMode === "required") requireTerminalManifestEntry(plugins);
    return { lifecycleVersion: PI_WEB_PLUGIN_LIFECYCLE_VERSION, terminalMode, plugins };
  }

  async plugins(): Promise<PiWebPluginsResponse> {
    return (await this.lifecycle()).response;
  }

  async readAsset(pluginId: string, assetPath: string, browserRevision?: string): Promise<{ content: Buffer; contentType: string } | undefined> {
    if (!isPiWebPluginId(pluginId)) return undefined;
    let artifact = this.browserArtifacts.get(pluginId);
    if (artifact !== undefined && !await this.cachedArtifactIsActive(artifact)) artifact = undefined;
    artifact ??= await this.loadBrowserArtifact(pluginId);
    if (artifact === undefined) return undefined;
    if (browserRevision !== undefined && assetPath === artifact.entryPath && artifact.revision !== browserRevision) return undefined;
    const content = artifact.files.get(assetPath);
    if (content === undefined) return undefined;
    this.touchBrowserArtifact(artifact);
    return { content, contentType: contentTypeFor(assetPath) };
  }

  private async loadBrowserArtifact(pluginId: string): Promise<CachedBrowserArtifact | undefined> {
    try {
      const lifecycle = await this.lifecycle();
      const browserPlugin = lifecycle.browserPlugins.find(({ plugin }) => plugin.id === pluginId);
      if (browserPlugin === undefined) return undefined;
      return await this.captureBrowserArtifact(browserPlugin.plugin, browserPlugin.backendRevision);
    } catch (error) {
      const localPlugin = await this.catalog.browserPlugin(pluginId);
      if (localPlugin?.serverModule !== undefined) throw error;
      return localPlugin === undefined ? undefined : await this.captureBrowserArtifact(localPlugin);
    }
  }

  private async captureBrowserArtifact(
    plugin: PiWebPluginPackageEntry,
    backendRevision?: string,
  ): Promise<CachedBrowserArtifact | undefined> {
    const module = plugin.browserModule;
    if (module === undefined) return undefined;
    const browserRoot = plugin.browserRoot;
    if (browserRoot === undefined) throw new Error(`PI WEB plugin has no browser root: ${plugin.id}`);
    const cached = this.browserArtifacts.get(plugin.id);
    if (cached !== undefined) {
      const matches = cached.revision === module.revision
        && cached.entryPath === module.path
        && cached.entryFilePath === module.filePath
        && cached.browserRootPath === browserRoot.path
        && cached.browserRootDirectoryPath === browserRoot.directoryPath
        && cached.packageRoot === plugin.packageRoot
        && cached.backendRevision === backendRevision;
      if (matches) {
        this.touchBrowserArtifact(cached);
        return cached;
      }
    }
    const packageArtifact = await readPiWebPluginPackageArtifact(plugin.packageRoot, browserRoot).catch(() => undefined);
    if (packageArtifact?.revision !== module.revision || !packageArtifact.files.has(module.path)) return undefined;
    const artifact: CachedBrowserArtifact = {
      pluginId: plugin.id,
      revision: module.revision,
      entryPath: module.path,
      entryFilePath: module.filePath,
      browserRootPath: browserRoot.path,
      browserRootDirectoryPath: browserRoot.directoryPath,
      packageRoot: plugin.packageRoot,
      ...(backendRevision === undefined ? {} : { backendRevision }),
      files: packageArtifact.files,
      byteLength: packageArtifact.byteLength,
    };
    this.cacheBrowserArtifact(artifact);
    return artifact;
  }

  private async cachedArtifactIsActive(artifact: CachedBrowserArtifact): Promise<boolean> {
    if (artifact.backendRevision === undefined) return true;
    const runtime = await this.loadRuntime();
    if (runtime.status !== "available") return false;
    const record = runtime.snapshot.records.find(({ pluginId }) => pluginId === artifact.pluginId);
    const health = runtime.snapshot.health.find(({ pluginId }) => pluginId === artifact.pluginId);
    return record?.state === "active"
      && record.moduleRevision === artifact.backendRevision
      && record.browserRevision === artifact.revision
      && health?.health.status !== "unhealthy";
  }

  private cacheBrowserArtifact(artifact: CachedBrowserArtifact): void {
    const current = this.browserArtifacts.get(artifact.pluginId);
    if (current !== undefined) {
      this.browserArtifacts.delete(artifact.pluginId);
      this.browserArtifactBytes -= current.byteLength;
    }
    while (this.browserArtifacts.size >= BROWSER_ARTIFACT_CACHE_MAX_ENTRIES
      || this.browserArtifactBytes + artifact.byteLength > BROWSER_ARTIFACT_CACHE_MAX_BYTES) {
      const oldest = this.browserArtifacts.values().next().value;
      if (oldest === undefined) break;
      this.browserArtifacts.delete(oldest.pluginId);
      this.browserArtifactBytes -= oldest.byteLength;
    }
    this.browserArtifacts.set(artifact.pluginId, artifact);
    this.browserArtifactBytes += artifact.byteLength;
  }

  private touchBrowserArtifact(artifact: CachedBrowserArtifact): void {
    if (this.browserArtifacts.get(artifact.pluginId) !== artifact) return;
    this.browserArtifacts.delete(artifact.pluginId);
    this.browserArtifacts.set(artifact.pluginId, artifact);
  }

  private async lifecycle() {
    const desired = await this.catalog.snapshot();
    const [runtime, desiredSafeStart] = await Promise.all([this.loadRuntime(), this.loadDesiredSafeStart()]);
    return reconcilePiWebPluginLifecycle(desired, runtime, browserModuleUrl, desiredSafeStart);
  }

  private async loadDesiredSafeStart(): Promise<PiWebPluginSafeStart | "off" | undefined> {
    if (this.recoveryProvider === undefined) return undefined;
    return (await this.recoveryProvider()).safeStart ?? "off";
  }

  private async loadRuntime(): Promise<ProviderRuntimeLoadResult> {
    if (this.runtimeProvider === undefined) {
      return { status: "unavailable", message: "Session daemon server-plugin runtime is unavailable" };
    }
    try {
      return { status: "available", snapshot: await this.runtimeProvider.providerRuntime() };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        status: error instanceof WorkspaceCatalogProtocolError ? "incompatible" : "unavailable",
        message,
      };
    }
  }
}

function requiredRuntimeFailureMessage(status: "unavailable" | "incompatible", message: string | undefined): string {
  const detail = message === undefined || message === "" ? "no runtime detail was available" : message;
  return `Required Terminal plugin runtime is ${status}: ${detail}. Retry when the session daemon is available and compatible; only an active safe-start-none runtime may disable Terminal.`;
}

function requireTerminalManifestEntry(plugins: readonly PiWebPluginManifestEntry[]): void {
  const terminal = plugins.find(({ id }) => id === REQUIRED_TERMINAL_PLUGIN_ID);
  if (terminal === undefined) throw new Error("Required Terminal browser entry is unavailable; use safe start none for recovery");
  if (terminal.scope !== "bundled" || terminal.source !== "bundled" || !terminal.machineSpecific) {
    throw new Error("Required Terminal browser entry is not the bundled machine-specific package");
  }
  if (terminal.backendRevision === undefined || terminal.backendCapabilityVersion !== 1 || terminal.channelVersion !== 1) {
    throw new Error("Required Terminal browser/server pairing is incompatible; restart or use safe start none for recovery");
  }
  if (plugins[0] !== terminal) throw new Error("Required Terminal browser entry must be activated before ordinary plugins");
}

function browserModuleUrl(plugin: PiWebPluginCatalogEntry): string {
  const browserModule = plugin.browserModule;
  if (browserModule === undefined) throw new Error(`PI WEB plugin has no browser module: ${plugin.id}`);
  const path = browserModule.path.split("/").map((segment) => encodeURIComponent(segment)).join("/");
  return `/pi-web-plugins/${encodeURIComponent(plugin.id)}/${path}?${pluginModuleQuery(plugin.id, browserModule.revision)}`;
}

function pluginModuleQuery(pluginId: string, revision: string): string {
  const params = new URLSearchParams({ v: revision });
  const dockerMode = pluginId === "updates" ? dockerModeFromEnv() : undefined;
  if (dockerMode !== undefined) params.set("piWebDockerMode", dockerMode);
  return params.toString();
}

function dockerModeFromEnv(): "runtime" | "dev" | undefined {
  if (!isTruthyEnv("PI_WEB_DOCKER_RUNTIME")) return undefined;
  const mode = process.env["PI_WEB_DOCKER_MODE"];
  if (mode === "runtime" || mode === "dev") return mode;
  if (firstNonEmptyEnv("PI_WEB_DOCKER_DEV_REPO_ROOT") !== undefined) return "dev";
  if (firstNonEmptyEnv("PI_WEB_DOCKER_INSTALL_DIR") !== undefined) return "runtime";
  return undefined;
}

function firstNonEmptyEnv(...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = process.env[key];
    if (value !== undefined && value !== "") return value;
  }
  return undefined;
}

function isTruthyEnv(key: string): boolean {
  const value = process.env[key];
  return value !== undefined && value !== "" && value !== "0" && value.toLowerCase() !== "false";
}

function contentTypeFor(path: string): string {
  const lowerPath = path.toLowerCase();
  if (lowerPath.endsWith(".js") || lowerPath.endsWith(".mjs")) return "application/javascript; charset=utf-8";
  if (lowerPath.endsWith(".json")) return "application/json; charset=utf-8";
  if (lowerPath.endsWith(".css")) return "text/css; charset=utf-8";
  if (lowerPath.endsWith(".html")) return "text/html; charset=utf-8";
  if (lowerPath.endsWith(".svg")) return "image/svg+xml";
  return "application/octet-stream";
}
