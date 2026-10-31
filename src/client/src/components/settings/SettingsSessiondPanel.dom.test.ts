// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { PiWebConfigResponse } from "../../api";
import { SettingsSessiondPanel } from "./SettingsSessiondPanel";
import type { SettingsPanelFrame } from "./SettingsPanelFrame";

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
  localStorage.clear();
});

function configResponse(): PiWebConfigResponse {
  return {
    path: "/tmp/pi-web/config.json",
    exists: true,
    config: { spawnSessions: false, subsessions: true, askUser: false },
    effectiveConfig: { spawnSessions: true, subsessions: true, askUser: true },
    envOverrides: { host: false, port: false, allowedHosts: false, spawnSessions: false, subsessions: false, sessionMessages: false, askUser: false },
  };
}

async function mount(config: PiWebConfigResponse = configResponse()): Promise<SettingsSessiondPanel> {
  const panel = new SettingsSessiondPanel();
  panel.configResponse = { ...config, effectiveConfig: { ...config.config, ...config.effectiveConfig } };
  document.body.append(panel);
  await panel.updateComplete;
  return panel;
}

function toggle(panel: SettingsSessiondPanel, id: string): HTMLInputElement {
  const input = panel.shadowRoot?.querySelector<HTMLInputElement>(`#${id}`);
  if (!input) throw new Error(`Missing toggle: ${id}`);
  return input;
}

function help(panel: SettingsSessiondPanel, input: HTMLInputElement): string {
  const description = panel.shadowRoot?.getElementById(input.getAttribute("aria-describedby") ?? "");
  if (!description) throw new Error("Missing accessible toggle description");
  return description.textContent;
}

describe("SettingsSessiondPanel DOM", () => {
  it("refreshes settings without suggesting a daemon restart and keeps the warning visible", async () => {
    const panel = await mount();
    const onReload = vi.fn();
    panel.onReload = onReload;
    panel.savedMessage = "Settings saved.";
    await panel.updateComplete;
    const frame = panel.shadowRoot?.querySelector<SettingsPanelFrame>("settings-panel-frame");
    if (!frame) throw new Error("Missing panel frame");
    await frame.updateComplete;
    const button = frame.shadowRoot?.querySelector("button");
    expect(button?.textContent).toBe("Refresh settings");
    expect(frame.shadowRoot?.querySelector(".description")?.textContent).toContain("Restarting interrupts active sessions and running work.");
    button?.click();
    expect(onReload).toHaveBeenCalledOnce();
    panel.loading = true;
    await panel.updateComplete;
    await frame.updateComplete;
    expect(button?.disabled).toBe(true);
    button?.click();
    expect(onReload).toHaveBeenCalledOnce();
  });

  it("labels controls by benefit and connects secondary tool details", async () => {
    const panel = await mount();
    for (const [id, label, tool] of [
      ["spawn-sessions", "Allow agents to start sessions", "spawn_session"],
      ["subsessions", "Allow agents to track child sessions", "spawn_subsession"],
      ["session-messages", "Allow agents to message other sessions", "send_session_message"],
      ["ask-user", "Allow agents to ask you questions", "ask_user"],
    ] as const) {
      const input = toggle(panel, id);
      expect(input.closest("label")?.textContent.trim()).toBe(label);
      expect(input.hasAttribute("aria-label")).toBe(false);
      expect(help(panel, input)).toContain(tool);
    }
    const onSave = vi.fn();
    panel.onSave = onSave;
    toggle(panel, "spawn-sessions").click();
    toggle(panel, "subsessions").click();
    await panel.updateComplete;
    expect(onSave.mock.calls).toEqual([[{ spawnSessions: false }], [{ subsessions: false }]]);
  });

  it("explains environment overrides and the required parent even when both block editing", async () => {
    const config = configResponse();
    config.effectiveConfig.spawnSessions = false;
    config.envOverrides.spawnSessions = true;
    config.envOverrides.subsessions = true;
    const panel = await mount(config);
    const onSave = vi.fn();
    panel.onSave = onSave;
    const spawn = toggle(panel, "spawn-sessions");
    const subsessions = toggle(panel, "subsessions");
    expect(spawn.disabled).toBe(true);
    expect(subsessions.disabled).toBe(true);
    expect(subsessions.checked).toBe(false);
    expect(help(panel, spawn)).toContain("Read-only because PI_WEB_SPAWN_SESSIONS overrides this setting.");
    expect(help(panel, subsessions)).toContain("Read-only because PI_WEB_SUBSESSIONS overrides this setting.");
    expect(help(panel, subsessions)).toContain("Enable “Allow agents to start sessions” first.");
    spawn.click();
    subsessions.click();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("disables child sessions without a parent and all controls while saving", async () => {
    const config = configResponse();
    config.effectiveConfig.spawnSessions = false;
    const panel = await mount(config);
    expect(toggle(panel, "subsessions").disabled).toBe(true);
    expect(help(panel, toggle(panel, "subsessions"))).toContain("Enable “Allow agents to start sessions” first.");
    panel.saving = true;
    await panel.updateComplete;
    for (const id of ["spawn-sessions", "subsessions", "session-messages", "ask-user"]) {
      expect(toggle(panel, id).disabled).toBe(true);
    }
  });

  it("summarizes next-restart values after overrides and parent dependencies, not active state", async () => {
    const config = configResponse();
    config.effectiveConfig.spawnSessions = false;
    const panel = await mount(config);
    const summary = panel.shadowRoot?.querySelector("section.effective-card");
    expect(summary?.getAttribute("aria-labelledby")).toBe("restart-summary-heading");
    expect(summary?.getAttribute("aria-describedby")).toBe("restart-summary-help");
    expect(summary?.querySelector("h3")?.textContent).toBe("After the next daemon restart");
    expect(summary?.querySelector("small")?.textContent).toContain("This does not show the running daemon’s active settings.");
    expect(Array.from(summary?.querySelectorAll("dd") ?? [], (item) => item.textContent)).toEqual(["Disabled", "Disabled", "Enabled", "Enabled"]);
  });

  it("keeps messaging independent of spawning, saves explicit choices, and resets saved overrides", async () => {
    const config = configResponse();
    config.effectiveConfig.spawnSessions = false;
    config.config.sessionMessages = false;
    config.effectiveConfig.sessionMessages = true;
    config.configSources = { "/sessionMessages": "defaults" };
    const panel = await mount(config);
    const onSave = vi.fn();
    const onReset = vi.fn();
    panel.onSave = onSave;
    panel.onReset = onReset;
    await panel.updateComplete;
    const messages = toggle(panel, "session-messages");
    expect(messages.checked).toBe(true);
    expect(messages.disabled).toBe(false);
    messages.click();
    expect(onSave).toHaveBeenCalledExactlyOnceWith({ sessionMessages: false });
    const reset = panel.shadowRoot?.querySelector<HTMLButtonElement>('button[aria-label="Reset saved override for /sessionMessages"]');
    expect(reset).not.toBeNull();
    reset?.click();
    expect(onReset).toHaveBeenCalledExactlyOnceWith(["/sessionMessages"]);

    panel.configResponse = { ...config, enforcedSettings: { "/sessionMessages": "PI_WEB_SESSION_MESSAGES" }, effectiveConfig: { ...config.effectiveConfig, sessionMessages: false } };
    await panel.updateComplete;
    expect(messages.checked).toBe(false);
    expect(messages.disabled).toBe(true);
    expect(help(panel, messages)).toContain("PI_WEB_SESSION_MESSAGES");
    expect(reset?.disabled).toBe(true);
    messages.click();
    reset?.click();
    expect(onSave).toHaveBeenCalledOnce();
    expect(onReset).toHaveBeenCalledOnce();
  });

  it("guides unavailable settings recovery through refresh", async () => {
    const panel = await mount();
    panel.configResponse = undefined;
    await panel.updateComplete;
    expect(panel.shadowRoot?.querySelector(".loading-card")?.textContent).toBe("Configuration is unavailable. Refresh settings to try again.");
    expect(panel.shadowRoot?.querySelector("input")).toBeNull();
  });
});
