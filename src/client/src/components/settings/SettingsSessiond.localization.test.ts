// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import type { PiWebConfigResponse } from "../../api";
import { localization } from "../../localization/browser";
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
    config: {},
    effectiveConfig: { spawnSessions: true, subsessions: true, askUser: true },
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
}
async function mount(): Promise<SettingsSessiondPanel> {
  const panel = new SettingsSessiondPanel();
  panel.configResponse = config();
  panel.targetLabel = raw;
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

it("localizes the panel live with unchanged raw values, controls and focus", async () => {
  releases.push(localization.registerCatalog({ id: "sessiond-test", namespace: "core.settingsSessiond", locale: "de", load: () => Promise.resolve({ heading: "Sitzungsdienst", refresh: "Aktualisieren" }) }));
  const panel = await mount();
  const ask = input(panel, "ask-user");
  ask.focus();
  for (const locale of ["de", "en-XA", "ar-XB", "en"]) {
    await language(panel, locale);
    expect(frame(panel).heading).toBe(messages.t("heading"));
    expect(frame(panel).description).toBe(messages.t("description", { target: raw }));
    expect(frame(panel).actionLabel).toBe(messages.t("refresh"));
    expect(ask.closest("label")?.textContent.trim()).toBe(messages.t("askUser"));
    expect(Array.from(panel.shadowRoot?.querySelectorAll("small code") ?? [], (node) => node.textContent)).toEqual(["spawn_session", "spawn_subsession", "list_subsessions", "check_subsession", "read_subsession", "send_session_message", "ask_user"]);
    expect(panel.shadowRoot?.querySelector("#restart-summary-help")?.textContent).toBe(messages.t("restartHelp"));
    expect(panel.shadowRoot?.querySelector(".config-path-card code")?.textContent).toBe(panel.configResponse?.path);
    expect(Array.from(panel.shadowRoot?.querySelectorAll("dd") ?? [], (node) => node.textContent)).toEqual(Array<string>(4).fill(messages.t("enabled")));
    expect(input(panel, ask.id)).toBe(ask);
    expect(ask.checked).toBe(true);
    expect(panel.shadowRoot?.activeElement).toBe(ask);
    expect(panel.shadowRoot?.querySelector("img")).toBeNull();
    expect(frame(panel).shadowRoot?.querySelector("img")).toBeNull();
  }
  expect(panel.onSave).not.toHaveBeenCalled();
  expect(panel.onReload).not.toHaveBeenCalled();
  ask.click();
  expect(panel.onSave).toHaveBeenCalledExactlyOnceWith({ askUser: false });
});

it("keeps pending permission saves and raw parent-owned feedback without replaying actions", async () => {
  const panel = await mount();
  const pending = deferred<undefined>();
  panel.onSave = vi.fn(() => pending.promise);
  input(panel, "ask-user").click();
  panel.saving = true;
  panel.error = raw;
  panel.savedMessage = "Raw saved <img>";
  for (const locale of ["en-XA", "ar-XB"]) {
    await language(panel, locale);
    expect(panel.onSave).toHaveBeenCalledExactlyOnceWith({ askUser: false });
    expect(input(panel, "ask-user").disabled).toBe(true);
    expect(frame(panel).actionDisabled).toBe(true);
    expect(frame(panel).notices).toEqual([{ type: "error", content: raw }, { type: "success", content: "Raw saved <img>" }]);
    expect(frame(panel).shadowRoot?.querySelector("img")).toBeNull();
  }
  pending.resolve(undefined);
  panel.saving = false;
  await settle(panel);
  required(frame(panel).shadowRoot?.querySelector("button")).click();
  expect(panel.onReload).toHaveBeenCalledOnce();
});

it("localizes environment locks, dependencies and recovery", async () => {
  const panel = await mount();
  const response = config();
  response.effectiveConfig.spawnSessions = false;
  response.envOverrides = { ...response.envOverrides, spawnSessions: true, subsessions: true, sessionMessages: true, askUser: true };
  panel.configResponse = response;
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

it("reconnects in the current locale without refreshing", async () => {
  const panel = await mount();
  const ask = input(panel, "ask-user");
  panel.remove();
  await language(panel, "ar-XB");
  document.body.append(panel);
  await settle(panel);
  expect(frame(panel).heading).toBe(messages.t("heading"));
  expect(input(panel, ask.id)).toBe(ask);
  expect(ask.checked).toBe(true);
  expect(panel.onSave).not.toHaveBeenCalled();
  expect(panel.onReload).not.toHaveBeenCalled();
});
