import { createSessionStateData, readSessionState, SESSION_STATE_CUSTOM_TYPE } from "@jmfederico/pi-web/server-plugin-api";
import { requireMcpServerName } from "./mcpConfig.js";

export const MANAGED_MCP_SESSION_ENTRY = SESSION_STATE_CUSTOM_TYPE;
export const MANAGED_MCP_SESSION_NAMESPACE = "mcp-manager";

export interface ManagedMcpSessionStore {
  getEntries(): readonly unknown[];
  appendCustomEntry?(customType: string, data?: unknown): string;
}

/** Session preferences follow append order, not the selected conversation branch. */
export function readManagedMcpSession(store: ManagedMcpSessionStore): string[] {
  return parseManagedMcpSessionValue(readSessionState(store.getEntries(), MANAGED_MCP_SESSION_NAMESPACE).value);
}

export function parseManagedMcpSessionValue(value: unknown): string[] {
  if (value === undefined) return [];
  if (!isRecord(value) || value["version"] !== 1 || !Array.isArray(value["enabledServers"])) {
    throw new Error("Invalid saved MCP session settings");
  }
  return [...new Set(value["enabledServers"].map((name) => requireMcpServerName(name, "saved MCP session settings")))];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function managedMcpSessionData(enabledServers: readonly string[]) {
  return createSessionStateData(MANAGED_MCP_SESSION_NAMESPACE, {
    version: 1,
    enabledServers: [...new Set(enabledServers.map((name) => requireMcpServerName(name, "saved MCP session settings")))],
  }, true);
}

export function writeManagedMcpSession(store: ManagedMcpSessionStore, enabledServers: readonly string[]): void {
  if (store.appendCustomEntry === undefined) throw new Error("Session storage does not support MCP preferences");
  store.appendCustomEntry(MANAGED_MCP_SESSION_ENTRY, managedMcpSessionData(enabledServers));
}
