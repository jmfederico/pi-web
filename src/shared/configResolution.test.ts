import { describe, expect, it } from "vitest";
import { escapeConfigPointerSegment, isPiWebConfigNamespacePath, overlayPiWebConfig, piWebConfigSettingPointers } from "./configResolution.js";

describe("configuration namespace identifiers", () => {
  it("escapes plugin IDs and top-level plugin setting keys without interpreting dots", () => {
    expect(escapeConfigPointerSegment("plugin~/id")).toBe("plugin~0~1id");
    expect(piWebConfigSettingPointers({
      plugins: { "plugin~/id": { enabled: false, settings: { "a.b~/c": { nested: true } } } },
      defaultLocalization: { language: "de" }, defaultTheme: { themeId: "themes:light", auto: false },
      pathAccess: { allowedPaths: [] }, sessionMessages: false,
    })).toEqual([
      "/plugins/plugin~0~1id/enabled", "/plugins/plugin~0~1id/settings/a.b~0~1c",
      "/defaultLocalization/language", "/defaultTheme", "/pathAccess/allowedPaths", "/sessionMessages",
    ]);
  });

  it("keeps empty namespace containers from masking independent inherited leaves", () => {
    const base = { plugins: { git: { enabled: false, settings: { value: { a: 1 } } }, other: { enabled: true } }, defaultLocalization: { language: "de" } };
    expect(overlayPiWebConfig(base, { plugins: {}, defaultLocalization: {} })).toEqual(base);
    expect(overlayPiWebConfig(base, { plugins: { git: { settings: {} } } })).toEqual(base);
    expect(piWebConfigSettingPointers({ plugins: { git: { settings: {} } }, defaultLocalization: {} })).toEqual([]);
  });

  it("resolves declared container fields independently without merging setting values", () => {
    const base = {
      uploads: { defaultFolder: "deployed" }, attachments: { defaultFolder: "attachments" },
      sessionNaming: { model: "provider/model", maxTokens: 48, timeoutMs: 12000 },
      sessionArchive: { directory: "/archive" }, pathAccess: { allowedPaths: ["/base"] },
      shortcuts: { first: "a", second: "b" },
      plugins: { git: { settings: { options: { old: true }, list: [1, 2] } } },
    };
    expect(overlayPiWebConfig(base, {
      uploads: {}, attachments: {}, sessionArchive: {}, sessionNaming: { maxTokens: 64 },
      pathAccess: { allowedPaths: [] }, shortcuts: { first: "c" },
      plugins: { git: { settings: { options: {}, list: [] } } },
    })).toEqual({
      ...base, sessionNaming: { model: "provider/model", maxTokens: 64, timeoutMs: 12000 },
      pathAccess: { allowedPaths: [] }, shortcuts: { first: "c" },
      plugins: { git: { settings: { options: {}, list: [] } } },
    });
    expect(piWebConfigSettingPointers({ uploads: {}, attachments: {}, sessionNaming: {}, sessionArchive: {}, pathAccess: {} })).toEqual([]);
    expect(piWebConfigSettingPointers({ uploads: base.uploads, attachments: base.attachments, sessionNaming: { maxTokens: 64 }, sessionArchive: base.sessionArchive, pathAccess: { allowedPaths: [] } })).toEqual([
      "/uploads/defaultFolder", "/attachments/defaultFolder", "/sessionNaming/maxTokens", "/sessionArchive/directory", "/pathAccess/allowedPaths",
    ]);
  });

  it("recognizes only schema-declared containers, not arbitrary object settings", () => {
    expect(isPiWebConfigNamespacePath(["sessionNaming"])).toBe(true);
    expect(isPiWebConfigNamespacePath(["uploads"])).toBe(true);
    expect(isPiWebConfigNamespacePath(["plugins", "git", "settings"])).toBe(true);
    expect(isPiWebConfigNamespacePath(["plugins", "git", "settings", "options"])).toBe(false);
    expect(isPiWebConfigNamespacePath(["defaultTheme"])).toBe(false);
    expect(isPiWebConfigNamespacePath(["shortcuts"])).toBe(false);
  });

  it("keeps the deprecated agent namespace atomic instead of expanding Pi-owned settings", () => {
    expect(overlayPiWebConfig({ agent: { command: "old", dir: "/old" } }, { agent: { dir: "/new" } }).agent).toEqual({ dir: "/new" });
  });
});
