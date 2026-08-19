import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { piWebDataDir } from "../../config.js";
import type { SafeTunnelDesiredState } from "../../shared/safeTunnelTypes.js";
import {
  hasExplicitSafeTunnelHttpPort,
  isSafeTunnelControlApiTransportAllowed,
  isSafeTunnelPublicIngressTransportAllowed,
} from "../../shared/safeTunnelUrlPolicy.js";
export const safeTunnelStateVersion = 2;
export const safeTunnelStateDirectoryMode = 0o700;
export const safeTunnelStateFileMode = 0o600;
export const defaultSafeTunnelLocalPiWebUrl = "http://127.0.0.1:8504";

const maximumUrlCharacters = 2_048;
const maximumMachineIdCharacters = 256;
const maximumBearerCredentialCharacters = 4_096;
const maximumPathCharacters = 4_096;
const bearerCredentialPattern = /^[A-Za-z0-9._~+/-]+={0,}$/u;

export type SafeTunnelMachineCredentialStatus = "active" | "rejected";

export interface SafeTunnelMachineCredentials {
  readonly controlApiBaseUrl: string;
  /** Absent values are normalized to active when an existing file is rewritten. */
  readonly credentialStatus?: SafeTunnelMachineCredentialStatus;
  readonly machineId: string;
  readonly machineToken: string;
  readonly machineSlug?: string;
  readonly publicUrl?: string;
}

/**
 * PI WEB-owned durable Safe Tunnel state. Desired state is deliberately separate
 * from runtime observations; no PID, process status, generated frp config, or log
 * state belongs in this file.
 */
export interface SafeTunnelPersistedState {
  readonly stateVersion: typeof safeTunnelStateVersion;
  readonly desiredState: SafeTunnelDesiredState;
  readonly localPiWebUrl: string;
  readonly frpcPath?: string;
  readonly machine?: SafeTunnelMachineCredentials;
}

export interface LoadedSafeTunnelState {
  readonly exists: boolean;
  readonly state: SafeTunnelPersistedState;
}

export interface SafeTunnelStateStorage {
  readonly filePath: string;
  load(): Promise<LoadedSafeTunnelState>;
  save(state: SafeTunnelPersistedState): Promise<void>;
}

export interface FileSafeTunnelStateStorageOptions {
  readonly filePath?: string;
  readonly platform?: NodeJS.Platform;
}

export class FileSafeTunnelStateStorage implements SafeTunnelStateStorage {
  readonly filePath: string;
  private readonly platform: NodeJS.Platform;

  constructor(options: FileSafeTunnelStateStorageOptions = {}) {
    this.filePath = options.filePath ?? defaultSafeTunnelStatePath();
    this.platform = options.platform ?? process.platform;
  }

  async load(): Promise<LoadedSafeTunnelState> {
    const persisted = await readJsonFile(this.filePath);
    if (persisted !== undefined) {
      await this.restrictExistingStatePermissions();
      const state = parseSafeTunnelState(persisted);
      if (!isCanonicalSafeTunnelStateRecord(persisted, state)) await this.save(state);
      return { exists: true, state };
    }

    return { exists: false, state: createDefaultSafeTunnelState() };
  }

  async save(state: SafeTunnelPersistedState): Promise<void> {
    const normalized = parseSafeTunnelState(state);
    const stateDirectory = dirname(this.filePath);
    await mkdir(stateDirectory, { mode: safeTunnelStateDirectoryMode, recursive: true });
    await restrictMode(stateDirectory, safeTunnelStateDirectoryMode, this.platform);

    const tempPath = `${this.filePath}.${process.pid.toString()}-${randomUUID()}.tmp`;
    try {
      await writeFile(tempPath, `${JSON.stringify(normalized, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: safeTunnelStateFileMode,
      });
      await restrictMode(tempPath, safeTunnelStateFileMode, this.platform);
      await rename(tempPath, this.filePath);
      await restrictMode(this.filePath, safeTunnelStateFileMode, this.platform);
    } finally {
      await rm(tempPath, { force: true }).catch(() => undefined);
    }
  }

  private async restrictExistingStatePermissions(): Promise<void> {
    await restrictMode(dirname(this.filePath), safeTunnelStateDirectoryMode, this.platform);
    await restrictMode(this.filePath, safeTunnelStateFileMode, this.platform);
  }
}

export function createDefaultSafeTunnelState(): SafeTunnelPersistedState {
  return {
    stateVersion: safeTunnelStateVersion,
    desiredState: "disabled",
    localPiWebUrl: defaultSafeTunnelLocalPiWebUrl,
  };
}

export function defaultSafeTunnelStatePath(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): string {
  return join(piWebDataDir(env, cwd), "safe-tunnel", "config.json");
}

export function parseSafeTunnelState(value: unknown): SafeTunnelPersistedState {
  const record = requireRecord(value, "Safe Tunnel state must be a JSON object.");
  if (record["stateVersion"] !== safeTunnelStateVersion) {
    throw new Error("Unsupported Safe Tunnel state version.");
  }

  const desiredState = requireDesiredState(record["desiredState"]);
  const localPiWebUrl = normalizeSafeTunnelLocalPiWebUrl(record["localPiWebUrl"]);
  const frpcPath = optionalBoundedStateString(
    record["frpcPath"],
    "frpcPath",
    maximumPathCharacters,
  );
  const machine = parseOptionalMachineCredentials(record["machine"]);
  return {
    stateVersion: safeTunnelStateVersion,
    desiredState,
    localPiWebUrl,
    ...(frpcPath === undefined ? {} : { frpcPath }),
    ...(machine === undefined ? {} : { machine }),
  };
}

/**
 * Accepts the RFC 6750 token68 transport domain used by Safe Tunnel bearer
 * credentials. Accepted values are returned byte-for-byte; whitespace,
 * controls, Unicode, and other header-unsafe representations are rejected.
 */
export function requireSafeTunnelBearerCredential(
  value: unknown,
  fieldName: string,
): string {
  if (typeof value !== "string"
    || value.length === 0
    || value.length > maximumBearerCredentialCharacters
    || !bearerCredentialPattern.test(value)) {
    throw new Error(
      `Safe Tunnel ${fieldName} must be a bounded HTTP-header-safe bearer credential.`,
    );
  }
  return value;
}

export function normalizeSafeTunnelControlApiBaseUrl(value: unknown): string {
  const source = requireBoundedString(
    value,
    "controlApiBaseUrl",
    maximumUrlCharacters,
  );
  const parsed = parseUrl(source, "controlApiBaseUrl");
  if (!isSafeTunnelControlApiTransportAllowed(parsed)) {
    throw new Error(
      "Safe Tunnel controlApiBaseUrl must use https, except for a literal loopback development endpoint.",
    );
  }
  requireUrlWithoutCredentials(parsed, "controlApiBaseUrl");
  if (parsed.search !== "" || parsed.hash !== "") {
    throw new Error("Safe Tunnel controlApiBaseUrl must not include a query or fragment.");
  }
  const path = parsed.pathname.replace(/\/+$/u, "");
  return `${parsed.origin}${path === "" ? "" : path}`;
}

export function normalizeSafeTunnelLocalPiWebUrl(value: unknown): string {
  const source = requireBoundedString(value, "localPiWebUrl", maximumUrlCharacters);
  const parsed = parseUrl(source, "localPiWebUrl");
  if (parsed.protocol !== "http:") {
    throw new Error("Safe Tunnel localPiWebUrl must use http.");
  }
  requireUrlWithoutCredentials(parsed, "localPiWebUrl");
  if (parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== "") {
    throw new Error("Safe Tunnel localPiWebUrl must not include a path, query, or fragment.");
  }
  if (parsed.port === "" && !hasExplicitSafeTunnelHttpPort(source)) {
    throw new Error("Safe Tunnel localPiWebUrl must include an explicit port.");
  }
  // WHATWG URLs omit the default HTTP port from `port` and `origin`, so put
  // an explicitly supplied :80 back into the constrained local target.
  return parsed.port === "" ? `${parsed.origin}:80` : parsed.origin;
}

export function normalizeSafeTunnelPublicUrl(value: unknown): string {
  const source = requireBoundedString(value, "publicUrl", maximumUrlCharacters);
  const parsed = parseUrl(source, "publicUrl");
  if (!isSafeTunnelPublicIngressTransportAllowed(parsed)) {
    throw new Error(
      "Safe Tunnel publicUrl must use https, except for a literal loopback development origin.",
    );
  }
  requireUrlWithoutCredentials(parsed, "publicUrl");
  if (parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== "") {
    throw new Error("Safe Tunnel publicUrl must not include a path, query, or fragment.");
  }
  return parsed.origin;
}

function parseOptionalMachineCredentials(value: unknown): SafeTunnelMachineCredentials | undefined {
  if (value === undefined) return undefined;
  const record = requireRecord(value, "Safe Tunnel machine credentials must be a JSON object.");
  const machineSlug = optionalBoundedStateString(
    record["machineSlug"],
    "machine.machineSlug",
    63,
  );
  const publicUrl = record["publicUrl"] === undefined
    ? undefined
    : normalizeSafeTunnelPublicUrl(record["publicUrl"]);
  if (machineSlug !== undefined && !isMachineSlug(machineSlug)) {
    throw new Error("Safe Tunnel machine.machineSlug must be a lowercase DNS label.");
  }

  return {
    controlApiBaseUrl: normalizeSafeTunnelControlApiBaseUrl(record["controlApiBaseUrl"]),
    credentialStatus: parseMachineCredentialStatus(record["credentialStatus"]),
    machineId: requireBoundedString(
      record["machineId"],
      "machine.machineId",
      maximumMachineIdCharacters,
    ),
    machineToken: requireSafeTunnelBearerCredential(
      record["machineToken"],
      "machine.machineToken",
    ),
    ...(machineSlug === undefined ? {} : { machineSlug }),
    ...(publicUrl === undefined ? {} : { publicUrl }),
  };
}

function parseMachineCredentialStatus(value: unknown): SafeTunnelMachineCredentialStatus {
  if (value === undefined || value === "active") return "active";
  if (value === "rejected") return "rejected";
  throw new Error("Safe Tunnel machine.credentialStatus must be active or rejected.");
}

function isCanonicalSafeTunnelStateRecord(
  value: unknown,
  state: SafeTunnelPersistedState,
): boolean {
  return JSON.stringify(value) === JSON.stringify(state);
}

async function readJsonFile(path: string): Promise<unknown> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error: unknown) {
    if (isNodeErrorWithCode(error, "ENOENT")) return undefined;
    throw error;
  }

  try {
    const value: unknown = JSON.parse(source);
    return value;
  } catch {
    throw new Error("Safe Tunnel state contains invalid JSON.");
  }
}

async function restrictMode(path: string, mode: number, platform: NodeJS.Platform): Promise<void> {
  if (platform === "win32") return;
  await chmod(path, mode);
}

function requireDesiredState(value: unknown): SafeTunnelDesiredState {
  if (value !== "enabled" && value !== "disabled") {
    throw new Error("Safe Tunnel desiredState must be enabled or disabled.");
  }
  return value;
}

function optionalBoundedStateString(
  value: unknown,
  fieldName: string,
  maximumCharacters: number,
): string | undefined {
  if (value === undefined) return undefined;
  return requireBoundedString(value, fieldName, maximumCharacters);
}

function requireNonEmptyString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Safe Tunnel ${fieldName} must be a non-empty string.`);
  }
  return value.trim();
}

function requireBoundedString(
  value: unknown,
  fieldName: string,
  maximumCharacters: number,
): string {
  const source = requireNonEmptyString(value, fieldName);
  if (source.length > maximumCharacters) {
    throw new Error(`Safe Tunnel ${fieldName} is too long.`);
  }
  return source;
}

function parseUrl(value: string, fieldName: string): URL {
  try {
    return new URL(value);
  } catch {
    throw new Error(`Safe Tunnel ${fieldName} must be a valid URL.`);
  }
}

function requireUrlWithoutCredentials(url: URL, fieldName: string): void {
  if (url.username !== "" || url.password !== "") {
    throw new Error(`Safe Tunnel ${fieldName} must not include credentials.`);
  }
}

function isMachineSlug(value: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(value);
}

function requireRecord(value: unknown, message: string): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) throw new Error(message);
  return value;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeErrorWithCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
