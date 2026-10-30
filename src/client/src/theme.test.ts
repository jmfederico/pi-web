import { afterEach, describe, expect, it, vi } from "vitest";
import { CLASSIC_THEME_ID, DEFAULT_THEME_PREFERENCE, THEME_STORAGE_KEY, clearStoredThemePreference, configureThemePolicy, effectiveThemePreference, findThemePairForTheme, getThemePolicy, readStoredThemePreference, resolveThemePreference, writeStoredThemePreference } from "./theme";

afterEach(() => {
  configureThemePolicy({ effectiveConfig: {} });
  vi.unstubAllGlobals();
});
import type { QualifiedContributionId, QualifiedThemeContribution, QualifiedThemePairContribution, ThemeColorScheme } from "./plugins/types";

const themes = [
  theme("pi-web-dark", "PI WEB Dark", "dark"),
  theme("pi-web-light", "PI WEB Light", "light"),
  theme("classic", "PI WEB Classic", "dark"),
];

const themePairs: QualifiedThemePairContribution[] = [
  {
    id: "themes:pi-web",
    pluginId: "themes",
    localId: "pi-web",
    name: "PI WEB",
    light: "themes:pi-web-light",
    dark: "themes:pi-web-dark",
  },
];

describe("effectiveThemePreference", () => {
  const configured = { themeId: "themes:pi-web-light", auto: false };
  it("uses the built-in default when neither config nor a device choice exists", () => {
    expect(effectiveThemePreference(undefined, undefined)).toBe(DEFAULT_THEME_PREFERENCE);
  });
  it("uses the configured default without creating a device choice", () => {
    expect(effectiveThemePreference(undefined, configured)).toBe(configured);
  });
  it("keeps the entire device preference ahead of config, including Auto", () => {
    const local = { themeId: "themes:classic", auto: true };
    expect(effectiveThemePreference(local, configured)).toBe(local);
  });
});

describe("theme deployment policy", () => {
  it("enforces the whole theme preference and preserves storage through refresh, reset attempts and unlock", () => {
    const local = { themeId: "themes:classic", auto: true };
    let stored: string | null = JSON.stringify(local);
    const setItem = vi.fn((_key: string, value: string) => { stored = value; });
    const removeItem = vi.fn(() => { stored = null; });
    vi.stubGlobal("window", { localStorage: { getItem: () => stored, setItem, removeItem } });
    const enforced = { themeId: "themes:pi-web-light", auto: false };
    configureThemePolicy({ effectiveConfig: { defaultTheme: enforced }, enforcedSettings: { "/defaultTheme": "PI_WEB_DEFAULT_THEME" }, configSources: { "/defaultTheme": "environment" } });
    expect(getThemePolicy()).toEqual({ defaultPreference: enforced, enforcedBy: "PI_WEB_DEFAULT_THEME", source: "environment" });
    expect(effectiveThemePreference(readStoredThemePreference(), local)).toEqual(enforced);
    writeStoredThemePreference(enforced);
    clearStoredThemePreference();
    expect(readStoredThemePreference()).toEqual(local);
    expect(setItem).not.toHaveBeenCalled();
    expect(removeItem).not.toHaveBeenCalled();
    configureThemePolicy({ effectiveConfig: { defaultTheme: { ...enforced, auto: true } }, enforcedSettings: { "/defaultTheme": "PI_WEB_DEFAULT_THEME" } });
    expect(effectiveThemePreference(local, undefined)).toEqual({ ...enforced, auto: true });
    configureThemePolicy({ effectiveConfig: { defaultTheme: enforced } });
    expect(effectiveThemePreference(readStoredThemePreference(), enforced)).toEqual(local);
    clearStoredThemePreference();
    expect(removeItem).toHaveBeenCalledWith(THEME_STORAGE_KEY);
  });
});

describe("resolveThemePreference", () => {
  it("resolves the default auto preference to the dark member when the system is dark", () => {
    expect(resolveThemePreference({ themes, themePairs, preference: DEFAULT_THEME_PREFERENCE, prefersLight: false }).activeTheme?.id)
      .toBe("themes:pi-web-dark");
  });

  it("resolves the default auto preference to the light member when the system is light", () => {
    expect(resolveThemePreference({ themes, themePairs, preference: DEFAULT_THEME_PREFERENCE, prefersLight: true }).activeTheme?.id)
      .toBe("themes:pi-web-light");
  });

  it("keeps an unpaired theme selected when auto is enabled", () => {
    const resolution = resolveThemePreference({
      themes,
      themePairs,
      preference: { themeId: CLASSIC_THEME_ID, auto: true },
      prefersLight: true,
    });

    expect(resolution.selectedTheme?.id).toBe("themes:classic");
    expect(resolution.activeTheme?.id).toBe("themes:classic");
    expect(resolution.selectedThemePair).toBeUndefined();
  });

  it.each([false, true])("falls back to Classic without mutating a missing theme preference (auto: %s)", (auto) => {
    const preference = {
      themeId: "plugin:missing",
      auto,
    } satisfies { themeId: QualifiedContributionId; auto: boolean };
    const resolution = resolveThemePreference({
      themes,
      themePairs,
      preference,
      prefersLight: false,
    });

    expect(resolution.selectedTheme?.id).toBe("themes:classic");
    expect(resolution.activeTheme?.id).toBe("themes:classic");
    expect(preference).toEqual({ themeId: "plugin:missing", auto });
  });

  it("waits for discovery before classifying a missing theme as unavailable", () => {
    const preference = { themeId: "themes:custom", auto: false };
    const options = { themes, themePairs, preference, prefersLight: true };
    expect(resolveThemePreference({ ...options, pending: true }).activeTheme).toBeUndefined();
    expect(resolveThemePreference({ ...options, pending: false }).activeTheme?.id).toBe(CLASSIC_THEME_ID);
    expect(resolveThemePreference({ ...options, themes: [...themes, theme("custom", "Custom", "light")], pending: true }).activeTheme?.id).toBe("themes:custom");
    expect(preference).toEqual({ themeId: "themes:custom", auto: false });
  });

  it("re-resolves a plugin default after its theme becomes available without changing the preference", () => {
    const preference = { themeId: "themes:custom", auto: false };
    expect(resolveThemePreference({ themes, themePairs, preference, prefersLight: true }).activeTheme?.id).toBe(CLASSIC_THEME_ID);
    expect(resolveThemePreference({ themes: [...themes, theme("custom", "Custom", "dark")], themePairs, preference, prefersLight: true }).activeTheme?.id).toBe("themes:custom");
    expect(preference).toEqual({ themeId: "themes:custom", auto: false });
  });

  it("keeps a paired theme fixed when Auto is off", () => {
    expect(resolveThemePreference({ themes, themePairs, preference: { themeId: "themes:pi-web-dark", auto: false }, prefersLight: true }).activeTheme?.id).toBe("themes:pi-web-dark");
  });

  it("can look up a pair from either member theme", () => {
    expect(findThemePairForTheme(themePairs, "themes:pi-web-light")?.id).toBe("themes:pi-web");
    expect(findThemePairForTheme(themePairs, "themes:pi-web-dark")?.id).toBe("themes:pi-web");
  });
});

function theme(localId: string, name: string, colorScheme: ThemeColorScheme): QualifiedThemeContribution {
  return {
    id: `themes:${localId}`,
    pluginId: "themes",
    localId,
    name,
    colorScheme,
  };
}
