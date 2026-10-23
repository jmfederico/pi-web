import type { FastifyInstance } from "fastify";
import type { ServerPluginRuntime } from "../plugins/serverPluginRuntime.js";
import type { TerminalServiceStatus } from "../../shared/terminalServiceStatus.js";
import { REQUIRED_TERMINAL_PLUGIN_ID } from "../../shared/requiredTerminalPlugin.js";

type TerminalRuntime = Pick<ServerPluginRuntime, "safeStartLevel" | "healthRecords" | "inspectHealth">;

/** Report the activated plugin's lifecycle and own health verdict, not a new provider selection. */
export function registerTerminalStatusRoutes(app: FastifyInstance, runtime: TerminalRuntime): void {
  app.get("/terminal-status", async (): Promise<TerminalServiceStatus> => {
    if (runtime.safeStartLevel() === "none") {
      return { state: "disabled", message: "disabled by no-server-plugin safe start" };
    }
    const record = runtime.healthRecords().find(({ pluginId }) => pluginId === REQUIRED_TERMINAL_PLUGIN_ID);
    if (record?.state === "disabled") {
      return { state: "disabled", message: record.message ?? "Terminal is disabled" };
    }
    if (record?.state !== "active") {
      return { state: "unavailable", message: record?.message ?? "Terminal plugin is not active" };
    }
    const inspection = (await runtime.inspectHealth([REQUIRED_TERMINAL_PLUGIN_ID]))[0];
    if (inspection === undefined) return { state: "unavailable", message: "Terminal plugin has no active health report" };
    const message = inspection.health.message ?? inspection.error;
    return { state: "active", health: inspection.health.status, ...(message === undefined ? {} : { message }) };
  });
}
