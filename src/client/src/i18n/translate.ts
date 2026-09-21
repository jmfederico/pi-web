import { en } from "./locales/en";
import { zhCN } from "./locales/zh-CN";
import type { Locale, TranslationParams } from "./types";

export type MessageKey = keyof typeof en;

const catalogs: { en: typeof en; "zh-CN": typeof zhCN } = {
  en,
  "zh-CN": zhCN,
};

export function translate<Key extends MessageKey>(locale: Locale, key: Key, params?: TranslationParams<Key, typeof en>): string {
  const message = catalogs[locale][key];
  return interpolate(message, params);
}

export function interpolate(message: string, params?: Record<string, string | number>): string {
  if (params === undefined) return message;
  return message.replace(/\{([A-Za-z0-9_.-]+)\}/gu, (placeholder, name: string) => {
    const value = params[name];
    return value === undefined ? placeholder : String(value);
  });
}

export function messageKeys(): readonly MessageKey[] {
  return Object.keys(en).filter((key): key is MessageKey => key in en);
}

export function messagePlaceholders(message: string): readonly string[] {
  return [...message.matchAll(/\{([A-Za-z0-9_.-]+)\}/gu)].map((match) => match[1] ?? "");
}

export { en, zhCN };
