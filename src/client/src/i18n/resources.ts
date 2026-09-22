import { en } from "./locales/en";
import type { AvailableLocale, LocaleResourceContribution } from "./types";

export const DEFAULT_LOCALE = "en";

/**
 * Merged view of every installed language-pack catalog. Contributions are
 * expected to be registry-validated; duplicates here fail loudly instead of
 * silently overriding an earlier provider.
 */
export class LocaleResourceStore {
  private readonly listeners = new Set<() => void>();
  private readonly catalogsByLocale = new Map<string, Map<string, string>>();
  private readonly availableByLocale = new Map<string, AvailableLocale>();
  private resourceVersion = 0;

  /** Replaces the installed resources with one validated snapshot and notifies on any change. */
  update(contributions: readonly LocaleResourceContribution[]): void {
    const catalogsByLocale = new Map<string, Map<string, string>>();
    const availableByLocale = new Map<string, AvailableLocale>();
    const ordered = [...contributions].sort((left, right) =>
      left.locale.localeCompare(right.locale) || left.namespace.localeCompare(right.namespace));
    for (const contribution of ordered) {
      const tag = normalizeLanguageTag(contribution.locale);
      let messages = catalogsByLocale.get(tag);
      if (messages === undefined) {
        messages = new Map<string, string>();
        catalogsByLocale.set(tag, messages);
      }
      for (const [key, message] of Object.entries(contribution.messages)) {
        const qualifiedKey = `${contribution.namespace}.${key}`;
        if (messages.has(qualifiedKey)) {
          throw new Error(`Duplicate locale message for ${contribution.locale} ${qualifiedKey}`);
        }
        messages.set(qualifiedKey, message);
      }
      const existing = availableByLocale.get(tag);
      if (existing === undefined) {
        availableByLocale.set(tag, {
          locale: contribution.locale,
          label: contribution.label,
          aliases: [...new Set((contribution.aliases ?? []).map(normalizeLanguageTag))].filter((alias) => alias !== tag),
        });
      } else {
        availableByLocale.set(tag, {
          locale: existing.locale,
          label: existing.label,
          aliases: [...new Set([...existing.aliases, ...(contribution.aliases ?? []).map(normalizeLanguageTag)])]
            .filter((alias) => alias !== tag),
        });
      }
    }
    this.catalogsByLocale.clear();
    for (const [tag, messages] of catalogsByLocale) this.catalogsByLocale.set(tag, messages);
    this.availableByLocale.clear();
    for (const [tag, available] of availableByLocale) this.availableByLocale.set(tag, available);
    this.resourceVersion += 1;
    this.notify();
  }

  getAvailableLocales(): readonly AvailableLocale[] {
    return [...this.availableByLocale.values()].sort((left, right) => left.locale.localeCompare(right.locale));
  }

  /** Whether `locale` (or one of its aliases/prefixes) names an installed language. */
  hasLocale(locale: string): boolean {
    return this.findLocale(locale) !== undefined;
  }

  /** Resolves a browser language tag to the declared installed locale tag, or undefined. */
  findLocale(languageTag: string): string | undefined {
    const tag = normalizeLanguageTag(languageTag);
    // English is the always-available built-in language.
    if (tag === DEFAULT_LOCALE || tag.startsWith(`${DEFAULT_LOCALE}-`)) return DEFAULT_LOCALE;
    const exact = this.availableByLocale.get(tag);
    if (exact !== undefined) return exact.locale;
    for (const [installedTag, { locale, aliases }] of this.availableByLocale) {
      if (aliases.includes(tag)) return locale;
      if (tag.startsWith(`${installedTag}-`)) return locale;
      if (aliases.some((alias) => tag.startsWith(`${alias}-`))) return locale;
    }
    return undefined;
  }

  /** First installed locale matching the browser preference order. */
  resolveAutoLocale(languages: readonly string[]): string | undefined {
    for (const language of languages) {
      const resolved = this.findLocale(language);
      if (resolved !== undefined) return resolved;
    }
    return undefined;
  }

  /** Message lookup for `locale`; missing keys fall back to English per key, then to the key itself. */
  message(locale: string, key: string): string {
    const localized = this.catalogsByLocale.get(normalizeLanguageTag(locale))?.get(key);
    if (localized !== undefined) return localized;
    return coreDefaultMessage(key) ?? reportMissingMessageKey(locale, key);
  }

  get version(): number {
    return this.resourceVersion;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

const coreDefaults: Readonly<Record<string, string>> = en;
let missingKeySink: ((locale: string, key: string) => void) | undefined;

/** Development diagnostics for missing keys; production keeps the silent key fallback. */
export function setMissingMessageKeyDiagnostics(sink: ((locale: string, key: string) => void) | undefined): void {
  missingKeySink = sink;
}

function coreDefaultMessage(key: string): string | undefined {
  return coreDefaults[key];
}

function reportMissingMessageKey(locale: string, key: string): string {
  missingKeySink?.(locale, key);
  return key;
}

export function normalizeLanguageTag(tag: string): string {
  return tag.trim().toLowerCase().replaceAll("_", "-");
}

/** Shared, empty until language packs register their contributions. */
export const localeResources = new LocaleResourceStore();
