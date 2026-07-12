import { machineScopedPluginId } from "../../../shared/machinePluginIds";
import type { PiWebPlugin, PiWebPluginRegistration } from "./types";

export interface PluginManifestEntry {
  id: string;
  module: string;
  machineSpecific: boolean;
}

interface PluginManifest {
  plugins: PluginManifestEntry[];
}

export interface LoadExternalPluginsOptions {
  machineId?: string;
  shouldLoadPlugin?: (entry: PluginManifestEntry) => boolean;
}

export async function loadExternalPlugins(manifestUrl = "pi-web-plugins/manifest.json", options: LoadExternalPluginsOptions = {}): Promise<PiWebPluginRegistration[]> {
  const manifest = await fetchPluginManifest(manifestUrl);
  if (manifest === undefined) return [];

  const registrations: PiWebPluginRegistration[] = [];
  for (const entry of manifest.plugins) {
    if (options.shouldLoadPlugin?.(entry) === false) continue;
    try {
      const moduleUrl = new URL(entry.module, new URL(manifestUrl, window.location.href)).toString();
      const module: unknown = await import(/* @vite-ignore */ moduleUrl);
      const plugin = parsePluginModule(module, moduleUrl);
      registrations.push({
        id: options.machineId === undefined ? entry.id : machineScopedPluginId(options.machineId, entry.id),
        plugin,
        machineSpecific: entry.machineSpecific,
        ...(options.machineId === undefined ? {} : { machineId: options.machineId, sourcePluginId: entry.id }),
      });
    } catch (error) {
      console.warn(`Failed to load PI WEB plugin ${entry.module}`, error);
    }
  }
  return registrations;
}

async function fetchPluginManifest(manifestUrl: string): Promise<PluginManifest | undefined> {
  const response = await fetch(manifestUrl, { cache: "no-store" });
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`Failed to load plugin manifest: ${response.statusText}`);
  return parseManifest(await response.json());
}

function parseManifest(value: unknown): PluginManifest {
  if (!isRecord(value) || !Array.isArray(value["plugins"])) throw new Error("Invalid plugin manifest");
  return {
    plugins: value["plugins"].map((entry) => {
      if (!isRecord(entry) || typeof entry["id"] !== "string" || entry["id"] === "" || typeof entry["module"] !== "string" || entry["module"] === "") throw new Error("Invalid plugin manifest entry");
      return { id: entry["id"], module: entry["module"], machineSpecific: parseMachineSpecific(entry["machineSpecific"]) };
    }),
  };
}

function parseMachineSpecific(value: unknown): boolean {
  if (value === undefined) return false;
  if (typeof value !== "boolean") throw new Error("Invalid plugin manifest entry");
  return value;
}

function parsePluginModule(module: unknown, moduleUrl: string): PiWebPlugin {
  if (!isRecord(module)) throw new Error(`Plugin module ${moduleUrl} did not export an object`);
  const plugin = module["default"];
  if (!isPiWebPlugin(plugin)) throw new Error(`Plugin module ${moduleUrl} default export is not a PiWebPlugin`);
  return plugin;
}

function isPiWebPlugin(value: unknown): value is PiWebPlugin {
  return isRecord(value) && value["apiVersion"] === 1 && typeof value["name"] === "string" && typeof value["activate"] === "function";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
