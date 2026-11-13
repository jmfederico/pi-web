import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createManagedMcpConfigService } from "./managedMcpConfig.js";
import { updateConfigDocument } from "../../configFileStorage.js";
import { applyPiWebConfigEnv, parsePiWebConfig, piWebConfigEnforcedSettings } from "../../config.js";

let root: string;
let globalPath: string;
let projectPath: string;
let defaultsPath: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pi-web-managed-mcp-"));
  globalPath = join(root, "global.json");
  defaultsPath = join(root, "defaults.json");
  projectPath = join(root, ".pi-web", "config.json");
  mkdirSync(join(root, ".pi-web"));
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });
const stdio = { command: "server", env: { TOKEN: "private" } };
const http = { url: "https://mcp.example.test", headers: { Authorization: "secret" } };
function put(path: string, value: unknown): void { writeFileSync(path, JSON.stringify(value)); }
function service(env: NodeJS.ProcessEnv = {}) { return createManagedMcpConfigService({ env: { PI_WEB_CONFIG: globalPath, ...env }, cwd: root }); }
function context() { return { cwd: root, projectTrusted: true }; }

describe("managed MCP config", () => {
  it("keeps machine/defaults replacement atomic and adds trusted project/session intent without renaming", () => {
    put(defaultsPath, { mcp: { servers: { inherited: http }, enabledServers: ["shared"] } });
    put(globalPath, { mcp: { servers: { shared: stdio, session_only: http } } });
    put(projectPath, { mcp: { servers: { project: http }, enabledServers: ["project"] } });
    const result = service({ PI_WEB_DEFAULTS_CONFIG: defaultsPath }).read({ ...context(), sessionEnabledServers: ["session_only"] });
    expect(result.definitions.map((entry) => entry.name)).toEqual(["shared", "session_only", "project"]);
    expect(result.enabledServers).toEqual(["shared", "session_only", "project"]);
    expect(result.enabledByScope).toEqual({ global: ["shared"], project: ["project"], session: ["session_only"] });
    expect(JSON.stringify(result.view)).not.toMatch(/private|Authorization|secret/);
    expect(result.view).toMatchObject({ globalWritable: true, projectWritable: true, sessionWritable: true });
  });

  it("never reads untrusted project content and supports machine-only reads", () => {
    writeFileSync(globalPath, `\uFEFF${JSON.stringify({ mcp: { servers: { shared: stdio } } })}`);
    writeFileSync(projectPath, '{ secret invalid json');
    expect(service().read({ cwd: root, projectTrusted: false }).definitions.map((entry) => entry.name)).toEqual(["shared"]);
    expect(service().read({ projectTrusted: false }).view.projectConfigPath).toBeUndefined();
    expect(() => service().read(context())).toThrow("invalid JSON");
    expect(() => service().read(context())).not.toThrow("secret");
  });

  it("reports duplicate names and normalized namespace conflicts without shadow merging", () => {
    put(globalPath, { mcp: { servers: { shared: stdio, "foo-bar": http }, enabledServers: ["shared", "foo-bar"] } });
    put(projectPath, { mcp: { servers: { shared: http, foo_bar: stdio }, enabledServers: ["foo_bar"] } });
    const result = service().read(context());
    expect(result.conflicts).toEqual(["shared", "foo-bar", "foo_bar"]);
    expect(result.enabledServers).toEqual([]);
    expect(result.view.servers.map((entry) => entry.name)).toEqual(["shared", "foo-bar", "foo_bar"]);
    expect(result.view.servers.every((entry) => entry.error !== undefined)).toBe(true);
  });

  it("enforces independent environment leaves across all scopes and keeps hidden saved intent", () => {
    put(globalPath, { mcp: { servers: { shared: stdio }, enabledServers: ["shared"] } });
    put(projectPath, { mcp: { servers: { project: http }, enabledServers: ["project"] } });
    const enforced = service({ PI_WEB_MCP: '{"enabledServers":[]}' });
    const result = enforced.read({ ...context(), sessionEnabledServers: ["shared"] });
    expect(result.enabledServers).toEqual([]);
    expect(result.view).toMatchObject({ globalWritable: false, projectWritable: false, sessionWritable: false });
    expect(() => enforced.setEnabled({ ...context(), scope: "global", serverName: "shared", enabled: false, revision: enforced.read(context()).view.revision })).toThrow("read-only");
    expect(service().read(context()).enabledServers).toEqual(["shared", "project"]);
    const definitionsPolicy = service({ PI_WEB_MCP: '{"servers":{}}' }).read(context());
    expect(definitionsPolicy.definitions).toEqual([]);
    expect(definitionsPolicy.view.sessionWritable).toBe(true);
    expect(piWebConfigEnforcedSettings({ PI_WEB_MCP: '{"servers":{}}' })).toEqual({ "/mcp/servers": "PI_WEB_MCP" });
  });

  it("changes only the selected scope, preserves current raw content, and rejects stale external edits", () => {
    put(globalPath, { mcp: { servers: { shared: stdio }, enabledServers: ["shared"] }, future: { untouched: true } });
    put(projectPath, { mcp: { enabledServers: ["shared"] }, plugins: { custom: { settings: { value: 3 } } } });
    const config = service();
    const stale = config.read(context());
    put(projectPath, { mcp: { enabledServers: ["shared"] }, future: "external edit" });
    const external = readFileSync(projectPath, "utf8");
    expect(() => config.setEnabled({ ...context(), scope: "project", serverName: "shared", enabled: false, revision: stale.view.revision })).toThrow("changed");
    expect(readFileSync(projectPath, "utf8")).toBe(external);
    const result = config.setEnabled({ ...context(), scope: "project", serverName: "shared", enabled: false, revision: config.read(context()).view.revision });
    expect(result.enabledServers).toEqual(["shared"]);
    expect(JSON.parse(readFileSync(projectPath, "utf8"))).toEqual({ mcp: { enabledServers: [] }, future: "external edit" });
    const globalResult = config.setEnabled({ ...context(), scope: "global", serverName: "shared", enabled: false, revision: result.view.revision });
    expect(globalResult.enabledServers).toEqual([]);
    expect(JSON.parse(readFileSync(globalPath, "utf8"))).toEqual({ mcp: { servers: { shared: stdio }, enabledServers: [] }, future: { untouched: true } });
  });

  it("rejects globally enabling a project definition and writing deployment defaults", () => {
    put(projectPath, { mcp: { servers: { project: http }, enabledServers: [] } });
    const config = service();
    expect(() => config.setEnabled({ ...context(), scope: "global", serverName: "project", enabled: true, revision: config.read(context()).view.revision })).toThrow("cannot be enabled globally");
    put(globalPath, { mcp: { servers: { shared: stdio } } });
    expect(service({ PI_WEB_DEFAULTS_CONFIG: globalPath }).read(context()).view.globalWritable).toBe(false);
  });

  it("keeps dangling global grants inactive for project definitions without erasing saved intent", () => {
    put(globalPath, { mcp: { servers: { shared: stdio }, enabledServers: ["project_only", "missing"] } });
    put(projectPath, { mcp: { servers: { project_only: http } } });
    const config = service();
    const initial = config.read(context());
    expect(initial.enabledServers).toEqual([]);
    expect(initial.view.servers.find((entry) => entry.name === "project_only")).toMatchObject({ enabled: { global: false, project: false }, effectiveEnabled: false });
    expect(initial.view.issues).toHaveLength(2);
    expect(initial.view.issues.some((issue) => issue.includes("project_only"))).toBe(true);
    expect(initial.view.issues.some((issue) => issue.includes("missing"))).toBe(true);
    const global = config.setEnabled({ ...context(), scope: "global", serverName: "shared", enabled: true, revision: initial.view.revision });
    expect(global.enabledServers).toEqual(["shared"]);
    expect(global.enabledByScope.global).toEqual(["project_only", "missing", "shared"]);
    expect(JSON.parse(readFileSync(globalPath, "utf8"))).toEqual({ mcp: { servers: { shared: stdio }, enabledServers: ["project_only", "missing", "shared"] } });
    const project = config.setEnabled({ ...context(), scope: "project", serverName: "project_only", enabled: true, revision: global.view.revision });
    expect(project.enabledServers).toEqual(["shared", "project_only"]);
    expect(project.view.servers.find((entry) => entry.name === "project_only")).toMatchObject({ enabled: { global: false, project: true }, effectiveEnabled: true });
  });

  it.skipIf(process.platform === "win32")("protects symlink aliases of deployment defaults", () => {
    put(defaultsPath, { mcp: { servers: { shared: stdio } } });
    symlinkSync(defaultsPath, globalPath);
    expect(service({ PI_WEB_DEFAULTS_CONFIG: defaultsPath }).read(context()).view.globalWritable).toBe(false);
  });

  it.skipIf(process.platform === "win32")("preserves symlinks when publishing changes", () => {
    const target = join(root, "target.json");
    put(target, { quietMode: true });
    symlinkSync(target, globalPath);
    updateConfigDocument(globalPath, ({ record }) => ({ ...record, askUser: false }));
    expect(JSON.parse(readFileSync(target, "utf8"))).toEqual({ quietMode: true, askUser: false });
  });

  it("refuses lock contention or a manual edit during publication", () => {
    put(globalPath, { quietMode: true });
    mkdirSync(`${globalPath}.pi-web-lock`);
    expect(() => { updateConfigDocument(globalPath, () => ({})); }).toThrow("being updated");
    rmSync(`${globalPath}.pi-web-lock`, { recursive: true });
    expect(() => { updateConfigDocument(globalPath, () => {
      put(globalPath, { external: "keep me" });
      return { stale: true };
    }); }).toThrow("changed during update");
    expect(JSON.parse(readFileSync(globalPath, "utf8"))).toEqual({ external: "keep me" });
  });

  it("validates definitions consistently in files/env and blocks project provider credential forwarding", () => {
    const valid = { servers: { shared: stdio }, enabledServers: ["shared"] };
    expect(parsePiWebConfig({ mcp: valid }).mcp).toEqual(valid);
    expect(applyPiWebConfigEnv({}, { PI_WEB_MCP: JSON.stringify(valid) }).mcp).toEqual(valid);
    for (const invalid of [{ enabledServers: "shared" }, { enabledServers: ["bad.name"] }, { servers: { x: { command: "run", enabled: false } } }, { servers: { x: { command: "run", env: { SECRET: 2 } } } }]) {
      expect(() => parsePiWebConfig({ mcp: invalid })).toThrow("PI WEB config mcp");
      expect(() => applyPiWebConfigEnv({}, { PI_WEB_MCP: JSON.stringify(invalid) })).toThrow("PI_WEB_MCP");
    }
    put(projectPath, { mcp: { servers: { x: { url: "https://example.test", auth: { provider: "private-provider" } } } } });
    expect(() => service().read(context())).toThrow("project servers cannot use auth.provider");
    expect(() => service().read(context())).not.toThrow("private-provider");
  });
});
