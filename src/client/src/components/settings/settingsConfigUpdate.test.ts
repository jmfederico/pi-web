import { describe, expect, it } from "vitest";
import { enforcedSetting, explicitConfigUpdate, mergeSelectedSettingsResponse, resetConfigUpdate, settingPath } from "./settingsConfigUpdate";
import type { PiWebConfigResponse } from "../../api";

function response(): PiWebConfigResponse {
  return { path: "/config.json", exists: true, config: { host: "saved", quietMode: true }, effectiveConfig: { host: "env", port: 9000, quietMode: true }, envOverrides: { host: true, port: false, allowedHosts: false, spawnSessions: false, subsessions: false, sessionMessages: false, askUser: false }, enforcedSettings: { "/host": "PI_WEB_HOST" } };
}

describe("explicit Settings updates", () => {
  it("omits unchanged defaults and enforced values, preserving hidden saved overrides", () => {
    const snapshot = response();
    expect(explicitConfigUpdate(snapshot, { ...snapshot.effectiveConfig, quietMode: false }, snapshot.effectiveConfig)).toEqual({ set: { quietMode: false } });
    expect(snapshot.config.host).toBe("saved");
    expect(resetConfigUpdate(snapshot, ["/host", "/quietMode", "/port"])).toEqual({ unset: ["/quietMode"] });
  });

  it("targets supplied namespace leaves only, with escaped opaque plugin IDs and setting names", () => {
    const snapshot = response();
    const id = "plugin/with~dots.v1";
    const key = "object/setting~";
    snapshot.config = { plugins: { [id]: { enabled: true, settings: { [key]: { old: true }, sibling: 1 } } }, defaultLocalization: { language: "en", timeZone: "UTC" } };
    snapshot.enforcedSettings = { [settingPath("plugins", id, "enabled")]: "PI_WEB_PLUGINS" };
    expect(explicitConfigUpdate(snapshot, { plugins: { [id]: { enabled: false, settings: { [key]: { next: true } } } }, defaultLocalization: { timeZone: "Europe/Paris" } })).toEqual({ set: { plugins: { [id]: { settings: { [key]: { next: true } } } }, defaultLocalization: { timeZone: "Europe/Paris" } } });
    expect(resetConfigUpdate(snapshot, [settingPath("plugins", id, "enabled"), settingPath("plugins", id, "settings", key)])).toEqual({ unset: ["/plugins/plugin~1with~0dots.v1/settings/object~1setting~0"] });
  });

  it("keeps empty dictionaries, arrays, false, zero and null shortcut bindings explicit", () => {
    expect(explicitConfigUpdate(response(), { shortcuts: { action: null }, allowedHosts: [], uploads: {}, extensionDialogsTimeoutMs: 0, quietMode: false })).toEqual({ set: { shortcuts: { action: null }, allowedHosts: [], extensionDialogsTimeoutMs: 0, quietMode: false } });
  });

  it("diffs static namespaces per leaf while keeping coherent objects atomic", () => {
    const snapshot = response();
    snapshot.config = { defaultLocalization: { language: "en", formatLocale: "en-US", timeZone: "UTC" }, uploads: { defaultFolder: "old" }, pathAccess: { allowedPaths: ["/old"] } };
    snapshot.enforcedSettings = { "/defaultLocalization/language": "PI_WEB_DEFAULT_LOCALIZATION" };
    expect(explicitConfigUpdate(snapshot, { defaultLocalization: { language: "de", formatLocale: "de-DE" }, uploads: {}, pathAccess: { allowedPaths: [] }, defaultTheme: { themeId: "new", auto: false } })).toEqual({ set: { defaultLocalization: { formatLocale: "de-DE" }, pathAccess: { allowedPaths: [] }, defaultTheme: { themeId: "new", auto: false } } });
    expect(resetConfigUpdate(snapshot, ["/defaultLocalization", "/defaultLocalization/formatLocale", "/uploads"])).toEqual({ unset: ["/defaultLocalization/formatLocale", "/defaultLocalization/timeZone", "/uploads/defaultFolder"] });
    snapshot.enforcedSettings = { "/defaultLocalization": "PI_WEB_DEFAULT_LOCALIZATION" };
    expect(enforcedSetting(snapshot, "/defaultLocalization/formatLocale")).toBe("PI_WEB_DEFAULT_LOCALIZATION");
    expect(explicitConfigUpdate(snapshot, { defaultLocalization: { formatLocale: "de-DE" } })).toEqual({});
    expect(resetConfigUpdate(snapshot, ["/defaultLocalization"])).toEqual({ unset: [] });
  });

  it("clears reset selected-machine values and metadata without dropping gateway settings", () => {
    const base = response();
    base.config.uploads = { defaultFolder: "old" };
    base.config.defaultTheme = { themeId: "theme", auto: false };
    base.configSources = { "/uploads": "config", "/defaultTheme": "config" };
    const incoming = response();
    incoming.config = {};
    incoming.effectiveConfig = { uploads: { defaultFolder: "deployed" } };
    incoming.configSources = { "/uploads": "defaults" };
    const merged = mergeSelectedSettingsResponse(base, incoming, ["uploads"]);
    expect(merged.config).not.toHaveProperty("uploads");
    expect(merged.config.defaultTheme).toEqual(base.config.defaultTheme);
    expect(merged.effectiveConfig.uploads).toEqual({ defaultFolder: "deployed" });
    expect(merged.configSources).toEqual({ "/uploads": "defaults", "/defaultTheme": "config" });
  });
});
