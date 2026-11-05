import type { PiWebConfigValues } from "./apiTypes.js";

/** Core file settings and the environment syntax accepted for their top-level inputs. */
export const PI_WEB_CONFIG_DEFINITIONS = {
  installationName: "string", host: "string", port: "number", allowedHosts: "allowedHosts",
  shortcuts: "json", defaultTheme: "json", defaultLocalization: "json",
  defaultStreamingBehavior: "string", quietMode: "boolean", plugins: "json",
  basePaths: "json", pathAccess: "json", uploads: "json", attachments: "json",
  maxUploadBytes: "number", sessionArchive: "json",
  spawnSessions: "boolean", sessionMessages: "boolean", subsessions: "boolean", askUser: "boolean",
  environmentFacts: "boolean", extensionDialogsTimeoutMs: "number",
} as const satisfies Record<Exclude<keyof PiWebConfigValues, "agent">, string>;

/** Add fields here when container schemas grow: resolution, enforcement and resets share this list. */
const PI_WEB_CONFIG_NAMESPACES = {
  defaultLocalization: ["language", "formatLocale", "timeZone", "hourCycle"],
  uploads: ["defaultFolder"],
  attachments: ["defaultFolder"],
  sessionArchive: ["directory"],
  pathAccess: ["allowedPaths"],
} as const satisfies { [Key in keyof PiWebConfigValues]?: readonly (keyof NonNullable<PiWebConfigValues[Key]>)[] };

export function piWebConfigNamespaceFields(key: string): readonly string[] | undefined {
  return Object.entries(PI_WEB_CONFIG_NAMESPACES).find(([name]) => name === key)?.[1];
}

export function isPiWebConfigNamespacePath(segments: readonly string[]): boolean {
  const [root] = segments;
  if (root === undefined) return false;
  if (segments.length === 1) return root === "plugins" || piWebConfigNamespaceFields(root) !== undefined;
  return root === "plugins" && (segments.length === 2 || segments.length === 3 && segments[2] === "settings");
}

export function piWebConfigEnvName(key: string): string {
  return `PI_WEB_${key.replace(/[A-Z]/g, (letter) => `_${letter}`).toUpperCase()}`;
}

export function parsePiWebEnvBoolean(value: string, source: string): boolean {
  if (/^(true|1)$/i.test(value)) return true;
  if (/^(false|0)$/i.test(value)) return false;
  throw new Error(`${source} must be true, false, 1, or 0`);
}

function suppliedValues(value: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, setting]) => setting !== undefined));
}

/** Resolve declared container fields independently; individual setting values replace. */
export function overlayPiWebConfig(base: PiWebConfigValues, override: PiWebConfigValues): PiWebConfigValues {
  const result = { ...base, ...suppliedValues(override) };
  for (const key of Object.keys(PI_WEB_CONFIG_NAMESPACES)) {
    const next: unknown = Object.getOwnPropertyDescriptor(override, key)?.value;
    if (!isRecord(next)) continue;
    const previous: unknown = Object.getOwnPropertyDescriptor(base, key)?.value;
    Object.defineProperty(result, key, { value: { ...(isRecord(previous) ? previous : {}), ...suppliedValues(next) }, enumerable: true, configurable: true, writable: true });
  }
  if (override.plugins !== undefined) {
    result.plugins = { ...base.plugins };
    for (const [id, plugin] of Object.entries(override.plugins)) {
      const previous = base.plugins?.[id];
      result.plugins[id] = { ...previous, ...suppliedValues(plugin),
        ...(plugin.settings !== undefined ? { settings: { ...previous?.settings, ...suppliedValues(plugin.settings) } } : {}),
      };
    }
  }
  return result;
}

export function escapeConfigPointerSegment(value: string): string {
  return value.replace(/~/g, "~0").replace(/\//g, "~1");
}

/** Enumerate independent setting identifiers; object-valued settings stay atomic. */
export function piWebConfigSettingPointers(config: PiWebConfigValues): string[] {
  const pointers: string[] = [];
  for (const [key, value] of Object.entries(config)) {
    if (value === undefined) continue;
    const fields = piWebConfigNamespaceFields(key);
    if (fields !== undefined && isRecord(value)) {
      for (const field of fields) {
        if (Object.getOwnPropertyDescriptor(value, field)?.value !== undefined) pointers.push(`/${key}/${escapeConfigPointerSegment(field)}`);
      }
    } else if (key === "plugins") {
      for (const [id, plugin] of Object.entries(config.plugins ?? {})) {
        const prefix = `/plugins/${escapeConfigPointerSegment(id)}`;
        if (plugin.enabled !== undefined) pointers.push(`${prefix}/enabled`);
        for (const setting of Object.keys(suppliedValues(plugin.settings ?? {}))) pointers.push(`${prefix}/settings/${escapeConfigPointerSegment(setting)}`);
      }
    } else {
      pointers.push(`/${key}`);
    }
  }
  return pointers;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
