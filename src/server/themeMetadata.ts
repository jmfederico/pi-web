import type { PiWebThemeMetadata, PiWebThemePairMetadata } from "../shared/themeCatalog.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Package metadata is data only; no browser or server module is evaluated. */
export function parseThemeMetadata(entry: Record<string, unknown>, source: string): {
  themes?: PiWebThemeMetadata[];
  themePairs?: PiWebThemePairMetadata[];
} {
  const fail = (detail: string): never => { throw new Error(`Invalid PI WEB theme metadata in ${source}: ${detail}`); };
  function record(value: unknown): Record<string, unknown> {
    if (!isRecord(value)) return fail("expected an object");
    return value;
  }
  function text(value: unknown): string {
    if (typeof value !== "string" || value.trim() === "") return fail("expected non-empty text");
    return value;
  }
  function id(value: unknown): string {
    const result = text(value);
    if (!/^[a-z][a-z0-9.-]*$/u.test(result)) return fail(`invalid local ID ${result}`);
    return result;
  }
  function common(value: Record<string, unknown>) {
    const description = value["description"];
    const order = value["order"];
    if (description !== undefined && typeof description !== "string") fail("description must be text");
    if (order !== undefined && (typeof order !== "number" || !Number.isFinite(order))) fail("order must be finite");
    return {
      id: id(value["id"]), name: text(value["name"]),
      ...(typeof description === "string" ? { description } : {}),
      ...(typeof order === "number" ? { order } : {}),
    };
  }
  function list<T extends { id: string }>(value: unknown, parse: (item: Record<string, unknown>) => T): T[] | undefined {
    if (value === undefined) return undefined;
    if (!Array.isArray(value)) return fail("expected an array");
    const result = value.map((item: unknown) => parse(record(item)));
    if (new Set(result.map((item) => item.id)).size !== result.length) fail("duplicate ID");
    return result;
  }
  const themes = list(entry["themes"], (value): PiWebThemeMetadata => {
    const colorScheme = value["colorScheme"];
    if (colorScheme !== "light" && colorScheme !== "dark") return fail("colorScheme must be light or dark");
    const stylesheets = list(value["stylesheets"], (sheet) => {
      const path = text(sheet["path"]);
      if (path.includes("\\") || path.includes("\0") || path.split("/").some((part) => part === "" || part === "." || part === "..")) fail("unsafe stylesheet path");
      const order = sheet["order"];
      if (order !== undefined && (typeof order !== "number" || !Number.isFinite(order))) fail("stylesheet order must be finite");
      return { id: id(sheet["id"]), path, ...(typeof order === "number" ? { order } : {}) };
    });
    if (stylesheets === undefined || stylesheets.length === 0) return fail("stylesheets must not be empty");
    return { ...common(value), colorScheme, stylesheets };
  });
  const themePairs = list(entry["themePairs"], (value): PiWebThemePairMetadata => ({ ...common(value), light: id(value["light"]), dark: id(value["dark"]) }));
  const allIds = [...(themes ?? []), ...(themePairs ?? [])].map((item) => item.id);
  if (new Set(allIds).size !== allIds.length) fail("theme and pair IDs must be distinct");
  for (const pair of themePairs ?? []) {
    if (themes?.some((theme) => theme.id === pair.light && theme.colorScheme === "light") !== true
      || !themes.some((theme) => theme.id === pair.dark && theme.colorScheme === "dark")) fail("pair members must reference local themes with matching color schemes");
  }
  return { ...(themes === undefined ? {} : { themes }), ...(themePairs === undefined ? {} : { themePairs }) };
}
