import { interpolate } from "./translate";
import type { AvailableLocale, CoreMessageKey, LanguagePreference, Locale, TranslationParams } from "./types";
import { DEFAULT_LOCALE, LocaleResourceStore, localeResources, normalizeLanguageTag } from "./resources";
import type { en } from "./locales/en";

export { localeResources } from "./resources";

export const LANGUAGE_STORAGE_KEY = "pi-web-app-language";
const storedPreferencePattern = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u;

export interface LocaleStoreDocument {
  documentElement?: { lang: string };
}

export interface LocaleStoreOptions {
  storage?: Storage | undefined;
  languages?: readonly string[] | undefined;
  document?: LocaleStoreDocument | undefined;
  window?: Window | undefined;
  resources?: LocaleResourceStore | undefined;
}

export interface LanguageOption {
  readonly value: LanguagePreference;
  readonly label: string;
  readonly unavailable: boolean;
}

/**
 * Language state: the saved `preference` (Auto or an explicit tag) and the
 * `effectiveLocale` resolved against installed language-pack resources. An
 * unavailable pack keeps the preference and displays English until the
 * resource returns.
 */
export class LocaleStore {
  private readonly listeners = new Set<() => void>();
  private preference: LanguagePreference = "auto";
  private locale: Locale = DEFAULT_LOCALE;
  private initialized = false;
  private unsubscribeResources: (() => void) | undefined;
  private storageListener: ((event: StorageEvent) => void) | undefined;
  private readonly options: LocaleStoreOptions;
  private readonly resources: LocaleResourceStore;

  constructor(options: LocaleStoreOptions = {}) {
    this.options = options;
    this.resources = options.resources ?? localeResources;
  }

  initialize(): void {
    if (this.initialized) return;
    this.initialized = true;
    const browserWindow = this.options.window ?? (typeof window === "undefined" ? undefined : window);
    const storage = this.options.storage ?? this.readBrowserStorage(browserWindow);
    const languages = this.options.languages ?? this.readBrowserLanguages();
    this.preference = readLanguagePreference(storage);
    this.locale = this.resolveLocale(this.preference, languages);
    this.applyDocumentLocale();
    this.unsubscribeResources = this.resources.subscribe(() => { this.resourcesChanged(); });
    if (browserWindow !== undefined && typeof browserWindow.addEventListener === "function") {
      this.storageListener = (event: StorageEvent) => {
        if (event.storageArea !== null && event.storageArea !== storage) return;
        if (event.key !== null && event.key !== LANGUAGE_STORAGE_KEY) return;
        // A null key reports a cleared storage area; the stored preference is gone.
        this.updatePreference(event.key === null ? "auto" : readLanguagePreference(storage, event.newValue ?? undefined));
      };
      browserWindow.addEventListener("storage", this.storageListener);
    }
  }

  dispose(): void {
    const browserWindow = this.options.window ?? (typeof window === "undefined" ? undefined : window);
    if (browserWindow !== undefined && this.storageListener !== undefined && typeof browserWindow.removeEventListener === "function") browserWindow.removeEventListener("storage", this.storageListener);
    this.storageListener = undefined;
    this.unsubscribeResources?.();
    this.unsubscribeResources = undefined;
    this.listeners.clear();
    this.initialized = false;
  }

  getPreference(): LanguagePreference {
    this.initialize();
    return this.preference;
  }

  getLocale(): Locale {
    this.initialize();
    return this.locale;
  }

  /** Selectable languages: Auto, English, then one entry per installed language-pack locale. */
  getLanguageOptions(): readonly LanguageOption[] {
    this.initialize();
    const options: LanguageOption[] = [
      { value: "auto", label: this.translate("core.language.auto"), unavailable: false },
      { value: DEFAULT_LOCALE, label: this.translate("core.language.english"), unavailable: false },
    ];
    for (const available of this.availableLocales()) {
      if (normalizeLanguageTag(available.locale) === DEFAULT_LOCALE) continue;
      options.push({ value: available.locale, label: available.label, unavailable: false });
    }
    if (this.preference !== "auto" && !this.isAvailable(this.preference)) {
      options.push({
        value: this.preference,
        label: interpolate(this.translate("core.language.unavailable"), { label: this.preference }),
        unavailable: true,
      });
    }
    return options;
  }

  setPreference(preference: LanguagePreference): void {
    this.initialize();
    const storage = this.options.storage ?? this.readBrowserStorage(this.options.window ?? (typeof window === "undefined" ? undefined : window));
    writeLanguagePreference(storage, preference);
    this.updatePreference(preference);
  }

  subscribe(listener: () => void): () => void {
    this.initialize();
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  translate<Key extends CoreMessageKey>(key: Key, params?: TranslationParams<Key, typeof en>): string;
  translate(key: string, params?: Record<string, string | number>): string;
  translate(key: string, params?: Record<string, string | number>): string {
    this.initialize();
    return interpolate(this.resources.message(this.locale, key), params);
  }

  private availableLocales(): readonly AvailableLocale[] {
    return this.resources.getAvailableLocales();
  }

  private isAvailable(locale: string): boolean {
    return normalizeLanguageTag(locale) === DEFAULT_LOCALE || this.resources.hasLocale(locale);
  }

  private resolveLocale(preference: LanguagePreference, languages: readonly string[]): Locale {
    if (preference !== "auto") return this.resources.findLocale(preference) ?? DEFAULT_LOCALE;
    const auto = this.resources.resolveAutoLocale(languages);
    return auto ?? DEFAULT_LOCALE;
  }

  private updatePreference(preference: LanguagePreference): void {
    const nextLocale = this.resolveLocale(preference, this.options.languages ?? this.readBrowserLanguages());
    const changed = this.preference !== preference || this.locale !== nextLocale;
    this.preference = preference;
    this.locale = nextLocale;
    this.applyDocumentLocale();
    if (changed) this.notify();
  }

  /** Resource publish/revoke notifies subscribers even when the language tag stays the same. */
  private resourcesChanged(): void {
    this.locale = this.resolveLocale(this.preference, this.options.languages ?? this.readBrowserLanguages());
    this.applyDocumentLocale();
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  private applyDocumentLocale(): void {
    const documentRef = this.options.document ?? (typeof document === "undefined" ? undefined : document);
    const documentElement = documentRef?.documentElement;
    if (documentElement !== undefined) documentElement.lang = this.locale;
  }

  private readBrowserStorage(browserWindow: Window | undefined): Storage | undefined {
    try {
      return browserWindow?.localStorage;
    } catch {
      return undefined;
    }
  }

  private readBrowserLanguages(): readonly string[] {
    if (typeof navigator === "undefined") return [];
    return navigator.languages.length > 0 ? navigator.languages : [navigator.language];
  }
}

/** Any syntactic language tag is a valid stored preference; unavailable ones display English. */
export function readLanguagePreference(storage: Pick<Storage, "getItem"> | undefined, value?: string): LanguagePreference {
  try {
    const stored = value ?? storage?.getItem(LANGUAGE_STORAGE_KEY);
    if (stored === "auto" || stored === undefined || stored === null) return "auto";
    return storedPreferencePattern.test(stored) ? stored : "auto";
  } catch {
    return "auto";
  }
}

export function writeLanguagePreference(storage: Pick<Storage, "setItem"> | undefined, preference: LanguagePreference): void {
  try {
    storage?.setItem(LANGUAGE_STORAGE_KEY, preference);
  } catch {
    // Storage is an optional enhancement; the current tab still updates.
  }
}

export const localeStore = new LocaleStore();

export function initializeLocale(): void {
  localeStore.initialize();
}
