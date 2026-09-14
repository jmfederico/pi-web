import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getCACertificates } from "node:tls";
import { defaultSafeTunnelStatePath } from "./safeTunnelState.js";

export const safeTunnelFrpcRuntimeDirectoryMode = 0o700;
export const safeTunnelFrpcConfigFileMode = 0o600;
export const safeTunnelFrpcTrustedCaFileMode = 0o600;
export const safeTunnelFrpcConfigFileName = "frpc.toml";
export const safeTunnelFrpcTrustedCaFileName = "frps-roots.pem";

export interface SafeTunnelFrpcRuntimeFiles {
  readonly configPath: string;
  readonly trustedCaPath: string;
  removeConfig(): Promise<void>;
  writeConfig(contents: string): Promise<void>;
}

export interface FileSafeTunnelFrpcRuntimeFilesOptions {
  readonly configPath?: string;
  readonly platform?: NodeJS.Platform;
  readonly statePath?: string;
  readonly trustedCaPath?: string;
  readonly trustedCaPem?: string;
}

/** Owns generated TOML and relay trust roots beneath the private PI WEB data directory. */
export class FileSafeTunnelFrpcRuntimeFiles implements SafeTunnelFrpcRuntimeFiles {
  readonly configPath: string;
  readonly trustedCaPath: string;
  private readonly platform: NodeJS.Platform;
  private readonly trustedCaPem: string;

  constructor(options: FileSafeTunnelFrpcRuntimeFilesOptions = {}) {
    const defaultDirectory = dirname(options.statePath ?? defaultSafeTunnelStatePath());
    this.configPath = options.configPath ?? join(defaultDirectory, safeTunnelFrpcConfigFileName);
    this.trustedCaPath = options.trustedCaPath
      ?? join(dirname(this.configPath), safeTunnelFrpcTrustedCaFileName);
    this.platform = options.platform ?? process.platform;
    this.trustedCaPem = requireTrustedCaPem(
      options.trustedCaPem ?? `${getCACertificates("default").join("\n")}\n`,
    );
  }

  async writeConfig(contents: string): Promise<void> {
    const directory = dirname(this.configPath);
    try {
      await mkdir(directory, {
        mode: safeTunnelFrpcRuntimeDirectoryMode,
        recursive: true,
      });
      await restrictMode(directory, safeTunnelFrpcRuntimeDirectoryMode, this.platform);
      await writePrivateFile(
        this.trustedCaPath,
        this.trustedCaPem,
        safeTunnelFrpcTrustedCaFileMode,
        this.platform,
      );
      await writePrivateFile(
        this.configPath,
        contents,
        safeTunnelFrpcConfigFileMode,
        this.platform,
      );
    } catch (error: unknown) {
      await this.removeConfig().catch(() => undefined);
      throw error;
    }
  }

  async removeConfig(): Promise<void> {
    await Promise.all([
      rm(this.configPath, { force: true }),
      rm(this.trustedCaPath, { force: true }),
    ]);
  }
}

export function safeTunnelFrpcTrustedCaPath(statePath: string): string {
  return join(dirname(statePath), safeTunnelFrpcTrustedCaFileName);
}

async function writePrivateFile(
  path: string,
  contents: string,
  mode: number,
  platform: NodeJS.Platform,
): Promise<void> {
  await writeFile(path, contents, { encoding: "utf8", mode });
  await restrictMode(path, mode, platform);
}

async function restrictMode(
  path: string,
  mode: number,
  platform: NodeJS.Platform,
): Promise<void> {
  if (platform !== "win32") await chmod(path, mode);
}

function requireTrustedCaPem(value: string): string {
  if (value.trim() === ""
    || !value.includes("-----BEGIN CERTIFICATE-----")
    || !value.includes("-----END CERTIFICATE-----")) {
    throw new Error("Safe Tunnel requires a non-empty PI WEB-owned CA certificate bundle.");
  }
  return value.endsWith("\n") ? value : `${value}\n`;
}
