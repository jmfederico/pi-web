import type { PiWebConfigValues } from "../../api";

export type SettingsConfigValidation =
  | { kind: "port" }
  | { kind: "externalPath"; value: string }
  | { kind: "folderRelative" | "folderTraversal"; field: "upload" | "attachment" };

/** Structured validation provenance; message preserves non-UI callers' English compatibility. */
export class SettingsConfigValidationError extends Error {
  constructor(readonly validation: SettingsConfigValidation, message: string) { super(message); }
}

export interface GatewayServerConfigDraft {
  host: string;
  port: string;
  allowedHostsMode: "list" | "all";
  allowedHostsText: string;
}

export interface MachineAccessConfigDraft {
  installationName: string;
  allowedPathsText: string;
  uploadDefaultFolder: string;
  attachmentDefaultFolder: string;
}

export function emptyGatewayServerConfigDraft(): GatewayServerConfigDraft {
  return { host: "", port: "", allowedHostsMode: "list", allowedHostsText: "" };
}

export function emptyMachineAccessConfigDraft(): MachineAccessConfigDraft {
  return { installationName: "", allowedPathsText: "", uploadDefaultFolder: "", attachmentDefaultFolder: "" };
}

export function gatewayServerDraftFromConfig(config: PiWebConfigValues): GatewayServerConfigDraft {
  return {
    host: config.host ?? "",
    port: config.port === undefined ? "" : String(config.port),
    allowedHostsMode: config.allowedHosts === true ? "all" : "list",
    allowedHostsText: Array.isArray(config.allowedHosts) ? config.allowedHosts.join("\n") : "",
  };
}

export function machineAccessDraftFromConfig(config: PiWebConfigValues): MachineAccessConfigDraft {
  return {
    installationName: config.installationName ?? "",
    allowedPathsText: config.pathAccess?.allowedPaths?.join("\n") ?? "",
    uploadDefaultFolder: config.uploads?.defaultFolder ?? "",
    attachmentDefaultFolder: config.attachments?.defaultFolder ?? "",
  };
}

// Refresh untouched fields without replacing edits made against the previous snapshot.
export function reconcileConfigDraft<T extends object>(draft: T, previous: T, incoming: T): T {
  const result = { ...incoming };
  for (const key in draft) {
    if (draft[key] !== previous[key]) result[key] = draft[key];
  }
  return result;
}

export function gatewayServerConfigFromDraft(draft: GatewayServerConfigDraft, baseConfig: PiWebConfigValues = {}): PiWebConfigValues {
  const config = preservedGatewayConfigRemainder(baseConfig);
  const host = draft.host.trim();
  const port = draft.port.trim();
  if (host !== "") config.host = host;
  if (port !== "") {
    const parsed = Number(port);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) throw new SettingsConfigValidationError({ kind: "port" }, "Port must be an integer from 1 to 65535.");
    config.port = parsed;
  }
  config.allowedHosts = draft.allowedHostsMode === "all" ? true : parseAllowedHostsText(draft.allowedHostsText);
  return config;
}

export function machineAccessConfigPatchFromDraft(draft: MachineAccessConfigDraft): PiWebConfigValues {
  const allowedPaths = parseAllowedPathsText(draft.allowedPathsText);
  const uploadDefaultFolder = normalizeWorkspaceRelativeFolder(draft.uploadDefaultFolder, "upload");
  const attachmentDefaultFolder = normalizeWorkspaceRelativeFolder(draft.attachmentDefaultFolder, "attachment");
  return {
    installationName: draft.installationName.trim(),
    pathAccess: { allowedPaths },
    uploads: uploadDefaultFolder === "" ? {} : { defaultFolder: uploadDefaultFolder },
    attachments: attachmentDefaultFolder === "" ? {} : { defaultFolder: attachmentDefaultFolder },
  };
}

function preservedGatewayConfigRemainder(baseConfig: PiWebConfigValues): PiWebConfigValues {
  return {
    ...(baseConfig.installationName === undefined ? {} : { installationName: baseConfig.installationName }),
    ...(baseConfig.shortcuts === undefined ? {} : { shortcuts: baseConfig.shortcuts }),
    ...(baseConfig.defaultTheme === undefined ? {} : { defaultTheme: baseConfig.defaultTheme }),
    ...(baseConfig.defaultLocalization === undefined ? {} : { defaultLocalization: baseConfig.defaultLocalization }),
    ...(baseConfig.defaultStreamingBehavior === undefined ? {} : { defaultStreamingBehavior: baseConfig.defaultStreamingBehavior }),
    ...(baseConfig.quietMode === undefined ? {} : { quietMode: baseConfig.quietMode }),
    ...(baseConfig.plugins === undefined ? {} : { plugins: baseConfig.plugins }),
    ...(baseConfig.pathAccess === undefined ? {} : { pathAccess: baseConfig.pathAccess }),
    ...(baseConfig.uploads === undefined ? {} : { uploads: baseConfig.uploads }),
    ...(baseConfig.attachments === undefined ? {} : { attachments: baseConfig.attachments }),
    ...(baseConfig.maxUploadBytes === undefined ? {} : { maxUploadBytes: baseConfig.maxUploadBytes }),
    ...(baseConfig.spawnSessions === undefined ? {} : { spawnSessions: baseConfig.spawnSessions }),
    ...(baseConfig.subsessions === undefined ? {} : { subsessions: baseConfig.subsessions }),
    ...(baseConfig.sessionMessages === undefined ? {} : { sessionMessages: baseConfig.sessionMessages }),
    ...(baseConfig.askUser === undefined ? {} : { askUser: baseConfig.askUser }),
    ...(baseConfig.agent === undefined ? {} : { agent: baseConfig.agent }),
  };
}

function parseAllowedHostsText(value: string): string[] {
  return value.split(/[\n,]/u).map((host) => host.trim()).filter((host) => host !== "");
}

function parseAllowedPathsText(value: string): string[] {
  const paths = value.split("\n").map((path) => path.trim()).filter((path) => path !== "");
  const invalid = paths.find((path) => !isAbsoluteishAllowedPath(path));
  if (invalid !== undefined) throw new SettingsConfigValidationError({ kind: "externalPath", value: invalid }, `Allowed external paths must be absolute paths or start with ~: ${invalid}`);
  return paths;
}

function normalizeWorkspaceRelativeFolder(value: string, field: "upload" | "attachment"): string {
  const label = field === "upload" ? "Upload default folder" : "Attachment default folder";
  const trimmed = value.trim();
  if (trimmed === "") return "";
  if (isAbsoluteLike(trimmed)) throw new SettingsConfigValidationError({ kind: "folderRelative", field }, `${label} must be workspace-relative.`);
  const parts = trimmed.split(/[\\/]+/u).filter((part) => part !== "" && part !== ".");
  if (parts.length === 0) return "";
  if (parts.some((part) => part === "..")) throw new SettingsConfigValidationError({ kind: "folderTraversal", field }, `${label} must not contain path traversal.`);
  return parts.join("/");
}

function isAbsoluteishAllowedPath(path: string): boolean {
  return path === "~" || path.startsWith("~/") || path.startsWith("~\\") || path.startsWith("/") || path.startsWith("\\") || /^[A-Za-z]:[\\/]/u.test(path);
}

function isAbsoluteLike(value: string): boolean {
  const withForwardSlashes = value.replace(/\\/g, "/");
  return withForwardSlashes.startsWith("/") || /^[A-Za-z]:\//u.test(withForwardSlashes);
}
