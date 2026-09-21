import { describe, expect, it } from "vitest";
import { LocaleStore, isSimplifiedChineseLanguage, readLanguagePreference, resolveLocale, writeLanguagePreference } from "./locale";

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  readonly length = 0;
  clear(): void { this.values.clear(); }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  key(): string | null { return null; }
  removeItem(key: string): void { this.values.delete(key); }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

describe("locale negotiation", () => {
  it("honors an explicit preference before browser languages", () => {
    expect(resolveLocale("en", ["zh-CN"])).toBe("en");
    expect(resolveLocale("zh-CN", ["en-US"])).toBe("zh-CN");
  });

  it("recognizes the supported simplified Chinese browser tags", () => {
    expect(isSimplifiedChineseLanguage("zh-CN")).toBe(true);
    expect(isSimplifiedChineseLanguage("zh_SG")).toBe(true);
    expect(isSimplifiedChineseLanguage("zh-Hans-CN")).toBe(true);
    expect(isSimplifiedChineseLanguage("zh-TW")).toBe(false);
    expect(isSimplifiedChineseLanguage("zh")).toBe(false);
  });

  it("falls back to English when auto mode has no supported browser language", () => {
    expect(resolveLocale("auto", ["fr-FR", "en-US"])).toBe("en");
  });
});

describe("locale storage", () => {
  it("accepts only supported stored preferences and tolerates storage failures", () => {
    const storage = new MemoryStorage();
    expect(readLanguagePreference(storage)).toBe("auto");
    writeLanguagePreference(storage, "zh-CN");
    expect(readLanguagePreference(storage)).toBe("zh-CN");
    expect(readLanguagePreference({ getItem: () => { throw new Error("blocked"); } })).toBe("auto");
    expect(() => { writeLanguagePreference({ setItem: () => { throw new Error("blocked"); } }, "en"); }).not.toThrow();
  });

  it("updates subscribers and the document without reloading the page", () => {
    const storage = new MemoryStorage();
    const documentRef = { documentElement: { lang: "en" } };
    const { documentElement } = documentRef;
    const store = new LocaleStore({ storage, languages: ["en-US"], document: documentRef });
    const listener = () => { calls += 1; };
    let calls = 0;
    const unsubscribe = store.subscribe(listener);

    store.setPreference("zh-CN");

    expect(store.getLocale()).toBe("zh-CN");
    expect(documentElement.lang).toBe("zh-CN");
    expect(calls).toBe(1);
    unsubscribe();
    store.setPreference("en");
    expect(calls).toBe(1);
  });
});
