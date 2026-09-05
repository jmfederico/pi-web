export const TERMINAL_SOFT_KEYS_STORAGE_KEY = "pi-web.terminal.softKeys";
export const TERMINAL_SOFT_KEYS_DEFAULT_ENVIRONMENT_MEDIA = "(pointer: coarse), (max-width: 760px)";

export type TerminalSoftKeysStorage = Pick<Storage, "getItem" | "setItem">;

export function terminalSoftKeysEnabled(preference: boolean | undefined, defaultEnabled: boolean): boolean {
  return preference ?? defaultEnabled;
}

export function parseTerminalSoftKeysPreference(value: string | null): boolean | undefined {
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

export function createTerminalSoftKeysDefaultEnvironmentMedia(): MediaQueryList | undefined {
  return typeof window !== "undefined" && "matchMedia" in window ? window.matchMedia(TERMINAL_SOFT_KEYS_DEFAULT_ENVIRONMENT_MEDIA) : undefined;
}

export function isTerminalSoftKeysDefaultEnvironment(media: MediaQueryList | undefined): boolean {
  return media?.matches === true;
}

export function initialTerminalSoftKeysEnabled(media = createTerminalSoftKeysDefaultEnvironmentMedia()): boolean {
  return terminalSoftKeysEnabled(readTerminalSoftKeysPreference(), isTerminalSoftKeysDefaultEnvironment(media));
}

export function hasTerminalSoftKeysPreference(): boolean {
  return readTerminalSoftKeysPreference() !== undefined;
}

export function readTerminalSoftKeysPreference(storage = browserStorage()): boolean | undefined {
  if (storage === undefined) return undefined;
  try {
    return parseTerminalSoftKeysPreference(storage.getItem(TERMINAL_SOFT_KEYS_STORAGE_KEY));
  } catch {
    return undefined;
  }
}

export function writeTerminalSoftKeysPreference(enabled: boolean, storage = browserStorage()): void {
  if (storage === undefined) return;
  try {
    storage.setItem(TERMINAL_SOFT_KEYS_STORAGE_KEY, String(enabled));
  } catch {
    // Ignore storage failures; the per-page toggle still works for this session.
  }
}

function browserStorage(): TerminalSoftKeysStorage | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}
