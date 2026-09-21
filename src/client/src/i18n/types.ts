export type LanguagePreference = "auto" | "en" | "zh-CN";

export type Locale = Exclude<LanguagePreference, "auto">;

export type MessageCatalog = Readonly<Record<string, string>>;

export type PlaceholderNames<Value extends string> = Value extends `${string}{${infer Name}}${infer Rest}`
  ? Name | PlaceholderNames<Rest>
  : never;

export type TranslationParams<Key extends string, Catalog extends MessageCatalog> =
  Key extends keyof Catalog
    ? Record<PlaceholderNames<Catalog[Key]>, string | number>
    : Record<string, string | number>;
