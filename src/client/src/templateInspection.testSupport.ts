import type { TemplateResult } from "lit";

/**
 * Shared Lit `TemplateResult` inspection seam for tests — an ESCAPE HATCH.
 *
 * This repository runs Vitest with no DOM environment (`vitest.config.ts` sets
 * the default node environment), so real shadow-DOM click harnesses are not
 * available. The `testing-guide` skill treats direct `TemplateResult`
 * inspection (calling `render()`, reading `strings`/`values`, and invoking an
 * event handler found near a stable marker) as an escape hatch that is only
 * proportionate when:
 *
 *   1. the test is specifically verifying Lit template event wiring;
 *   2. a DOM/custom-element render harness would add disproportionate setup,
 *      flakiness, or noise for the behavior being checked;
 *   3. the assertion checks observable component/controller effects, not Lit
 *      internals;
 *   4. the lookup is anchored to stable semantic markup, labels, or
 *      user-facing text rather than incidental handler order;
 *   5. the test stays narrow.
 *
 * Because that escape hatch was being copy-pasted as ad-hoc per-file helper
 * variants, the skill's "consolidate deliberately rather than copy-pasting
 * variants" rule applies: this module is the single, strictly-typed,
 * type-guarded consolidation. Prefer public component/controller/helper seams
 * first; reach for these helpers only for genuine event-wiring extraction, and
 * keep each call site anchored to a stable marker. Do NOT use these helpers for
 * general content, text, attribute, ordering, styling, layout, focus, keyboard,
 * or accessibility assertions — move those to a public seam.
 *
 * Every accessor is type-guarded and fails with a clear error if Lit's private
 * template shape cannot be inspected, so tests never silently assert against
 * `undefined`.
 */

export type TemplateEventHandler<E extends Event = Event> = (event: E) => void;

/** True when `value` is a Lit `TemplateResult` (guarded by its private shape). */
export function isTemplateResult(value: unknown): value is TemplateResult {
  return (
    typeof value === "object" &&
    value !== null &&
    isStringArray(Reflect.get(value, "strings")) &&
    Array.isArray(Reflect.get(value, "values"))
  );
}

/** The static string chunks of a single `TemplateResult`, or throw. */
export function templateStrings(template: TemplateResult): readonly string[] {
  const strings = Reflect.get(template, "strings");
  if (!isStringArray(strings)) throw new Error("TemplateResult strings were unavailable");
  return strings;
}

/** The interpolated values of a single `TemplateResult`, or throw. */
export function templateValues(template: TemplateResult): readonly unknown[] {
  const values = Reflect.get(template, "values");
  if (!Array.isArray(values)) throw new Error("TemplateResult values were unavailable");
  return values.map((value: unknown) => value);
}

/** True when `value` is usable as a template event handler. */
export function isTemplateEventHandler<E extends Event = Event>(value: unknown): value is TemplateEventHandler<E> {
  return typeof value === "function";
}

/**
 * Flatten static markup interleaved with primitive (string/number) values into
 * a single string, in document order.
 */
export function templateText(value: unknown): string {
  if (Array.isArray(value)) return value.map((item) => templateText(item)).join("");
  if (isTemplateResult(value)) {
    const strings = templateStrings(value);
    const values = templateValues(value);
    return strings.map((part, index) => `${part}${index < values.length ? templateText(values[index]) : ""}`).join("");
  }
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

/**
 * Every interpolated value whose immediately preceding static chunk includes
 * `marker`, collected across the whole tree in document order.
 *
 * Anchor `marker` to stable attribute markup (e.g. `src=`, `?open=`,
 * `data-scroll-anchor-id=`).
 */
export function templateValuesAfterMarker(template: TemplateResult, marker: string): unknown[] {
  const matches: unknown[] = [];
  visit(template);
  return matches;

  function visit(value: unknown): void {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!isTemplateResult(value)) return;
    const strings = templateStrings(value);
    const values = templateValues(value);
    for (let index = 0; index < values.length; index += 1) {
      if (strings[index]?.includes(marker) === true) matches.push(values[index]);
      visit(values[index]);
    }
  }
}

/** The first value whose preceding static chunk includes `marker`, or throw. */
export function templateValueAfterMarker(template: TemplateResult, marker: string): unknown {
  const matches = templateValuesAfterMarker(template, marker);
  if (matches.length === 0) throw new Error(`Expected template marker ${marker}`);
  return matches[0];
}

/**
 * Find an event handler whose adjacent static markup (the chunk immediately
 * before or after the handler value) includes `marker`.
 *
 * Use for attribute-anchored wiring such as `@click=`, `@load=`, `@toggle=`, or
 * a marker in the text right after the handler (e.g. `>Clear queue</button>`).
 */
export function templateEventHandlerNearMarker<E extends Event = Event>(template: TemplateResult, marker: string): TemplateEventHandler<E> {
  const handler = findOptionalTemplateEventHandlerNearMarker<E>(template, marker);
  if (handler === undefined) throw new Error(`Expected template event handler near ${marker}`);
  return handler;
}

/** Optional variant of {@link templateEventHandlerNearMarker}. */
export function findOptionalTemplateEventHandlerNearMarker<E extends Event = Event>(template: TemplateResult, marker: string): TemplateEventHandler<E> | undefined {
  return visit(template);

  function visit(value: unknown): TemplateEventHandler<E> | undefined {
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = visit(item);
        if (found !== undefined) return found;
      }
      return undefined;
    }
    if (!isTemplateResult(value)) return undefined;
    const strings = templateStrings(value);
    const values = templateValues(value);
    for (let index = 0; index < values.length; index += 1) {
      const candidate = values[index];
      const isNearMarker = strings[index]?.includes(marker) === true || strings[index + 1]?.includes(marker) === true;
      if (isNearMarker && isTemplateEventHandler<E>(candidate)) return candidate;
      const nested = visit(candidate);
      if (nested !== undefined) return nested;
    }
    return undefined;
  }
}

/**
 * Find the first event handler that appears at or after the static chunk
 * containing `marker`.
 *
 * Use when the marker is not the handler's own attribute but a stable anchor
 * that precedes it (e.g. a `send-button` id whose `@click=` handler follows).
 */
export function templateEventHandlerAfterMarker<E extends Event = Event>(template: TemplateResult, marker: string): TemplateEventHandler<E> {
  const handler = findOptionalTemplateEventHandlerAfterMarker<E>(template, marker);
  if (handler === undefined) throw new Error(`Expected template event handler after marker ${marker}`);
  return handler;
}

/** Optional variant of {@link templateEventHandlerAfterMarker}. */
export function findOptionalTemplateEventHandlerAfterMarker<E extends Event = Event>(template: TemplateResult, marker: string): TemplateEventHandler<E> | undefined {
  const strings = templateStrings(template);
  const values = templateValues(template);
  for (let index = 0; index < values.length; index += 1) {
    if (strings[index]?.includes(marker) === true) {
      for (let handlerIndex = index; handlerIndex < values.length; handlerIndex += 1) {
        const candidate = values[handlerIndex];
        if (isTemplateEventHandler<E>(candidate)) return candidate;
      }
    }
    const nested = findInValue(values[index]);
    if (nested !== undefined) return nested;
  }
  return undefined;

  function findInValue(value: unknown): TemplateEventHandler<E> | undefined {
    if (Array.isArray(value)) {
      for (const item of value) {
        const nested = findInValue(item);
        if (nested !== undefined) return nested;
      }
      return undefined;
    }
    if (isTemplateResult(value)) return findOptionalTemplateEventHandlerAfterMarker<E>(value, marker);
    return undefined;
  }
}

/**
 * Find an event handler that appears after a specific interpolated value.
 *
 * Anchors to a stable value (e.g. an accessible label like `Remove report.pdf`)
 * and then locates the handler tagged by `marker` (e.g. `@click=`) that follows
 * it, so the wiring is tied to user-facing content rather than handler order.
 */
export function templateEventHandlerAfterValue<E extends Event = Event>(template: TemplateResult, expectedValue: unknown, marker: string): TemplateEventHandler<E> {
  const handler = findOptionalTemplateEventHandlerAfterValue<E>(template, expectedValue, marker);
  if (handler === undefined) throw new Error(`Expected template event handler after value ${String(expectedValue)}`);
  return handler;
}

/** Optional variant of {@link templateEventHandlerAfterValue}. */
export function findOptionalTemplateEventHandlerAfterValue<E extends Event = Event>(template: TemplateResult, expectedValue: unknown, marker: string): TemplateEventHandler<E> | undefined {
  const strings = templateStrings(template);
  const values = templateValues(template);
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === expectedValue) {
      for (let handlerIndex = index + 1; handlerIndex < values.length; handlerIndex += 1) {
        const candidate = values[handlerIndex];
        if (strings[handlerIndex]?.includes(marker) === true && isTemplateEventHandler<E>(candidate)) return candidate;
      }
    }
    const nested = findInValue(value);
    if (nested !== undefined) return nested;
  }
  return undefined;

  function findInValue(value: unknown): TemplateEventHandler<E> | undefined {
    if (Array.isArray(value)) {
      for (const item of value) {
        const nested = findInValue(item);
        if (nested !== undefined) return nested;
      }
      return undefined;
    }
    if (isTemplateResult(value)) return findOptionalTemplateEventHandlerAfterValue<E>(value, expectedValue, marker);
    return undefined;
  }
}

/**
 * Find a click handler on the deepest template whose flattened text includes
 * `text`.
 *
 * Anchors wiring to user-facing row/label text (e.g. a file name) rather than
 * incidental handler order.
 */
export function templateClickHandlerForText<E extends Event = Event>(template: TemplateResult, text: string, clickMarker = "@click"): TemplateEventHandler<E> {
  const handler = findOptionalTemplateClickHandlerForText<E>(template, text, clickMarker);
  if (handler === undefined) throw new Error(`Expected click handler near ${text}`);
  return handler;
}

/** Optional variant of {@link templateClickHandlerForText}. */
export function findOptionalTemplateClickHandlerForText<E extends Event = Event>(value: unknown, text: string, clickMarker = "@click"): TemplateEventHandler<E> | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = findOptionalTemplateClickHandlerForText<E>(item, text, clickMarker);
      if (nested !== undefined) return nested;
    }
    return undefined;
  }
  if (!isTemplateResult(value)) return undefined;

  for (const item of templateValues(value)) {
    const nested = findOptionalTemplateClickHandlerForText<E>(item, text, clickMarker);
    if (nested !== undefined) return nested;
  }
  if (!templateText(value).includes(text)) return undefined;

  const strings = templateStrings(value);
  const values = templateValues(value);
  for (let index = 0; index < values.length; index += 1) {
    const candidate = values[index];
    if (strings[index]?.includes(clickMarker) === true && isTemplateEventHandler<E>(candidate)) return candidate;
  }
  return undefined;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item: unknown) => typeof item === "string");
}
