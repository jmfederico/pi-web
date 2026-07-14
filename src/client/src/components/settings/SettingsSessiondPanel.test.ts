import { describe, expect, it, vi } from "vitest";
import type { TemplateResult } from "lit";
import type { ActiveAgentProfileDescriptor, PiWebConfigResponse, PiWebConfigValues } from "../../api";
import { SettingsSessiondPanel } from "./SettingsSessiondPanel";
import type { SettingsNotice } from "./SettingsPanelFrame";

describe("settings-sessiond-panel layout", () => {
  it("names the selected machine in the scope and restart notice when config is available", () => {
    const panel = new SettingsSessiondPanel();
    panel.targetLabel = "Lab Mac (remote machine)";
    setPanelConfig(panel, configResponse({
      agent: { command: "agent-lab", dir: "/srv/agent-lab" },
      spawnSessions: true,
      subsessions: false,
    }));
    panel.activeAgentProfile = activeProfile("pi", "/srv/pi");

    const rendered = flattenTemplateContent(panel.render());

    expectTextOrder(rendered, [
      "Session daemon",
      "Select the Pi-compatible agent profile and companion CLI for Lab Mac (remote machine).",
      "Reload",
      "Pi-compatible agent profile restart required on Lab Mac (remote machine)",
      "Run <code>pi-web restart</code> on that machine",
      "Config file",
      "Companion CLI command",
      "agent-lab",
      "Profile state directory",
      "/srv/agent-lab",
      "Allow agents to start sessions",
    ]);
  });

  it("orders save/load notices before the restart notice and settings content", () => {
    const panel = new SettingsSessiondPanel();
    setPanelConfig(panel, configResponse({ agent: { command: "agent-lab", dir: "/srv/agent-lab" }, spawnSessions: false }));
    panel.activeAgentProfile = activeProfile("pi", "/srv/pi");
    panel.error = "Failed to save session-daemon config.";
    panel.savedMessage = "Session daemon settings saved.";

    const rendered = flattenTemplateContent(panel.render());

    expectTextOrder(rendered, [
      "Failed to save session-daemon config.",
      "Session daemon settings saved.",
      "Pi-compatible agent profile restart required on local (local gateway)",
      "Config file",
    ]);
  });

  it("shows the profile as active without restart guidance when desired and active match", () => {
    const panel = new SettingsSessiondPanel();
    setPanelConfig(panel, configResponse({ agent: { command: "agent-lab", dir: "/srv/agent-lab" } }));
    panel.activeAgentProfile = activeProfile("agent-lab", "/srv/agent-lab");

    const rendered = flattenTemplateContent(panel.render());

    expect(rendered).toContain("Profile status");
    expect(rendered).toContain("Active");
    expect(rendered).not.toContain("restart required on");
  });

  it("submits command and directory together as one profile save", async () => {
    const panel = new SettingsSessiondPanel();
    const onSave = vi.fn();
    setPanelConfig(panel, configResponse({ agent: { command: "pi", dir: "/srv/pi" } }));
    setPanelProperty(panel, "agentDraft", { command: " alternate-agent ", dir: " /srv/alternate " });
    panel.onSave = onSave;
    const event = new Event("submit", { cancelable: true });

    await callPanelPromise(panel, "saveAgentProfile", event);

    expect(event.defaultPrevented).toBe(true);
    expect(onSave.mock.calls).toEqual([[{ agent: { command: "alternate-agent", dir: "/srv/alternate" } }]]);
  });

  it("preserves a dirty profile draft when an unrelated daemon setting is saved", () => {
    const panel = new SettingsSessiondPanel();
    const initial = configResponse({ agent: { command: "pi", dir: "/srv/pi" }, spawnSessions: false });
    setPanelConfig(panel, initial);
    callPanelMethod(panel, "updateAgentDraft", { command: "alternate-agent", dir: "/srv/alternate" });

    const toggled = configResponse({ agent: { command: "pi", dir: "/srv/pi" }, spawnSessions: true });
    panel.configResponse = toggled;
    callPanelMethod(panel, "willUpdate", new Map([["configResponse", initial]]));

    expect(Reflect.get(panel, "agentDraft")).toEqual({ command: "alternate-agent", dir: "/srv/alternate" });

    const saved = configResponse({ agent: { command: "alternate-agent", dir: "/srv/alternate" }, spawnSessions: true });
    panel.configResponse = saved;
    callPanelMethod(panel, "willUpdate", new Map([["configResponse", toggled]]));
    expect(Reflect.get(panel, "agentDraftDirty")).toBe(false);
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
});

function activeProfile(command: string, dir: string): ActiveAgentProfileDescriptor {
  return {
    schemaVersion: 1,
    revision: `sha256:${"a".repeat(64)}`,
    command,
    dir,
    sessionDirEnvKeys: ["PI_WEB_AGENT_SESSION_DIR"],
  };
}

function setPanelConfig(panel: SettingsSessiondPanel, config: PiWebConfigResponse): void {
  panel.configResponse = config;
  callPanelMethod(panel, "willUpdate", new Map([["configResponse", undefined]]));
}

function setPanelProperty(panel: SettingsSessiondPanel, property: string, value: unknown): void {
  if (!Reflect.set(panel, property, value)) throw new Error(`Failed to set SettingsSessiondPanel property ${property}`);
}

async function callPanelPromise(panel: SettingsSessiondPanel, methodName: string, ...args: readonly unknown[]): Promise<void> {
  const result = callPanelMethod(panel, methodName, ...args);
  if (!(result instanceof Promise)) throw new Error(`SettingsSessiondPanel.${methodName} did not return a promise`);
  await result;
}

function callPanelMethod(panel: SettingsSessiondPanel, methodName: string, ...args: readonly unknown[]): unknown {
  const method: unknown = Reflect.get(panel, methodName);
  if (typeof method !== "function") throw new Error(`SettingsSessiondPanel.${methodName} is not callable`);
  return Reflect.apply(method, panel, args);
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

function configResponse(config: PiWebConfigValues): PiWebConfigResponse {
  return {
    path: "/tmp/pi-web/config.json",
    exists: true,
    config,
    effectiveConfig: config,
    envOverrides: { host: false, port: false, allowedHosts: false, spawnSessions: false, subsessions: false, agentCommand: false, agentDir: false, agentSessionDir: false },
  };
}
