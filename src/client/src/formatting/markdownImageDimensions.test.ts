import { afterEach, describe, expect, it, vi } from "vitest";
import { readMarkdownImageDimensions, rememberMarkdownImageDimensions } from "./markdownImageDimensions";

const storageKey = "pi-web:markdown-image-dimensions:v1";
const source = "https://pi.example/tools/api/machines/local/projects/p/workspaces/w/file/preview?path=images%2Fcat.png";
const dimensions = { width: 640, height: 480 };

function memoryStorage(values = new Map<string, string>()) {
  return {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { values.set(key, value); }),
  };
}

function sourceUrl(index: number): string {
  return `https://images.example/${index.toString()}.png`;
}

function storedRecords(storage: Pick<Storage, "getItem">): unknown {
  return JSON.parse(storage.getItem(storageKey) ?? "null");
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("markdown image dimension hints", () => {
  it("persists through a new storage adapter using the normal browser call signatures", () => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", memoryStorage(values));
    const observed = { ...dimensions, allowed: true, timestamp: 123 };
    rememberMarkdownImageDimensions(source, observed);
    observed.width = 1;

    expect([...values.entries()]).toEqual([[storageKey, JSON.stringify([{ source, ...dimensions }])]]);
    vi.stubGlobal("localStorage", memoryStorage(new Map(values)));
    expect(readMarkdownImageDimensions(source)).toEqual(dimensions);
    expect(readMarkdownImageDimensions(source)).toEqual(dimensions);

    vi.stubGlobal("localStorage", memoryStorage());
    expect(readMarkdownImageDimensions(source)).toBeUndefined();
  });

  it("replaces dimensions without keeping duplicate records", () => {
    const storage = memoryStorage();
    rememberMarkdownImageDimensions(source, dimensions, storage);
    const replacement = { width: 800, height: 600 };
    rememberMarkdownImageDimensions(source, replacement, storage);

    expect(readMarkdownImageDimensions(source, storage)).toEqual(replacement);
    expect(storedRecords(storage)).toEqual([{ source, ...replacement }]);
  });

  it("caps records at 128, promoting changed and unchanged writes but never reads", () => {
    const storage = memoryStorage();
    for (let index = 0; index < 128; index++) {
      rememberMarkdownImageDimensions(sourceUrl(index), dimensions, storage);
    }
    expect(storedRecords(storage)).toHaveLength(128);
    expect(readMarkdownImageDimensions(sourceUrl(0), storage)).toEqual(dimensions);

    const replacement = { width: 800, height: 600 };
    rememberMarkdownImageDimensions(sourceUrl(0), replacement, storage);
    rememberMarkdownImageDimensions(sourceUrl(1), dimensions, storage);
    const beforeRead = storage.getItem(storageKey);
    expect(readMarkdownImageDimensions(sourceUrl(2), storage)).toEqual(dimensions);
    expect(readMarkdownImageDimensions(sourceUrl(2), storage)).toEqual(dimensions);
    expect(storage.getItem(storageKey)).toBe(beforeRead);

    rememberMarkdownImageDimensions(sourceUrl(128), dimensions, storage);
    rememberMarkdownImageDimensions(sourceUrl(129), dimensions, storage);
    expect(readMarkdownImageDimensions(sourceUrl(2), storage)).toBeUndefined();
    expect(readMarkdownImageDimensions(sourceUrl(3), storage)).toBeUndefined();
    expect(readMarkdownImageDimensions(sourceUrl(0), storage)).toEqual(replacement);
    expect(readMarkdownImageDimensions(sourceUrl(1), storage)).toEqual(dimensions);
    expect(storedRecords(storage)).toEqual([
      ...Array.from({ length: 124 }, (_, index) => ({ source: sourceUrl(index + 4), ...dimensions })),
      { source: sourceUrl(0), ...replacement },
      { source: sourceUrl(1), ...dimensions },
      { source: sourceUrl(128), ...dimensions },
      { source: sourceUrl(129), ...dimensions },
    ]);
  });

  it("isolates full URLs across machines, projects, workspaces, sources and query versions", () => {
    const storage = memoryStorage();
    const sources = [
      source,
      source.replace("/machines/local/", "/machines/remote/"),
      source.replace("/projects/p/", "/projects/q/"),
      source.replace("/workspaces/w/", "/workspaces/other/"),
      source.replace("cat.png", "dog.png"),
      `${source}&v=2`,
      source.replace("pi.example/tools/", "other.example/tools/"),
      source.replace("/tools/", "/nested/tools/"),
    ];
    sources.forEach((url, index) => {
      rememberMarkdownImageDimensions(url, { width: index + 1, height: index + 2 }, storage);
    });
    sources.forEach((url, index) => {
      expect(readMarkdownImageDimensions(url, storage)).toEqual({ width: index + 1, height: index + 2 });
    });
    expect(readMarkdownImageDimensions(`${source}&v=3`, storage)).toBeUndefined();
  });

  it.each(["", "{bad json", "null", "42", '"text"', "{}", '{"records":[]}', "[]"])(
    "treats a missing or corrupt snapshot as empty and replaces it on write: %j",
    (raw) => {
      const storage = memoryStorage();
      expect(readMarkdownImageDimensions(source, storage)).toBeUndefined();
      storage.setItem(storageKey, raw);
      expect(readMarkdownImageDimensions(source, storage)).toBeUndefined();
      rememberMarkdownImageDimensions(source, dimensions, storage);
      expect(readMarkdownImageDimensions(source, storage)).toEqual(dimensions);
      expect(storedRecords(storage)).toEqual([{ source, ...dimensions }]);
    },
  );

  it("ignores malformed records and partial/nonpositive pairs, retaining only sanitized valid records", () => {
    const storage = memoryStorage();
    const otherSource = sourceUrl(1);
    const replacement = { width: 800, height: 600 };
    const invalidRecords: unknown[] = [
      null, true, 7, "record", [], {},
      { source: 7, ...dimensions },
      { source: "", ...dimensions },
      { source, width: 640 },
      { source, height: 480 },
      { source, width: 0, height: 480 },
      { source, width: 640, height: 0 },
      { source, width: -1, height: 480 },
      { source, width: 640, height: -1 },
      { source, width: 0.5, height: 480 },
      { source, width: 640, height: 0.5 },
      { source, width: "640", height: 480 },
      { source, width: 640, height: "480" },
      { source, width: null, height: 480 },
      { source, width: 640, height: null },
      { source, width: Number.MAX_SAFE_INTEGER + 1, height: 480 },
      { source, width: 640, height: Number.MAX_SAFE_INTEGER + 1 },
    ];
    storage.setItem(storageKey, JSON.stringify([
      { source: otherSource, ...dimensions },
      ...invalidRecords,
      { source: otherSource, ...replacement, allowed: true, timestamp: 0 },
      { source: otherSource, width: 0, height: 0 },
    ]));

    expect(readMarkdownImageDimensions(source, storage)).toBeUndefined();
    expect(readMarkdownImageDimensions(otherSource, storage)).toEqual(replacement);
    rememberMarkdownImageDimensions(source, dimensions, storage);
    expect(storedRecords(storage)).toEqual([
      { source: otherSource, ...replacement },
      { source, ...dimensions },
    ]);
  });

  it("bounds oversized stored snapshots on read and on the next write", () => {
    const storage = memoryStorage();
    storage.setItem(storageKey, JSON.stringify(Array.from({ length: 130 }, (_, index) => ({
      source: sourceUrl(index), ...dimensions,
    }))));
    expect(readMarkdownImageDimensions(sourceUrl(0), storage)).toBeUndefined();
    expect(readMarkdownImageDimensions(sourceUrl(1), storage)).toBeUndefined();
    expect(readMarkdownImageDimensions(sourceUrl(2), storage)).toEqual(dimensions);
    rememberMarkdownImageDimensions(sourceUrl(130), dimensions, storage);
    expect(storedRecords(storage)).toHaveLength(128);
    expect(readMarkdownImageDimensions(sourceUrl(2), storage)).toBeUndefined();
    expect(readMarkdownImageDimensions(sourceUrl(130), storage)).toEqual(dimensions);
  });

  it.each([
    { width: 0, height: 480 }, { width: 640, height: 0 },
    { width: -1, height: 480 }, { width: 640, height: -1 },
    { width: 0.5, height: 480 }, { width: 640, height: 0.5 },
    { width: NaN, height: 480 }, { width: 640, height: Infinity },
    { width: Number.MAX_SAFE_INTEGER + 1, height: 480 },
  ])("does not replace a valid hint with invalid observed dimensions: %j", (invalid) => {
    const storage = memoryStorage();
    rememberMarkdownImageDimensions(source, dimensions, storage);
    const beforeWrite = storage.getItem(storageKey);
    rememberMarkdownImageDimensions(source, invalid, storage);
    rememberMarkdownImageDimensions("", dimensions, storage);
    expect(storage.getItem(storageKey)).toBe(beforeWrite);
    expect(readMarkdownImageDimensions(source, storage)).toEqual(dimensions);
  });

  it("is a cache miss/no-op when browser storage is absent", () => {
    vi.stubGlobal("localStorage", undefined);
    expect(readMarkdownImageDimensions(source)).toBeUndefined();
    expect(() => { rememberMarkdownImageDimensions(source, dimensions); }).not.toThrow();
  });

  it("catches a disabled browser storage getter and lets injected storage bypass it", () => {
    vi.stubGlobal("localStorage", undefined);
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() { throw new Error("storage disabled"); },
    });
    expect(readMarkdownImageDimensions(source)).toBeUndefined();
    expect(() => { rememberMarkdownImageDimensions(source, dimensions); }).not.toThrow();

    const storage = memoryStorage();
    rememberMarkdownImageDimensions(source, dimensions, storage);
    expect(readMarkdownImageDimensions(source, storage)).toEqual(dimensions);
  });

  it("treats read failures as an empty snapshot and attempts a best-effort write", () => {
    const values = new Map<string, string>();
    const storage = memoryStorage(values);
    storage.getItem.mockImplementation(() => { throw new Error("read blocked"); });
    expect(readMarkdownImageDimensions(source, storage)).toBeUndefined();
    expect(() => { rememberMarkdownImageDimensions(source, dimensions, storage); }).not.toThrow();
    expect(readMarkdownImageDimensions(source, memoryStorage(values))).toEqual(dimensions);
  });

  it("drops failed writes without changing persisted hints or keeping a hidden in-memory copy", () => {
    const storage = memoryStorage();
    vi.stubGlobal("localStorage", storage);
    rememberMarkdownImageDimensions(source, dimensions);
    const beforeWrite = storage.getItem(storageKey);
    storage.setItem.mockImplementation(() => { throw new Error("quota exceeded"); });

    expect(() => { rememberMarkdownImageDimensions(source, { width: 800, height: 600 }); }).not.toThrow();
    expect(() => { rememberMarkdownImageDimensions(sourceUrl(1), dimensions); }).not.toThrow();
    expect(readMarkdownImageDimensions(source)).toEqual(dimensions);
    expect(readMarkdownImageDimensions(sourceUrl(1))).toBeUndefined();
    expect(storage.getItem(storageKey)).toBe(beforeWrite);
  });

  it("has no TTL, timestamps or background jobs", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2000-01-01T00:00:00Z"));
    const storage = memoryStorage();
    rememberMarkdownImageDimensions(source, dimensions, storage);
    vi.setSystemTime(new Date("2100-01-01T00:00:00Z"));

    expect(readMarkdownImageDimensions(source, storage)).toEqual(dimensions);
    expect(storedRecords(storage)).toEqual([{ source, ...dimensions }]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
