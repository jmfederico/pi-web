import type { PiWebThemeBootstrap, PiWebThemeCatalogResponse } from "../shared/themeCatalog.js";
import { DEFAULT_THEME_PREFERENCE } from "../shared/themePreference.js";
import type { PiWebThemePreference } from "../shared/apiTypes.js";
import type { PiWebThemeCatalog } from "./themeCatalog.js";

const STATIC_THEME_FALLBACK_PREFERENCE: PiWebThemePreference = { themeId: "themes:classic", auto: false };

export const THEME_BOOTSTRAP_MAX_BYTES = 2 * 1024 * 1024;
export const THEME_BOOTSTRAP_TIMEOUT_MS = 1000;

/** Never let theme discovery prevent delivery of the application shell. */
async function bounded<T>(operation: () => Promise<T>): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<undefined>((resolve) => { timer = setTimeout(() => { resolve(undefined); }, THEME_BOOTSTRAP_TIMEOUT_MS); }),
    ]);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

export function serializeThemeBootstrap(bootstrap: PiWebThemeBootstrap): string | undefined {
  const json = JSON.stringify(bootstrap).replace(/[<>&\u2028\u2029]/gu, (character) =>
    `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
  return Buffer.byteLength(json) <= THEME_BOOTSTRAP_MAX_BYTES ? json : undefined;
}

export function injectThemeBootstrap(html: string, bootstrap: PiWebThemeBootstrap | undefined): string {
  if (bootstrap === undefined) return html;
  const json = serializeThemeBootstrap(bootstrap);
  if (json === undefined) return html;
  return html.replace(/(<script\b[^>]*\bid=["']pi-web-theme-data["'][^>]*>)[\s\S]*?<\/script\s*>/iu,
    (_match, opening: string) => `${opening}${json}</script>`);
}

export function createThemeBootstrap(
  readCatalog: (preference?: PiWebThemePreference) => Promise<PiWebThemeCatalogResponse>,
  themes: Pick<PiWebThemeCatalog, "readAsset"> & Partial<Pick<PiWebThemeCatalog, "readCapturedAsset">>,
  requestedPreference?: PiWebThemePreference,
): Promise<PiWebThemeBootstrap | undefined> {
  return bounded(async () => {
    let fullCatalog = await readCatalog(requestedPreference);
    // This endpoint supplies data, not a preference mutation. Selection policy is
    // returned unchanged; explicit lookups must also work for fallback palettes.
    let preference = requestedPreference ?? fullCatalog.defaultTheme ?? DEFAULT_THEME_PREFERENCE;
    if (requestedPreference === undefined && !fullCatalog.themes.some((entry) => entry.id === preference.themeId)) {
      const fallback = await readCatalog(STATIC_THEME_FALLBACK_PREFERENCE);
      fullCatalog = { ...fullCatalog, themes: fallback.themes, themePairs: fallback.themePairs };
      preference = STATIC_THEME_FALLBACK_PREFERENCE;
    }
    const known = fullCatalog.themes.some((entry) => entry.id === preference.themeId);
    const pair = known ? fullCatalog.themePairs.find((entry) =>
      entry.light === preference.themeId || entry.dark === preference.themeId) : undefined;
    const selected = pair === undefined ? [preference.themeId] : [preference.themeId, pair.light, pair.dark];
    // Narrow metadata before serialization and budgeting: unrelated installed
    // themes must not grow the initial HTML or a targeted response.
    const catalog: PiWebThemeCatalogResponse = {
      ...fullCatalog,
      themes: fullCatalog.themes.filter((entry) => selected.includes(entry.id)),
      themePairs: pair === undefined ? [] : [pair],
    };
    const stylesheets: PiWebThemeBootstrap["stylesheets"] = [];
    let bytes = 0;
    for (const theme of catalog.themes) {
      // Pair metadata describes the theme independently of the current Auto
      // choice. Only preload the peer's CSS when this response uses Auto.
      if (!preference.auto && theme.id !== preference.themeId) continue;
      for (const sheet of theme.stylesheets) {
        if (stylesheets.some((entry) => entry.url === sheet.url)) continue;
        const match = /^pi-web-theme-assets\/([^/]+)\/revisions\/([^/]+)\/(.+)$/u.exec(sheet.url);
        if (match === null) throw new Error("Invalid theme asset URL");
        const pluginId = decodeURIComponent(match[1] ?? "");
        const path = (match[3] ?? "").split("/").map(decodeURIComponent).join("/");
        const revision = decodeURIComponent(match[2] ?? "");
        // The catalog already captured these exact revisions. Do not rediscover
        // every installed package once per CSS file while serving the same HTML.
        const asset = themes.readCapturedAsset?.(pluginId, path, revision) ?? await themes.readAsset(pluginId, path, revision);
        if (asset?.contentType.startsWith("text/css") !== true) throw new Error("Missing theme stylesheet");
        bytes += asset.content.byteLength;
        if (bytes > THEME_BOOTSTRAP_MAX_BYTES) throw new Error("Theme bootstrap too large");
        // Preserve source and its revision-qualified base URL for the browser compiler.
        stylesheets.push({ url: sheet.url, cssText: asset.content.toString("utf8") });
      }
    }
    const bootstrap = { catalog, stylesheets };
    return serializeThemeBootstrap(bootstrap) === undefined ? undefined : bootstrap;
  });
}

// The catalog itself comes from our backend; the browser owns catalog validation.
function isBootstrapEnvelope(value: unknown): value is PiWebThemeBootstrap {
  return typeof value === "object" && value !== null && "catalog" in value
    && typeof value.catalog === "object" && value.catalog !== null
    && "themes" in value.catalog && Array.isArray(value.catalog.themes)
    && "themePairs" in value.catalog && Array.isArray(value.catalog.themePairs)
    && "stylesheets" in value && Array.isArray(value.stylesheets)
    && value.stylesheets.every((sheet: unknown) => typeof sheet === "object" && sheet !== null
      && "url" in sheet && typeof sheet.url === "string" && "cssText" in sheet && typeof sheet.cssText === "string");
}

/** Vite's server-to-server request; the browser never requests this endpoint. */
export function fetchThemeBootstrap(url: string): Promise<PiWebThemeBootstrap | undefined> {
  return bounded(async () => {
    const response = await fetch(url, { signal: AbortSignal.timeout(THEME_BOOTSTRAP_TIMEOUT_MS) });
    if (!response.ok || response.body === null) return undefined;
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > THEME_BOOTSTRAP_MAX_BYTES) return undefined;
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    const data: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return isBootstrapEnvelope(data) ? data : undefined;
  });
}
