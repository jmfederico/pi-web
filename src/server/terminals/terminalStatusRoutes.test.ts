import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServerPluginRuntimeRecord } from "../plugins/serverPluginRuntime.js";
import type { ServerPluginHealth } from "../../server-plugin-api.js";
import { registerTerminalStatusRoutes } from "./terminalStatusRoutes.js";

const apps: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });

function pluginRecord(state: ServerPluginRuntimeRecord["state"], message?: string): ServerPluginRuntimeRecord {
  return { pluginId: "pi-web.terminal", source: "fixture", scope: "bundled", moduleRevision: "terminal-r1",
    settingsRevision: "settings-r1", machineSpecific: true, state, ...(message === undefined ? {} : { message }) };
}

function fixture(records: ServerPluginRuntimeRecord[], health: ServerPluginHealth = { status: "healthy" }, safeStart?: "none") {
  const app = Fastify();
  apps.push(app);
  const inspectHealth = vi.fn(() => Promise.resolve([{ pluginId: "pi-web.terminal", health }]));
  registerTerminalStatusRoutes(app, { safeStartLevel: () => safeStart, healthRecords: () => records, inspectHealth });
  return { app, inspectHealth };
}

describe("running Terminal status", () => {
  it("reports no-plugin recovery as disabled even though the catalog was never loaded", async () => {
    const { app, inspectHealth } = fixture([], undefined, "none");
    expect((await app.inject("/terminal-status")).json()).toEqual({ state: "disabled", message: "disabled by no-server-plugin safe start" });
    expect(inspectHealth).not.toHaveBeenCalled();
  });

  it("reports disabled Terminal without probing or loading a provider", async () => {
    const { app, inspectHealth } = fixture([pluginRecord("disabled", "disabled by no-server-plugin safe start")]);
    const response = await app.inject("/terminal-status");
    expect(response.json()).toEqual({ state: "disabled", message: "disabled by no-server-plugin safe start" });
    expect(inspectHealth).not.toHaveBeenCalled();
  });

  it.each(["healthy", "degraded", "unhealthy"] as const)("uses the activated plugin's %s health verdict", async health => {
    const { app, inspectHealth } = fixture([pluginRecord("active")], { status: health, message: "owned by the active service" });
    expect((await app.inject("/terminal-status")).json()).toEqual({ state: "active", health, message: "owned by the active service" });
    expect(inspectHealth).toHaveBeenCalledExactlyOnceWith(["pi-web.terminal"]);
  });

  it("reports a failed activation rather than inferring readiness from runtime APIs", async () => {
    const { app, inspectHealth } = fixture([pluginRecord("failed", "activation failed")]);
    expect((await app.inject("/terminal-status")).json()).toEqual({ state: "unavailable", message: "activation failed" });
    expect(inspectHealth).not.toHaveBeenCalled();
  });

  it("reports a missing service as unavailable", async () => {
    const { app } = fixture([]);
    expect((await app.inject("/terminal-status")).json()).toEqual({ state: "unavailable", message: "Terminal plugin is not active" });
  });
});
