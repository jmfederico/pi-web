import { describe, expect, it } from "vitest";
import { CLASSIC_THEME_ID, DEFAULT_THEME_PREFERENCE, effectiveThemePreference, findThemePairForTheme, resolveThemePreference } from "./theme";
import type { QualifiedContributionId, QualifiedThemeContribution, QualifiedThemePairContribution, ThemeColorScheme, ThemeTokens } from "./plugins/types";

const tokens = {
  "--pi-bg": "#000000",
  "--pi-surface": "#000000",
  "--pi-surface-hover": "#000000",
  "--pi-terminal-bg": "#000000",
  "--pi-terminal-text": "#000000",
  "--pi-border": "#000000",
  "--pi-border-muted": "#000000",
  "--pi-text": "#000000",
  "--pi-text-secondary": "#000000",
  "--pi-text-bright": "#000000",
  "--pi-muted": "#000000",
  "--pi-dim": "#000000",
  "--pi-accent": "#000000",
  "--pi-accent-border": "#000000",
  "--pi-selection-bg": "#000000",
  "--pi-success": "#000000",
  "--pi-success-border": "#000000",
  "--pi-success-bg": "#000000",
  "--pi-success-surface": "#000000",
  "--pi-success-ring": "#000000",
  "--pi-warning": "#000000",
  "--pi-warning-border": "#000000",
  "--pi-warning-surface": "#000000",
  "--pi-danger": "#000000",
  "--pi-purple": "#000000",
  "--pi-purple-border": "#000000",
  "--pi-purple-surface": "#000000",
  "--pi-overlay": "#000000",
  "--pi-shadow-soft": "#000000",
  "--pi-shadow": "#000000",
  "--pi-shadow-strong": "#000000",
  "--pi-bg-overlay-soft": "#000000",
  "--pi-bg-overlay": "#000000",
  "--pi-success-bg-overlay": "#000000",
  "--pi-terminal-selection": "#000000",
} satisfies ThemeTokens;

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

  it("falls back to Classic when the selected theme does not exist", () => {
    const resolution = resolveThemePreference({
      themes,
      themePairs,
      preference: { themeId: "plugin:missing", auto: false },
      prefersLight: true,
    });

    expect(resolution.selectedTheme?.id).toBe("themes:classic");
    expect(resolution.activeTheme?.id).toBe("themes:classic");
  });

  it("falls back to Classic without mutating a missing selected theme preference", () => {
    const preference = {
      themeId: "plugin:missing",
      auto: true,
    } satisfies { themeId: QualifiedContributionId; auto: boolean };
    const resolution = resolveThemePreference({
      themes,
      themePairs,
      preference,
      prefersLight: false,
    });

    expect(resolution.selectedTheme?.id).toBe("themes:classic");
    expect(resolution.activeTheme?.id).toBe("themes:classic");
    expect(preference).toEqual({ themeId: "plugin:missing", auto: true });
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
    tokens,
  };
}
