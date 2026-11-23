import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createManagedMcpConfigService, managedMcpAgentDir } from "./config.js";
import { updateConfigDocument } from "./storage.js";
import { parseManagedMcpConfig } from "./mcpConfig.js";

let root: string;
let globalPath: string;
let projectPath: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mcp-manager-config-"));
  globalPath = join(root, "agent", "mcp-manager", "config.json");
  projectPath = join(root, ".pi", "mcp-manager.json");
  mkdirSync(join(root, "agent", "mcp-manager"), { recursive: true });
  mkdirSync(join(root, ".pi"));
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });
const stdio = { command: "server", env: { TOKEN: "private" } };
const http = { url: "https://mcp.example.test", headers: { Authorization: "secret" } };
function put(path: string, value: unknown): void { writeFileSync(path, JSON.stringify(value)); }
function service(env: NodeJS.ProcessEnv = {}) { return createManagedMcpConfigService({ env: { PI_CODING_AGENT_DIR: join(root, "agent"), ...env }, cwd: root }); }
function context() { return { cwd: root, projectTrusted: true }; }

describe("MCP manager configuration", () => {
  it("adds trusted project/session intent without renaming and ignores PI WEB configuration", () => {
    put(globalPath, { servers: { shared: stdio, session_only: http }, enabledServers: ["shared"] });
    put(projectPath, { servers: { project: http }, enabledServers: ["project"] });
    const result = service({ PI_WEB_MCP: "not-json", PI_WEB_CONFIG: "missing" }).read({ ...context(), sessionEnabledServers: ["session_only"] });
    expect(result.definitions.map((entry) => entry.name)).toEqual(["shared", "session_only", "project"]);
    expect(result.enabledServers).toEqual(["shared", "session_only", "project"]);
    expect(result.enabledByScope).toEqual({ global: ["shared"], project: ["project"], session: ["session_only"] });
    expect(JSON.stringify(result.view)).not.toMatch(/private|Authorization|secret/);
    expect(result.view).toMatchObject({ globalConfigPath: globalPath, projectConfigPath: projectPath, globalWritable: true, projectWritable: true, sessionWritable: true });
    expect(managedMcpAgentDir({ env: { PI_CODING_AGENT_DIR: "agent" }, cwd: root })).toBe(join(root, "agent"));
  });

  it("never reads untrusted project content and supports global-only reads", () => {
    writeFileSync(globalPath, `\uFEFF${JSON.stringify({ servers: { shared: stdio } })}`);
    writeFileSync(projectPath, '{ secret invalid json');
    expect(service().read({ cwd: root, projectTrusted: false }).definitions.map((entry) => entry.name)).toEqual(["shared"]);
    expect(service().read({ projectTrusted: false }).view.projectConfigPath).toBeUndefined();
    expect(() => service().read(context())).toThrow("invalid JSON");
    expect(() => service().read(context())).not.toThrow("secret");
  });

  it("reports duplicate names and normalized namespace conflicts without shadow merging", () => {
    put(globalPath, { servers: { shared: stdio, "foo-bar": http }, enabledServers: ["shared", "foo-bar"] });
    put(projectPath, { servers: { shared: http, foo_bar: stdio }, enabledServers: ["foo_bar"] });
    const result = service().read(context());
    expect(result.conflicts).toEqual(["shared", "foo-bar", "foo_bar"]);
    expect(result.enabledServers).toEqual([]);
    expect(result.view.servers.map((entry) => entry.name)).toEqual(["shared", "foo-bar", "foo_bar"]);
    expect(result.view.servers.every((entry) => entry.error !== undefined)).toBe(true);
  });

  it("enforces independent environment leaves across all scopes and retains hidden saved intent", () => {
    put(globalPath, { servers: { shared: stdio }, enabledServers: ["shared"] });
    put(projectPath, { servers: { project: http }, enabledServers: ["project"] });
    const enforced = service({ PI_MCP_MANAGER: '{"enabledServers":[]}' });
    const result = enforced.read({ ...context(), sessionEnabledServers: ["shared"] });
    expect(result.enabledServers).toEqual([]);
    expect(result.view).toMatchObject({ globalWritable: false, projectWritable: false, sessionWritable: false });
    expect(() => enforced.setEnabled({ ...context(), scope: "global", serverName: "shared", enabled: false, revision: enforced.read(context()).view.revision })).toThrow("read-only");
    expect(service().read(context()).enabledServers).toEqual(["shared", "project"]);
    const definitionsPolicy = service({ PI_MCP_MANAGER: '{"servers":{}}' }).read(context());
    expect(definitionsPolicy.definitions).toEqual([]);
    expect(definitionsPolicy.view.sessionWritable).toBe(true);
    expect(() => service({ PI_MCP_MANAGER: "private-invalid-json" }).read(context())).toThrow("PI_MCP_MANAGER");
    expect(() => service({ PI_MCP_MANAGER: "private-invalid-json" }).read(context())).not.toThrow("private-invalid-json");
  });

  it("applies enforced enablement to trusted project definitions without treating it as a saved global grant", () => {
    put(globalPath, { servers: { shared: stdio }, enabledServers: ["shared"] });
    put(projectPath, { servers: { local: http }, enabledServers: [] });
    const enforced = service({ PI_MCP_MANAGER: '{"enabledServers":["local"]}' });
    const result = enforced.read({ ...context(), sessionEnabledServers: ["shared"] });
    expect(result.enabledServers).toEqual(["local"]);
    expect(result.enabledByScope).toEqual({ global: [], project: ["local"], session: [] });
    expect(result.view.servers.find((entry) => entry.name === "local")).toMatchObject({ effectiveEnabled: true, enabled: { global: false, project: true } });
    expect(result.view).toMatchObject({ globalWritable: false, projectWritable: false, sessionWritable: false });
    expect(result.view.issues).not.toContain("Globally enabled MCP server local has no global definition.");
    expect(enforced.read({ cwd: root, projectTrusted: false }).enabledServers).toEqual([]);
    expect(enforced.read({ projectTrusted: false }).enabledServers).toEqual([]);
    // Policy never writes the saved scope choices or bypasses a definition policy.
    expect(service().read(context()).enabledServers).toEqual(["shared"]);
    expect(service({ PI_MCP_MANAGER: '{"servers":{},"enabledServers":["local"]}' }).read(context()).enabledServers).toEqual([]);
  });

  it("changes only selected scope, preserves raw definitions, and rejects stale external edits", () => {
    const raw = { ...http, exposure: "codemode-deferred" };
    put(globalPath, { servers: { shared: raw }, enabledServers: ["shared"] });
    put(projectPath, { enabledServers: ["shared"] });
    const config = service();
    const stale = config.read(context());
    put(projectPath, { enabledServers: ["shared", "missing"] });
    const external = readFileSync(projectPath, "utf8");
    expect(() => config.setEnabled({ ...context(), scope: "project", serverName: "shared", enabled: false, revision: stale.view.revision })).toThrow("changed");
    expect(readFileSync(projectPath, "utf8")).toBe(external);
    const result = config.setEnabled({ ...context(), scope: "project", serverName: "shared", enabled: false, revision: config.read(context()).view.revision });
    expect(result.enabledServers).toEqual(["shared"]);
    expect(JSON.parse(readFileSync(projectPath, "utf8"))).toEqual({ enabledServers: ["missing"] });
    const globalResult = config.setEnabled({ ...context(), scope: "global", serverName: "shared", enabled: false, revision: result.view.revision });
    expect(globalResult.enabledServers).toEqual([]);
    expect(JSON.parse(readFileSync(globalPath, "utf8"))).toEqual({ servers: { shared: raw }, enabledServers: [] });
  });

  it("rejects globally enabling a project definition", () => {
    put(projectPath, { servers: { project: http }, enabledServers: [] });
    const config = service();
    expect(() => config.setEnabled({ ...context(), scope: "global", serverName: "project", enabled: true, revision: config.read(context()).view.revision })).toThrow("cannot be enabled globally");
  });

  it("keeps dangling global grants inactive for project definitions without erasing saved intent", () => {
    put(globalPath, { servers: { shared: stdio }, enabledServers: ["project_only", "missing"] });
    put(projectPath, { servers: { project_only: http } });
    const config = service();
    const initial = config.read(context());
    expect(initial.enabledServers).toEqual([]);
    expect(initial.view.servers.find((entry) => entry.name === "project_only")).toMatchObject({ enabled: { global: false, project: false }, effectiveEnabled: false });
    expect(initial.view.issues).toHaveLength(2);
    const global = config.setEnabled({ ...context(), scope: "global", serverName: "shared", enabled: true, revision: initial.view.revision });
    expect(global.enabledServers).toEqual(["shared"]);
    expect(global.enabledByScope.global).toEqual(["project_only", "missing", "shared"]);
    const project = config.setEnabled({ ...context(), scope: "project", serverName: "project_only", enabled: true, revision: global.view.revision });
    expect(project.enabledServers).toEqual(["shared", "project_only"]);
  });

  it.skipIf(process.platform === "win32")("protects project aliases of global files and preserves symlinks", () => {
    put(globalPath, { servers: { shared: stdio } });
    symlinkSync(globalPath, projectPath);
    expect(service().read(context()).view.projectWritable).toBe(false);
    const target = join(root, "target.json");
    put(target, { enabledServers: [] });
    rmSync(globalPath);
    symlinkSync(target, globalPath);
    updateConfigDocument(globalPath, ({ record }) => ({ ...record, enabledServers: ["shared"] }));
    expect(JSON.parse(readFileSync(target, "utf8"))).toEqual({ enabledServers: ["shared"] });
  });

  it("refuses lock contention or manual edits during publication", () => {
    put(globalPath, {});
    mkdirSync(`${globalPath}.mcp-manager-lock`);
    expect(() => { updateConfigDocument(globalPath, () => ({})); }).toThrow("being updated");
    rmSync(`${globalPath}.mcp-manager-lock`, { recursive: true });
    expect(() => { updateConfigDocument(globalPath, () => {
      put(globalPath, { enabledServers: ["external"] });
      return { enabledServers: [] };
    }); }).toThrow("changed during update");
    expect(JSON.parse(readFileSync(globalPath, "utf8"))).toEqual({ enabledServers: ["external"] });
  });

  it.skipIf(process.platform === "win32")("creates private files and preserves existing permissions", () => {
    updateConfigDocument(globalPath, () => ({}));
    expect(statSync(globalPath).mode & 0o777).toBe(0o600);
    writeFileSync(projectPath, "{}", { mode: 0o640 });
    updateConfigDocument(projectPath, () => ({}));
    expect(statSync(projectPath).mode & 0o777).toBe(0o640);
  });

  it("validates files/env consistently and blocks project provider credential forwarding", () => {
    const valid = { servers: { shared: stdio }, enabledServers: ["shared"] };
    expect(parseManagedMcpConfig(valid, "test")).toEqual(valid);
    expect(service({ PI_MCP_MANAGER: JSON.stringify(valid) }).read(context()).enabledServers).toEqual(["shared"]);
    for (const invalid of [{ enabledServers: "shared" }, { enabledServers: ["bad.name"] }, { servers: { x: { command: "run", enabled: false } } }, { servers: { x: { command: "run", env: { SECRET: 2 } } } }, { mcp: valid }]) {
      expect(() => parseManagedMcpConfig(invalid, "test")).toThrow("MCP manager");
      expect(() => service({ PI_MCP_MANAGER: JSON.stringify(invalid) }).read(context())).toThrow("PI_MCP_MANAGER");
    }
    put(projectPath, { servers: { x: { url: "https://example.test", auth: { provider: "private-provider" } } } });
    expect(() => service().read(context())).toThrow("project servers cannot use auth.provider");
    expect(() => service().read(context())).not.toThrow("private-provider");
  });
});
