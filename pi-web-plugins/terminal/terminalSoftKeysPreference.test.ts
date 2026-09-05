import { describe, expect, it } from "vitest";
import {
  parseTerminalSoftKeysPreference,
  readTerminalSoftKeysPreference,
  terminalSoftKeysEnabled,
  TERMINAL_SOFT_KEYS_STORAGE_KEY,
  writeTerminalSoftKeysPreference,
} from "./terminalSoftKeysPreference";

describe("terminal soft key preferences", () => {
  it("uses stored preferences before environment defaults", () => {
    expect(terminalSoftKeysEnabled(true, false)).toBe(true);
    expect(terminalSoftKeysEnabled(false, true)).toBe(false);
    expect(terminalSoftKeysEnabled(undefined, true)).toBe(true);
    expect(terminalSoftKeysEnabled(undefined, false)).toBe(false);
  });

  it("parses boolean local storage values", () => {
    expect(parseTerminalSoftKeysPreference("true")).toBe(true);
    expect(parseTerminalSoftKeysPreference("false")).toBe(false);
    expect(parseTerminalSoftKeysPreference(null)).toBeUndefined();
    expect(parseTerminalSoftKeysPreference("yes")).toBeUndefined();
  });

  it("reads and writes the stored preference", () => {
    const storage = new FakeStorage();

    expect(readTerminalSoftKeysPreference(storage)).toBeUndefined();
    writeTerminalSoftKeysPreference(true, storage);
    expect(storage.value(TERMINAL_SOFT_KEYS_STORAGE_KEY)).toBe("true");
    expect(readTerminalSoftKeysPreference(storage)).toBe(true);

    writeTerminalSoftKeysPreference(false, storage);
    expect(storage.value(TERMINAL_SOFT_KEYS_STORAGE_KEY)).toBe("false");
    expect(readTerminalSoftKeysPreference(storage)).toBe(false);
  });

  it("ignores storage failures", () => {
    const storage = new ThrowingStorage();

    expect(readTerminalSoftKeysPreference(storage)).toBeUndefined();
    expect(() => { writeTerminalSoftKeysPreference(true, storage); }).not.toThrow();
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
