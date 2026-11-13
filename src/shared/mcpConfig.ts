import type { McpExposure, McpServerConfig } from "@earendil-works/pi-coding-agent";

export interface PiWebMcpConfig {
  servers?: Record<string, McpServerConfig>;
  enabledServers?: string[];
}

export function requireMcpServerName(value: unknown, source: string): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]+$/.test(value)) throw new Error(`PI WEB config mcp server name must use letters, digits, underscores or hyphens: ${source}`);
  return value;
}

/** Validate without loading Pi or evaluating environment/command substitutions. Errors omit values. */
export function parseManagedMcpConfig(value: unknown, source: string, project = false): PiWebMcpConfig {
  const record = object(value, source);
  known(record, ["servers", "enabledServers"], source);
  const result: PiWebMcpConfig = {};
  if (record["servers"] !== undefined) {
    const servers = object(record["servers"], source);
    result.servers = Object.fromEntries(Object.entries(servers).map(([name, config]) => {
      requireMcpServerName(name, source);
      return [name, server(config, source, project)];
    }));
  }
  if (record["enabledServers"] !== undefined) {
    if (!Array.isArray(record["enabledServers"])) invalid(source);
    result.enabledServers = [...new Set(record["enabledServers"].map((name: unknown) => requireMcpServerName(name, source)))];
  }
  return result;
}

function server(value: unknown, source: string, project: boolean): McpServerConfig {
  const raw = object(value, source);
  if (Object.hasOwn(raw, "enabled")) throw new Error(`PI WEB config mcp: use mcp.enabledServers to control enablement: ${source}`);
  const common = ["type", "exposure", "toolExposure", "description", "timeout"];
  const base: Pick<McpServerConfig, "exposure" | "toolExposure" | "description" | "timeout"> = {};
  if (raw["description"] !== undefined) base.description = string(raw["description"], source);
  if (raw["timeout"] !== undefined) {
    if (typeof raw["timeout"] !== "number" || !Number.isFinite(raw["timeout"]) || raw["timeout"] <= 0) invalid(source);
    base.timeout = raw["timeout"];
  }
  if (raw["exposure"] !== undefined) base.exposure = exposure(raw["exposure"], source);
  if (raw["toolExposure"] !== undefined) base.toolExposure = Object.fromEntries(Object.entries(object(raw["toolExposure"], source)).map(([name, entry]) => [name, exposure(entry, source)]));
  if (raw["url"] !== undefined) {
    known(raw, [...common, "url", "headers", "oauth", "auth"], source);
    if (raw["type"] !== undefined && raw["type"] !== "http" && raw["type"] !== "streamable-http") invalid(source);
    const url = httpUrl(raw["url"], source);
    const config: Extract<McpServerConfig, { url: string }> = { ...base, url: url.href };
    // Keep the exact URL as supplied; Pi owns credential identity and URL normalization.
    config.url = string(raw["url"], source);
    if (raw["type"] !== undefined) config.type = "http";
    if (raw["headers"] !== undefined) config.headers = strings(raw["headers"], source);
    if (raw["auth"] !== undefined) {
      if (project) throw new Error(`PI WEB config mcp project servers cannot use auth.provider: ${source}`);
      const auth = object(raw["auth"], source);
      known(auth, ["provider"], source);
      if (!secure(url)) invalid(source);
      config.auth = { provider: nonempty(auth["provider"], source) };
    }
    if (raw["oauth"] !== undefined) {
      const oauth = object(raw["oauth"], source);
      known(oauth, ["clientId", "clientSecret", "callbackPort", "callbackUrl", "scope", "clientName", "clientRegistration", "authServerMetadataUrl"], source);
      const parsed: NonNullable<typeof config.oauth> = {};
      for (const key of ["clientId", "clientSecret", "callbackUrl", "scope", "clientName", "authServerMetadataUrl"] as const) {
        if (oauth[key] !== undefined) parsed[key] = string(oauth[key], source);
      }
      if (oauth["callbackPort"] !== undefined) {
        const port = oauth["callbackPort"];
        if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) invalid(source);
        parsed.callbackPort = port;
      }
      if (oauth["clientRegistration"] !== undefined) {
        const registration = oauth["clientRegistration"];
        if (registration !== "auto" && registration !== "dcr" && registration !== "cimd") invalid(source);
        parsed.clientRegistration = registration;
      }
      if (parsed.callbackUrl !== undefined) {
        const callback = httpUrl(parsed.callbackUrl, source);
        if (callback.protocol !== "http:" || !loopback(callback) || callback.username || callback.password || callback.hash) invalid(source);
      }
      if (parsed.authServerMetadataUrl !== undefined && !secure(httpUrl(parsed.authServerMetadataUrl, source))) invalid(source);
      if (parsed.clientRegistration === "cimd" && (parsed.clientId !== undefined || parsed.clientName !== undefined || (parsed.callbackUrl !== undefined && !["localhost", "127.0.0.1"].includes(httpUrl(parsed.callbackUrl, source).hostname)))) invalid(source);
      config.oauth = parsed;
    }
    return config;
  }
  known(raw, [...common, "command", "args", "env", "cwd"], source);
  if (raw["type"] !== undefined && raw["type"] !== "stdio") invalid(source);
  const config: Extract<McpServerConfig, { command: string }> = { ...base, command: nonempty(raw["command"], source) };
  if (raw["type"] !== undefined) config.type = "stdio";
  if (raw["args"] !== undefined) {
    if (!Array.isArray(raw["args"])) invalid(source);
    config.args = raw["args"].map((arg: unknown) => string(arg, source));
  }
  if (raw["env"] !== undefined) config.env = strings(raw["env"], source);
  if (raw["cwd"] !== undefined) config.cwd = string(raw["cwd"], source);
  return config;
}

function invalid(source: string): never { throw new Error(`PI WEB config mcp has an invalid server definition or enablement list: ${source}`); }
function object(value: unknown, source: string): Record<string, unknown> {
  if (!isRecord(value)) return invalid(source);
  return value;
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function known(value: Record<string, unknown>, keys: string[], source: string): void {
  if (Object.keys(value).some((key) => !keys.includes(key))) invalid(source);
}
function string(value: unknown, source: string): string { return typeof value === "string" ? value : invalid(source); }
function nonempty(value: unknown, source: string): string { const result = string(value, source); return result.trim() && !result.includes("\0") ? result : invalid(source); }
function strings(value: unknown, source: string): Record<string, string> { return Object.fromEntries(Object.entries(object(value, source)).map(([key, entry]) => [key, string(entry, source)])); }
function exposure(value: unknown, source: string): McpExposure {
  if (value === "codemode-deferred") return "codemode";
  if (value === "codemode" || value === "deferred" || value === "direct" || value === "hidden") return value;
  return invalid(source);
}
function httpUrl(value: unknown, source: string): URL {
  const text = string(value, source);
  if (!URL.canParse(text)) return invalid(source);
  const url = new URL(text);
  if (url.protocol !== "http:" && url.protocol !== "https:") invalid(source);
  return url;
}
function loopback(url: URL): boolean { return ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname); }
function secure(url: URL): boolean { return url.protocol === "https:" || loopback(url); }
