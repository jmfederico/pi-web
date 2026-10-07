import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

// pi owns the set of thinking levels. We re-export pi's type so the domain has a
// single source of truth, while the HTTP/wire contract (apiTypes.ts) keeps using
// `string` so an unknown level reported by a newer pi runtime degrades gracefully
// instead of failing to parse.
export type { ThinkingLevel };

/**
 * Known levels in increasing intensity, derived from pi's `ThinkingLevel` union.
 * The `satisfies` clause makes this fail to compile if pi removes or renames a
 * level; thinkingLevels.test.ts adds a compile-time check for additions too. When
 * either breaks, update this list and give the new level a label/description
 * where thinking levels are presented.
 */
export const KNOWN_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const satisfies readonly ThinkingLevel[];

export function isKnownThinkingLevel(value: string): value is ThinkingLevel {
  return KNOWN_THINKING_LEVELS.some((level) => level === value);
}

export function thinkingLevelLabel(level: string | undefined): string {
  return level === undefined || level === "" ? "off" : level;
}
