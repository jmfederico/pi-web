import type { QualifiedContributionId, QualifiedThemeContribution, QualifiedThemePairContribution } from "./plugins/types";

import type { PiWebConfigResponse, PiWebThemePreference } from "../../shared/apiTypes";
import { DEFAULT_THEME_PREFERENCE, parseThemePreference } from "../../shared/themePreference";
export { DEFAULT_THEME_PREFERENCE } from "../../shared/themePreference";

export type ThemePreference = PiWebThemePreference;

export interface ResolveThemePreferenceOptions {
  themes: readonly QualifiedThemeContribution[];
  themePairs: readonly QualifiedThemePairContribution[];
  preference: ThemePreference;
  prefersLight: boolean;
  fallbackThemeId?: QualifiedContributionId;
  /** Discovery has not finished; an absent preference is not unavailable yet. */
  pending?: boolean;
}

export interface ThemePreferenceResolution {
  selectedTheme: QualifiedThemeContribution | undefined;
  activeTheme: QualifiedThemeContribution | undefined;
  selectedThemePair: QualifiedThemePairContribution | undefined;
  fallbackTheme: QualifiedThemeContribution | undefined;
}

export const CLASSIC_THEME_ID: QualifiedContributionId = "themes:classic";
export const THEME_STORAGE_KEY = "pi-web-app-theme";

export interface ThemePolicy {
  defaultPreference: ThemePreference | undefined;
  enforcedBy: string | undefined;
  source: string | undefined;
}

let themePolicy: ThemePolicy = { defaultPreference: undefined, enforcedBy: undefined, source: undefined };

/** Apply a gateway response without changing the saved device preference. */
export function configureThemePolicy(response: Pick<PiWebConfigResponse, "effectiveConfig" | "enforcedSettings" | "configSources">): void {
  themePolicy = {
    defaultPreference: response.effectiveConfig.defaultTheme === undefined ? undefined : { ...response.effectiveConfig.defaultTheme },
    enforcedBy: response.enforcedSettings?.["/defaultTheme"],
    source: response.configSources?.["/defaultTheme"],
  };
}

export function getThemePolicy(): ThemePolicy {
  return { ...themePolicy, defaultPreference: themePolicy.defaultPreference === undefined ? undefined : { ...themePolicy.defaultPreference } };
}

export function readStoredThemePreference(): ThemePreference | undefined {
  try {
    const value = window.localStorage.getItem(THEME_STORAGE_KEY);
    return value === null ? undefined : parseThemePreference(JSON.parse(value));
  } catch {
    return undefined;
  }
}

export function writeStoredThemePreference(preference: ThemePreference): void {
  if (themePolicy.enforcedBy !== undefined) return;
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify(preference));
  } catch {
    // Ignore storage failures; the selected theme can still apply for this tab.
  }
}

export function clearStoredThemePreference(): void {
  if (themePolicy.enforcedBy !== undefined) return;
  try {
    window.localStorage.removeItem(THEME_STORAGE_KEY);
  } catch {
    // As with saving, following the default can still apply for this tab.
  }
}

export function effectiveThemePreference(local: ThemePreference | undefined, configuredDefault: ThemePreference | undefined, policy: ThemePolicy = themePolicy): ThemePreference {
  if (policy.enforcedBy !== undefined) return policy.defaultPreference ?? DEFAULT_THEME_PREFERENCE;
  return local ?? configuredDefault ?? policy.defaultPreference ?? DEFAULT_THEME_PREFERENCE;
}

// Preserve the released v4 palette allowlist without turning tokens into a v5 API.
const legacyThemeTokens = [
  "--pi-bg", "--pi-surface", "--pi-surface-hover", "--pi-terminal-bg", "--pi-terminal-text",
  "--pi-border", "--pi-border-muted", "--pi-text", "--pi-text-secondary", "--pi-text-bright",
  "--pi-muted", "--pi-dim", "--pi-accent", "--pi-accent-border", "--pi-selection-bg",
  "--pi-success", "--pi-success-border", "--pi-success-bg", "--pi-success-surface", "--pi-success-ring",
  "--pi-warning", "--pi-warning-border", "--pi-warning-surface", "--pi-danger",
  "--pi-purple", "--pi-purple-border", "--pi-purple-surface", "--pi-overlay",
  "--pi-shadow-soft", "--pi-shadow", "--pi-shadow-strong", "--pi-bg-overlay-soft", "--pi-bg-overlay",
  "--pi-success-bg-overlay", "--pi-terminal-selection",
] as const;

export function clearPiWebTheme(): void {
  const root = document.documentElement;
  delete root.dataset["piWebTheme"];
  root.style.removeProperty("color-scheme");
  for (const token of legacyThemeTokens) root.style.removeProperty(token);
  syncThemeColor();
}

export function applyPiWebTheme(theme: QualifiedThemeContribution): void {
  const root = document.documentElement;
  root.dataset["piWebTheme"] = theme.id;
  root.style.colorScheme = theme.colorScheme;
  for (const token of legacyThemeTokens) {
    const value = theme.tokens?.[token];
    if (value === undefined) root.style.removeProperty(token);
    else root.style.setProperty(token, value);
  }
  syncThemeColor();
}

function syncThemeColor(): void {
  const root = document.documentElement;
  const metas = [...document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')];
  // Before a theme commits, let the browser choose its own chrome colour.
  if (root.dataset["piWebTheme"] === undefined) {
    for (const meta of metas) meta.remove();
    return;
  }
  // Called only after palette adoption, so browser chrome follows the committed CSS.
  const background = getComputedStyle(root).getPropertyValue("--pi-bg").trim();
  if (background === "") return;
  if (metas.length === 0) {
    const meta = document.createElement("meta");
    meta.name = "theme-color";
    document.head.append(meta);
    metas.push(meta);
  }
  for (const meta of metas) meta.content = background;
}

export function resolveThemePreference(options: ResolveThemePreferenceOptions): ThemePreferenceResolution {
  const fallbackTheme = findFallbackTheme(options.themes, options.fallbackThemeId ?? CLASSIC_THEME_ID);
  const selectedTheme = options.themes.find((candidate) => candidate.id === options.preference.themeId) ?? (options.pending === true ? undefined : fallbackTheme);
  if (selectedTheme === undefined) {
    return { selectedTheme: undefined, activeTheme: undefined, selectedThemePair: undefined, fallbackTheme };
  }
  const selectedThemePair = findThemePairForTheme(options.themePairs, selectedTheme.id);
  if (!options.preference.auto || selectedThemePair === undefined) {
    return { selectedTheme, activeTheme: selectedTheme, selectedThemePair, fallbackTheme };
  }
  const activeThemeId = options.prefersLight ? selectedThemePair.light : selectedThemePair.dark;
  const activeTheme = options.themes.find((candidate) => candidate.id === activeThemeId) ?? selectedTheme;
  return { selectedTheme, activeTheme, selectedThemePair, fallbackTheme };
}

export function findFallbackTheme(themes: readonly QualifiedThemeContribution[], fallbackThemeId: QualifiedContributionId = CLASSIC_THEME_ID): QualifiedThemeContribution | undefined {
  return themes.find((candidate) => candidate.id === fallbackThemeId) ?? themes[0];
}

export function findThemePairForTheme(themePairs: readonly QualifiedThemePairContribution[], themeId: QualifiedContributionId): QualifiedThemePairContribution | undefined {
  return themePairs.find((pair) => pair.light === themeId || pair.dark === themeId);
}
