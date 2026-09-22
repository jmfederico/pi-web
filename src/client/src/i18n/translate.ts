import { en } from "./locales/en";
import type { MessageCatalog } from "./types";

/** Pure interpolation; values stay text and Lit escapes them at render time. */
export function interpolate(message: string, params?: Record<string, string | number>): string {
  if (params === undefined) return message;
  return message.replace(/\{([A-Za-z0-9_.-]+)\}/gu, (placeholder, name: string) => {
    const value = params[name];
    return value === undefined ? placeholder : String(value);
  });
}

export function messageKeys(catalog: MessageCatalog): readonly string[] {
  return Object.keys(catalog);
}

export function messagePlaceholders(message: string): readonly string[] {
  return [...message.matchAll(/\{([A-Za-z0-9_.-]+)\}/gu)].map((match) => match[1] ?? "");
}

export { en };
