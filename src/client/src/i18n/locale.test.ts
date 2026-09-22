// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import { LanguageOption, LocaleStore, LANGUAGE_STORAGE_KEY, readLanguagePreference, writeLanguagePreference } from "./locale";
import { LocaleResourceStore, setMissingMessageKeyDiagnostics } from "./resources";
import type { LocaleResourceContribution } from "./types";

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  readonly length = 0;
  clear(): void { this.values.clear(); }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  key(): string | null { return null; }
  removeItem(key: string): void { this.values.delete(key); }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

function zhCNContribution(messages: Record<string, string> = { "settings.generalConfiguration": "常规配置" }): LocaleResourceContribution {
  return {
    locale: "zh-CN",
    label: "简体中文",
    aliases: ["zh-Hans", "zh-SG"],
    namespace: "core",
    messages,
  };
}

afterEach(() => {
  window.localStorage.clear();
});

describe("stored preferences", () => {
  it("accepts language tags and auto, and rejects malformed values", () => {
    const storage = new MemoryStorage();
    expect(readLanguagePreference(storage)).toBe("auto");
    writeLanguagePreference(storage, "zh-CN");
    expect(readLanguagePreference(storage)).toBe("zh-CN");
    writeLanguagePreference(storage, "pt-BR");
    expect(readLanguagePreference(storage)).toBe("pt-BR");
    writeLanguagePreference(storage, "auto");
    expect(readLanguagePreference(storage)).toBe("auto");
    storage.setItem(LANGUAGE_STORAGE_KEY, "");
    expect(readLanguagePreference(storage)).toBe("auto");
    storage.setItem(LANGUAGE_STORAGE_KEY, "not a language tag!");
    expect(readLanguagePreference(storage)).toBe("auto");
    expect(readLanguagePreference({ getItem: () => { throw new Error("blocked"); } })).toBe("auto");
    expect(() => { writeLanguagePreference({ setItem: () => { throw new Error("blocked"); } }, "en"); }).not.toThrow();
  });
});

describe("LocaleStore resource-driven language state", () => {
  function createStore(options: { storage?: Storage; languages?: readonly string[]; resources?: LocaleResourceStore; document?: { documentElement: { lang: string } } } = {}) {
    const store = new LocaleStore({
      storage: options.storage,
      languages: options.languages ?? ["en-US"],
      document: options.document ?? { documentElement: { lang: "en" } },
      resources: options.resources,
    });
    store.initialize();
    return store;
  }

  it("keeps an explicit preference saved before its language pack arrives, then applies it", () => {
    const resources = new LocaleResourceStore();
    const storage = new MemoryStorage();
    storage.setItem(LANGUAGE_STORAGE_KEY, "zh-CN");
    const store = createStore({ storage, resources });

    expect(store.getPreference()).toBe("zh-CN");
    expect(store.getLocale()).toBe("en");
    expect(store.translate("core.settings.generalConfiguration")).toBe("General configuration");

    resources.update([zhCNContribution()]);

    expect(store.getLocale()).toBe("zh-CN");
    expect(store.translate("core.settings.generalConfiguration")).toBe("常规配置");
    expect(store.getPreference()).toBe("zh-CN");
  });

  it("falls back to English when the pack disappears but keeps the preference", () => {
    const resources = new LocaleResourceStore();
    const store = createStore({ resources });
    resources.update([zhCNContribution({ "settings.generalConfiguration": "常规配置", "common.reload": "重新加载" })]);
    store.setPreference("zh-CN");
    expect(store.getLocale()).toBe("zh-CN");

    resources.update([]);

    expect(store.getPreference()).toBe("zh-CN");
    expect(store.getLocale()).toBe("en");
    expect(store.translate("core.settings.generalConfiguration")).toBe("General configuration");
  });

  it("resolves Auto by browser language order before falling back to English", () => {
    const resources = new LocaleResourceStore();
    resources.update([zhCNContribution({ "common.reload": "重新加载" })]);

    expect(createStore({ resources, languages: ["en-US", "zh-CN"] }).getLocale()).toBe("en");
    expect(createStore({ resources, languages: ["zh-Hans-CN", "en"] }).getLocale()).toBe("zh-CN");
    expect(createStore({ resources, languages: ["zh_SG"] }).getLocale()).toBe("zh-CN");
    expect(createStore({ resources, languages: ["fr-FR"] }).getLocale()).toBe("en");
    expect(createStore({ resources, languages: [] }).getLocale()).toBe("en");
  });

  it("translates missing keys per key with English fallback and visible interpolation", () => {
    const resources = new LocaleResourceStore();
    resources.update([zhCNContribution({
      "settings.generalDescription": "网关服务器字段用于编辑当前网关；文件访问和上传默认值用于编辑{targetLabel}。",
    })]);
    const store = createStore({ resources });
    store.setPreference("zh-CN");

    expect(store.translate("core.settings.generalDescription", { targetLabel: "Lab Mac" }))
      .toBe("网关服务器字段用于编辑当前网关；文件访问和上传默认值用于编辑Lab Mac。");
    expect(store.translate("core.settings.generalConfiguration")).toBe("General configuration");
    expect(store.translate("core.settings.generalDescription", { targetLabel: "{targetLabel}" })).toContain("{targetLabel}");
    expect(store.translate("core.settings.generalDescription")).toContain("{targetLabel}");
  });

  it("lists Auto and English without language packs and installed languages with their labels", () => {
    const resources = new LocaleResourceStore();
    const bare = createStore({ resources });
    expect(bare.getLanguageOptions()).toEqual([
      { value: "auto", label: "Auto", unavailable: false },
      { value: "en", label: "English", unavailable: false },
    ] satisfies LanguageOption[]);

    resources.update([zhCNContribution()]);
    const storage = new MemoryStorage();
    storage.setItem(LANGUAGE_STORAGE_KEY, "zh-CN");
    const withPack = createStore({ resources, storage });
    const options = withPack.getLanguageOptions();
    expect(options.map((option) => option.value)).toEqual(["auto", "en", "zh-CN"]);
    expect(options[2]).toMatchObject({ label: "简体中文", unavailable: false });
  });

  it("shows an unavailable option for a saved preference whose pack is missing", () => {
    const storage = new MemoryStorage();
    storage.setItem(LANGUAGE_STORAGE_KEY, "ko-KR");
    const store = createStore({ storage });

    const options = store.getLanguageOptions();
    expect(options[options.length - 1]).toEqual({ value: "ko-KR", label: "ko-KR (unavailable)", unavailable: true });
  });

  it("notifies subscribers on preference and resource changes without reloading", () => {
    const resources = new LocaleResourceStore();
    const documentRef = { documentElement: { lang: "en" } };
    const { documentElement } = documentRef;
    const store = createStore({ resources, document: documentRef });
    let calls = 0;
    const unsubscribe = store.subscribe(() => { calls += 1; });

    store.setPreference("zh-CN");
    expect(calls).toBe(1);
    expect(store.getLocale()).toBe("en");

    resources.update([zhCNContribution()]);
    expect(calls).toBe(2);
    expect(store.getLocale()).toBe("zh-CN");
    expect(documentElement.lang).toBe("zh-CN");

    resources.update([zhCNContribution({ "settings.generalConfiguration": "常规配置（改）" })]);
    expect(calls).toBe(3);

    unsubscribe();
    store.setPreference("en");
    expect(calls).toBe(3);
  });

  it("syncs a saved preference across same-origin tabs through storage events", () => {
    const resources = new LocaleResourceStore();
    resources.update([zhCNContribution()]);
    const storage = new MemoryStorage();
    const store = new LocaleStore({ storage, languages: ["en-US"], document: { documentElement: { lang: "en" } }, resources });
    store.initialize();
    writeLanguagePreference(storage, "zh-CN");
    window.dispatchEvent(new StorageEvent("storage", { key: LANGUAGE_STORAGE_KEY, newValue: "zh-CN", storageArea: storage }));

    expect(store.getPreference()).toBe("zh-CN");
    expect(store.getLocale()).toBe("zh-CN");
  });

  it("tolerates unavailable storage while changing language in the current tab", () => {
    const resources = new LocaleResourceStore();
    resources.update([zhCNContribution()]);
    const store = new LocaleStore({ languages: ["en-US"], document: { documentElement: { lang: "en" } }, resources });

    store.setPreference("zh-CN");

    expect(store.getPreference()).toBe("zh-CN");
    expect(store.getLocale()).toBe("zh-CN");
  });
});

describe("LocaleResourceStore", () => {
  it("fails deterministically on duplicate (locale, namespace, key) provision", () => {
    const resources = new LocaleResourceStore();
    resources.update([zhCNContribution()]);

    expect(() => {
      resources.update([zhCNContribution(), {
        locale: "zh-CN",
        label: "另一个包",
        namespace: "core",
        messages: { "settings.generalConfiguration": "常规配置（冲突）" },
      }]);
    }).toThrow("Duplicate locale message for zh-CN core.settings.generalConfiguration");
  });

  it("merges same-locale catalogs from different namespaces and plugins", () => {
    const resources = new LocaleResourceStore();
    resources.update([
      { locale: "zh-CN", label: "简体中文", aliases: ["zh-Hans", "zh-SG"], namespace: "core", messages: { "common.reload": "重新加载" } },
      { locale: "zh-CN", label: "简体中文", namespace: "plugin.git", messages: { "openFile": "打开文件" } },
      { locale: "zh-CN", label: "简体中文", namespace: "core", messages: { "language.label": "语言" } },
    ]);

    expect(resources.getAvailableLocales()).toEqual([{ locale: "zh-CN", label: "简体中文", aliases: ["zh-hans", "zh-sg"] }]);
    expect(resources.findLocale("zh-hans")).toBe("zh-CN");
    expect(resources.resolveAutoLocale(["zh-SG", "en-US"])).toBe("zh-CN");
  });
});

describe("development diagnostics", () => {
  it("reports unknown keys through the installed diagnostics sink", () => {
    const sink = (locale: string, key: string): void => {
      expect(locale).toBe("zh-CN");
      expect(key).toBe("not.a.key");
    };
    setMissingMessageKeyDiagnostics(sink);
    try {
      const resources = new LocaleResourceStore();
      expect(resources.message("zh-CN", "not.a.key")).toBe("not.a.key");
      expect(resources.message("en", "core.common.reload")).toBe("Reload");
    } finally {
      setMissingMessageKeyDiagnostics(undefined);
    }
  });
});
