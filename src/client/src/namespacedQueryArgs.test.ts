import { afterEach, describe, expect, it, vi } from "vitest";
import {
  contributionQueryFromRecord,
  isContributionQueryParameter,
  readContributionQuery,
  readContributionQueryRecord,
  setContributionQueryKey,
  writeContributionQueryRecord,
} from "./namespacedQueryArgs";

const originalWindow = globalThis.window;

afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(globalThis, "window", { value: originalWindow, configurable: true });
});

describe("contribution-scoped query helpers", () => {
  it("reads canonical values before aliases and keeps history snapshots independent", () => {
    const browser = installWindow("https://example.test/app?machine=remote&project=p1&workspace=w1&panel.workspace.panel--file=canonical.ts&legacy.workspace.panel--file=legacy.ts&legacy.workspace.panel--mode=preview&panel.workspace.panel--tag=one&panel.workspace.panel--tag=two");

    const first = readContributionQuery("panel:workspace.panel", ["legacy:workspace.panel"]);
    expect(first).toEqual({ file: "canonical.ts", mode: "preview", tag: ["one", "two"] });

    browser.navigate("https://example.test/app?machine=remote&project=p1&workspace=w1&legacy.workspace.panel--file=back.ts");
    const restored = readContributionQuery("panel:workspace.panel", ["legacy:workspace.panel"]);

    expect(restored).toEqual({ file: "back.ts" });
    expect(first).toEqual({ file: "canonical.ts", mode: "preview", tag: ["one", "two"] });
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first["tag"])).toBe(true);
  });

  it("projects remembered full records through canonical and alias contribution identities", () => {
    const projected = contributionQueryFromRecord({
      "panel.workspace.panel--file": "canonical.ts",
      "legacy.workspace.panel--file": "legacy.ts",
      "legacy.workspace.panel--mode": "preview",
      "other.workspace.panel--file": "other.ts",
      malformed: "ignored",
    }, "panel:workspace.panel", ["legacy:workspace.panel"]);

    expect(projected).toEqual({ file: "canonical.ts", mode: "preview" });
    expect(Object.isFrozen(projected)).toBe(true);
  });

  it("reads inherited-key names as own strings and bounds values, keys, counts, and aggregate length", () => {
    const params = new URLSearchParams();
    params.append("panel.workspace.panel--constructor", "safe");
    for (let index = 0; index < 17; index += 1) params.append("panel.workspace.panel--tag", `tag-${String(index)}`);
    params.set(`panel.workspace.panel--${"k".repeat(240)}`, "oversized-key");
    params.set("panel.workspace.panel--oversized-value", "v".repeat(4_097));
    installWindow(`https://example.test/app?${params.toString()}`);

    const bounded = readContributionQuery("panel:workspace.panel");
    expect(Object.hasOwn(bounded, "constructor")).toBe(true);
    expect(Reflect.get(bounded, "constructor")).toBe("safe");
    expect(typeof Reflect.get(bounded, "constructor")).toBe("string");
    expect(Reflect.get(bounded, "toString")).toBeUndefined();
    expect(bounded["tag"]).toEqual(Array.from({ length: 16 }, (_value, index) => `tag-${String(index)}`));
    expect(bounded["oversized-value"]).toBeUndefined();
    expect(Object.keys(bounded)).toEqual(["constructor", "tag"]);

    const countParams = new URLSearchParams();
    for (let index = 0; index < 66; index += 1) countParams.set(`panel.workspace.panel--key-${String(index)}`, "value");
    installWindow(`https://example.test/app?${countParams.toString()}`);
    expect(Object.keys(readContributionQuery("panel:workspace.panel"))).toHaveLength(64);
    expect(Object.keys(readContributionQueryRecord())).toHaveLength(64);

    const aggregateParams = new URLSearchParams();
    for (let index = 0; index < 16; index += 1) aggregateParams.set(`panel.workspace.panel--value-${String(index)}`, "v".repeat(4_096));
    installWindow(`https://example.test/app?${aggregateParams.toString()}`);
    expect(Object.keys(readContributionQuery("panel:workspace.panel"))).toHaveLength(15);
    expect(Object.keys(readContributionQueryRecord())).toHaveLength(15);
  });

  it("canonicalizes alias writes with push/replace history and validates local keys", () => {
    const browser = installWindow("https://example.test/base/app?project=p1&workspace=w1&panel.workspace.panel--file=old.ts&legacy.workspace.panel--file=legacy.ts&other.workspace.panel--keep=yes&plain=kept#viewer");

    expect(setContributionQueryKey("panel:workspace.panel", ["legacy:workspace.panel"], "file", ["src/a.ts", 2, true])).toBe(true);
    expect(browser.pushed).toHaveLength(1);
    expect(browser.replaced).toHaveLength(0);
    expect(browser.url.searchParams.getAll("panel.workspace.panel--file")).toEqual(["src/a.ts", "2", "true"]);
    expect(browser.url.searchParams.has("legacy.workspace.panel--file")).toBe(false);
    expect(browser.url.searchParams.get("other.workspace.panel--keep")).toBe("yes");
    expect(browser.url.searchParams.get("plain")).toBe("kept");
    expect(browser.url.pathname).toBe("/base/app");
    expect(browser.url.hash).toBe("#viewer");

    expect(setContributionQueryKey("panel:workspace.panel", ["legacy:workspace.panel"], "mode", "raw", { replace: true })).toBe(true);
    expect(browser.replaced).toHaveLength(1);
    expect(browser.url.searchParams.get("panel.workspace.panel--mode")).toBe("raw");

    expect(() => setContributionQueryKey("panel:workspace.panel", [], "Bad Key", "value")).toThrow("Invalid contribution navigation key");
    expect(() => {
      Reflect.apply(setContributionQueryKey, undefined, ["panel:workspace.panel", [], "mode", { invalid: true }]);
    }).toThrow("Invalid contribution navigation value for key: mode");
    expect(browser.pushed).toHaveLength(1);
    expect(browser.replaced).toHaveLength(1);
  });

  it("removes an overlong restored value before valid set and remove writes", () => {
    const params = new URLSearchParams({ machine: "remote", project: "p1", workspace: "w1", plain: "kept" });
    params.set("legacy.workspace.panel--file", "legacy.ts");
    params.set("other.workspace.panel--poison", "v".repeat(4_097));
    const browser = installWindow(`https://example.test/base/app?${params.toString()}#viewer`);

    expect(setContributionQueryKey("panel:workspace.panel", ["legacy:workspace.panel"], "file", "README.md")).toBe(true);
    expect(browser.url.searchParams.get("panel.workspace.panel--file")).toBe("README.md");
    expect(browser.url.searchParams.has("legacy.workspace.panel--file")).toBe(false);
    expect(browser.url.searchParams.has("other.workspace.panel--poison")).toBe(false);
    expect(browser.url.searchParams.get("plain")).toBe("kept");
    expect(browser.url.pathname).toBe("/base/app");
    expect(browser.url.hash).toBe("#viewer");

    params.delete("legacy.workspace.panel--file");
    params.set("panel.workspace.panel--file", "README.md");
    params.set("other.workspace.panel--poison", "v".repeat(4_097));
    browser.navigate(`https://example.test/base/app?${params.toString()}#viewer`);
    expect(setContributionQueryKey("panel:workspace.panel", [], "file", undefined)).toBe(true);
    expect(browser.url.searchParams.has("panel.workspace.panel--file")).toBe(false);
    expect(browser.url.searchParams.has("other.workspace.panel--poison")).toBe(false);
  });

  it("trims restored repeated-value overflow before prioritizing a valid setter", () => {
    const params = new URLSearchParams({ project: "p1", plain: "kept" });
    for (let index = 0; index < 17; index += 1) params.append("other.workspace.panel--tag", `tag-${String(index)}`);
    const browser = installWindow(`https://example.test/app?${params.toString()}#viewer`);

    expect(setContributionQueryKey("panel:workspace.panel", [], "file", "README.md")).toBe(true);
    expect(browser.url.searchParams.get("panel.workspace.panel--file")).toBe("README.md");
    expect(browser.url.searchParams.getAll("other.workspace.panel--tag"))
      .toEqual(Array.from({ length: 16 }, (_value, index) => `tag-${String(index)}`));
    expect(browser.url.searchParams.get("plain")).toBe("kept");
    expect(browser.url.hash).toBe("#viewer");
  });

  it("trims restored parameter-count overflow while retaining the caller's valid write", () => {
    const params = new URLSearchParams({ project: "p1" });
    for (let index = 0; index < 65; index += 1) params.set(`other.workspace.panel--key-${String(index)}`, "value");
    const browser = installWindow(`https://example.test/app?${params.toString()}`);

    expect(setContributionQueryKey("panel:workspace.panel", [], "file", "README.md")).toBe(true);
    const keys = new Set(contributionEntries(browser.url).map(([key]) => key));
    expect(keys.size).toBe(64);
    expect(keys.has("panel.workspace.panel--file")).toBe(true);
    expect(browser.url.searchParams.get("panel.workspace.panel--file")).toBe("README.md");
  });

  it("trims restored aggregate overflow while retaining the caller's valid write", () => {
    const params = new URLSearchParams({ project: "p1", plain: "kept" });
    for (let index = 0; index < 16; index += 1) params.set(`other.workspace.panel--value-${String(index)}`, "v".repeat(4_096));
    expect(contributionRecordLength(params)).toBeGreaterThan(65_536);
    const browser = installWindow(`https://example.test/app?${params.toString()}#viewer`);

    expect(setContributionQueryKey("panel:workspace.panel", [], "file", "README.md")).toBe(true);
    expect(browser.url.searchParams.get("panel.workspace.panel--file")).toBe("README.md");
    expect(contributionRecordLength(browser.url.searchParams)).toBeLessThanOrEqual(65_536);
    expect(browser.url.searchParams.get("plain")).toBe("kept");
    expect(browser.url.hash).toBe("#viewer");
  });

  it("rejects caller-owned over-bound writes atomically without committing history", () => {
    const browser = installWindow("https://example.test/app?project=p1#viewer");
    const clean = browser.url.href;
    expect(() => setContributionQueryKey("panel:workspace.panel", [], "x".repeat(240), "value"))
      .toThrow("Contribution navigation parameter is too long");
    expect(() => setContributionQueryKey("panel:workspace.panel", [], "mode", "v".repeat(4_097)))
      .toThrow("Contribution navigation value is too long");
    expect(() => setContributionQueryKey("panel:workspace.panel", [], "mode", Array.from({ length: 17 }, () => "v")))
      .toThrow("Contribution navigation value has too many items");
    expect(browser.url.href).toBe(clean);
    expect(browser.pushed).toHaveLength(0);
    expect(browser.replaced).toHaveLength(0);
  });

  it("accepts the caller aggregate limit exactly and rejects one more byte without history", () => {
    const canonicalKey = "panel.workspace.panel--last";
    const exactValues = Array.from({ length: 16 }, () => "v".repeat(4_096));
    exactValues[exactValues.length - 1] = "v".repeat(4_096 - canonicalKey.length);
    expect(canonicalKey.length + exactValues.reduce((total, value) => total + value.length, 0)).toBe(65_536);
    const browser = installWindow("https://example.test/app?project=p1#viewer");

    expect(setContributionQueryKey("panel:workspace.panel", [], "last", exactValues)).toBe(true);
    expect(browser.pushed).toHaveLength(1);
    expect(browser.url.searchParams.getAll(canonicalKey)).toEqual(exactValues);
    const exactUrl = browser.url.href;

    const overflowValues = [...exactValues];
    overflowValues[overflowValues.length - 1] = `${overflowValues.at(-1) ?? ""}x`;
    expect(() => setContributionQueryKey("panel:workspace.panel", [], "last", overflowValues))
      .toThrow("Contribution navigation record is too long");
    expect(browser.url.href).toBe(exactUrl);
    expect(browser.pushed).toHaveLength(1);
    expect(browser.replaced).toHaveLength(0);
  });

  it("captures and restores only bounded contribution-owned parameters", () => {
    const browser = installWindow("https://example.test/app?project=p1&workspace=w1&panel.workspace.panel--file=one&panel.workspace.panel--file=two&plain=kept&bad--query=ignored#hash");

    expect(readContributionQueryRecord()).toEqual({
      "panel.workspace.panel--file": ["one", "two"],
    });

    expect(writeContributionQueryRecord({
      "next.workspace.panel--mode": "preview",
      "next.workspace.panel--selection": ["a", "b"],
      invalid: "ignored",
    }, { replace: true })).toBe(true);

    expect(browser.url.searchParams.get("project")).toBe("p1");
    expect(browser.url.searchParams.get("workspace")).toBe("w1");
    expect(browser.url.searchParams.get("plain")).toBe("kept");
    expect(browser.url.searchParams.get("bad--query")).toBe("ignored");
    expect(browser.url.searchParams.has("panel.workspace.panel--file")).toBe(false);
    expect(browser.url.searchParams.get("next.workspace.panel--mode")).toBe("preview");
    expect(browser.url.searchParams.getAll("next.workspace.panel--selection")).toEqual(["a", "b"]);
    expect(browser.url.hash).toBe("#hash");
  });

});

function contributionEntries(source: URL | URLSearchParams): [string, string][] {
  const params = source instanceof URL ? source.searchParams : source;
  return [...params].filter(([key]) => isContributionQueryParameter(key));
}

function contributionRecordLength(source: URLSearchParams): number {
  const seenKeys = new Set<string>();
  let length = 0;
  for (const [key, value] of contributionEntries(source)) {
    length += value.length;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    length += key.length;
  }
  return length;
}

function installWindow(href: string): {
  readonly url: URL;
  readonly pushed: string[];
  readonly replaced: string[];
  navigate(next: string): void;
} {
  let current = new URL(href);
  const pushed: string[] = [];
  const replaced: string[] = [];
  const location = {
    get href() { return current.href; },
    get pathname() { return current.pathname; },
    get search() { return current.search; },
    get hash() { return current.hash; },
  };
  const commit = (target: URL | string, entries: string[]) => {
    current = new URL(String(target), current);
    entries.push(current.href);
  };
  const fakeWindow = {
    location,
    history: {
      pushState: vi.fn((_state: object, _title: string, next: URL | string) => { commit(next, pushed); }),
      replaceState: vi.fn((_state: object, _title: string, next: URL | string) => { commit(next, replaced); }),
    },
  };
  Object.defineProperty(globalThis, "window", { value: fakeWindow, configurable: true });
  return {
    get url() { return current; },
    pushed,
    replaced,
    navigate: (next) => { current = new URL(next, current); },
  };
}
