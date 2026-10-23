import { join, resolve } from "node:path";
import { piWebDataDir } from "../../config.js";

export interface MaintenanceExecutionContext {
  readonly cwd: string;
  readonly env: Readonly<NodeJS.ProcessEnv>;
}

/** Resolve paths in the prepared child environment, after profile setup and environment scrubbing. */
export function resolveMaintenanceExecutionContext(
  childProcessEnvironment: Readonly<NodeJS.ProcessEnv>,
  daemonLaunchCwd: string,
): MaintenanceExecutionContext {
  const env = { ...childProcessEnvironment };
  for (const key of ["PI_WEB_DATA_DIR", "PI_WEB_CONFIG", "PI_WEB_SESSIOND_SOCKET", "PI_WEB_PI_PACKAGE_DIR", "PI_WEB_SESSION_ARCHIVE_DIR", "PI_CODING_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR"]) {
    const value = env[key];
    // Empty values retain each configuration reader's default/validation semantics.
    // Whitespace is a real path for readers such as piWebDataDir, not an empty value.
    if (value !== undefined && value !== "") env[key] = resolve(daemonLaunchCwd, value);
  }
  return Object.freeze({
    cwd: join(piWebDataDir(env, daemonLaunchCwd), "maintenance"),
    env: Object.freeze(env),
  });
}
