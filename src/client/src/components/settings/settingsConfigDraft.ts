import type { PiWebConfigValues } from "../../api";

export interface ConfigDraft {
  host: string;
  port: string;
  allowedHostsMode: "list" | "all";
  allowedHostsText: string;
  allowedPathsText: string;
}

export function emptyConfigDraft(): ConfigDraft {
  return { host: "", port: "", allowedHostsMode: "list", allowedHostsText: "", allowedPathsText: "" };
}

export function draftFromConfig(config: PiWebConfigValues): ConfigDraft {
  return {
    host: config.host ?? "",
    port: config.port === undefined ? "" : String(config.port),
    allowedHostsMode: config.allowedHosts === true ? "all" : "list",
    allowedHostsText: Array.isArray(config.allowedHosts) ? config.allowedHosts.join("\n") : "",
    allowedPathsText: config.pathAccess?.allowedPaths?.join("\n") ?? "",
  };
}

export function configFromDraft(draft: ConfigDraft, baseConfig: PiWebConfigValues = {}): PiWebConfigValues {
  const config: PiWebConfigValues = {
    ...(baseConfig.shortcuts === undefined ? {} : { shortcuts: baseConfig.shortcuts }),
    ...(baseConfig.plugins === undefined ? {} : { plugins: baseConfig.plugins }),
    ...(baseConfig.uploads === undefined ? {} : { uploads: baseConfig.uploads }),
    ...(baseConfig.maxUploadBytes === undefined ? {} : { maxUploadBytes: baseConfig.maxUploadBytes }),
    ...(baseConfig.spawnSessions === undefined ? {} : { spawnSessions: baseConfig.spawnSessions }),
    ...(baseConfig.subsessions === undefined ? {} : { subsessions: baseConfig.subsessions }),
    ...(baseConfig.agent === undefined ? {} : { agent: baseConfig.agent }),
  };
  const host = draft.host.trim();
  const port = draft.port.trim();
  if (host !== "") config.host = host;
  if (port !== "") {
    const parsed = Number(port);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) throw new Error("Port must be an integer from 1 to 65535.");
    config.port = parsed;
  }
  config.allowedHosts = draft.allowedHostsMode === "all" ? true : parseAllowedHostsText(draft.allowedHostsText);
  const allowedPaths = parseAllowedPathsText(draft.allowedPathsText);
  if (allowedPaths.length > 0) config.pathAccess = { allowedPaths };
  return config;
}

function parseAllowedHostsText(value: string): string[] {
  return value.split(/[\n,]/u).map((host) => host.trim()).filter((host) => host !== "");
}

function parseAllowedPathsText(value: string): string[] {
  const paths = value.split("\n").map((path) => path.trim()).filter((path) => path !== "");
  const invalid = paths.find((path) => !isAbsoluteishAllowedPath(path));
  if (invalid !== undefined) throw new Error(`Allowed external paths must be absolute paths or start with ~: ${invalid}`);
  return paths;
}

function isAbsoluteishAllowedPath(path: string): boolean {
  return path === "~" || path.startsWith("~/") || path.startsWith("~\\") || path.startsWith("/") || path.startsWith("\\") || /^[A-Za-z]:[\\/]/u.test(path);
}
