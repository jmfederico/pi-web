/**
 * Known levels in increasing intensity, derived from pi's `ThinkingLevel` union.
 * The `satisfies` clause makes this fail to compile if pi removes or renames a
 * level; thinkingLevels.test.ts adds a compile-time check for additions too. When
 * either breaks, update this list and give the new level a label/description
 * where thinking levels are presented.
 */
export declare const KNOWN_THINKING_LEVELS: readonly ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
export type ThinkingLevel = (typeof KNOWN_THINKING_LEVELS)[number];
export declare function isKnownThinkingLevel(value: string): value is ThinkingLevel;
export declare function thinkingLevelLabel(level: string | undefined): string;
export interface ThinkingGauge {
    /** Number of bars to render (the non-"off" levels). */
    total: number;
    /** Number of filled bars for the current level. */
    filled: number;
}
/**
 * Describe a thinking-level gauge from the available set rather than a hardcoded
 * table, so it stays correct even if pi changes the available levels at runtime.
 *
 * Convention: the first available level is treated as "no thinking". The gauge
 * therefore renders one bar per remaining level, and fills up to the current
 * level's rank. An unknown current level fills 0 bars instead of throwing.
 */
export declare function thinkingGauge(level: string | undefined, available: readonly string[]): ThinkingGauge;
