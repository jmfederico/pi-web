import type { ManagedMcpRuntimeState } from "./runtime.js";

export const MCP_MANAGER_REQUEST = "mcp-manager:request";
export const MCP_MANAGER_RESPONSE = "mcp-manager:response";
export interface McpManagerRequest { id: string; action: "refresh" | "view" }
export type McpManagerResponse = { id: string; state: ManagedMcpRuntimeState; projectTrusted: boolean } | { id: string; error: string };

/** Browser-safe MCP management data. Connection definitions and credentials never cross this boundary. */
export type ManagedMcpScope = "global" | "project" | "session";

export interface ManagedMcpContext {
  cwd?: string;
  sessionId?: string;
}

export interface ManagedMcpServerView {
  name: string;
  description?: string;
  definitionScope: "global" | "project";
  enabled: { global: boolean; project?: boolean; session?: boolean };
  /** Additive manager intent, not proof that the MCP transport is connected. */
  effectiveEnabled: boolean;
  pending?: boolean;
  error?: string;
  nativeConflict?: boolean;
}

export interface ManagedMcpView {
  globalConfigPath: string;
  projectConfigPath?: string;
  projectTrusted: boolean;
  globalWritable: boolean;
  projectWritable: boolean;
  sessionWritable: boolean;
  servers: ManagedMcpServerView[];
  issues: string[];
  revision: string;
}

export interface ManagedMcpUpdate extends ManagedMcpContext {
  scope: ManagedMcpScope;
  serverName: string;
  enabled: boolean;
  revision: string;
}
