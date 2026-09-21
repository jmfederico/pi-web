// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LANGUAGE_STORAGE_KEY, localeStore } from "../../i18n/locale";
import { SettingsGeneralPanel } from "./SettingsGeneralPanel";
import { SettingsPanelFrame } from "./SettingsPanelFrame";

beforeEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  localeStore.dispose();
  localeStore.initialize();
  localeStore.setPreference("en");
});

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  localeStore.dispose();
});

describe("settings-general-panel language preference", () => {
  it("applies other-tab language changes and ignores unrelated storage", async () => {
    const panel = new SettingsGeneralPanel();
    document.body.append(panel);
    await panel.updateComplete;
    window.dispatchEvent(new StorageEvent("storage", { key: LANGUAGE_STORAGE_KEY, newValue: "zh-CN", storageArea: localStorage }));
    await panel.updateComplete;
    expect(requiredFrame(panel).heading).toBe("常规配置");
    expect(document.documentElement.lang).toBe("zh-CN");
    window.dispatchEvent(new StorageEvent("storage", { key: LANGUAGE_STORAGE_KEY, newValue: "en", storageArea: sessionStorage }));
    await panel.updateComplete;
    expect(requiredFrame(panel).heading).toBe("常规配置");
    window.dispatchEvent(new StorageEvent("storage", { key: null, storageArea: localStorage }));
    await panel.updateComplete;
    expect(localeStore.getPreference()).toBe("auto");
    expect(requiredLanguageSelect(panel).value).toBe("auto");
  });

  it("switches the live panel language and persists the browser preference", async () => {
    const panel = new SettingsGeneralPanel();
    document.body.append(panel);
    await panel.updateComplete;

    const languageSelect = requiredLanguageSelect(panel);
    expect(requiredFrame(panel).heading).toBe("General configuration");

    languageSelect.value = "zh-CN";
    languageSelect.dispatchEvent(new Event("change", { bubbles: true }));
    await panel.updateComplete;

    expect(localeStore.getPreference()).toBe("zh-CN");
    expect(document.documentElement.lang).toBe("zh-CN");
    expect(languageSelect.value).toBe("zh-CN");
    expect(requiredFrame(panel).heading).toBe("常规配置");
    expect(panel.shadowRoot?.textContent).toContain("语言偏好");
    expect(localStorage.getItem("pi-web-app-language")).toBe("zh-CN");
  });
});

function requiredFrame(panel: SettingsGeneralPanel): SettingsPanelFrame {
  const frame = panel.shadowRoot?.querySelector<SettingsPanelFrame>("settings-panel-frame");
  if (frame === undefined || frame === null) throw new Error("Settings panel frame was not rendered");
  return frame;
}

function requiredLanguageSelect(panel: SettingsGeneralPanel): HTMLSelectElement {
  const select = panel.shadowRoot?.querySelector<HTMLSelectElement>(".language-card select");
  if (select === undefined || select === null) throw new Error("Language preference select was not rendered");
  return select;
}
