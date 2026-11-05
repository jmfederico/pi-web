import { parse } from "@formatjs/icu-messageformat-parser";
import { IntlMessageFormat, type Formatters } from "intl-messageformat";
import type { TemplateResult } from "lit";
import type {
  LocalizationDiagnostic, LocalizationPreferences, LocalizedMessages, MessageArguments,
  MessageDefinitions, MessageValues, TranslationContribution,
} from "../../../shared/localization.js";
import { pseudoLocalize, validateCatalog, validateMessages } from "./catalog.js";
import { loadCatalog, type CatalogLoad } from "./catalogLoader.js";

export { message } from "../../../shared/localization.js";
export type * from "../../../shared/localization.js";

/** Decides whether a catalog applies while the given machine is selected. */
export type CatalogMachineScope = (machineId: string) => boolean;

interface RegisteredCatalog extends TranslationContribution {
  appliesTo: CatalogMachineScope;
  loaded?: CatalogLoad;
}

const LOCAL_MACHINE_ID = "local";
const everyMachine: CatalogMachineScope = () => true;

interface SelectedMessage { message: string; locale: string }
interface RegisteredSource {
  definitions: MessageDefinitions;
  selected: Map<string, SelectedMessage>;
  active: boolean;
}

export const LOCALIZATION_FIELDS = ["language", "formatLocale", "timeZone", "hourCycle"] as const;
export type LocalizationField = typeof LOCALIZATION_FIELDS[number];
export interface LocalizationPolicy {
  enforcedFields?: Partial<Record<LocalizationField, string>>;
  sources?: Partial<Record<LocalizationField, string>>;
}

export interface LocalizationOptions {
  preferences?: LocalizationPreferences;
  /** Pseudo locales are a development facility, disabled in production. */
  development?: boolean;
  diagnostic?: (diagnostic: LocalizationDiagnostic) => void;
}

function canonicalLocale(locale: string): string {
  const canonical = Intl.getCanonicalLocales(locale)[0];
  if (canonical === undefined) throw new RangeError("A locale is required");
  return canonical;
}

function localeChain(locale: string): string[] {
  const parts = new Intl.Locale(locale).baseName.split("-");
  const result: string[] = [];
  while (parts.length) {
    result.unshift(parts.join("-"));
    parts.pop();
  }
  return result;
}

export function normalizePreferences(value: unknown): LocalizationPreferences {
  if (typeof value !== "object" || value === null || !("language" in value) || typeof value.language !== "string"
    || !("formatLocale" in value) || typeof value.formatLocale !== "string") throw new TypeError("Expected language and formatLocale");
  const language = canonicalLocale(value.language);
  const formatLocale = canonicalLocale(value.formatLocale);
  const hourCycle = "hourCycle" in value ? value.hourCycle : undefined;
  const zone = "timeZone" in value ? value.timeZone : undefined;
  if (hourCycle !== undefined && hourCycle !== "h11" && hourCycle !== "h12" && hourCycle !== "h23" && hourCycle !== "h24") {
    throw new RangeError("Invalid hour cycle");
  }
  if (zone !== undefined && typeof zone !== "string") throw new TypeError("Expected a time-zone name");
  // Native Intl validates zones; no locale-to-zone or locale-to-currency inference.
  const timeZone = zone === undefined ? undefined
    : new Intl.DateTimeFormat(formatLocale, { timeZone: zone }).resolvedOptions().timeZone;
  return { language, formatLocale, ...(timeZone === undefined ? {} : { timeZone }),
    ...(hourCycle === undefined ? {} : { hourCycle }) };
}

export function normalizePreferenceOverrides(value: unknown): Partial<LocalizationPreferences> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("Expected localization overrides");
  const normalized = normalizePreferences({ language: "en", formatLocale: "en", ...value });
  return {
    ...("language" in value ? { language: normalized.language } : {}),
    ...("formatLocale" in value ? { formatLocale: normalized.formatLocale } : {}),
    ...(normalized.timeZone === undefined ? {} : { timeZone: normalized.timeZone }),
    ...(normalized.hourCycle === undefined ? {} : { hourCycle: normalized.hourCycle }),
  };
}

function hasTextInfoMethod(locale: Intl.Locale): locale is Intl.Locale & { getTextInfo(): unknown } {
  return "getTextInfo" in locale && typeof locale.getTextInfo === "function";
}

export function localeDirection(language: string): "ltr" | "rtl" {
  if (language === "ar-XB") return "rtl";
  const locale = new Intl.Locale(language);
  // Engines ship either the current method or the earlier accessor form.
  const info: unknown = hasTextInfoMethod(locale) ? locale.getTextInfo() : "textInfo" in locale ? locale.textInfo : undefined;
  return typeof info === "object" && info !== null && "direction" in info && info.direction === "rtl" ? "rtl" : "ltr";
}

/** Owns catalogs/preferences. Environment effects belong to the browser/plugin adapters. */
export class LocalizationService {
  private current: LocalizationPreferences;
  private defaults: LocalizationPreferences = { language: "en", formatLocale: "en" };
  private overrides: Partial<LocalizationPreferences>;
  private policy: LocalizationPolicy = {};
  private readonly development: boolean;
  private readonly diagnostic: (diagnostic: LocalizationDiagnostic) => void;
  private readonly sources = new Map<string, Set<RegisteredSource>>();
  private readonly contributions = new Map<string, RegisteredCatalog>();
  private readonly listeners = new Set<() => void>();
  private readonly formats = new Map<string, IntlMessageFormat>();
  private readonly reported = new Set<string>();
  private preferencesRevision = 0;
  private pending: Promise<void> = Promise.resolve();
  private resolvedLanguage = "en";
  private machineId = LOCAL_MACHINE_ID;

  constructor(options: LocalizationOptions = {}) {
    this.current = normalizePreferences(options.preferences ?? this.defaults);
    this.overrides = options.preferences === undefined ? {} : { ...this.current };
    this.development = options.development ?? false;
    this.diagnostic = options.diagnostic ?? ((diagnostic) => { console.warn(`[i18n:${diagnostic.code}] ${diagnostic.message}`, diagnostic.cause ?? ""); });
    this.assertLanguage(this.current.language);
  }

  get preferences(): Readonly<LocalizationPreferences> { return { ...this.current }; }
  /** Explicit choices only; omitted fields continue to inherit defaults. */
  get preferenceOverrides(): Readonly<Partial<LocalizationPreferences>> { return { ...this.overrides }; }
  get preferenceDefaults(): Readonly<LocalizationPreferences> { return { ...this.defaults }; }
  get preferencePolicy(): LocalizationPolicy {
    return { enforcedFields: { ...this.policy.enforcedFields }, sources: { ...this.policy.sources } };
  }
  preferenceSettingPolicy(field: LocalizationField): { locked: boolean; enforcedBy: string | undefined; source: string | undefined } {
    const enforcedBy = this.policy.enforcedFields?.[field];
    return { locked: enforcedBy !== undefined, enforcedBy, source: this.policy.sources?.[field] };
  }

  private resolvePreferences(defaults: LocalizationPreferences, overrides: Partial<LocalizationPreferences>, policy: LocalizationPolicy): LocalizationPreferences {
    const effective: Partial<LocalizationPreferences> = { ...defaults, ...overrides };
    for (const field of LOCALIZATION_FIELDS) {
      if (policy.enforcedFields?.[field] !== undefined) {
        // A locked field inherits the gateway value, never the saved browser value.
        Reflect.deleteProperty(effective, field);
        Object.assign(effective, { [field]: defaults[field] });
      }
    }
    return normalizePreferences(effective);
  }
  /** Distinguishes explicit preference requests (even identical values) from catalog refreshes. */
  get preferenceRevision(): number { return this.preferencesRevision; }
  /** Actual UI language after catalog fallback, suitable for document.lang. */
  get language(): string { return this.isPseudo ? this.current.language : this.resolvedLanguage; }
  get direction(): "ltr" | "rtl" { return localeDirection(this.language); }
  get ready(): Promise<void> { return this.pending; }
  /** Installed catalog languages, without loading catalogs or exposing development pseudo modes. */
  get availableLanguages(): readonly string[] {
    return [...new Set(["en", ...this.machineCatalogs().map((item) => item.locale)])]
      .filter((locale) => locale !== "en-XA" && locale !== "ar-XB").sort();
  }
  private get isPseudo(): boolean { return this.current.language === "en-XA" || this.current.language === "ar-XB"; }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private notify(): void {
    this.formats.clear();
    for (const listener of this.listeners) listener();
  }

  private report(code: LocalizationDiagnostic["code"], message: string, cause?: unknown): void {
    const key = `${code}:${message}`;
    if (this.reported.has(key)) return;
    this.reported.add(key);
    this.diagnostic({ code, message, ...(cause === undefined ? {} : { cause }) });
  }

  private assertLanguage(language: string): void {
    if (!this.development && (language === "en-XA" || language === "ar-XB")) {
      throw new RangeError("Pseudo-localization is available only in development");
    }
  }

  setPreferences(preferences: LocalizationPreferences): Promise<void> {
    const normalized = normalizePreferences(preferences);
    this.assertLanguage(normalized.language);
    return this.setPreferenceOverrides(normalized);
  }

  /** Update inherited values without converting them into explicit preferences. */
  setPreferenceDefaults(preferences: LocalizationPreferences, policy: LocalizationPolicy = this.policy): Promise<void> {
    const defaults = normalizePreferences(preferences);
    const current = this.resolvePreferences(defaults, this.overrides, policy);
    this.assertLanguage(defaults.language);
    this.assertLanguage(current.language);
    this.defaults = defaults;
    this.policy = { enforcedFields: { ...policy.enforcedFields }, sources: { ...policy.sources } };
    this.current = current;
    this.refresh();
    return this.pending;
  }

  /** Replace the override layer. Clearing a field resumes inheritance for that field. */
  setPreferenceOverrides(preferences: Partial<LocalizationPreferences>): Promise<void> {
    const overrides = normalizePreferenceOverrides(preferences);
    for (const field of LOCALIZATION_FIELDS) {
      if (this.policy.enforcedFields?.[field] !== undefined) {
        Reflect.deleteProperty(overrides, field);
        if (this.overrides[field] !== undefined) Object.assign(overrides, { [field]: this.overrides[field] });
      }
    }
    const normalized = this.resolvePreferences(this.defaults, overrides, this.policy);
    this.assertLanguage(normalized.language);
    this.overrides = overrides;
    this.current = normalized;
    this.preferencesRevision++;
    this.refresh();
    return this.pending;
  }

  /** Register one application-lifetime namespace; keys remain local to its typed handle. */
  registerMessages<Definitions extends MessageDefinitions>(namespace: string, definitions: Definitions): LocalizedMessages<Definitions> {
    if (!namespace || this.sources.has(namespace)) throw new Error(`Duplicate or empty message namespace: ${namespace}`);
    return this.messageHandle<Definitions>(namespace, this.addSource(namespace, definitions));
  }

  /** Activations share a catalog address, not a mutable source definition. */
  acquireMessages<Definitions extends MessageDefinitions>(namespace: string, definitions: Definitions): {
    messages: LocalizedMessages<Definitions>; release(): void;
  } {
    const source = this.addSource(namespace, definitions);
    return {
      messages: this.messageHandle<Definitions>(namespace, source),
      release: () => {
        if (!source.active) return;
        source.active = false;
        source.selected.clear();
        const registrations = this.sources.get(namespace);
        registrations?.delete(source);
        if (registrations?.size === 0) this.sources.delete(namespace);
        this.refresh();
      },
    };
  }

  private addSource(namespace: string, definitions: MessageDefinitions): RegisteredSource {
    if (!namespace) throw new Error("Empty message namespace");
    const errors = validateMessages(definitions);
    if (errors.length) throw new Error(`Invalid source ${namespace}: ${errors.join("; ")}`);
    const source: RegisteredSource = { definitions, selected: new Map(), active: true };
    let registrations = this.sources.get(namespace);
    if (!registrations) { registrations = new Set(); this.sources.set(namespace, registrations); }
    registrations.add(source);
    this.refresh();
    return source;
  }

  private messageHandle<Definitions extends MessageDefinitions>(namespace: string, source: RegisteredSource): LocalizedMessages<Definitions> {
    return {
      t: <Key extends keyof Definitions & string>(key: Key, ...args: MessageArguments<Definitions[Key]>) => {
        const result = this.format(namespace, source, key, args[0]);
        if (typeof result !== "string") throw new Error(`Use rich() for ${namespace}.${key}`);
        return result;
      },
      rich: <Key extends keyof Definitions & string>(key: Key, ...args: MessageArguments<Definitions[Key]>) => this.format(namespace, source, key, args[0]),
    };
  }

  /**
   * Select the machine whose catalogs apply. A machine's language pack must not
   * translate the UI while another machine is selected.
   */
  setMachine(machineId: string): void {
    this.machineId = machineId;
    this.refresh();
  }

  /**
   * Contributions may target any namespace; registration order and load timing do not determine precedence.
   * `appliesTo` limits the catalog to selected machines; omitted, it applies on every machine.
   */
  registerCatalog(contribution: TranslationContribution, appliesTo: CatalogMachineScope = everyMachine): () => void {
    if (!contribution.id || this.contributions.has(contribution.id)) throw new Error(`Duplicate or empty catalog ID: ${contribution.id}`);
    const registered: RegisteredCatalog = { ...contribution, locale: canonicalLocale(contribution.locale), appliesTo };
    this.contributions.set(registered.id, registered);
    this.refresh();
    return () => {
      if (this.contributions.get(registered.id) !== registered) return;
      this.contributions.delete(registered.id);
      registered.loaded?.dispose();
      this.refresh();
    };
  }

  private machineCatalogs(): RegisteredCatalog[] {
    return [...this.contributions.values()].filter((item) => item.appliesTo(this.machineId));
  }

  private matchingCatalogs(): RegisteredCatalog[] {
    const chain = this.isPseudo ? [] : localeChain(this.current.language).filter((locale) => locale !== "en");
    return this.machineCatalogs()
      .filter((item) => chain.includes(item.locale))
      .sort((a, b) => chain.indexOf(a.locale) - chain.indexOf(b.locale) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  private refresh(): void {
    const loads: Promise<void>[] = [];
    for (const item of this.matchingCatalogs()) {
      if (item.loaded === undefined) {
        item.loaded = loadCatalog(item, ({ code, message, cause }) => { this.report(code, message, cause); });
        // Each catalog publishes independently. One slow pack cannot hide healthy siblings.
        void item.loaded.ready.then(() => { this.publish(); });
      }
      loads.push(item.loaded.ready);
    }
    this.pending = Promise.all(loads).then(() => undefined);
    // Preferences, persistence and fallback UI commit before any catalog I/O.
    this.publish();
  }

  private publish(): void {
    for (const registrations of this.sources.values()) {
      for (const source of registrations) source.selected.clear();
    }
    const owners = new Map<string, string>();
    let resolvedLanguage = "en";
    for (const item of this.matchingCatalogs()) {
      const registrations = this.sources.get(item.namespace);
      if (!registrations) continue;
      for (const [key, value] of Object.entries(item.loaded?.catalog ?? {})) {
        let used = false;
        const errors = new Set<string>();
        for (const source of registrations) {
          const incompatible = validateCatalog(source.definitions, { [key]: value });
          if (incompatible.length) {
            incompatible.forEach((error) => errors.add(error));
            continue;
          }
          source.selected.set(key, { message: value, locale: item.locale });
          used = true;
        }
        if (!used) {
          this.report("invalid", `${item.id}: ${[...errors].join("; ")}`);
          continue;
        }
        const identity = JSON.stringify([item.locale, item.namespace, key]);
        const owner = owners.get(identity);
        if (owner !== undefined) this.report("duplicate", `${item.locale}/${item.namespace}.${key}: ${item.id} overrides ${owner}`);
        owners.set(identity, item.id);
        resolvedLanguage = item.locale;
      }
    }
    this.resolvedLanguage = resolvedLanguage;
    this.notify();
  }

  private dateOptions(options: Intl.DateTimeFormatOptions): Intl.DateTimeFormatOptions {
    return { ...options, ...(this.current.timeZone === undefined ? {} : { timeZone: this.current.timeZone }),
      ...(this.current.hourCycle === undefined ? {} : { hourCycle: this.current.hourCycle, hour12: undefined }) };
  }

  private format(namespace: string, registration: RegisteredSource, key: string, values?: MessageValues): string | TemplateResult | (string | TemplateResult)[] {
    const source = registration.definitions[key];
    if (!source) throw new Error(`Unknown message: ${namespace}.${key}`);
    const translated = registration.selected.get(key);
    if (!translated && registration.active && !this.isPseudo && !this.current.language.startsWith("en") && this.development) {
      this.report("missing", `${this.current.language}/${namespace}.${key}: using English`);
    }
    const selected = this.isPseudo ? { message: source.message, locale: "en" } : translated ?? { message: source.message, locale: "en" };
    const format = (text: string, locale: string): string | TemplateResult | (string | TemplateResult)[] => {
      const cacheKey = JSON.stringify([namespace, key, text, locale, this.isPseudo]);
      let formatter = this.formats.get(cacheKey);
      if (!formatter) {
        const formatters: Formatters = {
          // FormatJS includes newer Intl option types than our ES2022 lib; pass them through to native Intl.
          // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
          getNumberFormat: (_locale, options) => new Intl.NumberFormat(this.current.formatLocale, options as Intl.NumberFormatOptions),
          getDateTimeFormat: (_locale, options) => new Intl.DateTimeFormat(this.current.formatLocale, this.dateOptions(options ?? {})),
          getPluralRules: (pluralLocale, options) => new Intl.PluralRules(pluralLocale, options),
        };
        let ast = parse(text);
        if (this.isPseudo) ast = pseudoLocalize(ast, this.current.language === "ar-XB");
        formatter = new IntlMessageFormat(ast, locale, undefined, { formatters });
        this.formats.set(cacheKey, formatter);
      }
      return formatter.format<TemplateResult>(values);
    };
    try { return format(selected.message, selected.locale); }
    catch (cause) {
      this.report("format", `${namespace}.${key}: formatting failed`, cause);
      // A broken translation cannot hide a usable source. Caller errors still throw clearly.
      if (selected.message !== source.message) return format(source.message, "en");
      throw cause;
    }
  }

  number(value: number | bigint, options?: Intl.NumberFormatOptions): string {
    return new Intl.NumberFormat(this.current.formatLocale, options).format(value);
  }
  date(value: Date | number, options: Intl.DateTimeFormatOptions = { dateStyle: "medium" }): string {
    return new Intl.DateTimeFormat(this.current.formatLocale, this.dateOptions(options)).format(value);
  }
  time(value: Date | number, options: Intl.DateTimeFormatOptions = { timeStyle: "short" }): string {
    return new Intl.DateTimeFormat(this.current.formatLocale, this.dateOptions(options)).format(value);
  }
  relativeTime(value: number, unit: Intl.RelativeTimeFormatUnit, options: Intl.RelativeTimeFormatOptions = { numeric: "auto" }): string {
    return new Intl.RelativeTimeFormat(this.current.formatLocale, options).format(value, unit);
  }
  list(values: Iterable<string>, options?: Intl.ListFormatOptions): string {
    return new Intl.ListFormat(this.current.formatLocale, options).format(values);
  }
}
