import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServerPluginExecFileRequest, ServerPluginExecFileResult } from "../server-plugin-api.js";
import { McpCheckService, MCP_CHECK_TIMEOUT_MS } from "./mcpCheckService.js";

const report = {
  servers: [
    { name: "docs", scope: "global", state: "connected", tools: ["search"], transport: "https://user:secret@example.test/mcp?token=secret" },
    { name: "sentry", scope: "project", state: "needs-auth", tools: [], error: "Sign-in required" },
  ],
  errors: [],
  note: "Project configuration is ignored until trusted",
};

function result(stdout: string, exitCode = 0): ServerPluginExecFileResult {
  return { stdout, stderr: "", exitCode, signal: null, stdoutTruncated: false, stderrTruncated: false };
}

afterEach(() => { vi.restoreAllMocks(); });

describe("McpCheckService", () => {
  it("uses the captured profile, fixed argv, resolved workspace, and projects safe diagnostic fields", async () => {
    const execute = vi.fn<(request: ServerPluginExecFileRequest) => Promise<ServerPluginExecFileResult>>(() => Promise.resolve(result(JSON.stringify(report), 1)));
    const check = new McpCheckService({ agentDir: "/active/profile", cliPath: "/installed/pi/cli.js", execute, now: () => new Date("2026-01-02T00:00:00Z") });
    const signal = new AbortController().signal;
    const response = await check.check("/managed/workspace", signal);
    expect(execute).toHaveBeenCalledWith({
      file: process.execPath,
      args: ["--input-type=module", "--eval", expect.stringContaining("cp.spawn ="), "/installed/pi/cli.js", "mcp", "list", "--json"],
      cwd: "/managed/workspace",
      env: { PI_CODING_AGENT_DIR: "/active/profile", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" },
      timeoutMs: MCP_CHECK_TIMEOUT_MS,
      signal,
    });
    expect(response).toEqual({
      checkedAt: "2026-01-02T00:00:00.000Z",
      servers: [
        { name: "docs", scope: "user", state: "connected", tools: ["search"] },
        { name: "sentry", scope: "project", state: "needs-auth", tools: [], error: "Authentication required for this temporary check." },
      ],
      errors: [],
      note: "Project MCP configuration was skipped because Pi has no saved trust decision for this workspace. Pi CLI checks do not use auth.provider credentials. Provider-auth servers may report needs-auth even when they work in a session; use /mcp in that session to verify them.",
    });
    expect(JSON.stringify(response)).not.toContain("secret");
    expect(JSON.stringify(response)).not.toContain("/mcp login");
    expect(JSON.stringify(response)).not.toContain("OAuth");
  });

  it("never exposes raw errors, stderr, HTTP bodies, parser excerpts or notes, and explains provider-auth limitations", async () => {
    const secret = "resolved-credential-private";
    const output = { servers: [{ name: "docs", scope: "global", state: "failed", tools: [], error: `HTTP error: ${secret}; stderr: ${secret}` }], errors: [`Invalid JSON near ${secret}`], note: secret };
    const checker = new McpCheckService({ agentDir: "/profile", execute: () => Promise.resolve(result(JSON.stringify(output), 1)) });
    const response = await checker.check();
    expect(JSON.stringify(response)).not.toContain(secret);
    expect(response.errors).toEqual(["Pi reported MCP configuration errors. Run pi mcp list on this machine for detailed diagnostics."]);
    expect(response.servers[0]?.error).toContain("Connection failed");
    expect(response.note).toContain("do not use auth.provider credentials");
  });

  it("checks user-wide configuration from a neutral profile cwd", async () => {
    const execute = vi.fn<(request: ServerPluginExecFileRequest) => Promise<ServerPluginExecFileResult>>(() => Promise.resolve(result(JSON.stringify({ servers: [], errors: [] }))));
    await new McpCheckService({ agentDir: "/profile", execute }).check();
    expect(execute.mock.calls[0]?.[0]).toMatchObject({ cwd: "/profile" });
  });

  it.each([
    result("not json"),
    result(JSON.stringify({ servers: [], errors: "bad" })),
    result(JSON.stringify({ servers: [{ ...report.servers[0], state: "invented" }], errors: [] })),
    result(JSON.stringify({ servers: [], errors: [] }), 2),
    { ...result("{}"), stdoutTruncated: true },
    { ...result("{}"), signal: "SIGTERM" as const },
  ])("rejects incomplete or invalid checks instead of reporting success", async (output) => {
    const check = new McpCheckService({ agentDir: "/profile", execute: () => Promise.resolve(output) });
    await expect(check.check()).rejects.toThrow();
  });

  it("propagates cancellation/executor failure", async () => {
    const check = new McpCheckService({ agentDir: "/profile", execute: () => Promise.reject(new Error("cancelled")) });
    await expect(check.check()).rejects.toThrow("cancelled");
  });
});
