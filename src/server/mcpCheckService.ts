import { fileURLToPath } from "node:url";
import type { McpCheckResponse, McpConnectionInfo } from "../shared/apiTypes.js";
import type { ServerPluginExecFileRequest, ServerPluginExecFileResult } from "../server-plugin-api.js";
import { executeMcpCheck } from "./mcpCheckProcess.js";
import { MCP_CHECK_BOOTSTRAP } from "./mcpCheckBootstrap.js";

export const MCP_CHECK_TIMEOUT_MS = 90_000;

type ExecuteFile = (request: ServerPluginExecFileRequest) => Promise<ServerPluginExecFileResult>;

export interface McpCheckServiceOptions {
  agentDir: string;
  execute?: ExecuteFile;
  cliPath?: string;
  now?: () => Date;
}

/**
 * Use this installation's Pi CLI to diagnose its supported transports/authentication,
 * without duplicating the MCP client or connecting anything when Settings opens.
 * The CLI closes all temporary connections before returning. Exit 1 is a valid
 * diagnostic report (a server failed or needs sign-in), not a failed API request.
 */
export class McpCheckService {
  private readonly execute: ExecuteFile;
  private readonly cliPath: string;
  private readonly now: () => Date;

  constructor(private readonly options: McpCheckServiceOptions) {
    this.execute = options.execute ?? executeMcpCheck;
    // Resolve from Pi's installed SDK, never a potentially unrelated `pi` on PATH.
    this.cliPath = options.cliPath ?? fileURLToPath(new URL("./cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")));
    this.now = options.now ?? (() => new Date());
  }

  async check(cwd?: string, signal: AbortSignal = new AbortController().signal): Promise<McpCheckResponse> {
    const result = await this.execute({
      file: process.execPath,
      args: ["--input-type=module", "--eval", MCP_CHECK_BOOTSTRAP, this.cliPath, "mcp", "list", "--json"],
      // The profile directory provides a neutral cwd for a machine-wide check;
      // the workspace route supplies a server-resolved cwd for project checks.
      cwd: cwd ?? this.options.agentDir,
      env: { PI_CODING_AGENT_DIR: this.options.agentDir, PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" },
      timeoutMs: MCP_CHECK_TIMEOUT_MS,
      signal,
    });
    if (result.signal !== null || (result.exitCode !== 0 && result.exitCode !== 1)) {
      throw new Error("Pi's MCP connection check could not complete");
    }
    if (result.stdoutTruncated) throw new Error("Pi's MCP connection check exceeded the output limit");
    return parseCheckReport(result.stdout, this.now().toISOString());
  }
}

function parseCheckReport(text: string, checkedAt: string): McpCheckResponse {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("Pi's MCP connection check did not return a JSON report");
  }
  if (!isRecord(value) || !Array.isArray(value["servers"]) || !isStringArray(value["errors"])) {
    throw new Error("Pi's MCP connection check returned an invalid report");
  }
  const servers = value["servers"].map(parseConnection);
  const note = value["note"];
  if (note !== undefined && typeof note !== "string") throw new Error("Invalid MCP connection check note");
  const errors = value["errors"].length === 0 ? [] : ["Pi reported MCP configuration errors. Run pi mcp list on this machine for detailed diagnostics."];
  const notes = [
    ...(note === undefined ? [] : ["Project MCP configuration was skipped because Pi has no saved trust decision for this workspace."]),
    "Pi CLI checks do not use auth.provider credentials. Provider-auth servers may report needs-auth even when they work in a session; use /mcp in that session to verify them.",
  ];
  return { checkedAt, servers, errors, note: notes.join(" ") };
}

const CONNECTION_STATES = new Set(["disabled", "connecting", "connected", "needs-auth", "failed", "disconnected"]);

function parseConnection(value: unknown): McpConnectionInfo {
  if (!isRecord(value)
    || typeof value["name"] !== "string"
    || (value["scope"] !== "global" && value["scope"] !== "project")
    || !isConnectionState(value["state"])
    || !isStringArray(value["tools"])
    || (value["error"] !== undefined && typeof value["error"] !== "string")) {
    throw new Error("Invalid MCP connection check server");
  }
  // Intentionally project only diagnostics: the CLI's transport field can contain
  // arguments or an authenticated URL, neither of which belongs in the browser.
  return {
    name: value["name"],
    scope: value["scope"] === "global" ? "user" : "project",
    state: value["state"],
    tools: value["tools"],
    ...(value["error"] === undefined ? {} : { error: safeConnectionError(value["state"]) }),
  };
}

// Pi diagnostics can include raw server stderr, HTTP bodies, or JSON parser
// excerpts. Never forward these to browsers: they can echo resolved secrets.
function safeConnectionError(state: McpConnectionInfo["state"]): string {
  return state === "needs-auth"
    ? "Authentication required for this temporary check."
    : "Connection failed. Run pi mcp list on this machine for detailed diagnostics.";
}

function isConnectionState(value: unknown): value is McpConnectionInfo["state"] {
  return typeof value === "string" && CONNECTION_STATES.has(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry: unknown) => typeof entry === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
