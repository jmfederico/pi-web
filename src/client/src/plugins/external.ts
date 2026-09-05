import { PI_WEB_PLUGIN_LIFECYCLE_VERSION } from "../../../shared/apiTypes";
import { machineScopedPluginId } from "../../../shared/machinePluginIds";
import { requirePluginBackendRevision } from "../../../shared/pluginBackendProtocol";
import { isPiWebPluginId, isReservedPiWebPluginId } from "../../../shared/pluginIds";
import { REQUIRED_TERMINAL_PLUGIN_ID, type TerminalPluginMode } from "../../../shared/requiredTerminalPlugin";
import { resolveAppUrl, type AppUrlContext } from "../appUrl";
import type { PiWebPlugin, PiWebPluginRegistration } from "./types";

export interface PluginManifestEntry {
  id: string;
  module: string;
  backendRevision?: string;
  backendCapabilityVersion?: 1;
  channelVersion?: 1;
  machineSpecific: boolean;
}

interface PluginManifest {
  terminalMode: TerminalPluginMode;
  plugins: PluginManifestEntry[];
}

export interface LoadExternalPluginsOptions {
  machineId?: string;
  shouldLoadPlugin?: (entry: PluginManifestEntry) => boolean;
  moduleLoader?: (moduleUrl: string) => Promise<unknown>;
}

export interface ExternalPluginLoadFailure {
  entry: PluginManifestEntry;
  error: unknown;
}

export interface ExternalPluginLoadResult {
  terminalMode: TerminalPluginMode;
  registrations: PiWebPluginRegistration[];
  failures: ExternalPluginLoadFailure[];
}

export async function loadExternalPlugins(manifestUrl = "pi-web-plugins/manifest.json", options: LoadExternalPluginsOptions = {}): Promise<ExternalPluginLoadResult> {
  const resolvedManifestUrl = resolveAppUrl(manifestUrl);
  const manifest = await fetchPluginManifest(resolvedManifestUrl);

  const registrations: PiWebPluginRegistration[] = [];
  const failures: ExternalPluginLoadFailure[] = [];
  for (const entry of manifest.plugins) {
    if (options.shouldLoadPlugin?.(entry) === false) continue;
    try {
      const moduleUrl = resolvePluginModuleUrl(entry.module, resolvedManifestUrl);
      const module = await (options.moduleLoader ?? importPluginModule)(moduleUrl);
      const plugin = parsePluginModule(module, moduleUrl);
      registrations.push({
        id: options.machineId === undefined ? entry.id : machineScopedPluginId(options.machineId, entry.id),
        plugin,
        machineSpecific: entry.machineSpecific,
        ...(entry.backendRevision === undefined ? {} : { backendRevision: entry.backendRevision }),
        ...(entry.backendCapabilityVersion === undefined ? {} : { backendCapabilityVersion: entry.backendCapabilityVersion }),
        ...(entry.channelVersion === undefined ? {} : { channelVersion: entry.channelVersion }),
        ...(options.machineId === undefined ? {} : { machineId: options.machineId, sourcePluginId: entry.id }),
      });
    } catch (error) {
      failures.push({ entry, error });
      if (manifest.terminalMode === "required" && entry.id === REQUIRED_TERMINAL_PLUGIN_ID) {
        return { terminalMode: manifest.terminalMode, registrations: [], failures };
      }
    }
  }
  return { terminalMode: manifest.terminalMode, registrations, failures };
}

export function resolvePluginModuleUrl(moduleReference: string, manifestUrl: string, appUrlContext?: AppUrlContext): string {
  if (!moduleReference.startsWith("/")) return new URL(moduleReference, manifestUrl).toString();
  return appUrlContext === undefined ? resolveAppUrl(moduleReference) : resolveAppUrl(moduleReference, appUrlContext);
}

async function importPluginModule(moduleUrl: string): Promise<unknown> {
  return import(/* @vite-ignore */ moduleUrl);
}

async function fetchPluginManifest(manifestUrl: string): Promise<PluginManifest> {
  const response = await fetch(manifestUrl, { cache: "no-store" });
  if (!response.ok) throw new Error(await pluginManifestResponseError(response));
  return parseManifest(await response.json());
}

function parseManifest(value: unknown): PluginManifest {
  if (!isRecord(value) || !Array.isArray(value["plugins"])) throw new Error("Invalid plugin manifest");
  if (value["lifecycleVersion"] !== PI_WEB_PLUGIN_LIFECYCLE_VERSION) throw new Error("Unsupported plugin manifest lifecycle version");
  const terminalMode = parseTerminalMode(value["terminalMode"]);
  const plugins = value["plugins"].map((entry) => {
    if (!isRecord(entry) || typeof entry["id"] !== "string" || typeof entry["module"] !== "string" || entry["module"] === "") throw new Error("Invalid plugin manifest entry");
    const id = entry["id"];
    if (!isPiWebPluginId(id)) throw new Error(`Invalid plugin manifest id: ${id}`);
    if (isReservedPiWebPluginId(id)) throw new Error(`Reserved plugin manifest id: ${id}`);
    const backendRevision = parseBackendRevision(entry["backendRevision"]);
    const backendCapabilityVersion = parseBackendCapabilityVersion(entry["backendCapabilityVersion"]);
    const channelVersion = parseChannelVersion(entry["channelVersion"]);
    if ((backendCapabilityVersion !== undefined || channelVersion !== undefined) && backendRevision === undefined) throw new Error("Invalid plugin manifest entry");
    if (channelVersion !== undefined && backendCapabilityVersion === undefined) throw new Error("Invalid plugin manifest entry");
    return {
      id,
      module: entry["module"],
      ...(backendRevision === undefined ? {} : { backendRevision }),
      ...(backendCapabilityVersion === undefined ? {} : { backendCapabilityVersion }),
      ...(channelVersion === undefined ? {} : { channelVersion }),
      machineSpecific: parseMachineSpecific(entry["machineSpecific"]),
    };
  });
  const ids = new Set<string>();
  for (const plugin of plugins) {
    if (ids.has(plugin.id)) throw new Error(`Duplicate plugin manifest id: ${plugin.id}`);
    ids.add(plugin.id);
  }
  const terminal = plugins.find(({ id }) => id === REQUIRED_TERMINAL_PLUGIN_ID);
  if (terminalMode === "required") {
    if (terminal === undefined || plugins[0] !== terminal || !terminal.machineSpecific) {
      throw new Error("Required Terminal plugin manifest entry is unavailable or out of order");
    }
    if (terminal.backendRevision === undefined || terminal.backendCapabilityVersion !== 1 || terminal.channelVersion !== 1) {
      throw new Error("Required Terminal plugin manifest entry is incompatible");
    }
  } else if (terminal !== undefined) {
    throw new Error("Recovery-disabled plugin manifest must not publish Terminal");
  }
  return { terminalMode, plugins };
}

function parseTerminalMode(value: unknown): TerminalPluginMode {
  if (value === "required" || value === "recovery-disabled") return value;
  throw new Error("Invalid plugin manifest Terminal mode");
}

async function pluginManifestResponseError(response: Response): Promise<string> {
  let detail: string | undefined;
  try {
    const value: unknown = await response.json();
    if (isRecord(value)) {
      const error = value["error"];
      const responseDetail = value["detail"];
      const message = value["message"];
      detail = typeof responseDetail === "string"
        ? `${typeof error === "string" ? `${error}: ` : ""}${responseDetail}`
        : typeof message === "string" ? message
          : typeof error === "string" ? error : undefined;
    }
  } catch {
    // Status metadata remains a useful bounded error when the body is not JSON.
  }
  const status = `${String(response.status)}${response.statusText === "" ? "" : ` ${response.statusText}`}`;
  return `Failed to load plugin manifest (${status})${detail === undefined ? "" : `: ${detail}`}`;
}

function parseBackendRevision(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  try {
    return requirePluginBackendRevision(value);
  } catch {
    throw new Error("Invalid plugin manifest entry");
  }
}

function parseBackendCapabilityVersion(value: unknown): 1 | undefined {
  if (value === undefined) return undefined;
  if (value !== 1) throw new Error("Invalid plugin manifest entry");
  return value;
}

function parseChannelVersion(value: unknown): 1 | undefined {
  if (value === undefined) return undefined;
  if (value !== 1) throw new Error("Invalid plugin manifest entry");
  return value;
}

function parseMachineSpecific(value: unknown): boolean {
  if (value === undefined) return false;
  if (typeof value !== "boolean") throw new Error("Invalid plugin manifest entry");
  return value;
}

function parsePluginModule(module: unknown, moduleUrl: string): PiWebPlugin {
  if (!isRecord(module)) throw new Error(`Plugin module ${moduleUrl} did not export an object`);
  const plugin = module["default"];
  if (isRecord(plugin) && plugin["apiVersion"] !== 2) {
    throw new Error(`Unsupported browser plugin API version for ${moduleUrl}: ${String(plugin["apiVersion"])} (expected 2)`);
  }
  if (!isPiWebPlugin(plugin)) throw new Error(`Plugin module ${moduleUrl} default export is not a PiWebPlugin`);
  return plugin;
}

function isPiWebPlugin(value: unknown): value is PiWebPlugin {
  return isRecord(value) && value["apiVersion"] === 2 && typeof value["name"] === "string" && typeof value["activate"] === "function";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
