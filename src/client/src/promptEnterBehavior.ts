// Keyboard behavior is an input-specific exception to viewport-only control sizing.
export const MOBILE_PROMPT_ENTER_MEDIA_QUERY = "(pointer: coarse), (max-width: 760px)";
export const PROMPT_ENTER_PREFERENCE_STORAGE_KEY = "pi-web.promptEnterPreference";

export type PromptEnterPreference = "auto" | "send" | "newline";
export type PromptEnterMedia = Pick<MediaQueryList, "matches">;
export type PromptEnterPreferenceStorage = Pick<Storage, "getItem" | "setItem">;

export function createMobilePromptEnterMedia(): PromptEnterMedia | undefined {
  return typeof window !== "undefined" && "matchMedia" in window ? window.matchMedia(MOBILE_PROMPT_ENTER_MEDIA_QUERY) : undefined;
}

export function parsePromptEnterPreference(value: string | null): PromptEnterPreference {
  if (value === "send" || value === "newline") return value;
  return "auto";
}

export function readPromptEnterPreference(storage = browserStorage()): PromptEnterPreference {
  if (storage === undefined) return "auto";
  try {
    return parsePromptEnterPreference(storage.getItem(PROMPT_ENTER_PREFERENCE_STORAGE_KEY));
  } catch {
    return "auto";
  }
}

export function writePromptEnterPreference(preference: PromptEnterPreference, storage = browserStorage()): void {
  if (storage === undefined) return;
  try {
    storage.setItem(PROMPT_ENTER_PREFERENCE_STORAGE_KEY, preference);
  } catch {
    // Ignore localStorage quota/privacy errors; Auto remains the safe fallback.
  }
}

export function shouldSendPromptOnEnter(media = createMobilePromptEnterMedia(), preference = readPromptEnterPreference()): boolean {
  if (preference === "send") return true;
  if (preference === "newline") return false;
  return media?.matches !== true;
}

export function shouldUsePromptEnterShiftShortcut(shiftKey: boolean, explicitShiftKeyActive: boolean, media = createMobilePromptEnterMedia()): boolean {
  // Touch keyboards can report autocapitalization as Shift on Enter after a line break.
  // On touch or narrow screens, only trust Shift when the editor saw an explicit Shift keydown.
  if (!shiftKey) return false;
  if (media?.matches === true) return explicitShiftKeyActive;
  return true;
}

export function shouldSendPromptOnEnterShortcut(shiftKey: boolean, media = createMobilePromptEnterMedia(), preference = readPromptEnterPreference()): boolean {
  const plainEnterSends = shouldSendPromptOnEnter(media, preference);
  return shiftKey ? !plainEnterSends : plainEnterSends;
}

function browserStorage(): PromptEnterPreferenceStorage | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}
