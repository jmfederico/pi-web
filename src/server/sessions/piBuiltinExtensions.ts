import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";

/**
 * Pi's built-in extensions (currently the llama.cpp provider) are exported
 * only from the SDK's CLI entry, not from its public API surface, and the
 * package export map blocks subpath imports of that module. Resolve the
 * package root from the main entry's module URL and import the internal
 * module directly; a layout change in a future SDK release degrades to "no
 * built-in extensions" rather than a startup failure, because everything that
 * depends on them is optional.
 */
let builtinExtensionsPromise: Promise<InlineExtension[]> | undefined;

export function loadPiBuiltinExtensions(): Promise<InlineExtension[]> {
  return builtinExtensionsPromise ??= loadPiBuiltinExtensionsOnce();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isInlineExtension(value: unknown): value is InlineExtension {
  if (typeof value === "function") return true;
  if (!isRecord(value)) return false;
  return typeof value["factory"] === "function";
}

async function loadPiBuiltinExtensionsOnce(): Promise<InlineExtension[]> {
  try {
    const entry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
    const packageRoot = dirname(dirname(entry));
    const moduleUrl = pathToFileURL(join(packageRoot, "dist/extensions/index.js")).href;
    const module: unknown = await import(/* @vite-ignore */ moduleUrl);
    const builtInExtensions = isRecord(module) ? module["builtInExtensions"] : undefined;
    if (!Array.isArray(builtInExtensions)) return [];
    return builtInExtensions.filter(isInlineExtension);
  } catch {
    return [];
  }
}

