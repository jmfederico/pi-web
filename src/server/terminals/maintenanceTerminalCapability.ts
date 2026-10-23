import { isAbsolute } from "node:path";
import type { PluginCapability } from "../../server-plugin-api.js";
import type { MaintenanceExecutionContext } from "./maintenanceExecutionContext.js";

/** Private composition contract shared with the bundled Terminal server entry. */
export const MAINTENANCE_TERMINAL_CAPABILITY = Object.freeze({
  pluginId: "pi-web.host",
  id: "terminal-maintenance",
  version: 1,
  parse(value: unknown): MaintenanceExecutionContext {
    if (typeof value !== "object" || value === null) throw new Error("Terminal maintenance execution context is required");
    const cwd: unknown = Reflect.get(value, "cwd");
    const env: unknown = Reflect.get(value, "env");
    if (typeof cwd !== "string" || !isAbsolute(cwd)) throw new Error("Terminal maintenance cwd must be absolute");
    if (typeof env !== "object" || env === null || Array.isArray(env)) throw new Error("Terminal maintenance env is required");
    const snapshot: NodeJS.ProcessEnv = {};
    for (const [key, entry] of Object.entries(env)) {
      if (entry !== undefined && typeof entry !== "string") throw new Error("Terminal maintenance env must contain only strings or undefined");
      Object.defineProperty(snapshot, key, { value: entry, enumerable: true });
    }
    return Object.freeze({ cwd, env: Object.freeze(snapshot) });
  },
}) satisfies PluginCapability<MaintenanceExecutionContext, 1>;
