export const MANAGED_MCP_SESSION_ENTRY = "pi-web.mcp-enabled";

export interface ManagedMcpSessionStore {
  getBranch(): readonly unknown[];
  getEntries?(): readonly unknown[];
  appendCustomEntry?(customType: string, data?: unknown): string;
}

/** Session preferences are not conversation-branch state; tree navigation must not undo a toggle. */
export function readManagedMcpSession(store: ManagedMcpSessionStore): string[] {
  const entries = store.getEntries?.() ?? store.getBranch();
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (!record(entry) || entry["type"] !== "custom" || entry["customType"] !== MANAGED_MCP_SESSION_ENTRY) continue;
    const data = entry["data"];
    if (!record(data) || data["version"] !== 1 || !Array.isArray(data["enabledServers"])) {
      throw new Error("Invalid saved MCP session settings");
    }
    const values: readonly unknown[] = data["enabledServers"];
    const names: string[] = [];
    for (const name of values) {
      if (typeof name !== "string" || !/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error("Invalid saved MCP session settings");
      names.push(name);
    }
    return [...new Set(names)];
  }
  return [];
}

export function writeManagedMcpSession(store: ManagedMcpSessionStore, enabledServers: readonly string[]): void {
  if (store.appendCustomEntry === undefined) throw new Error("Session storage does not support MCP preferences");
  store.appendCustomEntry(MANAGED_MCP_SESSION_ENTRY, { version: 1, enabledServers: [...new Set(enabledServers)] });
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
