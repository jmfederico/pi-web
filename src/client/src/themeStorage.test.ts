// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import { clearStoredThemePreference, readStoredThemePreference, THEME_STORAGE_KEY, writeStoredThemePreference } from "./theme";

afterEach(() => { localStorage.clear(); });

describe("device theme storage", () => {
  it("preserves existing theme/Auto preferences and removes them when following the default", () => {
    const local = { themeId: "themes:classic", auto: false };
    writeStoredThemePreference(local);
    expect(readStoredThemePreference()).toEqual(local);
    clearStoredThemePreference();
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
    expect(readStoredThemePreference()).toBeUndefined();
  });

  it.each(["not json", "{}", JSON.stringify({ themeId: "dark", auto: true })])("treats invalid stored data as no override: %s", (stored) => {
    localStorage.setItem(THEME_STORAGE_KEY, stored);
    expect(readStoredThemePreference()).toBeUndefined();
  });
});
