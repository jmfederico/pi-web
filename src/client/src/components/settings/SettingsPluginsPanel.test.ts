import { describe, expect, it } from "vitest";
import type { TemplateResult } from "lit";
import type { PiWebConfigResponse, PiWebConfigValues, PiWebPluginInfo, PiWebPluginsResponse } from "../../api";
import { SettingsPluginsPanel, settingsPluginRows, type SettingsPluginRow } from "./SettingsPluginsPanel";
import type { SettingsNotice } from "./SettingsPanelFrame";

describe("settings-plugins-panel layout", () => {
  it("orders load and save notices before the trusted-code warning and plugin content", () => {
    const panel = new SettingsPluginsPanel();
    panel.targetLabel = "Lab Mac (remote machine)";
    panel.configResponse = configResponse({ plugins: { "remote-enabled": { enabled: true } } });
    panel.pluginsResponse = pluginsResponse([pluginInfo("remote-enabled", true)]);
    panel.error = "Failed to load PI WEB plugin settings from Lab Mac: PI WEB plugins: timed out.";
    panel.savedMessage = "Config saved.";

    const rendered = flattenTemplateContent(panel.render());

    expectTextOrder(rendered, [
      "PI WEB plugins",
      "Compare desired plugin config with the active sessiond startup snapshot on ",
      "Lab Mac (remote machine)",
      "Failed to load PI WEB plugin settings from Lab Mac: PI WEB plugins: timed out.",
      "Config saved. Reload the browser tab to apply browser-only plugin changes.",
      "Trusted code warning:",
      "Config key on Lab Mac (remote machine):",
      "remote-enabled",
    ]);
  });

  it("uses conservative restart guidance after a save when active lifecycle state is unknown", () => {
    const panel = new SettingsPluginsPanel();
    panel.configResponse = configResponse({ plugins: { provider: { enabled: false } } });
    panel.savedMessage = "Config saved.";

    const rendered = flattenTemplateContent(panel.render());

    expect(rendered).toContain("Config saved. Restart the session daemon to apply server-plugin changes");
    expect(rendered).not.toContain("Config saved. Reload the browser tab to apply browser-only plugin changes.");
  });

  it("does not show a false empty state when the plugin response is missing", () => {
    const panel = new SettingsPluginsPanel();
    panel.targetLabel = "Lab Mac (remote machine)";

    const rendered = flattenTemplateContent(panel.render());

    expect(rendered).toContain("PI WEB plugin list unavailable for Lab Mac (remote machine). Use Reload to try again.");
    expect(rendered).not.toContain("No PI WEB browser plugins discovered");
    expect(rendered).not.toContain("Trusted code warning");
  });

  it("keeps exact offline recovery available when lifecycle loading failed before discovering plugins", () => {
    const panel = new SettingsPluginsPanel();
    panel.targetLabel = "local (local gateway)";
    panel.configResponse = configResponse({});
    panel.recoveryCommandsSupported = true;
    panel.error = "Failed to load PI WEB plugin lifecycle state.";

    const rendered = flattenTemplateContent(panel.render());

    expect(rendered).toContain("PI WEB plugin list unavailable");
    expect(rendered).toContain("Offline recovery on local (local gateway)");
    expect(rendered).toContain("pi-web plugins safe-start show");
    expect(rendered).toContain("pi-web plugins safe-start set none --restart");
  });

  it("does not claim local recovery commands are exact for an incompatible remote", () => {
    const panel = new SettingsPluginsPanel();
    panel.targetLabel = "Old host (remote machine)";
    panel.configResponse = configResponse({});
    const response = pluginsResponse([]);
    response.serverRuntime.status = "incompatible";
    panel.pluginsResponse = response;

    const rendered = flattenTemplateContent(panel.render());

    expect(rendered).toContain("Plugin lifecycle version mismatch");
    expect(rendered).not.toContain("Offline recovery on Old host");
    expect(rendered).not.toContain("pi-web plugins safe-start show");
  });

  it("shows the empty plugin state only after a plugin response has loaded", () => {
    const panel = new SettingsPluginsPanel();
    panel.targetLabel = "Lab Mac (remote machine)";
    panel.pluginsResponse = pluginsResponse([]);

    const rendered = flattenTemplateContent(panel.render());

    expect(rendered).toContain("No PI WEB plugins are discovered or active on Lab Mac (remote machine).");
    expect(rendered).not.toContain("PI WEB plugin list unavailable");
    expect(rendered).not.toContain("Trusted code warning");
  });

  it.each([
    ["bundled-only", "Only bundled server plugins were imported."],
    ["none", "No server plugins were imported; the kernel folder workspace remains available."],
  ] as const)("renders active %s safe-start recovery", (safeStart, message) => {
    const panel = new SettingsPluginsPanel();
    const response = pluginsResponse([]);
    response.serverRuntime.safeStart = safeStart;
    response.serverRuntime.desiredSafeStart = safeStart;
    panel.pluginsResponse = response;

    const rendered = flattenTemplateContent(panel.render());

    expect(rendered).toContain("Server-plugin safe mode active");
    expect(rendered).toContain(message);
    expect(rendered).toContain("pi-web plugins safe-start clear --restart");
  });

  it("renders every neutral server lifecycle state distinctly", () => {
    const states = ["active", "failed", "incompatible", "disabled", "missing", "unknown"] as const;
    const plugins = states.map((state) => {
      const value = pluginInfo(`state-${state}`, true);
      value.server = {
        state,
        desiredRevision: "1",
        ...(state === "active" ? { activeRevision: "1", health: { status: "healthy" as const } } : {}),
        staleRevision: false,
        restartRequired: state !== "active",
        disableCommand: `pi-web plugins disable state-${state} --restart`,
      };
      return value;
    });
    const panel = new SettingsPluginsPanel();
    panel.pluginsResponse = pluginsResponse(plugins);
    panel.configResponse = configResponse({});

    const rendered = flattenTemplateContent(panel.render());

    for (const label of ["Active", "Failed", "Incompatible", "Disabled", "Not active", "Active state unavailable", "Health healthy"]) {
      expect(rendered).toContain(label);
    }
  });

  it("surfaces lifecycle failure, conflict, stale revision, safe mode, restart, and exact offline commands", () => {
    const panel = new SettingsPluginsPanel();
    panel.targetLabel = "Lab Mac (remote machine)";
    const failed = pluginInfo("broken-provider", true);
    failed.conflict = true;
    failed.server = {
      state: "failed",
      desiredRevision: "2",
      activeRevision: "1",
      phase: "start",
      message: "startup failed",
      health: { status: "unhealthy", message: "probe failed" },
      staleRevision: true,
      restartRequired: true,
      disableCommand: "pi-web plugins disable broken-provider --restart",
    };
    const response = pluginsResponse([failed]);
    response.serverRuntime.safeStart = "none";
    response.serverRuntime.desiredSafeStart = "off";
    response.serverRuntime.restartRequired = true;
    response.diagnostics = [{ kind: "conflict", snapshot: "active", source: "fixture", message: "Duplicate PI WEB plugin id: broken-provider", pluginId: "broken-provider" }];
    panel.pluginsResponse = response;
    panel.configResponse = configResponse({ plugins: { "broken-provider": { enabled: true } } });

    const rendered = flattenTemplateContent(panel.render());

    for (const label of [
      "Server-plugin safe mode active",
      "No server plugins were imported",
      "Safe-mode restart pending",
      "Safe start is cleared in offline config but remains active until sessiond restarts.",
      "Session-daemon restart required",
      "Plugin id conflict",
      "Failed",
      "Conflict",
      "Stale revision",
      "Restart required",
      "Health unhealthy",
      "pi-web plugins disable broken-provider --restart",
      "pi-web plugins safe-start show",
      "pi-web plugins safe-start set bundled-only --restart",
      "pi-web plugins safe-start set none --restart",
      "pi-web plugins safe-start clear --restart",
      "They never include machine credentials.",
    ]) expect(rendered).toContain(label);
  });

  it("uses saved config as desired truth and keeps configured-only ids editable when lifecycle data is unavailable", () => {
    const stalePlugin = pluginInfo("stale-ui", true);
    const config = configResponse({
      plugins: {
        "stale-ui": { enabled: false },
        "configured-only": { enabled: true, settings: { retained: true } },
      },
    });

    const rows = settingsPluginRows(pluginsResponse([stalePlugin]), config);
    expect(rows).toEqual([
      expect.objectContaining({ id: "configured-only", enabled: true, configOnly: true, editable: true }),
      expect.objectContaining({ id: "stale-ui", enabled: false, configOnly: false, editable: true }),
    ]);

    const panel = new SettingsPluginsPanel();
    panel.targetLabel = "local (local gateway)";
    panel.configResponse = config;
    const renderedWithoutLifecycle = flattenTemplateContent(panel.render());
    expect(renderedWithoutLifecycle).toContain("configured-only");
    expect(renderedWithoutLifecycle).toContain("configured only · package not discovered");
    expect(renderedWithoutLifecycle).toContain("Configured only");
    const configuredOnly = rows.find(({ id }) => id === "configured-only");
    if (configuredOnly === undefined) throw new Error("Expected configured-only settings row");
    expect(templateValues(renderPluginTemplate(panel, configuredOnly)).filter(isBoolean)).toEqual([true, false]);
  });

  it("keeps loaded plugins visible but disabled when selected-machine config is unavailable", () => {
    const panel = new SettingsPluginsPanel();
    panel.targetLabel = "Lab Mac (remote machine)";
    panel.pluginsResponse = pluginsResponse([pluginInfo("remote-disabled", false)]);

    const rendered = flattenTemplateContent(panel.render());

    expectTextOrder(rendered, [
      "Configuration is unavailable. Reload to try again before changing plugin enablement.",
      "Trusted code warning:",
      "remote-disabled",
    ]);
    expect(countOccurrences(rendered, "Configuration is unavailable. Reload to try again before changing plugin enablement.")).toBe(1);
    expect(templateValues(renderPluginTemplate(panel, pluginInfo("remote-disabled", false))).filter(isBoolean)).toEqual([false, true]);
  });
});

function renderPluginTemplate(panel: SettingsPluginsPanel, plugin: PiWebPluginInfo | SettingsPluginRow): TemplateResult {
  const renderPlugin: unknown = Reflect.get(panel, "renderPlugin");
  if (!isPanelRenderPlugin(renderPlugin)) throw new Error("SettingsPluginsPanel.renderPlugin is not callable");
  const row = "configOnly" in plugin ? plugin : settingsPluginRows(pluginsResponse([plugin]), panel.configResponse)[0];
  if (row === undefined) throw new Error("Expected a settings plugin row");
  return renderPlugin.call(panel, row);
}

function isPanelRenderPlugin(value: unknown): value is (this: SettingsPluginsPanel, plugin: SettingsPluginRow) => TemplateResult {
  return typeof value === "function";
}

function flattenTemplateContent(template: TemplateResult): string {
  const chunks: string[] = [];
  visitTemplate(template);
  return chunks.join("");

  function visitTemplate(current: TemplateResult): void {
    const strings = templateStrings(current);
    const values = templateValues(current);
    for (let index = 0; index < values.length; index += 1) {
      const staticChunk = strings[index];
      if (staticChunk !== undefined) chunks.push(staticChunk);
      visitValue(values[index]);
    }
    const finalChunk = strings[values.length];
    if (finalChunk !== undefined) chunks.push(finalChunk);
  }

  function visitValue(value: unknown): void {
    if (Array.isArray(value)) {
      for (const item of value) visitValue(item);
      return;
    }
    if (isSettingsNotice(value)) {
      visitValue(value.title);
      visitValue(value.content);
      return;
    }
    if (isTemplateResult(value)) {
      visitTemplate(value);
      return;
    }
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      chunks.push(String(value));
    }
  }
}

function expectTextOrder(content: string, labels: readonly string[]): void {
  let previousIndex = -1;
  for (const label of labels) {
    const currentIndex = content.indexOf(label, previousIndex + 1);
    if (currentIndex === -1) throw new Error(`Expected rendered content to include ${label}`);
    expect(currentIndex).toBeGreaterThan(previousIndex);
    previousIndex = currentIndex;
  }
}

function countOccurrences(content: string, needle: string): number {
  return content.split(needle).length - 1;
}

function templateStrings(template: TemplateResult): readonly string[] {
  const strings = Reflect.get(template, "strings");
  if (!isStringArray(strings)) throw new Error("TemplateResult strings were unavailable");
  return strings;
}

function templateValues(template: TemplateResult): readonly unknown[] {
  const values = Reflect.get(template, "values");
  if (!Array.isArray(values)) throw new Error("TemplateResult values were unavailable");
  return values.map((value: unknown) => value);
}

function isTemplateResult(value: unknown): value is TemplateResult {
  return typeof value === "object" && value !== null && isStringArray(Reflect.get(value, "strings")) && Array.isArray(Reflect.get(value, "values"));
}

function isSettingsNotice(value: unknown): value is SettingsNotice {
  return typeof value === "object" && value !== null && typeof Reflect.get(value, "type") === "string" && Reflect.has(value, "content");
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item: unknown) => typeof item === "string");
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

function configResponse(config: PiWebConfigValues): PiWebConfigResponse {
  return {
    path: "/tmp/pi-web/config.json",
    exists: true,
    config,
    effectiveConfig: config,
    envOverrides: { host: false, port: false, allowedHosts: false, spawnSessions: false, subsessions: false, askUser: false, agentCommand: false, agentDir: false, agentSessionDir: false },
  };
}

function pluginsResponse(plugins: PiWebPluginInfo[]): PiWebPluginsResponse {
  return {
    lifecycleVersion: 1,
    plugins,
    diagnostics: [],
    serverRuntime: {
      status: "available",
      restartRequired: false,
      recovery: {
        showSafeStart: "pi-web plugins safe-start show",
        bundledOnly: "pi-web plugins safe-start set bundled-only --restart",
        noServerPlugins: "pi-web plugins safe-start set none --restart",
        clearSafeStart: "pi-web plugins safe-start clear --restart",
      },
    },
  };
}

function pluginInfo(id: string, enabled: boolean): PiWebPluginInfo {
  return {
    id,
    module: `/pi-web-plugins/${id}/plugin.js`,
    source: "test",
    scope: "local",
    machineSpecific: false,
    enabled,
    discovered: true,
    conflict: false,
  };
}
