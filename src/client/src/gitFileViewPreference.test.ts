import { describe, expect, it } from "vitest";
import {
  GIT_FILE_VIEW_STORAGE_KEY,
  parseGitFileView,
  readGitFileView,
  writeGitFileView,
} from "./gitFileViewPreference";

describe("gitFileViewPreference", () => {
  it("parses stored values and defaults unknown/missing input to list", () => {
    expect(parseGitFileView("tree")).toBe("tree");
    expect(parseGitFileView("list")).toBe("list");
    expect(parseGitFileView(null)).toBe("list");
    expect(parseGitFileView("")).toBe("list");
    expect(parseGitFileView("grid")).toBe("list");
  });

  it("defaults to list when nothing is stored yet", () => {
    expect(readGitFileView(new FakeStorage())).toBe("list");
  });

  it("reads and writes the stored view mode", () => {
    const storage = new FakeStorage();

    writeGitFileView("tree", storage);
    expect(storage.value(GIT_FILE_VIEW_STORAGE_KEY)).toBe("tree");
    expect(readGitFileView(storage)).toBe("tree");

    writeGitFileView("list", storage);
    expect(storage.value(GIT_FILE_VIEW_STORAGE_KEY)).toBe("list");
    expect(readGitFileView(storage)).toBe("list");
  });

  it("ignores storage failures and falls back to list", () => {
    const storage = new ThrowingStorage();

    expect(readGitFileView(storage)).toBe("list");
    expect(() => { writeGitFileView("tree", storage); }).not.toThrow();
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
