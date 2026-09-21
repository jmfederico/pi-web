import { translate, type MessageKey } from "./translate";
import type { LanguagePreference, Locale, TranslationParams } from "./types";

export const LANGUAGE_STORAGE_KEY = "pi-web-app-language";

export interface LocaleStoreDocument {
  documentElement?: { lang: string };
}

export interface LocaleStoreOptions {
  storage?: Storage | undefined;
  languages?: readonly string[] | undefined;
  document?: LocaleStoreDocument | undefined;
  window?: Window | undefined;
}

export function resolveLocale(preference: LanguagePreference, languages: readonly string[] = []): Locale {
  if (preference === "en" || preference === "zh-CN") return preference;
  return languages.some(isSimplifiedChineseLanguage) ? "zh-CN" : "en";
}

export function isSimplifiedChineseLanguage(language: string): boolean {
  const normalized = language.trim().toLowerCase().replaceAll("_", "-");
  return normalized === "zh-cn"
    || normalized.startsWith("zh-cn-")
    || normalized === "zh-sg"
    || normalized.startsWith("zh-sg-")
    || normalized === "zh-hans"
    || normalized.startsWith("zh-hans-");
}

export function readLanguagePreference(storage: Pick<Storage, "getItem"> | undefined): LanguagePreference {
  try {
    const value = storage?.getItem(LANGUAGE_STORAGE_KEY);
    return value === "en" || value === "zh-CN" || value === "auto" ? value : "auto";
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

export class LocaleStore {
  private readonly listeners = new Set<() => void>();
  private preference: LanguagePreference = "auto";
  private locale: Locale = "en";
  private initialized = false;
  private storageListener: ((event: StorageEvent) => void) | undefined;
  private readonly options: LocaleStoreOptions;

  constructor(options: LocaleStoreOptions = {}) {
    this.options = options;
  }

  initialize(): void {
    if (this.initialized) return;
    this.initialized = true;
    const browserWindow = this.options.window ?? (typeof window === "undefined" ? undefined : window);
    const storage = this.options.storage ?? this.readBrowserStorage(browserWindow);
    const languages = this.options.languages ?? this.readBrowserLanguages();
    this.preference = readLanguagePreference(storage);
    this.locale = resolveLocale(this.preference, languages);
    this.applyDocumentLocale();
    if (browserWindow !== undefined && typeof browserWindow.addEventListener === "function") {
      this.storageListener = (event: StorageEvent) => {
        if (event.storageArea !== null && event.storageArea !== storage) return;
        if (event.key !== null && event.key !== LANGUAGE_STORAGE_KEY) return;
        const next = event.newValue === "en" || event.newValue === "zh-CN" || event.newValue === "auto" ? event.newValue : "auto";
        this.updatePreference(next);
      };
      browserWindow.addEventListener("storage", this.storageListener);
    }
  }

  dispose(): void {
    const browserWindow = this.options.window ?? (typeof window === "undefined" ? undefined : window);
    if (browserWindow !== undefined && this.storageListener !== undefined && typeof browserWindow.removeEventListener === "function") browserWindow.removeEventListener("storage", this.storageListener);
    this.storageListener = undefined;
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

  translate<Key extends MessageKey>(key: Key, params?: TranslationParams<Key, typeof import("./locales/en").en>): string {
    return translate(this.getLocale(), key, params);
  }

  private updatePreference(preference: LanguagePreference): void {
    const nextLocale = resolveLocale(preference, this.options.languages ?? this.readBrowserLanguages());
    const changed = this.preference !== preference || this.locale !== nextLocale;
    this.preference = preference;
    this.locale = nextLocale;
    this.applyDocumentLocale();
    if (changed) this.notify();
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

export const localeStore = new LocaleStore();

export function initializeLocale(): void {
  localeStore.initialize();
}
