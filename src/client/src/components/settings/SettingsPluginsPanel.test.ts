import { describe, expect, it } from "vitest";
import type { TemplateResult } from "lit";
import type { PiWebConfigResponse, PiWebConfigValues, PiWebPluginInfo } from "../../api";
import { SettingsPluginsPanel } from "./SettingsPluginsPanel";

describe("settings-plugins-panel copy", () => {
  it("names the selected machine in plugin scope copy", () => {
    const panel = new SettingsPluginsPanel();
    panel.targetLabel = "Lab Mac (remote machine)";

    const template = panel.render();
    const strings = collectTemplateStrings(template).join("");
    const values = collectTemplateValues(template);

    expect(strings).toContain("Enable or disable discovered PI WEB browser plugins on ");
    expect(strings).toContain("Config key on ");
    expect(strings).toContain("No PI WEB browser plugins discovered on ");
    expect(values.filter((value) => value === "Lab Mac (remote machine)")).toHaveLength(3);
  });
});

describe("settings-plugins-panel state", () => {
  it("shows disabled remote plugins from the selected machine plugin list", () => {
    const panel = new SettingsPluginsPanel();
    panel.targetLabel = "Lab Mac (remote machine)";
    panel.configResponse = configResponse({ plugins: { "remote-disabled": { enabled: false } } });
    panel.pluginsResponse = { plugins: [pluginInfo("remote-disabled", false)] };

    const values = collectTemplateValues(panel.render());

    expect(values).toContain("remote-disabled");
    expect(values).toContain("Config disabled");
    expect(values).toContain("Disabled");
  });

  it("disables plugin toggles while selected-machine config is unavailable", () => {
    const panel = new SettingsPluginsPanel();
    panel.pluginsResponse = { plugins: [pluginInfo("remote-disabled", false)] };

    expect(collectTemplateStrings(panel.render()).join("")).toContain("Configuration is unavailable. Reload to try again before changing plugin enablement.");
    expect(templateValues(renderPluginTemplate(panel, pluginInfo("remote-disabled", false))).filter(isBoolean)).toEqual([false, true]);
  });
});

function renderPluginTemplate(panel: SettingsPluginsPanel, plugin: PiWebPluginInfo): TemplateResult {
  const renderPlugin: unknown = Reflect.get(panel, "renderPlugin");
  if (!isPanelRenderPlugin(renderPlugin)) throw new Error("SettingsPluginsPanel.renderPlugin is not callable");
  return renderPlugin.call(panel, plugin);
}

function isPanelRenderPlugin(value: unknown): value is (this: SettingsPluginsPanel, plugin: PiWebPluginInfo) => TemplateResult {
  return typeof value === "function";
}

function collectTemplateStrings(template: TemplateResult): string[] {
  const strings: string[] = [];
  visitTemplate(template);
  return strings;

  function visitTemplate(current: TemplateResult): void {
    strings.push(...templateStrings(current));
    for (const value of templateValues(current)) {
      if (Array.isArray(value)) {
        for (const item of value) if (isTemplateResult(item)) visitTemplate(item);
      } else if (isTemplateResult(value)) {
        visitTemplate(value);
      }
    }
  }
}

function collectTemplateValues(template: TemplateResult): unknown[] {
  const values: unknown[] = [];
  visit(template);
  return values;

  function visit(current: unknown): void {
    if (Array.isArray(current)) {
      for (const item of current) visit(item);
      return;
    }
    if (!isTemplateResult(current)) return;
    for (const value of templateValues(current)) {
      values.push(value);
      visit(value);
    }
  }
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
    envOverrides: { host: false, port: false, allowedHosts: false, spawnSessions: false, subsessions: false },
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
  };
}
