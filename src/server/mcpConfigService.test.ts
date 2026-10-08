import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import { access, chmod, mkdir, mkdtemp, readFile, readdir, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectTrustStore, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileMcpConfigService } from "./mcpConfigService.js";

// Plain copies expose deterministic filesystem failure/interleaving seams;
// the persistence tests still use real files and Pi's real config writer/queue.
vi.mock("node:fs", async (importOriginal) => ({ ...(await importOriginal<typeof fsSync>()) }));
vi.mock("node:fs/promises", async (importOriginal) => ({ ...(await importOriginal<typeof fs>()) }));

// Installed Pi's internal MCP loader/writers are not public SDK exports. Use
// them only as test oracles, without starting servers or evaluating secrets.
interface InstalledMcpConfig {
  loadMcpConfig: (options: { agentDir: string; cwd: string; projectTrusted: boolean }) => {
    servers: { name: string; scope: "global" | "project" }[];
    errors: string[];
  };
  addMcpServerConfig: (path: string, name: string, config: { command: string }) => boolean;
  updateMcpServerConfig: (path: string, name: string, patch: { enabled?: boolean; exposure?: string }) => void;
}

function isInstalledMcpConfig(value: unknown): value is InstalledMcpConfig {
  return typeof value === "object" && value !== null
    && "loadMcpConfig" in value && typeof value.loadMcpConfig === "function"
    && "addMcpServerConfig" in value && typeof value.addMcpServerConfig === "function"
    && "updateMcpServerConfig" in value && typeof value.updateMcpServerConfig === "function";
}

const installedMcpConfig: unknown = await import(new URL("./extensions/mcp/config.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href);
if (!isInstalledMcpConfig(installedMcpConfig)) throw new Error("Installed Pi MCP config loader/writers are unavailable");
const { loadMcpConfig, addMcpServerConfig, updateMcpServerConfig } = installedMcpConfig;

let root: string;
let agentDir: string;
let cwd: string;
let userPath: string;
let projectPath: string;
let service: FileMcpConfigService;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pi-web-mcp-config-"));
  agentDir = join(root, "active-agent");
  cwd = join(root, "workspace");
  userPath = join(agentDir, "mcp.json");
  projectPath = join(cwd, ".pi", "mcp.json");
  await mkdir(agentDir);
  await mkdir(join(cwd, ".pi"), { recursive: true });
  service = new FileMcpConfigService(agentDir);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

async function config(path: string, servers: Record<string, unknown>): Promise<void> {
  await writeFile(path, JSON.stringify({ mcpServers: servers }));
}

describe("MCP configuration metadata and trust", () => {
  it("uses the captured agent directory and treats missing files as empty", async () => {
    expect(await service.list()).toEqual({ servers: [], errors: [], userConfigPath: userPath });
    expect(await service.list(cwd)).toEqual({ servers: [], errors: [], userConfigPath: userPath, projectConfigPath: projectPath, projectTrusted: false });
    await expect(access(userPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    { defaultTrust: "ask", saved: null, trusted: false },
    { defaultTrust: "never", saved: null, trusted: false },
    { defaultTrust: "always", saved: null, trusted: true },
    { defaultTrust: "always", saved: false, trusted: false },
    { defaultTrust: "never", saved: true, trusted: true },
  ])("uses saved trust before the $defaultTrust default (saved=$saved)", async ({ defaultTrust, saved, trusted }) => {
    await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: defaultTrust }));
    // Project settings cannot declare the project trusted.
    await writeFile(join(cwd, ".pi", "settings.json"), JSON.stringify({ defaultProjectTrust: "always" }));
    if (saved !== null) new ProjectTrustStore(agentDir).set(cwd, saved);
    await config(userPath, { "same-name": { command: "unused" }, userOnly: { command: "unused" } });
    await config(projectPath, { "same-name": { command: "unused", enabled: false }, projectOnly: { url: "https://example.test/mcp" } });

    const response = await service.list(cwd);

    expect(response.projectTrusted).toBe(trusted);
    expect(response.servers.map(({ name, scope, overridden }) => ({ name, scope, overridden }))).toEqual([
      { name: "same-name", scope: "user", overridden: trusted },
      { name: "userOnly", scope: "user", overridden: false },
      { name: "same-name", scope: "project", overridden: false },
      { name: "projectOnly", scope: "project", overridden: false },
    ]);
    expect(response.servers[2]?.enabled).toBe(false);
    expect(response.errors).toEqual([]);
    // Machine-wide listing never reads project entries or trust.
    expect((await service.list()).servers).toHaveLength(2);
    expect(await service.list()).not.toHaveProperty("projectTrusted");
  });

  it.each([
    { userName: "same-name", projectName: "same_name", trusted: true },
    { userName: "same_name", projectName: "same-name", trusted: true },
    { userName: "same-name", projectName: "same_name", trusted: false },
  ])("keeps $userName active when project $projectName shares its namespace (trusted=$trusted)", async ({ userName, projectName, trusted }) => {
    new ProjectTrustStore(agentDir).set(cwd, trusted);
    await config(userPath, { [userName]: { command: "unused" } });
    // Disabled entries still participate in Pi's namespace validation.
    await config(projectPath, { [projectName]: { command: "unused", enabled: false } });

    const response = await service.list(cwd);
    const pi = loadMcpConfig({ agentDir, cwd, projectTrusted: trusted });

    expect(response.servers[0]).toMatchObject({ name: userName, enabled: true, overridden: false });
    expect(response.servers[0]).not.toHaveProperty("error");
    expect(response.servers[1]).toMatchObject({ name: projectName, enabled: false, overridden: false });
    if (trusted) {
      expect(response.servers[1]?.error).toBe("Server names must have distinct tool namespaces");
      expect(response.errors).toEqual(["project MCP configuration: Server names must have distinct tool namespaces"]);
      expect(pi.errors).toHaveLength(1);
    } else {
      expect(response.servers[1]).not.toHaveProperty("error");
      expect(response.errors).toEqual([]);
      expect(pi.errors).toEqual([]);
    }
    expect(pi.servers.map(({ name }) => name)).toEqual([userName]);
  });

  it("does not reserve a rejected project's namespace before a later exact-name override", async () => {
    new ProjectTrustStore(agentDir).set(cwd, true);
    await config(userPath, { "same-name": { command: "unused", enabled: false } });
    await config(projectPath, { same_name: { command: "unused" }, "same-name": { command: "project-unused" } });

    const response = await service.list(cwd);
    const pi = loadMcpConfig({ agentDir, cwd, projectTrusted: true });

    expect(response.servers[0]).toMatchObject({ name: "same-name", overridden: true });
    expect(response.servers[1]?.error).toBe("Server names must have distinct tool namespaces");
    expect(response.servers[2]).toMatchObject({ name: "same-name", overridden: false });
    expect(response.servers[2]).not.toHaveProperty("error");
    expect(pi.servers.map(({ name, scope }) => ({ name, scope }))).toEqual([{ name: "same-name", scope: "project" }]);
    expect(pi.errors).toHaveLength(1);
  });

  it("does not reserve an invalid user's namespace against a valid project entry", async () => {
    new ProjectTrustStore(agentDir).set(cwd, true);
    await config(userPath, { "same-name": { command: "unused", enabled: "invalid" } });
    await config(projectPath, { same_name: { command: "unused" } });

    const response = await service.list(cwd);
    const pi = loadMcpConfig({ agentDir, cwd, projectTrusted: true });

    expect(response.servers[0]?.error).toContain("enabled");
    expect(response.servers[1]).not.toHaveProperty("error");
    expect(pi.servers.map(({ name }) => name)).toEqual(["same_name"]);
    expect(response.errors).toHaveLength(1);
    expect(pi.errors).toHaveLength(1);
  });

  it("honors inherited saved trust and does not let an invalid project entry override", async () => {
    new ProjectTrustStore(agentDir).set(root, true);
    await config(userPath, { same: { command: "unused" } });
    await config(projectPath, { same: { command: "unused", enabled: "secret-invalid-value" } });

    const response = await service.list(cwd);

    expect(response.projectTrusted).toBe(true);
    expect(response.servers[0]?.overridden).toBe(false);
    expect(response.servers[1]?.error).toContain("enabled");
    expect(JSON.stringify(response)).not.toContain("secret-invalid-value");
  });

  it("projects only safe metadata without evaluating credentials or starting configured processes", async () => {
    const marker = join(root, "must-not-exist");
    const secret = "credential-never-returned";
    await config(userPath, {
      local: {
        command: "sh", args: ["-c", `touch '${marker}'`, secret],
        env: { KEY: `!touch '${marker}'`, TOKEN: secret }, cwd: marker,
        description: "Safe server summary", exposure: "codemode-deferred",
        extra: { secret },
      },
      remote: {
        type: "streamable-http", url: `https://user:${secret}@example.test/mcp?token=${secret}`,
        headers: { Authorization: secret }, oauth: { clientSecret: secret }, enabled: false, exposure: "deferred",
      },
    });
    await config(projectPath, { project: { command: "sh", args: ["-c", `touch '${marker}'`], env: { KEY: secret } } });

    const response = await service.list(cwd);
    const toggled = await service.setEnabled("project", "project", false, cwd);

    expect(response.servers).toEqual([
      { name: "local", scope: "user", source: userPath, transport: "stdio", enabled: true, exposure: "codemode", description: "Safe server summary", overridden: false },
      { name: "remote", scope: "user", source: userPath, transport: "http", enabled: false, exposure: "deferred", overridden: false },
      { name: "project", scope: "project", source: projectPath, transport: "stdio", enabled: true, exposure: "codemode", overridden: false },
    ]);
    expect(response.projectTrusted).toBe(false);
    for (const output of [response, toggled]) {
      const serialized = JSON.stringify(output);
      expect(serialized).not.toContain(secret);
      expect(serialized).not.toContain(marker);
      expect(serialized).not.toContain("https://");
      expect(serialized).not.toContain("Authorization");
    }
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("MCP toggle persistence", () => {
  it("preserves unknown root/server fields, sibling entries, indentation, line endings and permissions", async () => {
    const original = {
      autoEnableCodemode: false,
      futureSetting: { nested: [1, null, "secret"] },
      ["__proto__"]: { unknownRootField: true },
      mcpServers: {
        target: { command: "unused", args: ["secret"], env: { TOKEN: "secret" }, future: { flags: ["a", "b"] } },
        sibling: { url: "https://example.test", headers: { Authorization: "secret" }, enabled: false },
      },
    };
    await writeFile(userPath, `${JSON.stringify(original, null, "\t").replace(/\n/gu, "\r\n")}\r\n`);
    await chmod(userPath, 0o640);
    await config(projectPath, { target: { command: "project-unused" } });
    const untouchedProject = await readFile(projectPath, "utf8");

    expect((await service.setEnabled("target", "user", false, cwd)).servers[0]?.enabled).toBe(false);
    const saved = await readFile(userPath, "utf8");
    const parsed: unknown = JSON.parse(saved);
    expect(parsed).toEqual({ ...original, mcpServers: { ...original.mcpServers, target: { ...original.mcpServers.target, enabled: false } } });
    expect(saved).toContain("\r\n\t\"mcpServers\"");
    expect(saved.replace(/\r\n/gu, "")).not.toContain("\n");
    expect((await stat(userPath)).mode & 0o777).toBe(0o640);
    expect(await readFile(projectPath, "utf8")).toBe(untouchedProject);
    expect((await service.setEnabled("target", "user", true)).servers[0]?.enabled).toBe(true);
    expect((await readdir(agentDir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("updates project scope only and preserves compact JSON formatting", async () => {
    await config(userPath, { target: { command: "user-unused" } });
    await config(projectPath, { target: { command: "project-unused", extra: ["keep"] } });
    const untouchedUser = await readFile(userPath, "utf8");

    const response = await service.setEnabled("target", "project", false, cwd);

    expect(response.servers.find((entry) => entry.scope === "project")?.enabled).toBe(false);
    expect(await readFile(userPath, "utf8")).toBe(untouchedUser);
    expect(await readFile(projectPath, "utf8")).toBe('{"mcpServers":{"target":{"command":"project-unused","extra":["keep"],"enabled":false}}}\n');
  });

  it("serializes concurrent read-modify-writes without lost toggles, and recovers after a rejected toggle", async () => {
    const names = Array.from({ length: 12 }, (_, index) => `server_${String(index)}`);
    await config(userPath, Object.fromEntries(names.map((name) => [name, { command: "unused", custom: name }])));

    const results = await Promise.allSettled([
      service.setEnabled("missing", "user", false),
      ...names.map((name) => service.setEnabled(name, "user", false)),
      service.setEnabled("server_0", "user", true),
    ]);

    expect(results[0].status).toBe("rejected");
    expect(results.slice(1).every((result) => result.status === "fulfilled")).toBe(true);
    expect((await service.list()).servers.map((entry) => entry.enabled)).toEqual([true, ...names.slice(1).map(() => false)]);
    const persisted: unknown = JSON.parse(await readFile(userPath, "utf8"));
    expect(persisted).toEqual({ mcpServers: Object.fromEntries(names.map((name) => [name, { command: "unused", custom: name, enabled: name === "server_0" }])) });
  });

  it("keeps the original bytes and removes temporary files when atomic replacement fails", async () => {
    await config(userPath, { target: { command: "unused" } });
    const original = await readFile(userPath, "utf8");
    vi.spyOn(fsSync, "renameSync").mockImplementationOnce(() => { throw Object.assign(new Error("private-path-secret"), { code: "EACCES" }); });

    await expect(service.setEnabled("target", "user", false)).rejects.toMatchObject({ statusCode: 500, message: "user MCP configuration could not be written (EACCES)" });

    expect(await readFile(userPath, "utf8")).toBe(original);
    expect(await readdir(agentDir)).toEqual(["mcp.json"]);
    expect((await service.setEnabled("target", "user", false)).servers[0]?.enabled).toBe(false);
  });

  it.each(["CLI add", "session sibling toggle", "editor root flag"])("rejects a concurrent %s without losing external edits, then allows a fresh retry", async (writer) => {
    const original = {
      autoEnableCodemode: true,
      mcpServers: { target: { command: "unused" }, sibling: { command: "unused" } },
    };
    await writeFile(userPath, JSON.stringify(original));
    let externalText = "";
    const chmodFile = fs.chmod;
    vi.spyOn(fs, "chmod").mockImplementationOnce(async (path, mode) => {
      await chmodFile(path, mode);
      // Interleave after the replacement is prepared but before its final check.
      if (writer === "CLI add") addMcpServerConfig(userPath, "external", { command: "cli-unused" });
      else if (writer === "session sibling toggle") updateMcpServerConfig(userPath, "sibling", { enabled: false, exposure: "hidden" });
      else await writeFile(userPath, JSON.stringify({ ...original, autoEnableCodemode: false }));
      externalText = await readFile(userPath, "utf8");
    });

    await expect(service.setEnabled("target", "user", false)).rejects.toMatchObject({
      statusCode: 409, message: "user MCP configuration changed during the update; refresh configuration and retry",
    });

    expect(await readFile(userPath, "utf8")).toBe(externalText);
    expect(await readdir(agentDir)).toEqual(["mcp.json"]);
    expect((await service.list()).servers.find((entry) => entry.name === "target")?.enabled).toBe(true);
    await service.setEnabled("target", "user", false);
    expect(JSON.parse(await readFile(userPath, "utf8"))).toEqual({
      ...original,
      autoEnableCodemode: writer !== "editor root flag",
      mcpServers: {
        ...original.mcpServers, target: { command: "unused", enabled: false },
        ...(writer === "CLI add" ? { external: { command: "cli-unused" } } : {}),
        ...(writer === "session sibling toggle" ? { sibling: { command: "unused", enabled: false, exposure: "hidden" } } : {}),
      },
    });
  });

  it("shares Pi's canonical-path mutation queue and reads edits made by its current owner", async () => {
    await config(userPath, { target: { command: "unused" }, sibling: { command: "unused" } });
    const aliasDir = join(root, "agent-alias");
    await symlink(agentDir, aliasDir);
    const aliasService = new FileMcpConfigService(aliasDir);
    const reads = vi.spyOn(fs, "readFile");
    let toggle: Promise<unknown> | undefined;
    let readWhileHeld = false;

    await withFileMutationQueue(userPath, async () => {
      toggle = aliasService.setEnabled("target", "user", false);
      // A microtask barrier starts setEnabled's queued operation. It must not
      // read the config while Pi's current owner still holds the canonical key.
      await Promise.resolve();
      readWhileHeld = reads.mock.calls.length > 0;
      await config(userPath, {
        target: { command: "unused" }, sibling: { command: "unused", enabled: false }, external: { command: "unused" },
      });
    });
    await toggle;

    expect(readWhileHeld).toBe(false);
    expect(JSON.parse(await readFile(userPath, "utf8"))).toEqual({ mcpServers: {
      target: { command: "unused", enabled: false }, sibling: { command: "unused", enabled: false }, external: { command: "unused" },
    } });
  });

  it.each(["replacement", "deletion", "symlink retarget"])("rejects concurrent %s without recreating or replacing external state", async (change) => {
    await config(userPath, { target: { command: "unused" } });
    const original = await readFile(userPath, "utf8");
    const replacement = join(root, "replacement.json");
    await writeFile(replacement, original);
    const chmodFile = fs.chmod;
    vi.spyOn(fs, "chmod").mockImplementationOnce(async (path, mode) => {
      await chmodFile(path, mode);
      if (change === "replacement") await fs.rename(replacement, userPath);
      else {
        await fs.unlink(userPath);
        if (change === "symlink retarget") await symlink(replacement, userPath);
      }
    });

    await expect(service.setEnabled("target", "user", false)).rejects.toMatchObject({ statusCode: 409 });

    if (change === "deletion") await expect(access(userPath)).rejects.toMatchObject({ code: "ENOENT" });
    else expect(await readFile(userPath, "utf8")).toBe(original);
    if (change === "symlink retarget") expect(await readlink(userPath)).toBe(replacement);
    expect((await readdir(agentDir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("follows an existing config symlink without replacing it", async () => {
    const target = join(root, "linked-config.json");
    await config(target, { target: { command: "unused" } });
    await symlink(target, userPath);

    await service.setEnabled("target", "user", false);

    expect(await readlink(userPath)).toBe(target);
    expect((await service.list()).servers[0]?.enabled).toBe(false);
  });
});

describe("MCP invalid configuration and requests", () => {
  it.each(['{"mcpServers":', "null", '{"mcpServers":[]}', '{"mcpServers":{"target":{"enabled":"wrong","command":"unused"}}}'])("refuses to rewrite malformed documents or invalid target entries: %s", async (text) => {
    await writeFile(userPath, text);
    await expect(service.setEnabled("target", "user", false)).rejects.toMatchObject({ statusCode: 400 });
    expect(await readFile(userPath, "utf8")).toBe(text);
  });

  it("allows disabling a valid server while preserving an invalid sibling", async () => {
    const original = { mcpServers: { target: { command: "unused" }, broken: { command: "unused", enabled: "invalid" } }, future: { keep: true } };
    await writeFile(userPath, JSON.stringify(original));
    const response = await service.setEnabled("target", "user", false);
    expect(response.servers[0]?.enabled).toBe(false);
    expect(response.errors.length).toBeGreaterThan(0);
    const persisted: unknown = JSON.parse(await readFile(userPath, "utf8"));
    expect(persisted).toEqual({ ...original, mcpServers: { ...original.mcpServers, target: { command: "unused", enabled: false } } });
  });

  it.each([
    ["malformed JSON", '{"secret-parse-value":'],
    ["null root", "null"],
    ["array root", "[]"],
    ["string root", '"secret-root-value"'],
    ["invalid server map", '{"mcpServers":[]}'],
    ["null server map", '{"mcpServers":null}'],
    ["invalid top-level setting", '{"autoEnableCodemode":"secret-setting-value","mcpServers":{"target":{"command":"unused"}}}'],
    ...Object.entries({
      "non-object server": "secret-server-value",
      "invalid enabled": { command: "unused", enabled: "secret-enabled-value" },
      "invalid args": { command: "unused", args: ["secret-args-value", 2] },
      "invalid env": { command: "unused", env: { TOKEN: { secret: "secret-env-value" } } },
      "invalid headers": { url: "https://example.test", headers: { Authorization: 2 } },
      "invalid URL": { url: "secret-url-value" },
      "unsupported type": { type: "secret-type-value", url: "https://example.test" },
      "invalid exposure": { command: "unused", exposure: "secret-exposure-value" },
      "invalid tool exposure": { command: "unused", toolExposure: { "secret-tool-name": "invalid" } },
      "invalid OAuth": { url: "https://example.test", oauth: { clientSecret: 2 } },
      "project provider auth": { url: "https://example.test", auth: { provider: "unused" } },
    }).map(([label, entry]) => [label, JSON.stringify({ mcpServers: { target: { command: "unused" }, bad: entry } })]),
    ["namespace collision", '{"mcpServers":{"target":{"command":"unused"},"target-name":{"command":"unused"},"target_name":{"command":"unused"}}}'],
    ["prototype server name", '{"mcpServers":{"target":{"command":"unused"},"__proto__":{"command":"unused"}}}'],
  ])("lists sanitized errors without rewriting $0", async (_label, text) => {
    await writeFile(projectPath, text);

    const response = await service.list(cwd);

    expect(response.errors.length).toBeGreaterThan(0);
    expect(JSON.stringify(response)).not.toMatch(/secret-[a-z-]+/u);
    expect(await readFile(projectPath, "utf8")).toBe(text);
  });

  it.each(["", "bad.name", "../target", "__proto__", "constructor", "prototype"])("rejects unsafe server name %s", async (name) => {
    await config(userPath, { target: { command: "unused" } });
    await expect(service.setEnabled(name, "user", false)).rejects.toMatchObject({ statusCode: 400 });
  });

  it("rejects missing servers, project scope without cwd, invalid scope and nonboolean enabled", async () => {
    await expect(service.setEnabled("missing", "user", false)).rejects.toMatchObject({ statusCode: 404 });
    await expect(service.setEnabled("missing", "project", false)).rejects.toMatchObject({ statusCode: 400 });
    await config(userPath, { target: { command: "unused" } });
    await expect(service.setEnabled("toString", "user", false)).rejects.toMatchObject({ statusCode: 404 });
    // @ts-expect-error Deliberately exercise validation at the untyped runtime boundary.
    await expect(service.setEnabled("target", "machine", false)).rejects.toMatchObject({ statusCode: 400 });
    // @ts-expect-error Deliberately exercise validation at the untyped runtime boundary.
    await expect(service.setEnabled("target", "user", "false")).rejects.toMatchObject({ statusCode: 400 });
    expect((await service.list()).servers[0]?.enabled).toBe(true);
  });

  it("surfaces filesystem failures rather than claiming an unreadable config is empty", async () => {
    await mkdir(userPath);
    await expect(service.list()).rejects.toMatchObject({ statusCode: 500 });
    await expect(service.setEnabled("target", "user", false)).rejects.toMatchObject({ statusCode: 500 });
  });
});
