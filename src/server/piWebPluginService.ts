import { existsSync } from "node:fs";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { DefaultPackageManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { loadPiWebConfig, piWebDataDir, type PiWebConfig } from "../config.js";
import type { PiWebPluginInfo, PiWebPluginsResponse, PiWebPluginScope } from "../shared/apiTypes.js";
import { isPiWebPluginId } from "../shared/pluginIds.js";

export type { PiWebPluginInfo, PiWebPluginsResponse, PiWebPluginScope } from "../shared/apiTypes.js";

export interface PiWebPluginManifest {
  plugins: PiWebPluginManifestEntry[];
}

export interface PiWebPluginManifestEntry {
  id: string;
  module: string;
  source: string;
  scope: PiWebPluginScope;
  machineSpecific: boolean;
}

export interface ConfiguredPiPackage {
  source: string;
  scope: "user" | "project";
  installedPath?: string;
}

export interface PiPackageProvider {
  listPackages(): ConfiguredPiPackage[];
  getInstalledPath(source: string, scope: "user" | "project"): string | undefined;
}

interface PluginRecord {
  id: string;
  root: string;
  entryFile: string;
  version: string;
  source: string;
  scope: PiWebPluginScope;
  machineSpecific: boolean;
}

interface PiWebPluginServiceOptions {
  roots?: LocalPluginRoot[];
  cwd?: string;
  agentDir?: string;
  agentDirProvider?: () => string | Promise<string>;
  packageProvider?: PiPackageProvider | false;
  configProvider?: () => PiWebConfig | Promise<PiWebConfig>;
}

interface LocalPluginRoot {
  path: string;
  source: string;
  scope: PiWebPluginScope;
}

interface PiWebPackageConfig {
  plugins: PiWebPluginEntry[];
}

interface PiWebPluginEntry {
  id: string;
  module: string;
  machineSpecific: boolean;
}

type ArraylessPluginRecord = Omit<PluginRecord, "source" | "scope">;

export class DefaultPiPackageProvider implements PiPackageProvider {
  constructor(
    private readonly cwd: string,
    private readonly agentDir: string,
  ) {}

  listPackages(): ConfiguredPiPackage[] {
    return this.createPackageManager().listConfiguredPackages();
  }

  getInstalledPath(source: string, scope: "user" | "project"): string | undefined {
    return this.createPackageManager().getInstalledPath(source, scope);
  }

  private createPackageManager(): DefaultPackageManager {
    return new DefaultPackageManager({
      cwd: this.cwd,
      agentDir: this.agentDir,
      settingsManager: SettingsManager.create(this.cwd, this.agentDir),
    });
  }
}

export class PiWebPluginService {
  private readonly roots: LocalPluginRoot[];
  private readonly agentDir: string | undefined;
  private readonly agentDirProvider: (() => string | Promise<string>) | undefined;
  private readonly staticPackageProvider: PiPackageProvider | undefined;
  private readonly packageProviderForAgentDir: ((agentDir: string) => PiPackageProvider) | undefined;
  private readonly configProvider: () => PiWebConfig | Promise<PiWebConfig>;

  constructor(options: PiWebPluginServiceOptions = {}) {
    const cwd = options.cwd ?? process.cwd();
    this.roots = options.roots ?? defaultPluginRoots(cwd);
    this.agentDir = options.agentDir;
    this.agentDirProvider = options.agentDirProvider;
    const packageProvider = options.packageProvider;
    this.staticPackageProvider = packageProvider === false || packageProvider === undefined ? undefined : packageProvider;
    this.packageProviderForAgentDir = packageProvider === false || packageProvider !== undefined
      ? undefined
      : (agentDir) => new DefaultPiPackageProvider(cwd, agentDir);
    this.configProvider = options.configProvider ?? (() => loadPiWebConfig({ cwd }).config);
  }

  async manifest(): Promise<PiWebPluginManifest> {
    return {
      plugins: (await this.plugins()).plugins
        .filter((plugin) => plugin.enabled)
        .map((plugin) => ({ id: plugin.id, module: plugin.module, source: plugin.source, scope: plugin.scope, machineSpecific: plugin.machineSpecific })),
    };
  }

  async plugins(): Promise<PiWebPluginsResponse> {
    const config = await this.configProvider();
    const plugins = await this.discoverPlugins();
    return { plugins: plugins.map((plugin) => this.pluginInfo(plugin, config)) };
  }

  async readAsset(pluginId: string, assetPath: string): Promise<{ content: Buffer; contentType: string } | undefined> {
    if (!isPiWebPluginId(pluginId)) return undefined;
    const plugin = await this.findPlugin(pluginId);
    if (plugin === undefined) return undefined;

    const resolved = resolve(plugin.root, assetPath);
    const [realRoot, realAsset] = await Promise.all([
      realpath(plugin.root),
      realpath(resolved).catch(() => undefined),
    ]);
    if (realAsset === undefined || !isWithin(realRoot, realAsset)) return undefined;

    const assetStat = await stat(realAsset).catch(() => undefined);
    if (assetStat?.isFile() !== true) return undefined;

    return { content: await readFile(realAsset), contentType: contentTypeFor(realAsset) };
  }

  private pluginInfo(plugin: PluginRecord, config: PiWebConfig): PiWebPluginInfo {
    return {
      id: plugin.id,
      module: `/pi-web-plugins/${encodeURIComponent(plugin.id)}/${plugin.entryFile}?${pluginModuleQuery(plugin)}`,
      source: plugin.source,
      scope: plugin.scope,
      machineSpecific: plugin.machineSpecific,
      enabled: config.plugins?.[plugin.id]?.enabled !== false,
    };
  }

  private async discoverPlugins(): Promise<PluginRecord[]> {
    const records = new Map<string, PluginRecord>();
    for (const plugin of await this.discoverLocalPlugins()) addUnique(records, plugin);
    const packageProvider = await this.currentPackageProvider();
    if (packageProvider !== undefined) {
      for (const plugin of await this.discoverPiPackagePlugins(packageProvider)) addUnique(records, plugin);
    }
    return [...records.values()].sort((left, right) => left.id.localeCompare(right.id));
  }

  private async findPlugin(pluginId: string): Promise<PluginRecord | undefined> {
    const localPlugin = (await this.discoverLocalPlugins()).find((candidate) => candidate.id === pluginId);
    if (localPlugin !== undefined) return localPlugin;

    const packageProvider = await this.currentPackageProvider();
    if (packageProvider === undefined) return undefined;
    const records = new Map<string, PluginRecord>();
    for (const plugin of await this.discoverPiPackagePlugins(packageProvider)) addUnique(records, plugin);
    return records.get(pluginId);
  }

  private async currentPackageProvider(): Promise<PiPackageProvider | undefined> {
    if (this.staticPackageProvider !== undefined) return this.staticPackageProvider;
    if (this.packageProviderForAgentDir === undefined) return undefined;
    return this.packageProviderForAgentDir(await this.currentAgentDir());
  }

  private async currentAgentDir(): Promise<string> {
    if (this.agentDirProvider !== undefined) return await this.agentDirProvider();
    if (this.agentDir !== undefined) return this.agentDir;
    throw new Error("Pi package plugin discovery requires an explicit active agent directory");
  }

  private async discoverLocalPlugins(): Promise<PluginRecord[]> {
    const plugins: PluginRecord[] = [];
    for (const root of this.roots) plugins.push(...await discoverLocalRoot(root));
    return plugins;
  }

  private async discoverPiPackagePlugins(packageProvider: PiPackageProvider): Promise<PluginRecord[]> {
    const plugins: PluginRecord[] = [];
    for (const configuredPackage of packageProvider.listPackages()) {
      const root = configuredPackage.installedPath ?? packageProvider.getInstalledPath(configuredPackage.source, configuredPackage.scope);
      if (root === undefined) continue;
      try {
        plugins.push(...await discoverPackageRoot(root, configuredPackage));
      } catch (error) {
        warnInvalidPlugin(configuredPackage.source, error);
      }
    }
    return plugins;
  }
}

function defaultPluginRoots(cwd: string): LocalPluginRoot[] {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const packageRoot = join(moduleDir, "..", "..");
  return [
    { path: bundledPluginRoot(packageRoot), source: "bundled", scope: "bundled" },
    ...sourceCheckoutPluginRoots(cwd),
    { path: join(piWebDataDir(), "plugins"), source: "local", scope: "local" },
  ];
}

function bundledPluginRoot(packageRoot: string): string {
  return join(packageRoot, "dist", "pi-web-plugins");
}

function pluginModuleQuery(plugin: PluginRecord): string {
  const params = new URLSearchParams({ v: plugin.version });
  const dockerMode = plugin.id === "updates" ? dockerModeFromEnv() : undefined;
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

function sourceCheckoutPluginRoots(cwd: string): LocalPluginRoot[] {
  const pluginsRoot = join(cwd, "plugins");
  if (!existsSync(join(cwd, "src", "server", "index.ts")) || !existsSync(pluginsRoot)) return [];
  return [{ path: pluginsRoot, source: "dev", scope: "local" }];
}

async function discoverLocalRoot(root: LocalPluginRoot): Promise<PluginRecord[]> {
  if (!existsSync(root.path)) return [];
  const entries = await readdir(root.path, { withFileTypes: true }).catch(() => []);
  const plugins: PluginRecord[] = [];
  for (const entry of entries) {
    if (!isPiWebPluginId(entry.name)) continue;
    const pluginRoot = join(root.path, entry.name);
    const pluginStat = entry.isDirectory() ? undefined : entry.isSymbolicLink() ? await stat(pluginRoot).catch(() => undefined) : undefined;
    if (!entry.isDirectory() && pluginStat?.isDirectory() !== true) continue;
    try {
      plugins.push(...await discoverLocalPlugin(pluginRoot, root));
    } catch (error) {
      warnInvalidPlugin(pluginRoot, error);
    }
  }
  return plugins;
}

async function discoverLocalPlugin(root: string, localRoot: LocalPluginRoot): Promise<PluginRecord[]> {
  const config = await readPiWebPackageConfig(root);
  if (config === undefined) return [];
  const plugins = await discoverPluginEntries(root, config);
  return plugins.map((plugin) => ({ ...plugin, source: localRoot.source, scope: localRoot.scope }));
}

async function discoverPackageRoot(root: string, configuredPackage: ConfiguredPiPackage): Promise<PluginRecord[]> {
  const config = await readPiWebPackageConfig(root);
  if (config === undefined) return [];
  const plugins = await discoverPluginEntries(root, config);
  return plugins.map((plugin) => ({ ...plugin, source: configuredPackage.source, scope: configuredPackage.scope }));
}

async function discoverPluginEntries(root: string, config: PiWebPackageConfig): Promise<ArraylessPluginRecord[]> {
  const plugins: ArraylessPluginRecord[] = [];
  for (const entry of config.plugins) {
    if (!isSafeRelativePath(entry.module)) throw new Error(`Unsafe PI WEB plugin module path for ${entry.id}: ${entry.module}`);
    const entryPath = join(root, entry.module);
    const entryStat = await stat(entryPath).catch(() => undefined);
    if (entryStat?.isFile() !== true) throw new Error(`PI WEB plugin module not found for ${entry.id}: ${entry.module}`);
    plugins.push({ id: entry.id, root, entryFile: entry.module, version: String(Math.floor(entryStat.mtimeMs)), machineSpecific: entry.machineSpecific });
  }
  return plugins;
}

async function readPiWebPackageConfig(root: string): Promise<PiWebPackageConfig | undefined> {
  const packagePath = join(root, "package.json");
  const content = await readFile(packagePath, "utf8").catch(() => undefined);
  if (content === undefined) return undefined;
  const parsed: unknown = JSON.parse(content);
  if (!isRecord(parsed)) return undefined;
  const piWeb = parsed["piWeb"];
  if (!isRecord(piWeb)) return undefined;

  const plugins = parsePluginEntries(piWeb, packagePath);
  if (plugins.length === 0) return undefined;
  return { plugins };
}

function parsePluginEntries(piWeb: Record<string, unknown>, packagePath: string): PiWebPluginEntry[] {
  if (piWeb["plugin"] !== undefined) throw new Error(`Unsupported PI WEB plugin metadata in ${packagePath}: use piWeb.plugins with { id, module, machineSpecific? } entries`);
  const plugins = piWeb["plugins"];
  if (plugins === undefined) return [];
  if (!Array.isArray(plugins)) throw new Error(`PI WEB plugins must be an array in ${packagePath}`);

  return plugins.map((entry, index): PiWebPluginEntry => {
    if (!isRecord(entry)) throw new Error(`PI WEB plugin entry ${String(index + 1)} must be an object in ${packagePath}`);
    const id = entry["id"];
    const module = entry["module"];
    if (typeof id !== "string" || !isPiWebPluginId(id)) throw new Error(`Invalid PI WEB plugin id in ${packagePath}: ${String(id)}`);
    if (typeof module !== "string" || module === "") throw new Error(`Invalid PI WEB plugin module for ${id} in ${packagePath}`);
    return { id, module, machineSpecific: parseMachineSpecific(entry["machineSpecific"], packagePath, id) };
  });
}

function parseMachineSpecific(value: unknown, packagePath: string, pluginId: string): boolean {
  if (value === undefined) return false;
  if (typeof value !== "boolean") throw new Error(`Invalid PI WEB plugin machineSpecific value for ${pluginId} in ${packagePath}: ${formatUnknownValue(value)}`);
  return value;
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

function addUnique(records: Map<string, PluginRecord>, plugin: PluginRecord): void {
  if (records.has(plugin.id)) {
    warnInvalidPlugin(plugin.source, `Duplicate PI WEB plugin id: ${plugin.id}`);
    return;
  }
  records.set(plugin.id, plugin);
}

function warnInvalidPlugin(source: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`Skipping PI WEB plugin from ${source}: ${message}`);
}

function isSafeRelativePath(path: string): boolean {
  return path !== "" && !path.includes("..") && !path.startsWith("/");
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith(sep));
}

function contentTypeFor(path: string): string {
  const lowerPath = path.toLowerCase();
  if (lowerPath.endsWith(".js")) return "application/javascript; charset=utf-8";
  if (lowerPath.endsWith(".json")) return "application/json; charset=utf-8";
  if (lowerPath.endsWith(".css")) return "text/css; charset=utf-8";
  if (lowerPath.endsWith(".html")) return "text/html; charset=utf-8";
  if (lowerPath.endsWith(".svg")) return "image/svg+xml";
  return "application/octet-stream";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
