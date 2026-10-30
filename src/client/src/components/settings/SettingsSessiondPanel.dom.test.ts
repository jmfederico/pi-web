// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { PiWebConfigResponse } from "../../api";
import { SettingsSessiondPanel } from "./SettingsSessiondPanel";
import type { SettingsPanelFrame } from "./SettingsPanelFrame";
import type { CommandPicker } from "../CommandPicker";

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

  it("separates saved naming values and immediate-effect help from restart permissions", async () => {
    const config = configResponse();
    config.effectiveConfig.sessionNaming = { model: "provider/naming", maxTokens: 64, thinkingLevel: "off", timeoutMs: 30500 };
    const panel = await mount(config);
    const summary = panel.shadowRoot?.querySelector("section[aria-labelledby='naming-summary-heading']");
    expect(summary?.getAttribute("aria-describedby")).toBe("naming-summary-help");
    expect(summary?.querySelector("h3")?.textContent).toBe("For the next naming request");
    expect(summary?.querySelector("small")?.textContent).toBe("Saved naming settings apply without a restart. Existing names and in-progress naming requests are unchanged.");
    expect(Array.from(summary?.querySelectorAll("dd") ?? [], (item) => item.textContent)).toEqual(["provider/naming", "64", "30.5 seconds", "off"]);
    panel.configResponse = configResponse();
    await panel.updateComplete;
    expect(Array.from(summary?.querySelectorAll("dd") ?? [], (item) => item.textContent)).toEqual(["Use session model", "24", "10 seconds", "minimal"]);
  });

  it("describes inherited naming defaults rather than promising built-in fallback values", async () => {
    const config = configResponse();
    const inherited = { model: "provider/deployed", maxTokens: 48, timeoutMs: 30000, thinkingLevel: "high" as const };
    config.defaultsConfig = { sessionNaming: inherited };
    config.config.sessionNaming = { model: "provider/saved" };
    config.effectiveConfig.sessionNaming = { ...inherited, ...config.config.sessionNaming };
    const panel = await mount(config);
    panel.onSave = vi.fn();
    expect(help(panel, toggle(panel, "session-naming-max-tokens"))).toContain("Clear to use 48 tokens");
    expect(help(panel, toggle(panel, "session-naming-timeout"))).toContain("Clear to use 30 seconds");
    const thinking = panel.shadowRoot?.querySelector<HTMLSelectElement>("#session-naming-thinking-level");
    expect(thinking?.options[0]?.textContent).toBe("Default (high)");
    panel.shadowRoot?.querySelector<HTMLButtonElement>("#session-naming-model")?.click();
    await panel.updateComplete;
    const picker = panel.shadowRoot?.querySelector<CommandPicker>("command-picker");
    if (!picker) throw new Error("Missing naming model picker");
    await picker.updateComplete;
    expect(picker.options[0]?.label).toBe("Use configured default");
    expect(picker.options[0]?.description).toContain("provider/deployed");
    picker.shadowRoot?.querySelector<HTMLButtonElement>("button.ui-selection-option")?.click();
    expect(panel.onSave).toHaveBeenCalledExactlyOnceWith({}, ["/sessionNaming/model"]);
  });

  it("searches and selects naming models while preserving naming overrides, and resets defaults", async () => {
    const config = configResponse();
    config.config.sessionNaming = { model: "openai/gpt-5", maxTokens: 48, thinkingLevel: "off", timeoutMs: 30000 };
    const panel = await mount(config);
    panel.namingModels = [
      { provider: "openai", id: "gpt-5", name: "GPT 5" },
      { provider: "anthropic", id: "claude-sonnet", name: "Claude Sonnet" },
    ];
    const onSave = vi.fn();
    panel.onSave = onSave;
    await panel.updateComplete;
    const model = panel.shadowRoot?.querySelector<HTMLButtonElement>("#session-naming-model");
    expect(model?.textContent).toContain("openai/gpt-5");
    model?.click();
    await panel.updateComplete;
    const picker = panel.shadowRoot?.querySelector<CommandPicker>("command-picker");
    if (!picker) throw new Error("Missing naming model picker");
    await picker.updateComplete;
    const search = picker.shadowRoot?.querySelector("input");
    if (!search) throw new Error("Missing model search");
    search.value = "sonnet";
    search.dispatchEvent(new Event("input"));
    await picker.updateComplete;
    const choices = picker.shadowRoot?.querySelectorAll<HTMLButtonElement>("button.ui-selection-option");
    expect(choices).toHaveLength(1);
    expect(choices?.[0]?.textContent).toContain("Claude Sonnet");
    choices?.[0]?.click();
    await panel.updateComplete;
    expect(panel.shadowRoot?.querySelector("command-picker")).toBeNull();
    expect(onSave).toHaveBeenLastCalledWith({ sessionNaming: { model: "anthropic/claude-sonnet" } });
    const budget = toggle(panel, "session-naming-max-tokens");
    for (const invalid of ["0", "-1", "1.5"]) {
      onSave.mockClear();
      budget.value = invalid;
      budget.dispatchEvent(new Event("change"));
      expect(onSave).not.toHaveBeenCalled();
    }
    budget.value = "64";
    budget.dispatchEvent(new Event("change"));
    expect(onSave).toHaveBeenLastCalledWith({ sessionNaming: { maxTokens: 64 } });
    budget.value = "";
    budget.dispatchEvent(new Event("change"));
    expect(onSave).toHaveBeenLastCalledWith({}, ["/sessionNaming/maxTokens"]);
    model?.click();
    await panel.updateComplete;
    const resetPicker = panel.shadowRoot?.querySelector<CommandPicker>("command-picker");
    if (!resetPicker) throw new Error("Missing naming model picker");
    await resetPicker.updateComplete;
    resetPicker.shadowRoot?.querySelector<HTMLButtonElement>("button.ui-selection-option")?.click();
    await panel.updateComplete;
    expect(onSave).toHaveBeenLastCalledWith({}, ["/sessionNaming/model"]);
  });

  it("saves thinking overrides including off and resets to minimal without changing the model or budget", async () => {
    const config = configResponse();
    config.config.sessionNaming = { model: "provider/naming", maxTokens: 64, timeoutMs: 30000 };
    const panel = await mount(config);
    const onSave = vi.fn();
    panel.onSave = onSave;
    const select = panel.shadowRoot?.querySelector<HTMLSelectElement>("#session-naming-thinking-level");
    if (!select) throw new Error("Missing thinking-level selector");
    expect(select.value).toBe("");
    expect(select.selectedOptions[0]?.textContent).toBe("Default (minimal)");
    expect(Array.from(select.options, (option) => option.value)).toEqual(["", "off", "minimal", "low", "medium", "high", "xhigh", "max"]);
    select.value = "off";
    select.dispatchEvent(new Event("change"));
    expect(onSave).toHaveBeenLastCalledWith({ sessionNaming: { thinkingLevel: "off" } });
    panel.configResponse = { ...config, config: { sessionNaming: { model: "provider/naming", maxTokens: 64, thinkingLevel: "off", timeoutMs: 30000 } }, effectiveConfig: { ...config.effectiveConfig, sessionNaming: { model: "provider/naming", maxTokens: 64, thinkingLevel: "off", timeoutMs: 30000 } } };
    await panel.updateComplete;
    expect(select.value).toBe("off");
    select.value = "";
    select.dispatchEvent(new Event("change"));
    expect(onSave).toHaveBeenLastCalledWith({}, ["/sessionNaming/thinkingLevel"]);
    panel.saving = true;
    await panel.updateComplete;
    expect(select.disabled).toBe(true);
  });

  it("converts timeout seconds to integer milliseconds and clears only the timeout override", async () => {
    const config = configResponse();
    config.config.sessionNaming = { model: "provider/naming", maxTokens: 48, thinkingLevel: "off", timeoutMs: 30500 };
    const panel = await mount(config);
    const onSave = vi.fn();
    panel.onSave = onSave;
    const input = toggle(panel, "session-naming-timeout");
    expect(panel.shadowRoot?.querySelector(`label[for='${input.id}']`)?.textContent).toBe("Naming timeout (seconds)");
    expect(input.value).toBe("30.5");
    expect(input.min).toBe("0.001");
    expect(input.max).toBe("2147483.647");
    expect(input.step).toBe("0.001");
    // happy-dom uses exact floating-point remainder for step validation, rejecting
    // valid fractional seconds. Keep native range checks and emulate step tolerance.
    vi.spyOn(input.validity, "stepMismatch", "get").mockImplementation(() => {
      const milliseconds = input.valueAsNumber * 1000;
      return input.value !== "" && Math.abs(milliseconds - Math.round(milliseconds)) > 0.000001;
    });
    expect(help(panel, input)).toContain("Total timeout includes model loading. Increase it for cold local engines.");
    for (const [seconds, timeoutMs] of [["0.001", 1], ["1.001", 1001], ["2147483.647", 2147483647]] as const) {
      input.value = seconds;
      input.dispatchEvent(new Event("change"));
      expect(onSave).toHaveBeenLastCalledWith({ sessionNaming: { timeoutMs } });
    }
    for (const invalid of ["0", "-1", "0.0001", "1.0005", "2147483.648"]) {
      onSave.mockClear();
      input.value = invalid;
      input.dispatchEvent(new Event("change"));
      expect(onSave).not.toHaveBeenCalled();
    }
    input.value = "";
    input.dispatchEvent(new Event("change"));
    expect(onSave).toHaveBeenLastCalledWith({}, ["/sessionNaming/timeoutMs"]);
  });

  it("defaults to the session model and 24 tokens, allows cancel, and disables naming controls during saves", async () => {
    const panel = await mount();
    const onSave = vi.fn();
    panel.onSave = onSave;
    const model = panel.shadowRoot?.querySelector<HTMLButtonElement>("#session-naming-model");
    expect(model?.textContent).toContain("Use session model");
    expect(toggle(panel, "session-naming-max-tokens").placeholder).toBe("24");
    const timeout = toggle(panel, "session-naming-timeout");
    expect(timeout.value).toBe("");
    expect(timeout.placeholder).toBe("10");
    expect(help(panel, timeout)).toContain("Clear to use 10 seconds.");
    model?.click();
    await panel.updateComplete;
    const picker = panel.shadowRoot?.querySelector<CommandPicker>("command-picker");
    if (!picker) throw new Error("Missing picker");
    await picker.updateComplete;
    picker.shadowRoot?.querySelector<HTMLButtonElement>("button[aria-label='Close']")?.click();
    await panel.updateComplete;
    expect(onSave).not.toHaveBeenCalled();
    expect(panel.shadowRoot?.querySelector("command-picker")).toBeNull();
    panel.saving = true;
    await panel.updateComplete;
    expect(model?.disabled).toBe(true);
    expect(toggle(panel, "session-naming-max-tokens").disabled).toBe(true);
    expect(timeout.disabled).toBe(true);
    panel.saving = false;
    panel.loading = true;
    await panel.updateComplete;
    expect(timeout.disabled).toBe(true);
  });

  it("keeps an unavailable saved model visible and explains loading and catalog errors without changing it", async () => {
    const config = configResponse();
    config.config.sessionNaming = { model: "missing/model" };
    const panel = await mount(config);
    const onSave = vi.fn();
    panel.onSave = onSave;
    expect(panel.shadowRoot?.textContent).toContain("The saved naming model is unavailable");
    expect(panel.shadowRoot?.querySelector("#session-naming-model")?.textContent).toContain("missing/model");
    panel.namingModelsLoading = true;
    await panel.updateComplete;
    expect(panel.shadowRoot?.textContent).toContain("Loading naming models");
    expect(panel.shadowRoot?.querySelector<HTMLButtonElement>("#session-naming-model")?.disabled).toBe(true);
    panel.namingModelsLoading = false;
    panel.namingModelsError = "Could not load models.";
    await panel.updateComplete;
    expect(panel.shadowRoot?.textContent).toContain("Could not load models. Refresh settings to try again. Your saved model is unchanged.");
    expect(onSave).not.toHaveBeenCalled();
  });

  it("closes the model picker when the settings target changes", async () => {
    const panel = await mount();
    panel.shadowRoot?.querySelector<HTMLButtonElement>("#session-naming-model")?.click();
    await panel.updateComplete;
    expect(panel.shadowRoot?.querySelector("command-picker")).not.toBeNull();
    panel.targetId = "another-machine";
    panel.targetLabel = "Another machine";
    await panel.updateComplete;
    expect(panel.shadowRoot?.querySelector("command-picker")).toBeNull();
  });

  it("guides unavailable settings recovery through refresh", async () => {
    const panel = await mount();
    panel.configResponse = undefined;
    await panel.updateComplete;
    expect(panel.shadowRoot?.querySelector(".loading-card")?.textContent).toBe("Configuration is unavailable. Refresh settings to try again.");
    expect(panel.shadowRoot?.querySelector("input")).toBeNull();
  });
});
