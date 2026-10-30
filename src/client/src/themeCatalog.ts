import { request } from "./api/http";
import { resolveAppUrl } from "./appUrl";
import type { QualifiedThemeContribution, QualifiedThemePairContribution } from "./plugins/types";
import { effectiveThemePreference, type ThemePreference } from "./theme";
import type { PiWebThemeBootstrap, PiWebThemeCatalogResponse } from "../../shared/themeCatalog";

export interface BrowserThemeCatalog extends Pick<PiWebThemeCatalogResponse, "defaultTheme" | "enforcedBy"> {
  themes: QualifiedThemeContribution[];
  themePairs: QualifiedThemePairContribution[];
}

export interface BrowserThemeBootstrap extends Omit<PiWebThemeBootstrap, "catalog"> {
  catalog: BrowserThemeCatalog;
}

/** Read the server's response without an additional browser request. */
export function readInitialThemeBootstrap(document: Document): BrowserThemeBootstrap | undefined {
  const source = document.getElementById("pi-web-theme-data")?.textContent.trim();
  if (source === undefined || source === "") return undefined;
  try {
    return parseThemeBootstrap(JSON.parse(source));
  } catch (error) {
    console.warn("Could not read initial theme data; requesting the default theme instead", error);
    return undefined;
  }
}

export function parseThemeBootstrap(value: unknown): BrowserThemeBootstrap {
  const input = record(value);
  const catalog = parseThemeCatalog(input["catalog"]);
  const declaredUrls = new Set(catalog.themes.flatMap((theme) => (theme.stylesheets ?? []).map(({ url }) => url)));
  const seen = new Set<string>();
  const stylesheets = list(input["stylesheets"]).map((entry) => {
    const stylesheet = record(entry);
    const url = resolveAppUrl(text(stylesheet["url"]));
    const cssText = stylesheet["cssText"];
    if (typeof cssText !== "string" || !declaredUrls.has(url) || seen.has(url)) throw new Error("Invalid delivered theme stylesheet");
    seen.add(url);
    return { url, cssText };
  });
  return { catalog, stylesheets };
}

export function loadDefaultThemeBootstrap(): Promise<BrowserThemeBootstrap> {
  return request("api/theme-bootstrap", parseThemeBootstrap, { timeoutMs: 10_000 });
}

export function loadThemeBootstrap(preference: ThemePreference, signal?: AbortSignal): Promise<BrowserThemeBootstrap> {
  const query = new URLSearchParams({ themeId: preference.themeId, auto: String(preference.auto) });
  return request(`api/theme?${query.toString()}`, parseThemeBootstrap, { timeoutMs: 10_000, ...(signal === undefined ? {} : { signal }) });
}

export function bootstrapPreference(catalog: BrowserThemeCatalog, local: ThemePreference | undefined): ThemePreference {
  return effectiveThemePreference(local, catalog.defaultTheme, {
    defaultPreference: catalog.defaultTheme, enforcedBy: catalog.enforcedBy, source: undefined,
  });
}

export function mergeThemeCatalog(previous: BrowserThemeCatalog, incoming: BrowserThemeCatalog): BrowserThemeCatalog {
  const themes = new Map(previous.themes.map((theme) => [theme.id, theme]));
  const pairs = new Map(previous.themePairs.map((pair) => [pair.id, pair]));
  for (const theme of incoming.themes) themes.set(theme.id, theme);
  for (const pair of incoming.themePairs) pairs.set(pair.id, pair);
  return { ...incoming, themes: [...themes.values()], themePairs: [...pairs.values()] };
}

/** The complete inventory is needed only by the theme picker. */
export function loadThemeCatalog(): Promise<BrowserThemeCatalog> {
  return request("api/themes", parseThemeCatalog, { timeoutMs: 10_000 });
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Invalid theme catalog object");
  return value;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function text(value: unknown): string {
  if (typeof value !== "string" || value === "") throw new Error("Invalid theme catalog string");
  return value;
}
function qualified(value: unknown): `${string}:${string}` {
  const id = text(value);
  const colon = id.indexOf(":");
  if (colon < 1 || colon === id.length - 1) throw new Error("Invalid qualified theme ID");
  return `${id.slice(0, colon)}:${id.slice(colon + 1)}`;
}
function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("Invalid theme catalog list");
  return value;
}

export function parseThemeCatalog(value: unknown): BrowserThemeCatalog {
  const input = record(value);
  const themes = list(input["themes"]).map((entry): QualifiedThemeContribution => {
    const item = record(entry);
    const id = qualified(item["id"]);
    const pluginId = text(item["pluginId"]);
    const colorScheme = item["colorScheme"];
    if (colorScheme !== "light" && colorScheme !== "dark") throw new Error("Invalid theme color scheme");
    return {
      id, pluginId, localId: id.slice(pluginId.length + 1), name: text(item["name"]), colorScheme,
      ...(typeof item["description"] === "string" ? { description: item["description"] } : {}),
      ...(typeof item["order"] === "number" ? { order: item["order"] } : {}),
      stylesheets: list(item["stylesheets"]).map((entry) => {
        const stylesheet = record(entry);
        return {
          id: qualified(stylesheet["id"]), url: resolveAppUrl(text(stylesheet["url"])),
          ...(typeof stylesheet["order"] === "number" ? { order: stylesheet["order"] } : {}),
        };
      }),
    };
  });
  const themePairs = list(input["themePairs"]).map((entry): QualifiedThemePairContribution => {
    const item = record(entry);
    const id = qualified(item["id"]);
    const pluginId = text(item["pluginId"]);
    return {
      id, pluginId, localId: id.slice(pluginId.length + 1), name: text(item["name"]),
      light: qualified(item["light"]), dark: qualified(item["dark"]),
      ...(typeof item["description"] === "string" ? { description: item["description"] } : {}),
      ...(typeof item["order"] === "number" ? { order: item["order"] } : {}),
    };
  });
  const defaultValue = input["defaultTheme"];
  let defaultTheme: ThemePreference | undefined;
  if (defaultValue !== undefined) {
    const preference = record(defaultValue);
    if (typeof preference["auto"] !== "boolean") throw new Error("Invalid theme Auto preference");
    defaultTheme = { themeId: qualified(preference["themeId"]), auto: preference["auto"] };
  }
  return { themes, themePairs, ...(defaultTheme === undefined ? {} : { defaultTheme }), ...(typeof input["enforcedBy"] === "string" ? { enforcedBy: input["enforcedBy"] } : {}) };
}
