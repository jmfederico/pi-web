import { isPiWebPluginId } from "./shared/pluginIds.js";
import {
  disableServerPlugin,
  loadServerPluginRecoveryConfig,
  setServerPluginSafeStart,
  type ServerPluginRecoveryConfigOptions,
  type ServerPluginSafeStart,
} from "./serverPluginRecovery.js";

export interface SessionDaemonRestartPlan {
  kind: "automatic" | "manual";
  guidance: string;
  command?: string;
  perform?: () => void;
}

export interface PluginRecoveryRestartContext {
  configPath: string;
  explicitConfigPath: boolean;
}

export interface PluginRecoveryCliDependencies {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  writeLine?: (line: string) => void;
  restartPlan: (context: PluginRecoveryRestartContext) => SessionDaemonRestartPlan;
}

type PluginRecoveryCommand =
  | { kind: "help" }
  | { kind: "disable"; pluginId: string; configPath?: string; restart: boolean }
  | { kind: "safe-start-show"; configPath?: string }
  | { kind: "safe-start-set"; safeStart: ServerPluginSafeStart; configPath?: string; restart: boolean }
  | { kind: "safe-start-clear"; configPath?: string; restart: boolean };

export function pluginRecoveryHelp(): string {
  return `PI WEB server plugin recovery

Usage:
  pi-web plugins disable <plugin-id> [--config <path>] [--restart]
  pi-web plugins safe-start show [--config <path>]
  pi-web plugins safe-start set <bundled-only|none> [--config <path>] [--restart]
  pi-web plugins safe-start clear [--config <path>] [--restart]

Safe-start levels:
  bundled-only  Load bundled server plugins only.
  none          Load no server plugins; the kernel folder workspace remains available.

These commands edit config offline and never contact the session daemon or import plugins.
Changes take effect after a manual session-daemon restart unless --restart can restart it automatically.`;
}

export function runPluginRecoveryCli(
  args: readonly string[],
  dependencies: PluginRecoveryCliDependencies,
): void {
  const command = parsePluginRecoveryCommand(args);
  const writeLine = dependencies.writeLine ?? ((line) => { console.log(line); });
  if (command.kind === "help") {
    for (const line of pluginRecoveryHelp().split("\n")) writeLine(line);
    return;
  }

  const configOptions = recoveryConfigOptions(command.configPath, dependencies);
  if (command.kind === "safe-start-show") {
    const recovery = loadServerPluginRecoveryConfig(configOptions);
    writeLine(`Server plugin safe start: ${recovery.safeStart ?? "off"}`);
    reportRecoveryDiagnostic(recovery.safeStartDiagnostic, writeLine);
    writeLine(`Config: ${recovery.path}${recovery.exists ? "" : " (not created)"}`);
    return;
  }

  if (command.kind === "disable") {
    const recovery = disableServerPlugin(command.pluginId, configOptions);
    writeLine(`Disabled server plugin ${JSON.stringify(command.pluginId)} in ${recovery.path}.`);
    reportRecoveryDiagnostic(recovery.safeStartDiagnostic, writeLine);
    reportRestart(command.restart, restartPlanFor(recovery.path, command.configPath, dependencies), writeLine);
    return;
  }

  if (command.kind === "safe-start-set") {
    const recovery = setServerPluginSafeStart(command.safeStart, configOptions);
    writeLine(`Set server plugin safe start to ${command.safeStart} in ${recovery.path}.`);
    reportRecoveryDiagnostic(recovery.safeStartDiagnostic, writeLine);
    reportRestart(command.restart, restartPlanFor(recovery.path, command.configPath, dependencies), writeLine);
    return;
  }

  const recovery = setServerPluginSafeStart(undefined, configOptions);
  writeLine(`Cleared server plugin safe start in ${recovery.path}.`);
  reportRecoveryDiagnostic(recovery.safeStartDiagnostic, writeLine);
  reportRestart(command.restart, restartPlanFor(recovery.path, command.configPath, dependencies), writeLine);
}

function parsePluginRecoveryCommand(args: readonly string[]): PluginRecoveryCommand {
  const parsed = parseOptions(args);
  if (parsed.help) return { kind: "help" };
  const [command, ...rest] = parsed.positional;
  if (command === undefined || command === "help") return requireNoMutationOptions(parsed, { kind: "help" });

  if (command === "disable") {
    const [pluginId, ...extra] = rest;
    if (pluginId === undefined || extra.length > 0) throw new Error("Usage: pi-web plugins disable <plugin-id> [--config <path>] [--restart]");
    if (!isPiWebPluginId(pluginId)) throw new Error(`Invalid PI WEB plugin id: ${pluginId}`);
    return withConfigPath({ kind: "disable", pluginId, restart: parsed.restart }, parsed.configPath);
  }

  if (command !== "safe-start") throw new Error(`Unknown plugins command: ${command}`);
  const [action, value, ...extra] = rest;
  if (action === "show" && value === undefined && extra.length === 0) {
    if (parsed.restart) throw new Error("--restart is not valid with safe-start show");
    return withConfigPath({ kind: "safe-start-show" }, parsed.configPath);
  }
  if (action === "clear" && value === undefined && extra.length === 0) {
    return withConfigPath({ kind: "safe-start-clear", restart: parsed.restart }, parsed.configPath);
  }
  if (action === "set" && extra.length === 0) {
    if (value !== "bundled-only" && value !== "none") {
      throw new Error("Safe-start level must be bundled-only or none");
    }
    return withConfigPath({ kind: "safe-start-set", safeStart: value, restart: parsed.restart }, parsed.configPath);
  }
  throw new Error("Usage: pi-web plugins safe-start show|clear|set <bundled-only|none> [--config <path>] [--restart]");
}

interface ParsedOptions {
  positional: string[];
  configPath?: string;
  restart: boolean;
  help: boolean;
}

function parseOptions(args: readonly string[]): ParsedOptions {
  const positional: string[] = [];
  let configPath: string | undefined;
  let restart = false;
  let help = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--restart") {
      if (restart) throw new Error("Duplicate plugins option: --restart");
      restart = true;
    } else if (arg === "--config") {
      if (configPath !== undefined) throw new Error("Duplicate plugins option: --config");
      const value = args[index + 1];
      if (value === undefined || value === "" || value.startsWith("-")) throw new Error("--config requires a path");
      configPath = value;
      index += 1;
    } else if (arg.startsWith("--config=")) {
      if (configPath !== undefined) throw new Error("Duplicate plugins option: --config");
      const value = arg.slice("--config=".length);
      if (value === "") throw new Error("--config requires a path");
      configPath = value;
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown plugins option: ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  return {
    positional,
    ...(configPath === undefined ? {} : { configPath }),
    restart,
    help,
  };
}

function recoveryConfigOptions(
  configPath: string | undefined,
  dependencies: Pick<PluginRecoveryCliDependencies, "env" | "cwd">,
): ServerPluginRecoveryConfigOptions {
  return {
    ...(dependencies.env === undefined ? {} : { env: dependencies.env }),
    ...(dependencies.cwd === undefined ? {} : { cwd: dependencies.cwd }),
    ...(configPath === undefined ? {} : { configPath }),
  };
}

function withConfigPath<T extends object>(value: T, configPath: string | undefined): T & { configPath?: string } {
  return { ...value, ...(configPath === undefined ? {} : { configPath }) };
}

function requireNoMutationOptions(parsed: ParsedOptions, command: PluginRecoveryCommand): PluginRecoveryCommand {
  if (parsed.configPath !== undefined || parsed.restart) throw new Error("Plugin recovery help does not accept --config or --restart");
  return command;
}

function restartPlanFor(
  configPath: string,
  explicitConfigPath: string | undefined,
  dependencies: Pick<PluginRecoveryCliDependencies, "restartPlan">,
): SessionDaemonRestartPlan {
  return dependencies.restartPlan({ configPath, explicitConfigPath: explicitConfigPath !== undefined });
}

function reportRecoveryDiagnostic(
  diagnostic: string | undefined,
  writeLine: (line: string) => void,
): void {
  if (diagnostic !== undefined) writeLine(`Warning: ${diagnostic}`);
}

function reportRestart(
  performRestart: boolean,
  plan: SessionDaemonRestartPlan,
  writeLine: (line: string) => void,
): void {
  if (performRestart && plan.kind === "automatic" && plan.perform !== undefined) {
    plan.perform();
    writeLine("Session daemon restart requested. Active sessions owned by that daemon may stop.");
    return;
  }

  if (performRestart && plan.kind === "manual") {
    writeLine("The session daemon cannot be restarted automatically for this installation.");
  }
  writeLine("Restart the session daemon to apply this change. Active sessions owned by that daemon may stop.");
  writeLine(plan.guidance);
  if (plan.command !== undefined) writeLine(`  ${plan.command}`);
}
