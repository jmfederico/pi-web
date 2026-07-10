import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { posix, win32 } from "node:path";

export const connectorConfigDirectoryMode = 0o700;
export const connectorConfigFileMode = 0o600;
export const connectorConfigSchemaVersion = 2;
export const defaultLocalPiWebUrl = "http://127.0.0.1:8504";

/** Schema versions this connector knows how to read; older versions are upgraded on write. */
const readableConnectorConfigSchemaVersions = new Set<number>([1, 2]);

interface PathApi {
  dirname(path: string): string;
}

interface ConnectorConfigDirectoryOptions {
  readonly mode: number;
  readonly recursive: true;
}

interface ConnectorConfigFileWriteOptions {
  readonly encoding: BufferEncoding;
  readonly mode: number;
}

/**
 * Machine credentials issued by the connector device-login flow (or the internal-slice
 * owner-bootstrap command) and persisted locally. The plaintext machine token is stored under the
 * private config file mode.
 */
export interface ConnectorMachineCredentials {
  readonly controlApiBaseUrl: string;
  readonly machineId: string;
  readonly machineToken: string;
  readonly machineSlug?: string;
  readonly publicUrl?: string;
}

export interface ConnectorConfig {
  readonly localPiWebUrl: string;
  readonly schemaVersion: typeof connectorConfigSchemaVersion;
  readonly frpcPath?: string;
  readonly machine?: ConnectorMachineCredentials;
}

export interface ConnectorConfigStorageDependencies {
  readonly chmod: (path: string, mode: number) => void;
  readonly mkdir: (path: string, options: ConnectorConfigDirectoryOptions) => void;
  readonly platform: NodeJS.Platform;
  readonly readFile: (path: string, encoding: BufferEncoding) => string;
  readonly writeFile: (path: string, contents: string, options: ConnectorConfigFileWriteOptions) => void;
}

export function createDefaultConnectorConfig(): ConnectorConfig {
  return {
    localPiWebUrl: defaultLocalPiWebUrl,
    schemaVersion: connectorConfigSchemaVersion,
  };
}

export function createNodeConnectorConfigStorageDependencies(
  platform: NodeJS.Platform = process.platform,
): ConnectorConfigStorageDependencies {
  return {
    chmod(path, mode): void {
      chmodSync(path, mode);
    },
    mkdir(path, options): void {
      mkdirSync(path, options);
    },
    platform,
    readFile(path, encoding): string {
      return readFileSync(path, encoding);
    },
    writeFile(path, contents, options): void {
      writeFileSync(path, contents, options);
    },
  };
}

export function readConnectorConfig(
  configPath: string,
  dependencies: ConnectorConfigStorageDependencies = createNodeConnectorConfigStorageDependencies(),
): ConnectorConfig {
  return parseConnectorConfig(dependencies.readFile(configPath, "utf8"));
}

export function writeConnectorConfig(
  configPath: string,
  config: ConnectorConfig,
  dependencies: ConnectorConfigStorageDependencies = createNodeConnectorConfigStorageDependencies(),
): void {
  const configDirectory = pathApiForPlatform(dependencies.platform).dirname(configPath);

  dependencies.mkdir(configDirectory, {
    mode: connectorConfigDirectoryMode,
    recursive: true,
  });
  applyPrivateMode(dependencies, configDirectory, connectorConfigDirectoryMode);

  dependencies.writeFile(configPath, serializeConnectorConfig(config), {
    encoding: "utf8",
    mode: connectorConfigFileMode,
  });
  applyPrivateMode(dependencies, configPath, connectorConfigFileMode);
}

export function serializeConnectorConfig(config: ConnectorConfig): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

export function parseConnectorConfig(contents: string): ConnectorConfig {
  const parsed: unknown = JSON.parse(contents);

  if (!isRecord(parsed)) {
    throw new Error("Connector config must be a JSON object.");
  }

  const schemaVersion = parsed["schemaVersion"];

  if (typeof schemaVersion !== "number" || !readableConnectorConfigSchemaVersions.has(schemaVersion)) {
    throw new Error(`Unsupported connector config schema version: ${formatUnknownValue(schemaVersion)}.`);
  }

  const localPiWebUrl = parsed["localPiWebUrl"];

  if (typeof localPiWebUrl !== "string" || localPiWebUrl.trim().length === 0) {
    throw new Error("Connector config localPiWebUrl must be a non-empty string.");
  }

  const frpcPath = parseOptionalConfigString(parsed["frpcPath"], "frpcPath");
  const machine = parseOptionalMachineCredentials(parsed["machine"]);
  const base: ConnectorConfig = {
    localPiWebUrl,
    schemaVersion: connectorConfigSchemaVersion,
  };

  return withOptionalConfigFields(base, frpcPath, machine);
}

function withOptionalConfigFields(
  base: ConnectorConfig,
  frpcPath: string | undefined,
  machine: ConnectorMachineCredentials | undefined,
): ConnectorConfig {
  if (frpcPath !== undefined && machine !== undefined) {
    return { ...base, frpcPath, machine };
  }

  if (frpcPath !== undefined) {
    return { ...base, frpcPath };
  }

  if (machine !== undefined) {
    return { ...base, machine };
  }

  return base;
}

function parseOptionalConfigString(value: unknown, fieldName: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Connector config ${fieldName} must be a non-empty string.`);
  }

  return value;
}

function parseOptionalMachineCredentials(value: unknown): ConnectorMachineCredentials | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isRecord(value)) {
    throw new Error("Connector config machine must be a JSON object.");
  }

  const machine: ConnectorMachineCredentials = {
    controlApiBaseUrl: requireMachineCredentialString(value["controlApiBaseUrl"], "controlApiBaseUrl"),
    machineId: requireMachineCredentialString(value["machineId"], "machineId"),
    machineToken: requireMachineCredentialString(value["machineToken"], "machineToken"),
  };
  const machineSlug = parseOptionalConfigString(value["machineSlug"], "machine.machineSlug");
  const publicUrl = parseOptionalConfigString(value["publicUrl"], "machine.publicUrl");

  if (machineSlug !== undefined && publicUrl !== undefined) {
    return { ...machine, machineSlug, publicUrl };
  }

  if (machineSlug !== undefined) {
    return { ...machine, machineSlug };
  }

  if (publicUrl !== undefined) {
    return { ...machine, publicUrl };
  }

  return machine;
}

function requireMachineCredentialString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Connector config machine.${fieldName} must be a non-empty string.`);
  }

  return value;
}

function applyPrivateMode(
  dependencies: ConnectorConfigStorageDependencies,
  path: string,
  mode: number,
): void {
  if (dependencies.platform === "win32") {
    return;
  }

  dependencies.chmod(path, mode);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatUnknownValue(value: unknown): string {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  if (value === null) {
    return "null";
  }

  return typeof value;
}

function pathApiForPlatform(platform: NodeJS.Platform): PathApi {
  if (platform === "win32") {
    return win32;
  }

  return posix;
}
