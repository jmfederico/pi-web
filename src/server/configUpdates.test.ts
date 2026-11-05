import { describe, expect, it } from "vitest";
import { configUpdateTargets, parseConfigPointer, preserveEnforcedConfigOverrides, removeConfigOverrides, validateConfigUpdate } from "./configUpdates.js";

describe("legacy replacement protection", () => {
  const enforced = { "/installationName": "PI_WEB_INSTALLATION_NAME", "/defaultLocalization/language": "PI_WEB_DEFAULT_LOCALIZATION" };
  const current = { installationName: "Hidden", defaultLocalization: { language: "fr", timeZone: "UTC" }, askUser: false };

  it("retains omitted locked scalars and leaves without retaining ordinary siblings", () => {
    const replacement = { defaultLocalization: { formatLocale: "de-DE" } };
    expect(preserveEnforcedConfigOverrides(current, replacement, enforced)).toEqual({ installationName: "Hidden", defaultLocalization: { language: "fr", formatLocale: "de-DE" } });
    expect(replacement).toEqual({ defaultLocalization: { formatLocale: "de-DE" } });
    expect(current.defaultLocalization.timeZone).toBe("UTC");
    expect(preserveEnforcedConfigOverrides(current, {}, enforced)).toEqual({ installationName: "Hidden", defaultLocalization: { language: "fr" } });
  });

  it("allows unchanged saved roundtrips and rejects explicit differences", () => {
    expect(preserveEnforcedConfigOverrides(current, current, enforced)).toEqual(current);
    expect(() => preserveEnforcedConfigOverrides(current, { installationName: "Enforced" }, enforced)).toThrow("enforced by PI_WEB_INSTALLATION_NAME");
    expect(() => preserveEnforcedConfigOverrides(current, { defaultLocalization: { language: "de" } }, enforced)).toThrow("enforced by PI_WEB_DEFAULT_LOCALIZATION");
  });

  it("keeps absent saved overrides absent and rejects adding locked overrides", () => {
    expect(preserveEnforcedConfigOverrides({}, {}, enforced)).toEqual({});
    expect(() => preserveEnforcedConfigOverrides({}, { installationName: "New" }, enforced)).toThrow("enforced by");
  });

  it("preserves escaped plugin leaves and compares atomic objects independent of key order", () => {
    const saved = { plugins: { "a/b": { enabled: true, settings: { options: { one: 1, two: 2 }, ordinary: true } } } };
    const policy = { "/plugins/a~1b/settings/options": "PI_WEB_PLUGINS" };
    expect(preserveEnforcedConfigOverrides(saved, { plugins: { "a/b": { settings: { options: { two: 2, one: 1 } } } } }, policy))
      .toEqual({ plugins: { "a/b": { settings: { options: { one: 1, two: 2 } } } } });
    expect(() => preserveEnforcedConfigOverrides(saved, { plugins: { "a/b": { settings: { options: {} } } } }, policy)).toThrow("enforced by");
  });

  it("leaves un-enforced replacement semantics intact", () => {
    expect(preserveEnforcedConfigOverrides(current, { defaultLocalization: {} })).toEqual({ defaultLocalization: {} });
  });
});

describe("configuration override removal", () => {
  it("uses escaped JSON pointers without splitting plugin setting names", () => {
    const pointer = "/plugins/git/settings/a.b~1c~0d";
    expect(parseConfigPointer(pointer)).toEqual(["plugins", "git", "settings", "a.b/c~d"]);
    const config = { plugins: { git: { enabled: true, settings: { "a.b/c~d": [1], other: false } } } };
    expect(removeConfigOverrides(config, [pointer])).toEqual({ plugins: { git: { enabled: true, settings: { other: false } } } });
    expect(config.plugins.git.settings["a.b/c~d"]).toEqual([1]);
  });

  it("prunes empty namespace envelopes, but keeps unrelated explicit empty values", () => {
    expect(removeConfigOverrides({ defaultLocalization: { language: "fr" }, pathAccess: { allowedPaths: [] } }, ["/defaultLocalization/language"]))
      .toEqual({ pathAccess: { allowedPaths: [] } });
    expect(removeConfigOverrides({ plugins: { git: { settings: { test: true } } } }, ["/plugins/git/settings/test"]))
      .toEqual({});
  });

  it.each(["quietMode", "/unknown", "/defaultLocalization/unknown", "/defaultTheme/auto", "/shortcuts/action", "/plugins/git/settings/key/deeper", "/plugins/git/settings/bad~escape"])("rejects invalid setting identifier %s", (pointer) => {
    expect(() => parseConfigPointer(pointer)).toThrow("PI WEB config update");
  });

  it.each(["/uploads/defaultFolder", "/attachments/defaultFolder", "/defaultLocalization/language", "/defaultLocalization/timeZone", "/defaultLocalization/hourCycle", "/defaultLocalization/formatLocale", "/sessionArchive/directory", "/pathAccess/allowedPaths"])("accepts declared independent setting %s", (pointer) => {
    expect(parseConfigPointer(pointer)).toEqual(pointer.slice(1).split("/"));
  });

  it("rejects conflicting operations and enforced ancestor/descendant writes", () => {
    expect(() => { validateConfigUpdate({ set: { quietMode: false }, unset: ["/quietMode"] }); }).toThrow("conflicting");
    expect(() => { validateConfigUpdate({ unset: ["/plugins/git", "/plugins/git/enabled"] }); }).toThrow("conflicting");
    expect(() => { validateConfigUpdate({ unset: ["/plugins"] }, { "/plugins/git/enabled": "PI_WEB_PLUGINS" }); }).toThrow("enforced by PI_WEB_PLUGINS");
    expect(() => { validateConfigUpdate({ set: { defaultLocalization: { language: "fr" } } }, { "/defaultLocalization/timeZone": "PI_WEB_DEFAULT_LOCALIZATION" }); }).not.toThrow();
  });

  it("treats declared containers as namespaces, but individual object values as single settings", () => {
    expect(configUpdateTargets({ defaultLocalization: { timeZone: "UTC", language: "fr" }, plugins: { git: { settings: { options: {} }, enabled: false } } }).sort())
      .toEqual(["/defaultLocalization/language", "/defaultLocalization/timeZone", "/plugins/git/enabled", "/plugins/git/settings/options"]);
  });
});
