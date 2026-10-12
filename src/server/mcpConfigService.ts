import { randomUUID } from "node:crypto";
import { readFileSync, realpathSync, renameSync, statSync } from "node:fs";
import { chmod, readFile, realpath, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ProjectTrustStore, SettingsManager, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type { McpConfigScope, McpServerInfo, McpServersResponse } from "../shared/apiTypes.js";

export interface McpConfigService {
  list(cwd?: string): Promise<McpServersResponse>;
  setEnabled(name: string, scope: McpConfigScope, enabled: boolean, cwd?: string): Promise<McpServersResponse>;
}

/** Messages from this boundary contain field names, never configuration values. */
export class McpConfigError extends Error {
  constructor(message: string, readonly statusCode: 400 | 404 | 409 | 500, options?: ErrorOptions) {
    super(message, options);
    this.name = "McpConfigError";
  }
}

interface ConfigFile {
  path: string;
  scope: McpConfigScope;
  text?: string;
  root?: Record<string, unknown>;
  entries: Record<string, unknown>;
  servers: McpServerInfo[];
  errors: string[];
}

/**
 * Own one instance in the daemon, using its captured active agent directory.
 * Reads only metadata and persists toggles; it never expands credentials or
 * starts servers. Idle sessions need /reload to apply a persisted change.
 */
export class FileMcpConfigService implements McpConfigService {
  private mutationQueue: Promise<void> = Promise.resolve();
  private readonly userConfigPath: string;

  constructor(private readonly agentDir: string) {
    this.userConfigPath = join(agentDir, "mcp.json");
  }

  async list(cwd?: string): Promise<McpServersResponse> {
    const user = await readConfig(this.userConfigPath, "user");
    if (cwd === undefined) return responseFor(user);
    requireCwd(cwd);
    const projectTrusted = this.projectTrusted(cwd);
    // Pi validates trusted project entries against the already accepted user
    // namespaces. A rejected project entry must not reserve its namespace.
    const namespaces = projectTrusted
      ? new Map(user.servers.filter((server) => server.error === undefined).map((server) => [server.name.replace(/-/gu, "_"), server.name]))
      : undefined;
    const project = await readConfig(join(cwd, ".pi", "mcp.json"), "project", namespaces);
    return responseFor(user, project, projectTrusted);
  }

  setEnabled(name: string, scope: McpConfigScope, enabled: boolean, cwd?: string): Promise<McpServersResponse> {
    const operation = this.mutationQueue.then(async () => {
      validateMcpServerName(name);
      if (!["user", "project"].includes(scope)) throw new McpConfigError("MCP scope must be user or project", 400);
      if (typeof enabled !== "boolean") throw new McpConfigError("enabled must be a boolean", 400);
      if (cwd !== undefined) requireCwd(cwd);
      if (scope === "project" && cwd === undefined) throw new McpConfigError("Project MCP scope requires a workspace", 400);
      const path = scope === "project" && cwd !== undefined ? join(cwd, ".pi", "mcp.json") : this.userConfigPath;
      // Join Pi's canonical-path queue used by session edit/write tools, while
      // retaining our same-instance queue (including its rejection recovery).
      await withFileMutationQueue(path, async () => {
        const file = await readConfig(path, scope);
        // Never rewrite malformed documents, but a broken sibling must not stop
        // the user disabling a valid server. Unrelated invalid values stay intact.
        if (file.root === undefined && file.text !== undefined) throw new McpConfigError(file.errors[0] ?? "Invalid MCP configuration", 400);
        const info = file.servers.find((entry) => entry.name === name);
        if (info?.error !== undefined) throw new McpConfigError(info.error, 400);
        const server = Object.hasOwn(file.entries, name) ? file.entries[name] : undefined;
        if (!isRecord(server) || file.root === undefined || file.text === undefined) {
          throw new McpConfigError("MCP server not found in the requested scope", 404);
        }
        server["enabled"] = enabled;
        await writeConfig(file);
      });
      return await this.list(cwd);
    });
    // A rejected operation must not poison subsequent toggles.
    this.mutationQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private projectTrusted(cwd: string): boolean {
    try {
      const saved = new ProjectTrustStore(this.agentDir).get(cwd);
      if (saved !== null) return saved;
      // A project cannot grant itself trust through its settings.json.
      const settings = SettingsManager.create(cwd, this.agentDir, { projectTrusted: false });
      const errors = settings.drainErrors();
      if (errors.length > 0) throw new McpConfigError("Could not read Pi project trust settings", 500);
      return settings.getDefaultProjectTrust() === "always";
    } catch (error) {
      if (error instanceof McpConfigError) throw error;
      throw new McpConfigError("Could not read Pi project trust", 500, { cause: error });
    }
  }
}

export function validateMcpServerName(name: string): void {
  if (typeof name !== "string" || !/^[A-Za-z0-9_-]+$/u.test(name) || ["__proto__", "constructor", "prototype"].includes(name)) {
    throw new McpConfigError("Invalid MCP server name; use letters, digits, underscores or hyphens", 400);
  }
}

function requireCwd(cwd: string): void {
  if (typeof cwd !== "string" || cwd.trim() === "") throw new McpConfigError("MCP workspace directory must be non-empty", 400);
}

async function readConfig(path: string, scope: McpConfigScope, namespaces = new Map<string, string>()): Promise<ConfigFile> {
  const file: ConfigFile = { path, scope, entries: {}, servers: [], errors: [] };
  try {
    file.text = await readFile(path, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return file;
    throw filesystemError(scope, "read", error);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(file.text);
  } catch {
    file.errors.push(`${scope} MCP configuration contains invalid JSON`);
    return file;
  }
  if (!isRecord(parsed) || (parsed["mcpServers"] !== undefined && !isRecord(parsed["mcpServers"]))) {
    file.errors.push(`${scope} MCP configuration must be an object with an mcpServers object`);
    return file;
  }
  file.root = parsed;
  const entries = parsed["mcpServers"];
  file.entries = isRecord(entries) ? entries : {};
  if (parsed["autoEnableCodemode"] !== undefined && typeof parsed["autoEnableCodemode"] !== "boolean") {
    file.errors.push(`${scope} MCP configuration: autoEnableCodemode must be a boolean`);
  }
  for (const [name, raw] of Object.entries(file.entries)) {
    try {
      validateMcpServerName(name);
    } catch {
      file.errors.push(`${scope} MCP configuration contains an invalid server name`);
      continue;
    }
    let error = validateServer(raw, scope);
    const namespace = name.replace(/-/gu, "_");
    const acceptedName = namespaces.get(namespace);
    if (error === undefined && acceptedName !== undefined && acceptedName !== name) error = "Server names must have distinct tool namespaces";
    if (error === undefined) namespaces.set(namespace, name);
    const value = isRecord(raw) ? raw : {};
    file.servers.push({
      name,
      scope,
      source: path,
      enabled: value["enabled"] !== false,
      transport: transportFor(value),
      exposure: exposureFor(value["exposure"]) ?? "unknown",
      ...(typeof value["description"] === "string" ? { description: value["description"] } : {}),
      overridden: false,
      ...(error === undefined ? {} : { error }),
    });
    if (error !== undefined) file.errors.push(`${scope} MCP configuration: ${error}`);
  }
  return file;
}

function responseFor(user: ConfigFile, project?: ConfigFile, projectTrusted?: boolean): McpServersResponse {
  const overrides = new Set(projectTrusted === true
    ? project?.servers.filter((server) => server.error === undefined).map((server) => server.name)
    : []);
  return {
    servers: [
      ...user.servers.map((server) => ({ ...server, overridden: overrides.has(server.name) })),
      ...project?.servers ?? [],
    ],
    errors: [...user.errors, ...project?.errors ?? []],
    userConfigPath: user.path,
    ...(project === undefined ? {} : { projectConfigPath: project.path, projectTrusted: projectTrusted === true }),
  };
}

function transportFor(value: Record<string, unknown>): McpServerInfo["transport"] {
  const type = value["type"];
  if (typeof value["url"] === "string" && (type === undefined || type === "http" || type === "streamable-http")) return "http";
  if (typeof value["command"] === "string" && (type === undefined || type === "stdio")) return "stdio";
  return "unknown";
}

function exposureFor(value: unknown): string | undefined {
  if (value === undefined || value === "codemode-deferred") return "codemode";
  return typeof value === "string" && ["codemode", "deferred", "direct", "hidden"].includes(value) ? value : undefined;
}

/** Local shape validation deliberately never evaluates !commands or ${ENV}. */
function validateServer(raw: unknown, scope: McpConfigScope): string | undefined {
  if (!isRecord(raw)) return "Server entry must be an object";
  if (raw["enabled"] !== undefined && typeof raw["enabled"] !== "boolean") return "enabled must be a boolean";
  if (exposureFor(raw["exposure"]) === undefined) return "Invalid server exposure";
  const toolExposure = raw["toolExposure"];
  if (toolExposure !== undefined && (!isRecord(toolExposure) || !Object.values(toolExposure).every((value) => exposureFor(value) !== undefined))) {
    return "toolExposure must map tool names to valid exposures";
  }
  if (raw["description"] !== undefined && typeof raw["description"] !== "string") return "description must be a string";
  const timeout = raw["timeout"];
  if (timeout !== undefined && (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0)) return "timeout must be positive seconds";
  const transport = transportFor(raw);
  if (transport === "unknown") return "Server needs a supported type and command (stdio) or URL (HTTP)";
  if (transport === "stdio") {
    if (raw["command"] === "") return "command must be non-empty";
    const args = raw["args"];
    if (args !== undefined && (!Array.isArray(args) || !args.every((value: unknown) => typeof value === "string"))) return "args must be an array of strings";
    if (raw["env"] !== undefined && !isStringRecord(raw["env"])) return "env must map names to strings";
    if (raw["cwd"] !== undefined && typeof raw["cwd"] !== "string") return "cwd must be a string";
  } else {
    const url = httpUrl(raw["url"]);
    if (url === undefined) return "url must be an HTTP or HTTPS URL";
    if (raw["headers"] !== undefined && !isStringRecord(raw["headers"])) return "headers must map names to strings";
    const oauth = raw["oauth"];
    if (oauth !== undefined) {
      if (!isRecord(oauth)) return "oauth must be an object";
      for (const key of ["clientId", "clientSecret", "scope", "clientName"]) {
        if (oauth[key] !== undefined && typeof oauth[key] !== "string") return "OAuth client fields must be strings";
      }
      const port = oauth["callbackPort"];
      if (port !== undefined && (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535)) return "oauth.callbackPort must be a valid port";
      const callback = oauth["callbackUrl"];
      if (callback !== undefined) {
        const callbackUrl = httpUrl(callback);
        if (callbackUrl?.protocol !== "http:" || !isLoopback(callbackUrl) || callbackUrl.search !== "" || callbackUrl.hash !== "") return "oauth.callbackUrl must be an HTTP loopback URL without query or fragment";
        if (callbackUrl.port !== "" && port !== undefined && Number(callbackUrl.port) !== port) return "OAuth callback ports must match";
      }
      const metadata = oauth["authServerMetadataUrl"];
      if (metadata !== undefined) {
        const metadataUrl = httpUrl(metadata);
        if (metadataUrl === undefined || (metadataUrl.protocol !== "https:" && !isLoopback(metadataUrl))) return "OAuth metadata requires HTTPS or HTTP loopback";
      }
    }
    const auth = raw["auth"];
    if (auth !== undefined) {
      if (scope === "project") return "Provider auth is only allowed in user MCP configuration";
      if (!isRecord(auth) || typeof auth["provider"] !== "string" || auth["provider"] === "") return "auth.provider must be a provider name";
      if (url.protocol !== "https:" && !isLoopback(url)) return "Provider auth requires HTTPS or HTTP loopback";
    }
  }
  return undefined;
}

function httpUrl(value: unknown): URL | undefined {
  if (typeof value !== "string" || !URL.canParse(value)) return undefined;
  const url = new URL(value);
  return url.protocol === "http:" || url.protocol === "https:" ? url : undefined;
}

function isLoopback(url: URL): boolean {
  return ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
}

async function writeConfig(file: ConfigFile): Promise<void> {
  let tempPath: string | undefined;
  let failure: McpConfigError | undefined;
  try {
    // Follow an existing config symlink rather than replacing the symlink.
    const target = await realpath(file.path);
    const originalStat = await stat(target, { bigint: true });
    const mode = Number(originalStat.mode & 0o777n);
    const indent = /^([ \t]+)\S/mu.exec(file.text ?? "")?.[1];
    const newline = file.text?.includes("\r\n") === true ? "\r\n" : "\n";
    const content = JSON.stringify(file.root, null, indent ?? (file.text?.includes("\n") === true ? "  " : undefined));
    tempPath = join(dirname(target), `.mcp-${randomUUID()}.tmp`);
    await writeFile(tempPath, `${content.replace(/\n/gu, newline)}${newline}`, { flag: "wx", mode: 0o600 });
    await chmod(tempPath, mode);
    // Pi's MCP CLI/TUI writer does not lock. Detect edits made while preparing
    // this replacement, including byte-identical inode/permission changes.
    // Keep the final check and rename synchronous so an in-process Pi writer
    // cannot interleave here. Other processes still have a check-to-rename race;
    // no advisory lock can exclude editors/CLI writers that do not take it.
    try {
      const currentStat = statSync(target, { bigint: true });
      if (realpathSync(file.path) !== target || readFileSync(target, "utf8") !== file.text
        || currentStat.dev !== originalStat.dev || currentStat.ino !== originalStat.ino
        || currentStat.mtimeNs !== originalStat.mtimeNs || currentStat.ctimeNs !== originalStat.ctimeNs) {
        throw configConflict(file.scope);
      }
    } catch (error) {
      if (errorCode(error) === "ENOENT") throw configConflict(file.scope);
      throw error;
    }
    renameSync(tempPath, target);
  } catch (error) {
    failure = error instanceof McpConfigError ? error : filesystemError(file.scope, "written", error);
  }
  if (tempPath !== undefined) {
    try {
      await unlink(tempPath);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") {
        failure = filesystemError(file.scope, "cleaned up", failure === undefined ? error : new AggregateError([failure, error]));
      }
    }
  }
  if (failure !== undefined) throw failure;
}

function configConflict(scope: McpConfigScope): McpConfigError {
  return new McpConfigError(`${scope} MCP configuration changed during the update; refresh configuration and retry`, 409);
}

function filesystemError(scope: McpConfigScope, operation: string, error: unknown): McpConfigError {
  const code = errorCode(error);
  return new McpConfigError(`${scope} MCP configuration could not be ${operation}${code === undefined ? "" : ` (${code})`}`, 500, { cause: error });
}

function errorCode(error: unknown): string | undefined {
  if (!isRecord(error)) return undefined;
  const code = error["code"];
  return typeof code === "string" && /^[A-Z0-9_]+$/u.test(code) ? code : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): boolean {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}
