// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import type { PiWebConfigResponse } from "../../api";
import { localization } from "../../localization/browser";
import type { CommandPicker } from "../CommandPicker";
import { deferred } from "../SettingsDialog.testSupport";
import type { SettingsPanelFrame } from "./SettingsPanelFrame";
import { SettingsSessiondPanel, sessiondMessages as messages } from "./SettingsSessiondPanel";

const raw = "Raw <img> العربية";
const releases: (() => void)[] = [];
afterEach(async () => {
  document.body.replaceChildren();
  releases.splice(0).forEach((release) => { release(); });
  await localization.setPreferences({ language: "en", formatLocale: "en-US" });
  localStorage.clear();
  vi.restoreAllMocks();
});
function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Missing fixture control");
  return value;
}
function config(): PiWebConfigResponse {
  return {
    path: `/raw/<img>/${raw}/config.json`, exists: true,
    config: { sessionNaming: { model: "raw/model", maxTokens: 1200, timeoutMs: 30500 } },
    effectiveConfig: { spawnSessions: true, subsessions: true, askUser: true, sessionNaming: { model: "raw/model", maxTokens: 1200, timeoutMs: 30500 } },
    envOverrides: { host: false, port: false, allowedHosts: false, spawnSessions: false, subsessions: false, sessionMessages: false, askUser: false },
  };
}
function input(panel: SettingsSessiondPanel, id: string): HTMLInputElement {
  return required(panel.shadowRoot?.querySelector<HTMLInputElement>(`#${id}`));
}
function frame(panel: SettingsSessiondPanel): SettingsPanelFrame {
  return required(panel.shadowRoot?.querySelector<SettingsPanelFrame>("settings-panel-frame"));
}
async function settle(panel: SettingsSessiondPanel): Promise<void> {
  await panel.updateComplete;
  await frame(panel).updateComplete;
  await panel.shadowRoot?.querySelector<CommandPicker>("command-picker")?.updateComplete;
}
async function mount(): Promise<SettingsSessiondPanel> {
  const panel = new SettingsSessiondPanel();
  panel.configResponse = config();
  panel.targetLabel = raw;
  panel.targetId = "raw-machine";
  panel.namingModels = [{ provider: "raw", id: "model", name: raw }];
  panel.onSave = vi.fn();
  panel.onReload = vi.fn();
  document.body.append(panel);
  await settle(panel);
  return panel;
}
async function language(panel: SettingsSessiondPanel, language: string): Promise<void> {
  await localization.setPreferences({ language, formatLocale: "ar-EG" });
  await settle(panel);
}

it("localizes the whole panel live, with regional summaries and unchanged raw values, drafts and focus", async () => {
  releases.push(localization.registerCatalog({ id: "sessiond-test", namespace: "core.settingsSessiond", locale: "de", load: () => Promise.resolve({ heading: "Sitzungsdienst", refresh: "Aktualisieren", model: "Namensmodell" }) }));
  const panel = await mount();
  const budget = input(panel, "session-naming-max-tokens");
  const timeout = input(panel, "session-naming-timeout");
  budget.value = "1234";
  budget.dispatchEvent(new Event("input"));
  timeout.value = "2.125";
  timeout.dispatchEvent(new Event("input"));
  budget.focus();
  for (const locale of ["de", "en-XA", "ar-XB", "en"]) {
    await language(panel, locale);
    expect(frame(panel).heading).toBe(messages.t("heading"));
    expect(frame(panel).description).toBe(messages.t("description", { target: raw }));
    expect(frame(panel).actionLabel).toBe(messages.t("refresh"));
    expect(panel.shadowRoot?.querySelector("#session-naming-model-label")?.textContent).toBe(messages.t("model"));
    expect(Array.from(panel.shadowRoot?.querySelectorAll("small code") ?? [], (node) => node.textContent)).toEqual(["spawn_session", "spawn_subsession", "list_subsessions", "check_subsession", "read_subsession", "send_session_message", "ask_user"]);
    expect(panel.shadowRoot?.querySelector("#restart-summary-help")?.textContent).toBe(messages.t("restartHelp"));
    expect(panel.shadowRoot?.querySelector("#naming-summary-help")?.textContent).toBe(messages.t("namingSummaryHelp"));
    expect(panel.shadowRoot?.querySelector(".config-path-card code")?.textContent).toBe(panel.configResponse?.path);
    expect(panel.shadowRoot?.querySelector("#session-naming-model-value bdi")?.textContent).toBe("raw/model");
    const summary = panel.shadowRoot?.querySelector("[aria-labelledby='naming-summary-heading']");
    expect(Array.from(summary?.querySelectorAll("dd") ?? [], (node) => node.textContent)).toEqual(["raw/model", localization.number(1200), messages.t("seconds", { count: 30.5 }), "minimal"]);
    expect(input(panel, budget.id)).toBe(budget);
    expect(budget.value).toBe("1234");
    expect(timeout.value).toBe("2.125");
    expect(panel.shadowRoot?.activeElement).toBe(budget);
    expect(panel.shadowRoot?.querySelector("img")).toBeNull();
    expect(frame(panel).shadowRoot?.querySelector("img")).toBeNull();
  }
  expect(panel.onSave).not.toHaveBeenCalled();
  expect(panel.onReload).not.toHaveBeenCalled();
  budget.dispatchEvent(new Event("change"));
  expect(panel.onSave).toHaveBeenCalledExactlyOnceWith({ sessionNaming: { maxTokens: 1234 } });
});

it("retains an open model picker and its search when the locale or display target changes, not its identity", async () => {
  const panel = await mount();
  required(panel.shadowRoot?.querySelector<HTMLButtonElement>("#session-naming-model")).click();
  await settle(panel);
  const picker = required(panel.shadowRoot?.querySelector<CommandPicker>("command-picker"));
  const search = required(picker.shadowRoot?.querySelector("input"));
  search.value = "raw";
  search.dispatchEvent(new Event("input"));
  search.focus();
  for (const locale of ["en-XA", "ar-XB"]) {
    panel.targetLabel = `${raw} renamed`;
    await language(panel, locale);
    expect(panel.shadowRoot?.querySelector("command-picker")).toBe(picker);
    expect(picker.title).toBe(messages.t("selectModel"));
    expect(picker.options[0]?.label).toBe(messages.t("useSessionModel"));
    expect(picker.options[0]?.description).toBe(messages.t("sessionModelHelp"));
    expect(picker.shadowRoot?.querySelector("input")).toBe(search);
    expect(search.value).toBe("raw");
    expect(picker.shadowRoot?.activeElement).toBe(search);
    expect(picker.shadowRoot?.textContent).toContain(raw);
    expect(picker.shadowRoot?.querySelector("img")).toBeNull();
  }
  expect(panel.onSave).not.toHaveBeenCalled();
  required(picker.shadowRoot?.querySelector<HTMLButtonElement>("button.ui-selection-option")).click();
  await settle(panel);
  expect(panel.onSave).not.toHaveBeenCalled();
  required(panel.shadowRoot?.querySelector<HTMLButtonElement>("#session-naming-model")).click();
  await settle(panel);
  panel.targetId = "different-machine";
  await settle(panel);
  expect(panel.shadowRoot?.querySelector("command-picker")).toBeNull();
});

it("keeps pending permission saves and raw parent-owned feedback without replaying actions", async () => {
  const panel = await mount();
  const pending = deferred<undefined>();
  panel.onSave = vi.fn(() => pending.promise);
  input(panel, "ask-user").click();
  panel.saving = true;
  panel.error = raw;
  panel.savedMessage = "Raw saved <img>";
  panel.namingModelsError = raw;
  for (const locale of ["en-XA", "ar-XB"]) {
    await language(panel, locale);
    expect(panel.onSave).toHaveBeenCalledExactlyOnceWith({ askUser: false });
    expect(input(panel, "ask-user").disabled).toBe(true);
    expect(frame(panel).actionDisabled).toBe(true);
    expect(frame(panel).notices).toEqual([{ type: "error", content: raw }, { type: "success", content: "Raw saved <img>" }]);
    expect(panel.shadowRoot?.textContent).toContain(messages.t("modelsError", { error: raw }));
    expect(frame(panel).shadowRoot?.querySelector("img")).toBeNull();
  }
  pending.resolve(undefined);
  panel.saving = false;
  await settle(panel);
  required(frame(panel).shadowRoot?.querySelector("button")).click();
  expect(panel.onReload).toHaveBeenCalledOnce();
});

it("localizes environment locks, dependencies, model statuses, default values and recovery", async () => {
  const panel = await mount();
  const response = config();
  response.effectiveConfig.spawnSessions = false;
  response.envOverrides = { ...response.envOverrides, spawnSessions: true, subsessions: true, sessionMessages: true, askUser: true };
  response.config.sessionNaming = {};
  response.effectiveConfig.sessionNaming = { timeoutMs: 1000 };
  panel.configResponse = response;
  panel.namingModels = [];
  for (const locale of ["en-XA", "ar-XB"]) {
    await language(panel, locale);
    for (const [id, variable] of [["spawn-sessions", "PI_WEB_SPAWN_SESSIONS"], ["subsessions", "PI_WEB_SUBSESSIONS"], ["session-messages", "PI_WEB_SESSION_MESSAGES"], ["ask-user", "PI_WEB_ASK_USER"]]) {
      const control = input(panel, required(id));
      expect(control.disabled).toBe(true);
      const help = required(panel.shadowRoot?.getElementById(required(control.getAttribute("aria-describedby"))));
      expect(help.querySelector("code:last-child")?.textContent).toBe(variable);
      expect(help.querySelector("code:last-child")?.getAttribute("dir")).toBe("ltr");
    }
    expect(panel.shadowRoot?.textContent).toContain(messages.t("enableSpawn"));
    expect(panel.shadowRoot?.textContent).toContain(messages.t("modelsEmpty"));
    expect(panel.shadowRoot?.querySelector("#session-naming-model-value")?.textContent).toBe(messages.t("useSessionModel"));
    expect(panel.shadowRoot?.querySelector("option[value='']")?.textContent).toBe(messages.t("defaultThinking", { level: "minimal" }));
    expect(panel.shadowRoot?.textContent).toContain(messages.t("seconds", { count: 1 }));
    panel.namingModelsLoading = true;
    await settle(panel);
    expect(panel.shadowRoot?.textContent).toContain(messages.t("modelsLoading"));
    panel.namingModelsLoading = false;
  }
  panel.configResponse = undefined;
  for (const locale of ["en-XA", "ar-XB"]) {
    panel.loading = true;
    await language(panel, locale);
    expect(panel.shadowRoot?.querySelector(".loading-card")?.textContent).toBe(messages.t("loading"));
    panel.loading = false;
    await settle(panel);
    expect(panel.shadowRoot?.querySelector(".loading-card")?.textContent).toBe(messages.t("unavailable"));
  }
  expect(panel.onSave).not.toHaveBeenCalled();
  expect(panel.onReload).not.toHaveBeenCalled();
});

it("resets numeric drafts on target identity changes even when configured values match", async () => {
  const panel = await mount();
  const budget = input(panel, "session-naming-max-tokens");
  budget.value = "55";
  panel.targetId = "other-machine";
  await settle(panel);
  expect(input(panel, budget.id)).toBe(budget);
  expect(budget.value).toBe("1200");
  expect(panel.onSave).not.toHaveBeenCalled();
});

it("reconnects in the current locale without losing drafts or refreshing", async () => {
  const panel = await mount();
  const budget = input(panel, "session-naming-max-tokens");
  budget.value = "55";
  panel.remove();
  await language(panel, "ar-XB");
  document.body.append(panel);
  await settle(panel);
  expect(frame(panel).heading).toBe(messages.t("heading"));
  expect(input(panel, budget.id)).toBe(budget);
  expect(budget.value).toBe("55");
  expect(panel.onSave).not.toHaveBeenCalled();
  expect(panel.onReload).not.toHaveBeenCalled();
});
