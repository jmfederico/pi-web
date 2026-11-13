import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createManagedMcpConfigService } from "./managedMcpConfig.js";
import { ManagedMcpService } from "./managedMcpService.js";
import { MANAGED_MCP_SESSION_ENTRY, readManagedMcpSession } from "./managedMcpSession.js";
import { hasManagedMcpProjectConfig } from "./nativeMcpNames.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "managed-mcp-service-")); directories.push(root);
  const agentDir = join(root, "agent"); mkdirSync(agentDir);
  const cwd = join(root, "project"); mkdirSync(cwd);
  const configPath = join(root, "config.json");
  writeFileSync(configPath, JSON.stringify({ mcp: { servers: { docs: { url: "https://example.test/mcp", headers: { Authorization: "secret" } } } } }));
  const config = createManagedMcpConfigService({ env: { PI_WEB_CONFIG: configPath } });
  const service = new ManagedMcpService(config, agentDir);
  const entries: unknown[] = [];
  const manager = {
    getCwd: () => cwd, getEntries: () => entries, getBranch: () => [],
    appendCustomEntry: (customType: string, data?: unknown) => { entries.push({ type: "custom", customType, data }); return String(entries.length); },
  };
  const context = { cwd, sessionId: "session" };
  return { root, agentDir, cwd, configPath, service, manager, entries, context };
}

it("persists session grants without changing definitions, exposes no secrets, and protects stale edits", () => {
  const f = fixture();
  const before = readFileSync(f.configPath, "utf8");
  const view = f.service.view(f.context, true, f.manager);
  expect(JSON.stringify(view)).not.toContain("secret");
  expect(JSON.stringify(view)).not.toContain("https://example.test");
  f.service.update({ ...f.context, scope: "session", serverName: "docs", enabled: true, revision: view.revision }, true, f.manager);
  expect(readManagedMcpSession(f.manager)).toEqual(["docs"]);
  expect(f.service.view(f.context, true, f.manager).servers[0]).toMatchObject({ enabled: { global: false, project: false, session: true }, effectiveEnabled: true });
  expect(readFileSync(f.configPath, "utf8")).toBe(before);
  expect(() => { f.service.update({ ...f.context, scope: "session", serverName: "docs", enabled: false, revision: view.revision }, true, f.manager); }).toThrow("changed");
  expect(readManagedMcpSession(f.manager)).toEqual(["docs"]);
});

it("removing a session grant does not disable a global grant", () => {
  const f = fixture();
  let view = f.service.view(f.context, true, f.manager);
  f.service.update({ ...f.context, scope: "global", serverName: "docs", enabled: true, revision: view.revision }, true, f.manager);
  view = f.service.view(f.context, true, f.manager);
  f.service.update({ ...f.context, scope: "session", serverName: "docs", enabled: false, revision: view.revision }, true, f.manager);
  expect(f.service.view(f.context, true, f.manager).servers[0]).toMatchObject({ enabled: { global: true, session: false }, effectiveEnabled: true });
});

it("native disabled entries retain ownership and block session grants without editing either file", () => {
  const f = fixture();
  const nativePath = join(f.agentDir, "mcp.json");
  const native = JSON.stringify({ mcpServers: { docs: { url: "https://native.test", enabled: false } } });
  writeFileSync(nativePath, native);
  const view = f.service.view(f.context, true, f.manager);
  expect(view.servers[0]?.nativeConflict).toBe(true);
  expect(() => { f.service.update({ ...f.context, scope: "session", serverName: "docs", enabled: true, revision: view.revision }, true, f.manager); }).toThrow("defined in Pi");
  expect(readManagedMcpSession(f.manager)).toEqual([]);
  expect(readFileSync(nativePath, "utf8")).toBe(native);
});

it("does not read untrusted project native files and fails closed on malformed saved session state", () => {
  const f = fixture();
  mkdirSync(join(f.cwd, ".pi"));
  writeFileSync(join(f.cwd, ".pi", "mcp.json"), "invalid secret text");
  expect(f.service.view(f.context, false, f.manager).servers[0]?.nativeConflict).toBeUndefined();
  expect(() => f.service.view(f.context, true, f.manager)).toThrow("Cannot read valid Pi MCP configuration");
  f.entries.push({ type: "custom", customType: MANAGED_MCP_SESSION_ENTRY, data: { version: 1, enabledServers: "bad" } });
  expect(() => readManagedMcpSession(f.manager)).toThrow("Invalid saved");
});

it("requires project trust for managed config even without any Pi resources", () => {
  const f = fixture();
  expect(hasManagedMcpProjectConfig(f.cwd)).toBe(false);
  mkdirSync(join(f.cwd, ".pi-web"));
  writeFileSync(join(f.cwd, ".pi-web", "config.json"), JSON.stringify({ mcp: { enabledServers: ["docs"] } }));
  expect(hasManagedMcpProjectConfig(f.cwd)).toBe(true);
});
