import { describe, expect, it } from "vitest";
import { parseThemePreference, requireDefaultThemePreference } from "./themePreference.js";

describe("theme preference data", () => {
  it("accepts qualified builtin and plugin themes without requiring them to be installed", () => {
    for (const themeId of ["themes:pi-web-dark", "acme.themes:night"]) {
      expect(requireDefaultThemePreference({ themeId, auto: false }, "test")).toEqual({ themeId, auto: false });
    }
  });

  it.each([null, [], "dark", {}, { themeId: "dark", auto: true }, { themeId: "themes:dark" }, { themeId: "themes:dark", auto: "yes" }])("rejects invalid preferences: %j", (value) => {
    expect(parseThemePreference(value)).toBeUndefined();
    expect(() => requireDefaultThemePreference(value, "config.json")).toThrow("PI WEB config defaultTheme must contain a qualified themeId and a boolean auto: config.json");
  });
});
