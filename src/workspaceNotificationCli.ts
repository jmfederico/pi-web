import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isPiWebPluginId } from "./shared/pluginIds.js";
import { SessionDaemonClient, type SessionDaemonClientOptions, type SessionDaemonRequestClient } from "./sessiond/sessionDaemonClient.js";

export interface WorkspaceNotificationCliDependencies {
  client?: SessionDaemonRequestClient;
  createClient?: (options: SessionDaemonClientOptions) => SessionDaemonRequestClient;
  writeLine?: (line: string) => void;
}

const usage = "Usage: pi-web workspaces notify --project <projectId> --plugin <pluginId>";
const idMaxLength = 512;

/** These identifiers are opaque; preserve the original value rather than trimming it. */
export function requireWorkspaceNotificationProjectId(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > idMaxLength) {
    throw new Error("Workspace notification project id must be non-empty and at most 512 characters");
  }
  return value;
}

export function requireWorkspaceNotificationPluginId(value: unknown): string {
  if (typeof value !== "string" || value.length > idMaxLength || !isPiWebPluginId(value)) {
    throw new Error("Workspace notification plugin id must match a PI WEB plugin id and be at most 512 characters");
  }
  return value;
}

/** Failures propagate to the CLI's nonzero exit boundary; integrations own best-effort policy. */
export async function runWorkspaceNotificationCli(
  args: readonly string[],
  dependencies: WorkspaceNotificationCliDependencies = {},
): Promise<void> {
  const target = parseCommand(args);
  if (target === undefined) {
    (dependencies.writeLine ?? console.log)(usage);
    return;
  }

  const client = dependencies.client ?? dependencies.createClient?.(target.daemonOptions) ?? new SessionDaemonClient(target.daemonOptions);
  const response = await client.request(
    "POST",
    `/workspace-notifications/projects/${encodeURIComponent(target.projectId)}`,
    { pluginId: target.pluginId },
    { signal: AbortSignal.timeout(2_000) },
  );
  if (response.statusCode < 200 || response.statusCode >= 300) {
    const detail = response.body.trim().slice(0, 1024);
    throw new Error(`Workspace notification failed (HTTP ${String(response.statusCode)})${detail === "" ? "" : `: ${detail}`}`);
  }
}

function parseCommand(args: readonly string[]): { projectId: string; pluginId: string; daemonOptions: SessionDaemonClientOptions } | undefined {
  if (args.length === 0
    || (args.length === 1 && (args[0] === "help" || isHelp(args[0])))
    || (args.length === 2 && args[0] === "notify" && isHelp(args[1]))) {
    return undefined;
  }
  if (args[0] !== "notify") throw new Error(usage);

  const values = new Map<string, string>();
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;
    const equals = arg.indexOf("=");
    const option = equals === -1 ? arg : arg.slice(0, equals);
    if (option !== "--project" && option !== "--plugin" && option !== "--daemon-url" && option !== "--daemon-socket") {
      throw new Error(`Unknown workspaces notify option: ${arg}`);
    }
    if (values.has(option)) throw new Error(`Duplicate workspaces notify option: ${option}`);
    const value = equals === -1 ? args[index + 1] : arg.slice(equals + 1);
    if (value === undefined || value === "" || (equals === -1 && value.startsWith("-"))) {
      throw new Error(`${option} requires a value`);
    }
    values.set(option, value);
    if (equals === -1) index += 1;
  }
  if (!values.has("--project") || !values.has("--plugin")) throw new Error(usage);
  if (values.has("--daemon-url") && values.has("--daemon-socket")) {
    throw new Error("Specify only one of --daemon-url and --daemon-socket");
  }
  const daemonOptions: SessionDaemonClientOptions = {};
  const url = values.get("--daemon-url");
  if (url !== undefined) {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("--daemon-url requires an HTTP(S) URL");
    daemonOptions.baseUrl = parsed.href;
  }
  const socket = values.get("--daemon-socket");
  if (socket !== undefined) daemonOptions.socketPath = socket;
  return {
    projectId: requireWorkspaceNotificationProjectId(values.get("--project")),
    pluginId: requireWorkspaceNotificationPluginId(values.get("--plugin")),
    daemonOptions,
  };
}

function isHelp(value: string | undefined): boolean {
  return value === "--help" || value === "-h";
}

// Hook invocations use this lightweight entry instead of loading the service
// installation CLI. Both entrypoints share the same bounded request runner.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runWorkspaceNotificationCli(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
