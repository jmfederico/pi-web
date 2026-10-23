import { describe, expect, it } from "vitest";
import type { McpCheckResponse, McpServerInfo, McpServersResponse } from "../api";
import { parseMcpCheckResponse, parseMcpServersResponse } from "./parsers";

const server: McpServerInfo = {
  name: "catalog", scope: "user", source: "/home/pi/.pi/agent/mcp.json", enabled: true,
  transport: "http", exposure: "tools", description: "Service catalog", overridden: false,
};
const config: McpServersResponse = {
  servers: [server], errors: [], userConfigPath: server.source,
  projectConfigPath: "/repo/.pi/mcp.json", projectTrusted: false,
};
const check: McpCheckResponse = {
  checkedAt: "2026-10-01T00:00:00Z", errors: ["One connection failed"], note: "Temporary check completed",
  servers: [{ name: "catalog", scope: "project", state: "failed", tools: [], error: "Unavailable" }],
};

describe("MCP response parsers", () => {
  it("keeps only safe summary fields, preserving diagnostics, paths and override information", () => {
    expect(parseMcpServersResponse({
      ...config, token: "secret",
      servers: [{ ...server, env: { TOKEN: "secret" }, headers: { Authorization: "secret" }, args: ["secret"], url: "https://user:secret@example.test" }],
    })).toEqual(config);
    expect(parseMcpServersResponse({ servers: [{ ...server, scope: "project", overridden: true, error: "Invalid server", transport: "unknown" }], errors: ["Invalid file"], userConfigPath: "user.json" })).toEqual({
      servers: [{ ...server, scope: "project", overridden: true, error: "Invalid server", transport: "unknown" }], errors: ["Invalid file"], userConfigPath: "user.json",
    });
    expect(parseMcpServersResponse({ servers: [], errors: [], userConfigPath: "user.json" })).toEqual({ servers: [], errors: [], userConfigPath: "user.json" });
  });

  it.each([
    { servers: {} }, { servers: [null] }, { errors: [2] }, { errors: undefined },
    { userConfigPath: null }, { projectConfigPath: 3 }, { projectTrusted: "yes" },
  ])("rejects malformed configuration response %j", (override) => {
    expect(() => parseMcpServersResponse({ ...config, ...override })).toThrow();
  });

  it.each([
    { name: null }, { scope: "global" }, { source: 1 }, { enabled: "yes" },
    { transport: "sse" }, { exposure: [] }, { description: null }, { overridden: undefined }, { error: 2 },
  ])("rejects malformed server summary %j", (override) => {
    expect(() => parseMcpServersResponse({ ...config, servers: [{ ...server, ...override }] })).toThrow();
  });

  it("parses temporary checks and drops extraneous connection details", () => {
    expect(parseMcpCheckResponse({ ...check, credentials: "secret", servers: check.servers.map((entry) => ({ ...entry, token: "secret" })) })).toEqual(check);
    expect(parseMcpCheckResponse({ checkedAt: "now", servers: [], errors: [] })).toEqual({ checkedAt: "now", servers: [], errors: [] });
  });

  it.each(["disabled", "connecting", "connected", "needs-auth", "failed", "disconnected"])("accepts connection state %s", (state) => {
    expect(parseMcpCheckResponse({ ...check, servers: [{ name: "catalog", scope: "user", state, tools: ["lookup"] }] }).servers[0]?.state).toBe(state);
  });

  it.each([
    { checkedAt: 3 }, { servers: null }, { errors: "failure" }, { note: false },
  ])("rejects malformed check response %j", (override) => {
    expect(() => parseMcpCheckResponse({ ...check, ...override })).toThrow();
  });

  it.each([
    { name: 2 }, { scope: "machine" }, { state: "ready" }, { tools: [2] }, { tools: undefined }, { error: false },
  ])("rejects malformed check entry %j", (override) => {
    expect(() => parseMcpCheckResponse({ ...check, servers: [{ name: "catalog", scope: "user", state: "connected", tools: [], ...override }] })).toThrow();
  });

  it.each([undefined, null, [], "invalid"])("rejects non-object or incomplete responses %j", (value) => {
    expect(() => parseMcpServersResponse(value)).toThrow();
    expect(() => parseMcpCheckResponse(value)).toThrow();
  });
});
