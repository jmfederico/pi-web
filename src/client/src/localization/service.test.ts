import { describe, expect, it, vi } from "vitest";
import { html, type TemplateResult } from "lit";
import { LocalizationService, message, normalizePreferences, type LocalizationDiagnostic, type MessageDefinitions, type RichMessageTag } from "./service.js";
import { validateCatalog, validateMessages } from "./catalog.js";

const definitions = {
  greeting: message<{ name: string }>("Hello {name}", "Welcome a user by name"),
  files: message<{ count: number }>("{count, plural, one {# file} other {# files}}", "Number of files"),
  status: message<{ state: string }>("{state, select, ready {Ready} other {Waiting}}", "Task status"),
  rich: message<{ strong: RichMessageTag; name: string }>(
    "Read <strong>{name}</strong>", "Emphasized document title"),
  price: message<{ amount: number }>("Total: {amount, number, ::currency/USD}", "Price in explicitly specified US dollars"),
  date: message<{ at: Date }>("{at, time, short}", "Event time"),
  cancel: message("Cancel", "Cancel the current operation"),
} satisfies MessageDefinitions;

function setup(language = "en", development = true) {
  const diagnostics: LocalizationDiagnostic[] = [];
  const service = new LocalizationService({ preferences: { language, formatLocale: "de-DE", timeZone: "UTC", hourCycle: "h23" },
    development, diagnostic: (diagnostic) => diagnostics.push(diagnostic) });
  const messages = service.registerMessages("test", definitions);
  return { service, messages, diagnostics };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("localization deployment policy", () => {
  it.each(["language", "formatLocale", "timeZone", "hourCycle"] as const)("locks only %s, preserves hidden choices and restores them when unlocked", async (field) => {
    const service = new LocalizationService();
    const local = { language: "en", formatLocale: "de-DE", timeZone: "Europe/Berlin", hourCycle: "h12" as const };
    const defaults = { language: "fr", formatLocale: "fr-FR", timeZone: "UTC", hourCycle: "h23" as const };
    await service.setPreferenceOverrides(local);
    await service.setPreferenceDefaults(defaults, { enforcedFields: { [field]: "DEPLOYMENT_ENV" }, sources: { [field]: "environment" } });
    expect(service.preferences).toEqual({ ...local, [field]: defaults[field] });
    expect(service.preferenceOverrides).toEqual(local);
    expect(service.preferenceSettingPolicy(field)).toEqual({ locked: true, enforcedBy: "DEPLOYMENT_ENV", source: "environment" });
    // A broad reset removes unlocked overrides only, not the saved value hidden by policy.
    await service.setPreferenceOverrides({});
    expect(service.preferenceOverrides).toEqual({ [field]: local[field] });
    expect(service.preferences).toEqual(defaults);
    await service.setPreferenceDefaults(defaults, {});
    expect(service.preferences).toEqual({ ...defaults, [field]: local[field] });
    expect(service.preferenceSettingPolicy(field).locked).toBe(false);
  });

  it("retains enforcement when ordinary defaults are updated without new metadata", async () => {
    const service = new LocalizationService({ preferences: { language: "en", formatLocale: "de-DE" } });
    await service.setPreferenceDefaults({ language: "en", formatLocale: "fr-FR" }, { enforcedFields: { formatLocale: "FORMAT_ENV" } });
    await service.setPreferenceDefaults({ language: "en", formatLocale: "sv-SE" });
    await service.setPreferences({ language: "en", formatLocale: "en-GB" });
    expect(service.preferences.formatLocale).toBe("sv-SE");
    expect(service.preferenceOverrides.formatLocale).toBe("de-DE");
  });
});

describe("localization", () => {
  it("lists installed catalog languages without loading, deduplicates, and removes released languages", async () => {
    const { service } = setup();
    const load = vi.fn(() => Promise.resolve({}));
    const remove = service.registerCatalog({ id: "de-a", namespace: "test", locale: "de-de", load });
    service.registerCatalog({ id: "de-b", namespace: "other", locale: "de-DE", load });
    const removeFrench = service.registerCatalog({ id: "fr", namespace: "other", locale: "fr", load });
    service.registerCatalog({ id: "pseudo", namespace: "test", locale: "ar-XB", load });
    await service.ready;
    expect(service.availableLanguages).toEqual(["de-DE", "en", "fr"]);
    expect(load).not.toHaveBeenCalled();
    remove();
    removeFrench();
    expect(service.availableLanguages).toEqual(["de-DE", "en"]);
  });

  it("formats ICU interpolation, selects, plurals and rich callbacks without translating values", async () => {
    const { service, messages } = setup();
    await service.ready;
    expect(messages.t("greeting", { name: "/home/user.ts" })).toBe("Hello /home/user.ts");
    expect(messages.t("files", { count: 1 })).toBe("1 file");
    expect(messages.t("files", { count: 1200 })).toBe("1.200 files");
    expect(messages.t("status", { state: "ready" })).toBe("Ready");
    const strong = vi.fn((parts: (string | TemplateResult)[]) => html`<strong>${parts}</strong>`);
    const result = messages.rich("rich", { name: "<script>user</script>", strong });
    expect(strong).toHaveBeenCalledWith(["<script>user</script>"]);
    expect(Array.isArray(result)).toBe(true);
    expect(messages.t("cancel")).toBe("Cancel");
  });

  it("keeps UI plural rules independent of regional number/date preferences", async () => {
    const { service, messages } = setup("fr");
    service.registerCatalog({ id: "plugin:fr", namespace: "test", locale: "fr", load: () => Promise.resolve({ files: "{count, plural, one {# fichier} other {# fichiers}}" }) });
    await service.ready;
    expect(messages.t("files", { count: 0 })).toBe("0 fichier");
    // Missing translations use English plural semantics, not the requested French rules.
    expect(messages.t("greeting", { name: "Ada" })).toBe("Hello Ada");
    expect(messages.t("price", { amount: 1200.5 })).toBe(`Total: ${new Intl.NumberFormat("de-DE", { style: "currency", currency: "USD" }).format(1200.5)}`);
    const at = new Date("2026-01-01T17:45:00Z");
    expect(messages.t("date", { at })).toBe("17:45");
    expect(service.number(1200.5)).toBe(new Intl.NumberFormat("de-DE").format(1200.5));
    expect(service.date(at)).toBe(new Intl.DateTimeFormat("de-DE", { dateStyle: "medium", timeZone: "UTC", hourCycle: "h23" }).format(at));
    expect(service.time(at)).toBe("17:45");
    expect(service.relativeTime(-1, "day")).toBe(new Intl.RelativeTimeFormat("de-DE", { numeric: "auto" }).format(-1, "day"));
    expect(service.list(["A", "B"])).toBe(new Intl.ListFormat("de-DE").format(["A", "B"]));
  });

  it("composes lazy catalogs deterministically, falls back by locale, and removes contributions", async () => {
    const { service, messages, diagnostics } = setup();
    const slow = deferred<Record<string, string>>();
    const load = vi.fn(() => slow.promise);
    const removeZ = service.registerCatalog({ id: "z-pack", namespace: "test", locale: "fr", load });
    service.registerCatalog({ id: "a-plugin", namespace: "test", locale: "fr", load: () => Promise.resolve({ cancel: "Annuler A", greeting: "Bonjour {name}" }) });
    service.registerCatalog({ id: "a-ca", namespace: "test", locale: "fr-CA", load: () => Promise.resolve({ greeting: "Salut {name}" }) });
    await service.ready;
    expect(load).not.toHaveBeenCalled();
    const ready = service.setPreferences({ language: "fr-CA", formatLocale: "en-GB" });
    slow.resolve({ cancel: "Annuler Z" });
    await ready;
    await service.ready;
    expect(messages.t("cancel")).toBe("Annuler Z");
    expect(messages.t("greeting", { name: "Ada" })).toBe("Salut Ada");
    expect(service.language).toBe("fr-CA");
    expect(diagnostics.filter(({ code }) => code === "duplicate")).toHaveLength(1);
    removeZ();
    await service.ready;
    expect(messages.t("cancel")).toBe("Annuler A");
    await service.setPreferences({ language: "en", formatLocale: "en" });
    await service.setPreferences({ language: "fr", formatLocale: "en" });
    expect(load).toHaveBeenCalledOnce();
  });

  it("ignores stale asynchronous loads after switching languages or disposing a catalog", async () => {
    const { service, messages } = setup();
    const slow = deferred<Record<string, string>>();
    const remove = service.registerCatalog({ id: "fr", namespace: "test", locale: "fr", load: () => slow.promise });
    const french = service.setPreferences({ language: "fr", formatLocale: "en" });
    await service.setPreferences({ language: "en", formatLocale: "en" });
    remove();
    slow.resolve({ cancel: "Annuler" });
    await french;
    await service.ready;
    expect(messages.t("cancel")).toBe("Cancel");
    expect(service.language).toBe("en");
  });

  it("isolates failed loaders and invalid messages, logging rather than surfacing conflicts to users", async () => {
    const { service, messages, diagnostics } = setup("fr");
    service.registerCatalog({ id: "broken", namespace: "test", locale: "fr", load: () => Promise.reject(new Error("offline")) });
    service.registerCatalog({ id: "invalid", namespace: "test", locale: "fr", load: () => Promise.resolve({ greeting: "Bonjour {wrong}", rich: "<script>{name}</script>", cancel: "Annuler" }) });
    await service.ready;
    expect(messages.t("greeting", { name: "Ada" })).toBe("Hello Ada");
    expect(messages.t("cancel")).toBe("Annuler");
    expect(diagnostics.map(({ code }) => code)).toEqual(expect.arrayContaining(["load", "invalid", "missing"]));
    expect(diagnostics.filter(({ code }) => code === "invalid")).toHaveLength(2);
    messages.t("greeting", { name: "Ada" });
    expect(diagnostics.filter(({ code }) => code === "missing")).toHaveLength(1);
  });

  it("applies a machine-scoped pack only while its machine is selected", async () => {
    const { service, messages } = setup("fr");
    const load = vi.fn(() => Promise.resolve({ cancel: "Annuler" }));
    service.registerCatalog({ id: "remote-pack", namespace: "test", locale: "fr", load }, (machineId) => machineId === "remote");
    await service.ready;
    expect(messages.t("cancel")).toBe("Cancel");
    expect(service.availableLanguages).toEqual(["en"]);
    expect(load).not.toHaveBeenCalled();
    service.setMachine("remote");
    await service.ready;
    expect(messages.t("cancel")).toBe("Annuler");
    expect(service.availableLanguages).toEqual(["en", "fr"]);
    expect(service.language).toBe("fr");
    service.setMachine("local");
    expect(messages.t("cancel")).toBe("Cancel");
    expect(service.language).toBe("en");
  });

  it("supports packs registered before their target namespace", async () => {
    const service = new LocalizationService({ preferences: { language: "fr", formatLocale: "fr" } });
    service.registerCatalog({ id: "pack", namespace: "later", locale: "fr", load: () => Promise.resolve({ cancel: "Annuler" }) });
    await service.ready;
    const messages = service.registerMessages("later", { cancel: definitions.cancel });
    await service.ready;
    expect(messages.t("cancel")).toBe("Annuler");
  });

  it("publishes preferences and healthy catalogs without waiting for an unrelated stalled pack", async () => {
    const { service, messages } = setup();
    const healthy = deferred<Record<string, string>>();
    const removeStalled = service.registerCatalog({ id: "stalled", namespace: "absent-plugin", locale: "fr", load: () => new Promise(() => undefined) });
    service.registerCatalog({ id: "healthy", namespace: "test", locale: "fr", load: () => healthy.promise });
    let translated: () => void = () => undefined;
    const published = new Promise<void>((resolve) => { translated = resolve; });
    const listener = vi.fn(() => { if (messages.t("cancel") === "Annuler") translated(); });
    const unsubscribe = service.subscribe(listener);
    void service.setPreferences({ language: "fr", formatLocale: "sv-SE" });
    expect(listener).toHaveBeenCalledOnce();
    expect(messages.t("cancel")).toBe("Cancel");
    expect(service.number(1234.5)).toBe(new Intl.NumberFormat("sv-SE").format(1234.5));
    healthy.resolve({ cancel: "Annuler" });
    await published;
    expect(service.language).toBe("fr");
    expect(messages.t("cancel")).toBe("Annuler");
    // Removal also settles a captured readiness promise without waiting for the loader.
    const ready = service.ready;
    removeStalled();
    await ready;
    unsubscribe();
  });

  it("does not start a catalog loader after its registration was removed", async () => {
    const { service, messages } = setup("fr");
    const load = vi.fn(() => Promise.resolve({ cancel: "Annuler" }));
    const remove = service.registerCatalog({ id: "removed", namespace: "test", locale: "fr", load });
    remove();
    await service.ready;
    expect(load).not.toHaveBeenCalled();
    expect(messages.t("cancel")).toBe("Cancel");
  });

  it("settles stalled loaders after five seconds and ignores their late result", async () => {
    vi.useFakeTimers();
    try {
      const { service, messages, diagnostics } = setup("fr");
      const late = deferred<Record<string, string>>();
      service.registerCatalog({ id: "stalled", namespace: "test", locale: "fr", load: () => late.promise });
      const ready = service.ready;
      expect(messages.t("cancel")).toBe("Cancel");
      await vi.advanceTimersByTimeAsync(5_000);
      await ready;
      expect(messages.t("cancel")).toBe("Cancel");
      expect(diagnostics.filter(({ code }) => code === "load")).toHaveLength(1);
      expect(String(diagnostics.find(({ code }) => code === "load")?.cause)).toContain("exceeded 5 seconds");
      late.resolve({ cancel: "Too late" });
      await late.promise;
      await Promise.resolve();
      expect(messages.t("cancel")).toBe("Cancel");
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it("validates shared catalog entries separately against each activation's source schema", async () => {
    const diagnostic = vi.fn<(value: LocalizationDiagnostic) => void>();
    const service = new LocalizationService({ preferences: { language: "fr", formatLocale: "en" }, diagnostic });
    const old = service.acquireMessages("plugin:example:panel", { greeting: message<{ name: string }>("Hello {name}", "Original source") });
    const newer = service.acquireMessages("plugin:example:panel", { greeting: message<{ user: string }>("Welcome {user}", "Revised source") });
    service.registerCatalog({ id: "a-original", namespace: "plugin:example:panel", locale: "fr", load: () => Promise.resolve({ greeting: "Bonjour {name}" }) });
    const removeNew = service.registerCatalog({ id: "z-newer", namespace: "plugin:example:panel", locale: "fr", load: () => Promise.resolve({ greeting: "Salut {user}" }) });
    await service.ready;
    expect(old.messages.t("greeting", { name: "Ada" })).toBe("Bonjour Ada");
    expect(newer.messages.t("greeting", { user: "Ada" })).toBe("Salut Ada");
    removeNew();
    await service.ready;
    expect(old.messages.t("greeting", { name: "Ada" })).toBe("Bonjour Ada");
    expect(newer.messages.t("greeting", { user: "Ada" })).toBe("Welcome Ada");
    old.release();
    expect(old.messages.t("greeting", { name: "Ada" })).toBe("Hello Ada");
    expect(newer.messages.t("greeting", { user: "Ada" })).toBe("Welcome Ada");
    newer.release();
  });

  it("pseudo-localizes English literals only, including ICU branches and rich messages", async () => {
    const { service, messages } = setup();
    await service.setPreferences({ language: "en-XA", formatLocale: "en" });
    expect(messages.t("greeting", { name: "/home/user.ts" })).toContain("/home/user.ts");
    expect(messages.t("greeting", { name: "Ada" })).toContain("Hëllö");
    expect(messages.t("files", { count: 2 })).toContain("fïlës");
    expect(messages.t("cancel").length).toBeGreaterThan("Cancel".length);
    expect(service.direction).toBe("ltr");
    await service.setPreferences({ language: "ar-XB", formatLocale: "en" });
    expect(service.direction).toBe("rtl");
    expect(messages.t("cancel")).toContain("\u202e");
    expect(() => setup("en-XA", false)).toThrow(/development/);
  });

  it("validates preferences before mutating state and gives subscribers an explicit cleanup", async () => {
    const { service } = setup();
    await service.ready;
    const listener = vi.fn();
    const unsubscribe = service.subscribe(listener);
    const original = service.preferences;
    expect(() => service.setPreferences({ language: "en", formatLocale: "en", timeZone: "Not/AZone" })).toThrow();
    expect(service.preferences).toEqual(original);
    await service.setPreferences({ language: "en", formatLocale: "en-GB" });
    expect(listener).toHaveBeenCalledOnce();
    unsubscribe();
    await service.setPreferences({ language: "en", formatLocale: "de" });
    expect(listener).toHaveBeenCalledOnce();
    expect(normalizePreferences({ language: "EN-us", formatLocale: "de-de" })).toEqual({ language: "en-US", formatLocale: "de-DE" });
  });

  it("keeps independent override/default layers and validates them before mutation", async () => {
    const service = new LocalizationService();
    await service.setPreferenceDefaults({ language: "fr", formatLocale: "de-DE", timeZone: "Europe/Berlin", hourCycle: "h23" });
    expect(service.preferenceOverrides).toEqual({});
    const revision = service.preferenceRevision;
    await service.setPreferenceOverrides({ formatLocale: "sv-SE" });
    expect(service.preferences).toEqual({ language: "fr", formatLocale: "sv-SE", timeZone: "Europe/Berlin", hourCycle: "h23" });
    expect(service.preferenceRevision).toBe(revision + 1);
    await service.setPreferenceDefaults({ language: "en", formatLocale: "en-GB", timeZone: "UTC" });
    expect(service.preferenceRevision).toBe(revision + 1);
    expect(service.preferences).toEqual({ language: "en", formatLocale: "sv-SE", timeZone: "UTC" });
    const before = service.preferences;
    expect(() => service.setPreferenceOverrides({ formatLocale: "" })).toThrow();
    expect(() => service.setPreferenceDefaults({ language: "en", formatLocale: "en", timeZone: "Mars/Olympus" })).toThrow();
    expect(service.preferences).toEqual(before);
    expect(service.preferenceOverrides).toEqual({ formatLocale: "sv-SE" });
    await service.setPreferenceOverrides({});
    expect(service.preferences).toEqual({ language: "en", formatLocale: "en-GB", timeZone: "UTC" });
    expect(service.preferenceOverrides).toEqual({});
  });

  it("rejects invalid source catalogs and validates translation placeholders/tags", () => {
    expect(validateMessages({ bad: message("{unclosed", "") })).toHaveLength(2);
    expect(validateCatalog(definitions, { unknown: "Unknown", greeting: "Hi {other}", rich: "<em>{name}</em>" })).toHaveLength(3);
    expect(validateCatalog(definitions, { files: "{count, plural, few {# items} other {# items}}" })).toEqual([]);
    const { service } = setup();
    expect(() => service.registerMessages("invalid", { bad: message("{", "Invalid") })).toThrow(/Invalid source/);
  });
});

// Compile-time API contract: unknown keys and missing/wrong placeholders must fail typechecking.
function typeContract(messages: ReturnType<typeof setup>["messages"]): void {
  messages.t("cancel");
  messages.t("files", { count: 2 });
  // @ts-expect-error unknown message key
  messages.t("unknown");
  // @ts-expect-error missing required values
  messages.t("greeting");
  // @ts-expect-error wrong value type
  messages.t("files", { count: "two" });
  // @ts-expect-error unknown placeholder
  messages.t("greeting", { name: "Ada", extra: "unexpected" });
}
void typeContract;
