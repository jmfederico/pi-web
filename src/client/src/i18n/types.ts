import type { en } from "./locales/en";

/** "auto" or an explicit language tag such as "en" or "zh-CN". */
export type LanguagePreference = string;

/** Effective display language. English is always available without language packs. */
export type Locale = string;

export type MessageCatalog = Readonly<Record<string, string>>;

export type CoreMessageKey = keyof typeof en;

export type PlaceholderNames<Value extends string> = Value extends `${string}{${infer Name}}${infer Rest}`
  ? Name | PlaceholderNames<Rest>
  : never;

export type TranslationParams<Key extends string, Catalog extends MessageCatalog> =
  Key extends keyof Catalog
    ? Record<PlaceholderNames<Catalog[Key]>, string | number>
    : Record<string, string | number>;

/** One namespaced catalog published by an installed language pack. */
export interface LocaleResourceContribution {
  readonly locale: string;
  readonly label: string;
  readonly aliases?: readonly string[];
  readonly namespace: string;
  readonly messages: Readonly<Record<string, string>>;
}

/** A language selectable in the UI, derived from installed resources. */
export interface AvailableLocale {
  readonly locale: string;
  readonly label: string;
  readonly aliases: readonly string[];
}
