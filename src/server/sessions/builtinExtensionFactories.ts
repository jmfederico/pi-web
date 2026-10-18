import { createCodemodeExtension, createMcpExtension, createToolSearchExtension, type InlineExtension } from "@earendil-works/pi-coding-agent";
import { withDefaultSearchMcp } from "./defaultSearchMcp.js";

// Pi 1.x guarantees these exports. Create factories lazily and share them across
// session resource loaders; missing exports must not silently disable builtins.
let cachedPromise: Promise<InlineExtension[]> | undefined;

export function getBuiltinExtensionFactories(): Promise<InlineExtension[]> {
  cachedPromise ??= Promise.resolve().then(() => [
    { name: "mcp", factory: withDefaultSearchMcp(createMcpExtension()), builtin: true, replaceable: true },
    { name: "codemode", factory: createCodemodeExtension(), builtin: true, replaceable: true },
    { name: "tool-search", factory: createToolSearchExtension(), builtin: true, replaceable: true },
  ]);
  return cachedPromise;
}
