import { createRequire } from "node:module";
import { extname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { piWebDataDir } from "../../config.js";
import type { ServerPluginWorkspaceNotifications } from "../../server-plugin-api.js";
import { sessiondSocketPath } from "../../sessiond/config.js";
import {
  requireWorkspaceNotificationPluginId,
  requireWorkspaceNotificationProjectId,
} from "../../workspaceNotificationCli.js";

export interface WorkspaceNotificationCommandOptions {
  /** The owning daemon's startup environment, not a gateway/client environment. */
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  nodeExecutable?: string;
  /** Defaults to this module; also permits testing distribution and source layouts. */
  moduleUrl?: string;
  /** Actual port after binding when the owning daemon requested an ephemeral TCP port (0). */
  listeningPort?: () => number | undefined;
}

/** Supply the returned (pluginId) => { command(projectId) } factory to the plugin runtime. */
export function createWorkspaceNotificationCommandFactory(
  options: WorkspaceNotificationCommandOptions = {},
): (pluginId: string) => ServerPluginWorkspaceNotifications {
  const env = { ...(options.env ?? process.env) };
  const cwd = resolve(options.cwd ?? process.cwd());
  const moduleUrl = options.moduleUrl ?? import.meta.url;
  const source = extname(fileURLToPath(moduleUrl)) === ".ts";
  const cliPath = fileURLToPath(new URL(source ? "../../workspaceNotificationCli.ts" : "../../workspaceNotificationCli.js", moduleUrl));
  // An absolute import URL works from any project cwd, including paths with spaces.
  const loader = source ? pathToFileURL(createRequire(moduleUrl).resolve("tsx/esm")).href : undefined;
  const listeningPort = options.listeningPort;
  const fixedTransport = env["PI_WEB_SESSIOND_PORT"] === "0" ? undefined : daemonTransportArgs(env, cwd);
  const executable = Object.freeze([
    options.nodeExecutable ?? process.execPath,
    ...(loader === undefined ? [] : ["--import", loader]),
    cliPath,
    "notify",
  ]);
  return (pluginId) => {
    const attributedPluginId = requireWorkspaceNotificationPluginId(pluginId);
    return Object.freeze({
      command: (projectId: string): readonly string[] => {
        const attributedProjectId = requireWorkspaceNotificationProjectId(projectId);
        const port = fixedTransport === undefined ? listeningPort?.() : undefined;
        // There is no address for a port-0 listener until it binds. Do not guess
        // another daemon's endpoint or make an optional integration block startup.
        if (fixedTransport === undefined && port === undefined) return Object.freeze([]);
        const transport = fixedTransport ?? daemonTransportArgs({ ...env, PI_WEB_SESSIOND_PORT: String(port) }, cwd);
        return Object.freeze([
          ...executable, ...transport,
          // Equals form preserves opaque ids beginning with '-' under strict CLI parsing.
          `--project=${attributedProjectId}`,
          `--plugin=${attributedPluginId}`,
        ]);
      },
    });
  };
}

function daemonTransportArgs(env: NodeJS.ProcessEnv, cwd: string): string[] {
  const port = env["PI_WEB_SESSIOND_PORT"] ?? "";
  // SESSIOND_URL selects the client endpoint only. Never copy it: it can refer
  // to a gateway or another daemon, whereas this command belongs to our listener.
  if (port !== "") return [`--daemon-url=${daemonHttpUrl(env["PI_WEB_SESSIOND_HOST"] ?? "127.0.0.1", port)}`];
  const dataDir = piWebDataDir(env, cwd);
  const socket = resolve(cwd, sessiondSocketPath({ ...env, PI_WEB_DATA_DIR: dataDir }));
  return [`--daemon-socket=${socket}`];
}

function daemonHttpUrl(host: string, port: string): string {
  const parsedPort = Number(port);
  if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
    throw new Error("Workspace notification daemon port must be an integer from 1 to 65535");
  }
  const clientHost = host === "0.0.0.0" || host === "" ? "127.0.0.1" : host === "::" || host === "[::]" ? "::1" : host;
  const urlHost = clientHost.includes(":") && !clientHost.startsWith("[") ? `[${clientHost}]` : clientHost;
  return new URL(`http://${urlHost}:${String(parsedPort)}`).href;
}
