import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createMobilePromptEnterMedia,
  MOBILE_PROMPT_ENTER_MEDIA_QUERY,
  parsePromptEnterPreference,
  PROMPT_ENTER_PREFERENCE_STORAGE_KEY,
  readPromptEnterPreference,
  shouldSendPromptOnEnter,
  shouldSendPromptOnEnterShortcut,
  shouldUsePromptEnterShiftShortcut,
  writePromptEnterPreference,
  type PromptEnterMedia,
} from "./promptEnterBehavior";

afterEach(() => { vi.unstubAllGlobals(); });

describe("promptEnterBehavior", () => {
  it("keeps touch keyboard behavior independent of control sizing", () => {
    expect(MOBILE_PROMPT_ENTER_MEDIA_QUERY).toBe("(pointer: coarse), (max-width: 760px)");
  });

  it.each([
    { width: 760, coarse: false },
    { width: 760, coarse: true },
    { width: 761, coarse: false },
    { width: 761, coarse: true },
    { width: 1024, coarse: true },
  ])("selects the keyboard default ($width px, coarse pointer: $coarse)", ({ width, coarse }) => {
    const matchMedia = vi.fn((query: string) => ({
      matches: (query.includes("max-width: 760px") && width <= 760) || (query.includes("pointer: coarse") && coarse),
    }));
    vi.stubGlobal("window", { matchMedia });
    const media = createMobilePromptEnterMedia();

    expect(matchMedia).toHaveBeenCalledExactlyOnceWith("(pointer: coarse), (max-width: 760px)");
    expect(shouldSendPromptOnEnter(media, "auto")).toBe(width > 760 && !coarse);
    expect(shouldUsePromptEnterShiftShortcut(true, false, media)).toBe(width > 760 && !coarse);
    expect(shouldUsePromptEnterShiftShortcut(true, true, media)).toBe(true);
    expect(shouldSendPromptOnEnter(media, "send")).toBe(true);
    expect(shouldSendPromptOnEnter(media, "newline")).toBe(false);
  });

  it("uses the environment default when the preference is auto", () => {
    expect(shouldSendPromptOnEnter({ matches: false } satisfies PromptEnterMedia, "auto")).toBe(true);
    expect(shouldSendPromptOnEnter(undefined, "auto")).toBe(true);
    expect(shouldSendPromptOnEnter({ matches: true } satisfies PromptEnterMedia, "auto")).toBe(false);
  });

  it("lets explicit preferences override the environment", () => {
    expect(shouldSendPromptOnEnter({ matches: true } satisfies PromptEnterMedia, "send")).toBe(true);
    expect(shouldSendPromptOnEnter({ matches: false } satisfies PromptEnterMedia, "newline")).toBe(false);
    expect(shouldSendPromptOnEnter(undefined, "newline")).toBe(false);
  });

  it("swaps Shift+Enter with the plain Enter behavior", () => {
    expect(shouldSendPromptOnEnterShortcut(false, { matches: false } satisfies PromptEnterMedia, "auto")).toBe(true);
    expect(shouldSendPromptOnEnterShortcut(true, { matches: false } satisfies PromptEnterMedia, "auto")).toBe(false);
    expect(shouldSendPromptOnEnterShortcut(false, { matches: true } satisfies PromptEnterMedia, "auto")).toBe(false);
    expect(shouldSendPromptOnEnterShortcut(true, { matches: true } satisfies PromptEnterMedia, "auto")).toBe(true);
    expect(shouldSendPromptOnEnterShortcut(true, undefined, "send")).toBe(false);
    expect(shouldSendPromptOnEnterShortcut(true, undefined, "newline")).toBe(true);
  });

  it("ignores implicit Shift state in touch or narrow-screen contexts", () => {
    expect(shouldUsePromptEnterShiftShortcut(false, true, { matches: true } satisfies PromptEnterMedia)).toBe(false);
    expect(shouldUsePromptEnterShiftShortcut(true, false, { matches: true } satisfies PromptEnterMedia)).toBe(false);
    expect(shouldUsePromptEnterShiftShortcut(true, true, { matches: true } satisfies PromptEnterMedia)).toBe(true);
    expect(shouldUsePromptEnterShiftShortcut(true, false, { matches: false } satisfies PromptEnterMedia)).toBe(true);
    expect(shouldUsePromptEnterShiftShortcut(true, false, undefined)).toBe(true);
  });

  it("parses local storage preference values", () => {
    expect(parsePromptEnterPreference("auto")).toBe("auto");
    expect(parsePromptEnterPreference("send")).toBe("send");
    expect(parsePromptEnterPreference("newline")).toBe("newline");
    expect(parsePromptEnterPreference(null)).toBe("auto");
    expect(parsePromptEnterPreference("return")).toBe("auto");
  });

  it("reads and writes the stored preference", () => {
    const storage = new FakeStorage();

    expect(readPromptEnterPreference(storage)).toBe("auto");
    writePromptEnterPreference("send", storage);
    expect(storage.value(PROMPT_ENTER_PREFERENCE_STORAGE_KEY)).toBe("send");
    expect(readPromptEnterPreference(storage)).toBe("send");

    writePromptEnterPreference("newline", storage);
    expect(storage.value(PROMPT_ENTER_PREFERENCE_STORAGE_KEY)).toBe("newline");
    expect(readPromptEnterPreference(storage)).toBe("newline");

    writePromptEnterPreference("auto", storage);
    expect(storage.value(PROMPT_ENTER_PREFERENCE_STORAGE_KEY)).toBe("auto");
    expect(readPromptEnterPreference(storage)).toBe("auto");
  });

  it("ignores storage failures", () => {
    const storage = new ThrowingStorage();

    expect(readPromptEnterPreference(storage)).toBe("auto");
    expect(() => { writePromptEnterPreference("send", storage); }).not.toThrow();
  });
});

class FakeStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  value(key: string): string | undefined {
    return this.values.get(key);
  }
}

class ThrowingStorage {
  getItem(): string | null {
    throw new Error("blocked");
  }

  setItem(): void {
    throw new Error("blocked");
  }
}
