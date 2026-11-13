import { join } from "node:path";
import { readConfigDocument } from "../../configFileStorage.js";

/** Only detect ownership conflicts. Pi alone resolves and validates native MCP configuration. */
export function readNativeMcpNames(agentDir: string, cwd?: string, projectTrusted = false): Set<string> {
  const names = new Set<string>();
  const paths = [join(agentDir, "mcp.json"), ...(cwd !== undefined && projectTrusted ? [join(cwd, ".pi", "mcp.json")] : [])];
  for (const path of paths) {
    let value: unknown;
    try { value = readConfigDocument(path).record; }
    catch { throw new Error(`Cannot read valid Pi MCP configuration at ${path}`); }
    if (!record(value) || (value["mcpServers"] !== undefined && !record(value["mcpServers"]))) {
      throw new Error(`Invalid Pi MCP configuration at ${path}`);
    }
    for (const name of Object.keys(value["mcpServers"] ?? {})) names.add(mcpNamespaceKey(name));
  }
  return names;
}

export function mcpNamespaceKey(name: string): string { return name.replaceAll("-", "_"); }

/** .pi-web MCP commands require trust even when the workspace contains no .pi resources. */
export function hasManagedMcpProjectConfig(cwd: string): boolean {
  try {
    return readConfigDocument(join(cwd, ".pi-web", "config.json")).record["mcp"] !== undefined;
  } catch {
    // An unreadable or malformed project file must never bypass a trust decision.
    return true;
  }
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
