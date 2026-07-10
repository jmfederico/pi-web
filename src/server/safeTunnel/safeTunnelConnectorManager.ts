import { dirname, join, posix, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import type { SafeTunnelConnectorInstallStatus, SafeTunnelConnectorStatus } from "../../shared/apiTypes.js";

export const defaultSafeTunnelConnectorCommand = "pi-web-tunnel";
export const defaultSafeTunnelConnectorPackageSpec = "@jmfederico/pi-web-tunnel";
export const defaultSafeTunnelConnectorBinName = "pi-web-tunnel";
export const safeTunnelConnectorCommandEnvVar = "PI_WEB_SAFE_TUNNEL_CONNECTOR_COMMAND";
export const safeTunnelConnectorAutoInstallEnvVar = "PI_WEB_SAFE_TUNNEL_CONNECTOR_AUTO_INSTALL";
export const safeTunnelConnectorInstallDirEnvVar = "PI_WEB_SAFE_TUNNEL_CONNECTOR_INSTALL_DIR";
export const safeTunnelConnectorPackageEnvVar = "PI_WEB_SAFE_TUNNEL_CONNECTOR_PACKAGE";
export const safeTunnelConnectorBinEnvVar = "PI_WEB_SAFE_TUNNEL_CONNECTOR_BIN";
export const safeTunnelConnectorNpmCommandEnvVar = "PI_WEB_SAFE_TUNNEL_CONNECTOR_NPM_COMMAND";

const localDevelopmentConnectorCommand = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "scripts", "pi-web-tunnel-dev.sh");
const connectorInstallTimeoutMs = 5 * 60_000;
const connectorStatusTimeoutMs = 5_000;
const maxCapturedOutputCharacters = 24_000;

type PathApi = Pick<typeof posix, "join" | "resolve">;

export interface SafeTunnelConnectorCommandInvocation {
  readonly args: readonly string[];
  readonly command: string;
}

export interface SafeTunnelConnectorCommandRunOptions {
  readonly maxOutputCharacters: number;
  readonly timeoutMs: number;
  readonly onStderr?: (chunk: string) => void;
  readonly onStdout?: (chunk: string) => void;
}

export interface SafeTunnelConnectorCommandRunResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly signal?: string;
  readonly timedOut: boolean;
}

export interface SafeTunnelConnectorCommandRunner {
  run(invocation: SafeTunnelConnectorCommandInvocation, options: SafeTunnelConnectorCommandRunOptions): Promise<SafeTunnelConnectorCommandRunResult>;
}

export interface SafeTunnelConnectorManagerDependencies {
  readonly commandRunner: SafeTunnelConnectorCommandRunner;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly fileExists: (path: string) => boolean;
  readonly homeDirectory: string;
  readonly platform: NodeJS.Platform;
}

type ConnectorInstallPlan = SafeTunnelConnectorInstallStatus;

interface ConnectorResolution {
  readonly command: string;
  readonly install?: ConnectorInstallPlan;
}

export interface SafeTunnelConnectorStatusProbe {
  readonly connector: SafeTunnelConnectorStatus;
  readonly statusJson?: string;
}

interface ConnectorCommandCheck {
  readonly available: boolean;
  readonly error?: string;
  readonly statusJson?: string;
}

export class SafeTunnelConnectorManager {
  private installation: Promise<string> | undefined;

  constructor(private readonly dependencies: SafeTunnelConnectorManagerDependencies) {}

  async status(): Promise<SafeTunnelConnectorStatus> {
    return (await this.probeStatus()).connector;
  }

  async probeStatus(): Promise<SafeTunnelConnectorStatusProbe> {
    const resolution = resolveConnector(this.dependencies);
    const check = await this.checkCommand(resolution.command);

    if (check.available) {
      return {
        connector: { command: resolution.command, state: "available" },
        ...(check.statusJson === undefined ? {} : { statusJson: check.statusJson }),
      };
    }

    if (resolution.install !== undefined) {
      return {
        connector: {
          command: resolution.install.command,
          state: "installable",
          install: installStatus(resolution.install),
          ...(check.error === undefined ? {} : { error: check.error }),
        },
      };
    }

    return {
      connector: {
        command: resolution.command,
        state: "unavailable",
        ...(check.error === undefined ? {} : { error: check.error }),
      },
    };
  }

  async ensureCommand(): Promise<string> {
    const resolution = resolveConnector(this.dependencies);
    const check = await this.checkCommand(resolution.command);
    if (check.available) return resolution.command;

    if (resolution.install === undefined) {
      throw new Error(`PI WEB Safe Tunnel connector command is unavailable: ${check.error ?? resolution.command}`);
    }

    const command = await this.installConnector(resolution.install);
    const installedCheck = await this.checkCommand(command);
    if (!installedCheck.available) {
      throw new Error(`Installed PI WEB Safe Tunnel connector is unavailable: ${installedCheck.error ?? command}`);
    }
    return command;
  }

  private async installConnector(plan: ConnectorInstallPlan): Promise<string> {
    this.installation ??= this.runInstall(plan).finally(() => {
      this.installation = undefined;
    });
    return this.installation;
  }

  private async runInstall(plan: ConnectorInstallPlan): Promise<string> {
    const result = await this.dependencies.commandRunner.run({
      command: plan.installerCommand,
      args: ["install", "--prefix", plan.installDirectory, "--no-audit", "--no-fund", plan.packageSpec],
    }, {
      maxOutputCharacters: maxCapturedOutputCharacters,
      timeoutMs: connectorInstallTimeoutMs,
    });

    if (result.exitCode !== 0 || result.timedOut) {
      const reason = nonEmptyString(result.stderr) ?? nonEmptyString(result.stdout) ?? (result.timedOut ? "installer timed out" : `installer exited with code ${formatExitCode(result.exitCode)}`);
      throw new Error(`Failed to install PI WEB Safe Tunnel connector package ${plan.packageSpec}: ${reason}`);
    }

    return plan.command;
  }

  private async checkCommand(command: string): Promise<ConnectorCommandCheck> {
    try {
      const result = await this.dependencies.commandRunner.run({ command, args: ["status", "--json"] }, {
        maxOutputCharacters: maxCapturedOutputCharacters,
        timeoutMs: connectorStatusTimeoutMs,
      });

      if (result.exitCode === 0 && !result.timedOut) return { available: true, statusJson: result.stdout };
      return {
        available: false,
        error: nonEmptyString(result.stderr) ?? nonEmptyString(result.stdout) ?? (result.timedOut ? "connector status timed out" : `connector status exited with code ${formatExitCode(result.exitCode)}`),
      };
    } catch (error) {
      return { available: false, error: errorMessage(error) };
    }
  }
}

function resolveConnector(dependencies: SafeTunnelConnectorManagerDependencies): ConnectorResolution {
  const configuredCommand = nonEmptyString(dependencies.env[safeTunnelConnectorCommandEnvVar]);
  if (configuredCommand !== undefined) return { command: configuredCommand };

  const developmentCommand = discoveredDevelopmentConnectorCommand(dependencies);
  if (developmentCommand !== undefined) return { command: developmentCommand };

  const install = connectorInstallPlan(dependencies);
  if (install !== undefined && dependencies.fileExists(install.command)) {
    return { command: install.command, install };
  }

  return { command: defaultSafeTunnelConnectorCommand, ...(install === undefined ? {} : { install }) };
}

function connectorInstallPlan(dependencies: SafeTunnelConnectorManagerDependencies): ConnectorInstallPlan | undefined {
  if (!autoInstallEnabled(dependencies.env)) return undefined;

  const packageSpec = nonEmptyString(dependencies.env[safeTunnelConnectorPackageEnvVar]) ?? defaultSafeTunnelConnectorPackageSpec;
  const binName = nonEmptyString(dependencies.env[safeTunnelConnectorBinEnvVar]) ?? defaultSafeTunnelConnectorBinName;
  const installDirectory = connectorInstallDirectory(dependencies);
  const installerCommand = nonEmptyString(dependencies.env[safeTunnelConnectorNpmCommandEnvVar]) ?? "npm";
  const command = connectorBinPath(installDirectory, binName, dependencies.platform);

  return {
    binName,
    command,
    enabled: true,
    installDirectory,
    installerCommand,
    packageSpec,
  };
}

function installStatus(plan: ConnectorInstallPlan): SafeTunnelConnectorInstallStatus {
  return {
    binName: plan.binName,
    command: plan.command,
    enabled: true,
    installDirectory: plan.installDirectory,
    installerCommand: plan.installerCommand,
    packageSpec: plan.packageSpec,
  };
}

function connectorInstallDirectory(dependencies: SafeTunnelConnectorManagerDependencies): string {
  const pathApi = pathApiForPlatform(dependencies.platform);
  const configured = nonEmptyString(dependencies.env[safeTunnelConnectorInstallDirEnvVar]);
  if (configured !== undefined) return pathApi.resolve(dependencies.cwd, configured);

  const homeDirectory = requireHomeDirectory(dependencies.homeDirectory);
  if (dependencies.platform === "win32") {
    const dataRoot = nonEmptyString(dependencies.env["LOCALAPPDATA"]) ?? pathApi.join(homeDirectory, "AppData", "Local");
    return pathApi.join(dataRoot, "pi-web", "safe-tunnel-connector");
  }

  const dataRoot = nonEmptyString(dependencies.env["XDG_DATA_HOME"]) ?? pathApi.join(homeDirectory, ".local", "share");
  return pathApi.join(dataRoot, "pi-web", "safe-tunnel-connector");
}

function connectorBinPath(installDirectory: string, binName: string, platform: NodeJS.Platform): string {
  const executableName = platform === "win32" ? `${binName}.cmd` : binName;
  return pathApiForPlatform(platform).join(installDirectory, "node_modules", ".bin", executableName);
}

function discoveredDevelopmentConnectorCommand(dependencies: Pick<SafeTunnelConnectorManagerDependencies, "fileExists" | "platform">): string | undefined {
  if (dependencies.platform === "win32") return undefined;
  return dependencies.fileExists(localDevelopmentConnectorCommand) ? localDevelopmentConnectorCommand : undefined;
}

function autoInstallEnabled(env: Readonly<Record<string, string | undefined>>): boolean {
  const configured = nonEmptyString(env[safeTunnelConnectorAutoInstallEnvVar]);
  if (configured === undefined) return true;
  const normalized = configured.toLowerCase();
  return normalized !== "0" && normalized !== "false" && normalized !== "no" && normalized !== "off";
}

function requireHomeDirectory(homeDirectory: string): string {
  const normalized = nonEmptyString(homeDirectory);
  if (normalized === undefined) {
    throw new Error("Unable to discover a home directory for the PI WEB Safe Tunnel connector install directory.");
  }
  return normalized;
}

function pathApiForPlatform(platform: NodeJS.Platform): PathApi {
  return platform === "win32" ? win32 : posix;
}

function nonEmptyString(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function formatExitCode(exitCode: number | null): string {
  return exitCode === null ? "unknown" : exitCode.toString();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
