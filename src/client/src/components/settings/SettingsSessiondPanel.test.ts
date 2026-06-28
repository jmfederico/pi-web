import { describe, expect, it } from "vitest";
import type { TemplateResult } from "lit";
import type { PiWebConfigResponse, PiWebConfigValues } from "../../api";
import { agentConfigPatchForField, SettingsSessiondPanel } from "./SettingsSessiondPanel";
import type { SettingsNotice } from "./SettingsPanelFrame";

describe("settings-sessiond-panel layout", () => {
  it("names the selected machine in the scope and restart notice when config is available", () => {
    const panel = new SettingsSessiondPanel();
    panel.targetLabel = "Lab Mac (remote machine)";
    panel.configResponse = configResponse({ spawnSessions: true, subsessions: false });

    const rendered = flattenTemplateContent(panel.render());

    expectTextOrder(rendered, [
      "Session daemon",
      "These settings affect the long-lived session runtime on Lab Mac (remote machine).",
      "Reload",
      "Restart required on Lab Mac (remote machine)",
      "run <code>pi-web restart</code> on that machine",
      "Config file",
      "Allow agents to start sessions",
    ]);
  });

  it("orders save/load notices before the restart notice and settings content", () => {
    const panel = new SettingsSessiondPanel();
    panel.configResponse = configResponse({ spawnSessions: false });
    panel.error = "Failed to save session-daemon config.";
    panel.savedMessage = "Session daemon settings saved.";

    const rendered = flattenTemplateContent(panel.render());

    expectTextOrder(rendered, [
      "Failed to save session-daemon config.",
      "Session daemon settings saved.",
      "Restart required on local (local gateway)",
      "Config file",
    ]);
  });

  it("shows one blocked content state without restart guidance or toggles when config is unavailable", () => {
    const panel = new SettingsSessiondPanel();
    panel.targetLabel = "Lab Mac (remote machine)";
    panel.error = "Selected-machine settings are not available on Lab Mac.";

    const rendered = flattenTemplateContent(panel.render());

    expectTextOrder(rendered, [
      "Selected-machine settings are not available on Lab Mac.",
      "Configuration is unavailable. Reload to try again.",
    ]);
    expect(countOccurrences(rendered, "Configuration is unavailable. Reload to try again.")).toBe(1);
    expect(rendered).not.toContain("Restart required on");
    expect(rendered).not.toContain("Allow agents to start sessions");
    expect(rendered).not.toContain("Effective after environment overrides");
  });

  it("builds agent field edits as narrow config patches", () => {
    expect(agentConfigPatchForField(
      { command: "pi", dir: "/opt/pi-agent/state" },
      "command",
      " acme-agent ",
    )).toEqual({ agent: { command: "acme-agent", dir: "/opt/pi-agent/state" } });
    expect(agentConfigPatchForField({ command: "pi" }, "command", "")).toEqual({ agent: {} });
  });
});

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

function configResponse(config: PiWebConfigValues): PiWebConfigResponse {
  return {
    path: "/tmp/pi-web/config.json",
    exists: true,
    config,
    effectiveConfig: config,
    envOverrides: { host: false, port: false, allowedHosts: false, spawnSessions: false, subsessions: false, agentCommand: false, agentDir: false, agentSessionDir: false },
  };
}
