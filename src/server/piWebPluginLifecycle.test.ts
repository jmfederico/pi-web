import { describe, expect, it } from "vitest";
import type { PiWebPluginCatalogEntry, PiWebPluginCatalogSnapshot } from "./piWebPluginCatalog.js";
import { reconcilePiWebPluginLifecycle } from "./piWebPluginLifecycle.js";
import type { ServerPluginRuntimeRecord } from "./plugins/serverPluginRuntime.js";
import { createWorkspaceProviderRuntimeSnapshot } from "./workspaces/workspaceCatalog.js";

describe("PI WEB plugin desired/active lifecycle reconciliation", () => {
  it("publishes browser-only changes immediately but pairs dual entries only with the active compatible snapshot", () => {
    const desired = snapshot([
      entry("browser-on", { browser: "browser-1" }),
      entry("browser-off", { browser: "browser-1", enabled: false }),
      entry("became-browser-only", { browser: "browser-1" }),
      entry("active-dual", { browser: "browser-1", server: "server-1" }),
      entry("desired-off-active", { browser: "browser-1", server: "server-1", enabled: false }),
      entry("stale-server", { browser: "browser-2", server: "server-2" }),
      entry("stale-browser", { browser: "browser-2", server: "server-1" }),
      entry("stale-settings", { browser: "browser-1", server: "server-1", settingsRevision: "settings-2" }),
      entry("stale-source", { browser: "browser-1", server: "server-1" }),
      entry("failed", { browser: "browser-1", server: "server-1" }),
      entry("health-threw", { browser: "browser-1", server: "server-1" }),
      entry("incompatible", { browser: "browser-1", server: "server-1" }),
      entry("missing", { browser: "browser-1", server: "server-1" }),
    ]);
    const records = [
      record("active-dual", "active"),
      record("became-browser-only", "active"),
      record("desired-off-active", "active"),
      record("stale-server", "active", { moduleRevision: "server-1", browserRevision: "browser-2" }),
      record("stale-browser", "active", { browserRevision: "browser-1" }),
      record("stale-settings", "active"),
      record("stale-source", "active", { source: "another-package" }),
      record("failed", "failed", { phase: "start", message: "startup exploded" }),
      record("health-threw", "active"),
      record("incompatible", "incompatible", { phase: "validate", message: "future API" }),
      record("active-only", "active"),
    ];
    const runtime = createWorkspaceProviderRuntimeSnapshot(records, [
      { pluginId: "active-dual", health: { status: "healthy", details: { token: "must-not-leak" } } },
      { pluginId: "desired-off-active", health: { status: "degraded", message: "limited" } },
      { pluginId: "stale-server", health: { status: "healthy" } },
      { pluginId: "stale-browser", health: { status: "healthy" } },
      { pluginId: "stale-settings", health: { status: "healthy" } },
      { pluginId: "stale-source", health: { status: "healthy" } },
      { pluginId: "failed", health: { status: "unhealthy", message: "not available" } },
      { pluginId: "health-threw", health: { status: "unhealthy", message: "Health check failed" }, phase: "health", error: "probe exploded" },
      { pluginId: "active-only", health: { status: "healthy" } },
    ]);

    const reconciled = reconcilePiWebPluginLifecycle(desired, { status: "available", snapshot: runtime }, moduleUrl);

    expect(reconciled.browserPlugins.map(({ plugin }) => plugin.id)).toEqual(["active-dual", "browser-on", "desired-off-active"]);
    expect(reconciled.browserPlugins.find(({ plugin }) => plugin.id === "active-dual")?.backendRevision).toBe("server-1");
    expect(plugin(reconciled, "active-dual").server?.health).toEqual({ status: "healthy" });
    expect(plugin(reconciled, "became-browser-only")).toMatchObject({
      server: { state: "active", staleRevision: true, restartRequired: true },
    });
    expect(plugin(reconciled, "desired-off-active")).toMatchObject({
      enabled: false,
      server: { state: "active", health: { status: "degraded" }, restartRequired: true, staleRevision: false },
    });
    expect(plugin(reconciled, "stale-server").server).toMatchObject({ state: "active", staleRevision: true, restartRequired: true });
    expect(plugin(reconciled, "stale-browser").server).toMatchObject({ state: "active", staleRevision: true, restartRequired: true });
    expect(plugin(reconciled, "stale-settings").server).toMatchObject({ state: "active", staleRevision: true, restartRequired: true });
    expect(plugin(reconciled, "stale-source").server).toMatchObject({ state: "active", staleRevision: true, restartRequired: true });
    expect(plugin(reconciled, "failed").server).toMatchObject({ state: "failed", phase: "start", message: "startup exploded", restartRequired: true });
    expect(plugin(reconciled, "health-threw").server).toMatchObject({ state: "active", phase: "health", message: "probe exploded", health: { status: "unhealthy" } });
    expect(plugin(reconciled, "incompatible").server).toMatchObject({ state: "incompatible", phase: "validate", message: "future API", restartRequired: true });
    expect(plugin(reconciled, "missing").server).toMatchObject({ state: "missing", restartRequired: true });
    expect(plugin(reconciled, "active-only")).toMatchObject({ discovered: false, enabled: false, server: { state: "active", restartRequired: true } });
    expect(reconciled.response.serverRuntime).toMatchObject({ status: "available", restartRequired: true });
  });

  it.each(["bundled-only", "none"] as const)("surfaces %s safe mode, disabled state, conflicts, and secret-free recovery commands", (safeStart) => {
    const desired = snapshot(
      [entry("conflicted", { browser: "browser-1", server: "server-1" })],
      [{ code: "duplicate-id", source: "desired-copy", message: "Duplicate PI WEB plugin id: conflicted", pluginId: "conflicted" }],
    );
    const runtime = createWorkspaceProviderRuntimeSnapshot(
      [record("conflicted", "disabled", { message: `disabled by ${safeStart} safe start` })],
      [],
      safeStart,
      [{ code: "duplicate-id", source: "active-copy", message: "Duplicate PI WEB plugin id: conflicted", pluginId: "conflicted" }],
    );

    const reconciled = reconcilePiWebPluginLifecycle(desired, { status: "available", snapshot: runtime }, moduleUrl, safeStart);
    const conflicted = plugin(reconciled, "conflicted");

    expect(reconciled.browserPlugins).toEqual([]);
    expect(conflicted).toMatchObject({ conflict: true, server: { state: "disabled", restartRequired: false } });
    expect(reconciled.response.diagnostics).toEqual([
      expect.objectContaining({ kind: "conflict", snapshot: "desired", pluginId: "conflicted" }),
      expect.objectContaining({ kind: "conflict", snapshot: "active", pluginId: "conflicted" }),
    ]);
    expect(reconciled.response.serverRuntime).toMatchObject({ status: "available", safeStart, desiredSafeStart: safeStart, restartRequired: false });
    expect(conflicted.server?.disableCommand).toBe("pi-web plugins disable conflicted --restart");
    expect(Object.values(reconciled.response.serverRuntime.recovery).join("\n")).not.toMatch(/token|authorization|bearer/iu);
  });

  it("infers disabled server state when no-server-plugin safe start bypassed catalog discovery", () => {
    const desired = snapshot([entry("suppressed", { browser: "browser-1", server: "server-1" })]);
    const runtime = createWorkspaceProviderRuntimeSnapshot([], [], "none");

    const reconciled = reconcilePiWebPluginLifecycle(desired, { status: "available", snapshot: runtime }, moduleUrl, "none");

    expect(reconciled.browserPlugins).toEqual([]);
    expect(plugin(reconciled, "suppressed").server).toMatchObject({ state: "disabled", restartRequired: false });
    expect(reconciled.response.serverRuntime).toMatchObject({ safeStart: "none", desiredSafeStart: "none", restartRequired: false });

    const clearing = reconcilePiWebPluginLifecycle(desired, { status: "available", snapshot: runtime }, moduleUrl, "off");
    expect(plugin(clearing, "suppressed").server).toMatchObject({ state: "disabled", restartRequired: true });
    expect(clearing.response.serverRuntime).toMatchObject({ safeStart: "none", desiredSafeStart: "off", restartRequired: true });
  });

  it.each(["unavailable", "incompatible"] as const)("keeps browser-only plugins available while withholding server-backed plugins when sessiond is %s", (status) => {
    const desired = snapshot([
      entry("browser-only", { browser: "browser-1" }),
      entry("server-backed", { browser: "browser-1", server: "server-1" }),
    ]);

    const reconciled = reconcilePiWebPluginLifecycle(
      desired,
      { status, message: status === "unavailable" ? "connect ECONNREFUSED" : "unsupported protocol" },
      moduleUrl,
    );

    expect(reconciled.browserPlugins.map(({ plugin }) => plugin.id)).toEqual(["browser-only"]);
    expect(plugin(reconciled, "server-backed").server).toMatchObject({ state: "unknown", restartRequired: false });
    expect(reconciled.response.serverRuntime).toMatchObject({ status });
    expect(typeof reconciled.response.serverRuntime.message).toBe("string");
  });
});

function entry(
  id: string,
  options: { browser?: string; server?: string; enabled?: boolean; settingsRevision?: string } = {},
): PiWebPluginCatalogEntry {
  return {
    id,
    packageRoot: `/plugins/${id}`,
    ...(options.browser === undefined ? {} : { browserModule: { path: "browser.js", filePath: `/plugins/${id}/browser.js`, revision: options.browser } }),
    ...(options.server === undefined ? {} : { serverModule: { path: "server.js", filePath: `/plugins/${id}/server.js`, revision: options.server } }),
    source: "fixture",
    scope: "local",
    machineSpecific: options.browser !== undefined && options.server !== undefined,
    enabled: options.enabled ?? true,
    settings: {},
    settingsRevision: options.settingsRevision ?? "settings-1",
  };
}

function record(
  pluginId: string,
  state: ServerPluginRuntimeRecord["state"],
  patch: Partial<ServerPluginRuntimeRecord> = {},
): ServerPluginRuntimeRecord {
  return {
    pluginId,
    source: "fixture",
    scope: "local",
    moduleRevision: "server-1",
    browserRevision: "browser-1",
    settingsRevision: "settings-1",
    machineSpecific: true,
    state,
    ...patch,
  };
}

function snapshot(
  plugins: PiWebPluginCatalogEntry[],
  diagnostics: PiWebPluginCatalogSnapshot["diagnostics"] = [],
): PiWebPluginCatalogSnapshot {
  return { plugins, diagnostics: [...diagnostics] };
}

function moduleUrl(value: PiWebPluginCatalogEntry): string {
  return `/pi-web-plugins/${value.id}/browser.js?v=${value.browserModule?.revision ?? "missing"}`;
}

function plugin(reconciled: ReturnType<typeof reconcilePiWebPluginLifecycle>, pluginId: string) {
  const value = reconciled.response.plugins.find(({ id }) => id === pluginId);
  if (value === undefined) throw new Error(`Missing reconciled plugin ${pluginId}`);
  return value;
}
