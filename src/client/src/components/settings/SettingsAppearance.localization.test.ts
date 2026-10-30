// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { localization } from "../../localization/browser";
import { themeMessages, shortcutMessages, frameMessages } from "./settingsAppearanceMessages";
import { SettingsThemePanel } from "./SettingsThemePanel";
import { SettingsShortcutsPanel } from "./SettingsShortcutsPanel";
import { COMPOSER_SEND_DESKTOP } from "../../composerShortcuts";
import type { PiWebConfigResponse } from "../../api";
import type { AppAction } from "../../actions";

const releases: (() => void)[] = [];
afterEach(async () => {
  document.body.replaceChildren();
  releases.splice(0).forEach((release) => { release(); });
  await localization.setPreferences({ language: "en", formatLocale: "en" });
  localStorage.clear();
  vi.useRealTimers();
});

function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error("Expected settings control");
  return value;
}
function input(panel: SettingsShortcutsPanel, id = "raw-action"): HTMLInputElement {
  return required([...panel.renderRoot.querySelectorAll<HTMLInputElement>(".shortcut-input")].find((item) => item.dataset["actionId"] === id));
}
function row(panel: SettingsShortcutsPanel, id = "raw-action"): HTMLElement {
  return required(input(panel, id).closest("article"));
}
async function settle(panel: SettingsShortcutsPanel): Promise<void> {
  await panel.updateComplete;
  await panel.renderRoot.querySelector("settings-panel-frame")?.updateComplete;
}
async function language(language: string, panel: SettingsThemePanel | SettingsShortcutsPanel): Promise<void> {
  await localization.setPreferences({ language, formatLocale: "ar-EG" });
  await panel.updateComplete;
  if (panel instanceof SettingsShortcutsPanel) await settle(panel);
}
const action: AppAction = { id: "raw-action", title: "Raw <img> العربية", description: "Raw provider description", shortcut: "mod+k", run: vi.fn() };
async function shortcuts(actions = [action], nested = false): Promise<SettingsShortcutsPanel> {
  const panel = new SettingsShortcutsPanel();
  panel.actions = actions;
  panel.configResponse = {
    path: "/raw/<img>/config.json", exists: true, envOverrides: { host: false, port: false, allowedHosts: false, spawnSessions: false, subsessions: false, sessionMessages: false, askUser: false }, config: {}, effectiveConfig: {},
  } satisfies PiWebConfigResponse;
  if (nested) document.body.appendChild(document.createElement("div")).attachShadow({ mode: "open" }).append(panel);
  else document.body.append(panel);
  await settle(panel);
  return panel;
}
function edit(panel: SettingsShortcutsPanel, value: string, id = "raw-action"): void {
  const field = input(panel, id);
  field.value = value;
  field.dispatchEvent(new Event("input", { bubbles: true }));
}
function click(panel: SettingsShortcutsPanel, index: number, id = "raw-action"): void {
  required(row(panel, id).querySelectorAll("button")[index]).click();
}
function notice(panel: SettingsShortcutsPanel): string {
  return required(panel.renderRoot.querySelector("settings-panel-frame")?.shadowRoot).querySelector(".notice-content")?.textContent ?? "";
}

it("updates the whole theme panel live without changing staged choices, focus, or applying actions", async () => {
  releases.push(localization.registerCatalog({ id: "theme-test", namespace: "core.settingsTheme", locale: "de", load: () => Promise.resolve({ heading: "Thema", unavailable: "Nicht verfügbar: {id}", useLocal: "Hier anwenden" }) }));
  const panel = new SettingsThemePanel();
  panel.themes = [{ id: "raw:theme", name: "Raw <img> العربية", pluginId: "raw", localId: "theme", colorScheme: "dark" }];
  panel.preference = { themeId: "missing:theme", auto: true };
  panel.onUseLocal = vi.fn();
  panel.onSetDefault = vi.fn();
  document.body.append(panel);
  await panel.updateComplete;
  const select = required(panel.renderRoot.querySelector("select"));
  select.value = "raw:theme";
  select.dispatchEvent(new Event("change"));
  const checkbox = required(panel.renderRoot.querySelector("input"));
  checkbox.click();
  await panel.updateComplete;
  select.focus();
  for (const locale of ["de", "en-XA", "ar-XB"]) {
    await language(locale, panel);
    expect(panel.renderRoot.querySelector("select")).toBe(select);
    expect(panel.shadowRoot?.activeElement).toBe(select);
    expect(select.value).toBe("raw:theme");
    expect(checkbox.checked).toBe(false);
    expect(select.getAttribute("aria-label")).toBe(themeMessages.t("heading"));
    expect(panel.renderRoot.querySelector("option")?.textContent).toBe("Raw <img> العربية");
    expect(panel.renderRoot.querySelector("img")).toBeNull();
    expect(panel.onUseLocal).not.toHaveBeenCalled();
    expect(panel.onSetDefault).not.toHaveBeenCalled();
  }
  required(panel.renderRoot.querySelector("button")).click();
  expect(panel.onUseLocal).toHaveBeenCalledExactlyOnceWith({ themeId: "raw:theme", auto: false });
});

it.each([false, true])("preserves shortcut drafts, details, focus and raw fields across live locales (nested: %s)", async (nested) => {
  releases.push(localization.registerCatalog({ id: "shortcut-test", namespace: "core.settingsShortcuts", locale: "de", load: () => Promise.resolve({ heading: "Tastenkürzel", shortcut: "Kürzel", otherGroup: "Andere", composerGroup: "Z-Komponist", save: "Speichern" }) }));
  const panel = await shortcuts([action], nested);
  panel.onSave = vi.fn();
  panel.onReload = vi.fn();
  edit(panel, "mod+shift+p");
  await settle(panel);
  const field = input(panel);
  const details = required(panel.renderRoot.querySelector("details"));
  details.open = true;
  field.focus();
  for (const locale of ["de", "en-XA", "ar-XB"]) {
    await language(locale, panel);
    expect(input(panel)).toBe(field);
    expect(panel.shadowRoot?.activeElement).toBe(field);
    expect(field.value).toBe("mod+shift+p");
    expect(field.dir).toBe("ltr");
    expect(field.getAttribute("aria-label")).toBe(shortcutMessages.t("shortcutFor", { title: action.title }));
    expect(details.open).toBe(true);
    expect(row(panel).querySelector("strong")?.textContent).toBe(action.title);
    expect(panel.renderRoot.querySelector(".config-path-card > code")?.textContent).toBe("/raw/<img>/config.json");
    expect(panel.renderRoot.querySelector("img")).toBeNull();
    expect(panel.onSave).not.toHaveBeenCalled();
    expect(panel.onReload).not.toHaveBeenCalled();
  }
  click(panel, 0);
  expect(panel.onSave).toHaveBeenCalledExactlyOnceWith({ shortcuts: { "raw-action": "mod+shift+p" } });
});

it("keeps recording alive across live language changes and cancels by the same Escape key", async () => {
  vi.useFakeTimers();
  const panel = await shortcuts();
  click(panel, 1);
  await settle(panel);
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "g", bubbles: true }));
  await settle(panel);
  for (const locale of ["en-XA", "ar-XB"]) {
    await language(locale, panel);
    expect(input(panel).value).toBe("g");
    expect(row(panel).querySelector(".recording-hint")?.textContent).toBe(shortcutMessages.t("recordingSequence", { shortcut: "G" }));
  }
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "p", bubbles: true }));
  await settle(panel);
  expect(input(panel).value).toBe("g p");
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await settle(panel);
  expect(row(panel).querySelector(".recording-hint")).toBeNull();
});

it.each([
  ["mod+mod+k", "duplicateModifier"], ["mod+bogus", "unsupportedKey"], ["mod", "missingKey"], ["a+b", "multipleKeys"],
] as const)("resolves stored %s validation in the current language, not by matching English", async (value, key) => {
  const panel = await shortcuts();
  edit(panel, value);
  await settle(panel);
  click(panel, 0);
  await settle(panel);
  await language("ar-XB", panel);
  const expected = key === "duplicateModifier" ? shortcutMessages.t(key, { value: "Ctrl" })
    : key === "unsupportedKey" ? shortcutMessages.t(key, { value: "bogus" }) : shortcutMessages.t(key);
  expect(notice(panel)).toBe(expected);
  const frame = required(panel.renderRoot.querySelector("settings-panel-frame")?.shadowRoot);
  expect(frame.querySelector(".notice-stack")?.getAttribute("aria-label")).toBe(frameMessages.t("notices"));
});

it("keeps save failure provenance and raw diagnostics live, and localizes built-in composer actions", async () => {
  const panel = await shortcuts();
  panel.onSave = vi.fn(() => Promise.reject(new Error("Raw <img> runtime")));
  edit(panel, "mod+p");
  await settle(panel);
  click(panel, 0);
  await Promise.resolve();
  await settle(panel);
  await language("ar-XB", panel);
  expect(notice(panel)).toBe(shortcutMessages.t("saveFailure", { diagnostic: "Raw <img> runtime" }));
  expect(row(panel, COMPOSER_SEND_DESKTOP).querySelector("strong")?.textContent).toBe(shortcutMessages.t("composerTitle", { screen: "desktop" }));
  expect(row(panel, COMPOSER_SEND_DESKTOP).textContent).toContain(shortcutMessages.t("composerDescription"));
  expect(input(panel).value).toBe("mod+p");
  expect(panel.onSave).toHaveBeenCalledOnce();
});

it("formats conflict counts and action lists regionally without changing dispatch identity", async () => {
  const actions = Array.from({ length: 5 }, (_, i) => ({ ...action, id: `action-${String(i)}`, title: `Raw ${String(i)}` }));
  const panel = await shortcuts(actions);
  await language("ar-XB", panel);
  expect(row(panel, "action-0").textContent).toContain(shortcutMessages.t("conflict", {
    count: 4, more: 2, names: localization.list(["Raw 1", "Raw 2"]),
  }));
  expect(row(panel, "action-1").textContent).toContain(shortcutMessages.t("inactive", { title: "Raw 0" }));
});
