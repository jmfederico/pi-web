import { join } from "node:path";
import { lstatSync } from "node:fs";
import { readConfigDocument } from "./storage.js";

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

/** Presence is enough to require trust; never parse untrusted project configuration. */
export function hasManagedMcpProjectConfig(cwd: string): boolean {
  try {
    lstatSync(join(cwd, ".pi", "mcp-manager.json"));
    return true;
  } catch (error) {
    // Only absence permits skipping trust; even a broken symlink requires it.
    return !(error instanceof Error && "code" in error && error.code === "ENOENT");
  }
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
