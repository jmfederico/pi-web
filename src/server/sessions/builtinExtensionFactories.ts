import { spawn } from "node:child_process";
import { McpAuthFlowService } from "./mcpAuthFlowService.js";
import { createCodemodeExtension, createMcpExtension, createToolSearchExtension, type InlineExtension } from "../../piSdk.js";

// Pi 1.x guarantees these exports. Create factories lazily and share them across
// session resource loaders; missing exports must not silently disable builtins.
let cachedPromise: Promise<InlineExtension[]> | undefined;

export function getBuiltinExtensionFactories(): Promise<InlineExtension[]> {
  cachedPromise ??= Promise.resolve().then(() => [
    { name: "mcp", factory: createMcpExtension({ openUrl: openMcpUrl }), builtin: true, replaceable: true },
    { name: "codemode", factory: createCodemodeExtension(), builtin: true, replaceable: true },
    { name: "tool-search", factory: createToolSearchExtension(), builtin: true, replaceable: true },
  ]);
  return cachedPromise;
}

function openMcpUrl(url: string): void {
  const operation = McpAuthFlowService.current();
  if (operation) {
    operation.openUrl(url);
    return;
  }
  // Preserve Pi's best-effort browser launch outside modal operations. Use no
  // shell: authorization URLs can contain shell metacharacters.
  const [command, args] = process.platform === "darwin" ? ["open", [url]]
    : process.platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", url]] : ["xdg-open", [url]];
  spawn(command, args, { stdio: "ignore", detached: true }).on("error", () => { /* URL is also presented by Pi's UI. */ }).unref();
}
