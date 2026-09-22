// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LANGUAGE_STORAGE_KEY, localeStore, localeResources } from "../../i18n/locale";
import { SettingsGeneralPanel } from "./SettingsGeneralPanel";
import { SettingsPanelFrame } from "./SettingsPanelFrame";

beforeEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  localeResources.update([]);
  localeStore.dispose();
  localeStore.initialize();
  localeStore.setPreference("en");
});

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  localeResources.update([]);
  localeStore.dispose();
});

describe("settings-general-panel language preference", () => {
  it("applies other-tab language changes and ignores unrelated storage", async () => {
    localeResources.update([simplifiedChineseCore({ "settings.generalConfiguration": "常规配置" })]);
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
    localeResources.update([simplifiedChineseCore({
      "settings.generalConfiguration": "常规配置",
      "settings.languagePreference": "语言偏好",
    })]);
    const panel = new SettingsGeneralPanel();
    document.body.append(panel);
    await panel.updateComplete;

    const languageSelect = requiredLanguageSelect(panel);
    expect(requiredFrame(panel).heading).toBe("General configuration");
    expect([...languageSelect.options].map((option) => option.value)).toEqual(["auto", "en", "zh-CN"]);

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

  it("keeps English display for a saved preference whose language pack is unavailable", async () => {
    localeStore.dispose();
    localStorage.setItem("pi-web-app-language", "ko-KR");
    localeStore.initialize();
    const panel = new SettingsGeneralPanel();
    document.body.append(panel);
    await panel.updateComplete;

    expect(localeStore.getPreference()).toBe("ko-KR");
    expect(localeStore.getLocale()).toBe("en");
    expect(requiredFrame(panel).heading).toBe("General configuration");
    const select = requiredLanguageSelect(panel);
    const unavailableOption = requiredOption(select, "ko-KR");
    expect(unavailableOption.disabled).toBe(true);
    expect(unavailableOption.textContent).toBe("ko-KR (unavailable)");
  });
});

function requiredOption(select: HTMLSelectElement, value: string): HTMLOptionElement {
  const option = [...select.options].find((candidate) => candidate.value === value);
  if (option === undefined) throw new Error(`Language option ${value} was not rendered`);
  return option;
}

function simplifiedChineseCore(messages: Record<string, string>): {
  locale: string;
  label: string;
  aliases: string[];
  namespace: string;
  messages: Record<string, string>;
} {
  return {
    locale: "zh-CN",
    label: "简体中文",
    aliases: ["zh-Hans", "zh-SG"],
    namespace: "core",
    messages,
  };
}

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
