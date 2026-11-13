import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { hasManagedMcpProjectConfig, readNativeMcpNames } from "./nativeMcpNames.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "mcp-manager-native-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  mkdirSync(agentDir); mkdirSync(join(cwd, ".pi"), { recursive: true });
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }); });
  return { root, agentDir, cwd };
}

it("reserves disabled native namespaces and never reads untrusted native project files", () => {
  const { cwd, agentDir } = fixture();
  writeFileSync(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { "native-name": { enabled: false } } }));
  writeFileSync(join(cwd, ".pi", "mcp.json"), "invalid-secret");
  expect([...readNativeMcpNames(agentDir, cwd, false)]).toEqual(["native_name"]);
  expect(() => readNativeMcpNames(agentDir, cwd, true)).toThrow("Cannot read valid Pi MCP configuration");
  expect(() => readNativeMcpNames(agentDir, cwd, true)).not.toThrow("invalid-secret");
});

it("detects project config presence without parsing executable content", () => {
  const { cwd } = fixture();
  expect(hasManagedMcpProjectConfig(cwd)).toBe(false);
  writeFileSync(join(cwd, ".pi", "mcp-manager.json"), "invalid-secret");
  expect(hasManagedMcpProjectConfig(cwd)).toBe(true);
});

it.skipIf(process.platform === "win32")("treats a broken project config symlink as trust-requiring content", () => {
  const { cwd, root } = fixture();
  symlinkSync(join(root, "missing"), join(cwd, ".pi", "mcp-manager.json"));
  expect(hasManagedMcpProjectConfig(cwd)).toBe(true);
});
