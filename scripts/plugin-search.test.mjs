import { readFileSync } from "node:fs";
import { Window } from "happy-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

const html = readFileSync(new URL("../docs/community-plugins.html", import.meta.url), "utf8");
const script = readFileSync(new URL("../docs/plugin-search.js", import.meta.url), "utf8");
const windows = [];

afterEach(async () => {
  await Promise.all(windows.splice(0).map((window) => window.close()));
});

function setup(fetch) {
  const window = new Window({ url: "https://pi-web.dev/dev/community-plugins" });
  windows.push(window);
  window.document.write(html);
  window.fetch = fetch;
  window.console.error = vi.fn();
  window.eval(script);
  const root = window.document.querySelector("[data-plugin-search]");
  return { window, root, status: root.querySelector('[role="status"]') };
}

function response(packages = [], total = packages.length) {
  return { ok: true, json: async () => ({ objects: packages.map((pkg) => ({ package: pkg, downloads: { monthly: pkg.monthlyDownloads ?? 100 } })), total }) };
}

function pkg(name, keywords = ["pi-web.dev-plugin", "pi-web-plugin"]) {
  return { name, version: "1.0.0", description: "A plugin", keywords, publisher: { username: "author" }, date: "2026-10-14T22:03:20.579Z" };
}

function submit(window, root, text) {
  root.querySelector("input").value = text;
  root.querySelector("form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
}

function changeSort(window, root, mode) {
  const select = root.querySelector("select");
  select.value = mode;
  select.dispatchEvent(new window.Event("change", { bubbles: true }));
}

function resultNames(root) {
  return [...root.querySelectorAll(".plugin-result h3 a")].map((link) => link.textContent);
}

describe("website plugin search", () => {
  it("queries both keywords, merges duplicates, and renders untrusted metadata as text", async () => {
    const shared = { ...pkg("@scope/shared"), description: '<img src=x onerror="alert(1)">' };
    const fetch = vi.fn(async (url) => response(url.searchParams.get("text").includes("pi-web.dev-plugin")
      ? [shared, pkg("specific", ["pi-web.dev-plugin"])]
      : [shared, pkg("broad", ["pi-web-plugin"]), pkg("unrelated", ["other"])]));
    const { root, status } = setup(fetch);
    expect(status.textContent).toBe("Searching npm…");
    await vi.waitFor(() => expect(status.textContent).toBe("3 packages shown."));
    expect(fetch.mock.calls.map(([url]) => url.searchParams.get("text"))).toEqual([
      "keywords:pi-web.dev-plugin", "keywords:pi-web-plugin",
    ]);
    expect(root.querySelectorAll(".plugin-result")).toHaveLength(3);
    expect(root.querySelector("img")).toBeNull();
    expect(root.textContent).toContain(shared.description);
    expect(root.textContent).toContain("v1.0.0");
    expect(root.textContent).toContain("Published by author · Updated Oct 14, 2026");
    expect(root.querySelector("time").dateTime).toBe("2026-10-14T22:03:20.579Z");
    expect(root.querySelector(".plugin-result a").href).toBe("https://www.npmjs.com/package/%40scope%2Fshared");
    expect(root.querySelector(".plugin-result-actions a").textContent).toBe("View on npm");
    expect(root.querySelector("[data-plugin-more]").hidden).toBe(true);
  });

  it("copies an install source without installing anything and provides accessible confirmation", async () => {
    const { window, root, status } = setup(async () => response([pkg("@scope/plugin")]));
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, "clipboard", { value: { writeText }, configurable: true });
    await vi.waitFor(() => expect(status.textContent).toBe("1 package shown."));
    const copy = root.querySelector(".plugin-copy");
    expect(copy.getAttribute("aria-label")).toBe("Copy install source for @scope/plugin");
    copy.click();
    await vi.waitFor(() => expect(root.querySelector(".plugin-copy-feedback").textContent).toBe("Install source copied."));
    expect(writeText).toHaveBeenCalledWith("npm:@scope/plugin");
    expect(status.textContent).toBe("1 package shown.");
    expect(copy.disabled).toBe(false);
  });

  it("shows a manually copyable source when clipboard access fails", async () => {
    const { window, root, status } = setup(async () => response([pkg("@scope/plugin")]));
    Object.defineProperty(window.navigator, "clipboard", {
      value: { writeText: vi.fn().mockRejectedValue(new Error("Permission denied")) }, configurable: true,
    });
    await vi.waitFor(() => expect(status.textContent).toBe("1 package shown."));
    root.querySelector(".plugin-copy").click();
    await vi.waitFor(() => expect(root.querySelector(".plugin-copy-feedback").textContent).toContain("Select and copy this source: npm:@scope/plugin"));
    expect(root.querySelector(".plugin-copy").disabled).toBe(false);
  });

  it("omits missing or invalid publication dates", async () => {
    const { root, status } = setup(async () => response([{ ...pkg("plugin"), date: "not a date" }]));
    await vi.waitFor(() => expect(status.textContent).toBe("1 package shown."));
    expect(root.querySelector("time")).toBeNull();
    expect(root.textContent).not.toContain("Invalid Date");
  });

  it("loads complete streams independently before sorting and paginates locally", async () => {
    const first = Array.from({ length: 100 }, (_, i) => ({ ...pkg(`plugin-${String(i).padStart(3, "0")}`), monthlyDownloads: i }));
    const winner = { ...pkg("winner"), monthlyDownloads: 9999 };
    const fetch = vi.fn(async (url) => {
      if (url.searchParams.get("text").includes("pi-web.dev-plugin")) return response([pkg("specific")]);
      return response(url.searchParams.get("from") === "0" ? first : [first[0], winner], 102);
    });
    const { window, root, status } = setup(fetch);
    await vi.waitFor(() => expect(status.textContent).toContain("20 of 102 packages shown"));
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch.mock.calls.map(([url]) => url.searchParams.get("size"))).toEqual(["100", "100", "100"]);
    expect(fetch.mock.calls.map(([url]) => url.searchParams.get("from"))).toEqual(["0", "0", "100"]);
    expect(root.querySelector(".plugin-result a").textContent).toBe("winner");
    root.querySelector("[data-plugin-more]").click();
    expect(root.querySelectorAll(".plugin-result")).toHaveLength(40);
    expect(fetch).toHaveBeenCalledTimes(3);
    submit(window, root, "files & tools");
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(6));
    await vi.waitFor(() => expect(status.textContent).toContain("20 of 102 packages shown"));
    expect(fetch.mock.calls.slice(3, 5).map(([url]) => url.searchParams.get("text"))).toEqual([
      "files & tools keywords:pi-web.dev-plugin", "files & tools keywords:pi-web-plugin",
    ]);
    expect(root.querySelectorAll(".plugin-result")).toHaveLength(20);
  });

  it("sorts by monthly downloads by default, breaks ties by name, and reorders updates locally", async () => {
    const entries = [
      { ...pkg("z-popular"), monthlyDownloads: 300, date: "2025-01-01" },
      { ...pkg("a-popular"), monthlyDownloads: 300, date: "2024-01-01" },
      { ...pkg("updated"), monthlyDownloads: 10, date: "2026-10-19" },
      { ...pkg("unknown-date"), monthlyDownloads: 0, date: "invalid" },
    ];
    const fetch = vi.fn(async () => response(entries));
    const { window, root, status } = setup(fetch);
    await vi.waitFor(() => expect(status.textContent).toBe("4 packages shown."));
    expect(resultNames(root)).toEqual(["a-popular", "z-popular", "updated", "unknown-date"]);
    expect(root.textContent).toContain("300 downloads/month");
    changeSort(window, root, "updated");
    await vi.waitFor(() => expect(root.querySelector("select").disabled).toBe(false));
    expect(resultNames(root)).toEqual(["updated", "z-popular", "a-popular", "unknown-date"]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("loads and caches creation dates only for Newest packages, independently of updates", async () => {
    const entries = [
      { ...pkg("old-package"), date: "2026-10-19", monthlyDownloads: 1000 },
      { ...pkg("@scope/new-package"), date: "2026-10-01", monthlyDownloads: 1 },
    ];
    const fetch = vi.fn(async (url) => url.pathname === "/-/v1/search"
      ? response(entries)
      : { ok: true, json: async () => ({ time: { created: url.pathname.includes("old-package") ? "2024-01-01" : "2026-10-01" } }) });
    const { window, root, status } = setup(fetch);
    await vi.waitFor(() => expect(status.textContent).toBe("2 packages shown."));
    expect(fetch).toHaveBeenCalledTimes(2);
    changeSort(window, root, "newest");
    await vi.waitFor(() => expect(root.querySelector("select").disabled).toBe(false));
    expect(resultNames(root)).toEqual(["@scope/new-package", "old-package"]);
    expect(root.textContent).toContain("First published Oct 1, 2026");
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(fetch.mock.calls[3][0].pathname).toBe("/%40scope%2Fnew-package");
    changeSort(window, root, "popular");
    await vi.waitFor(() => expect(root.querySelector("select").disabled).toBe(false));
    changeSort(window, root, "newest");
    await vi.waitFor(() => expect(root.querySelector("select").disabled).toBe(false));
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("preserves the previous ordering and allows retry when creation metadata fails", async () => {
    const fetch = vi.fn(async (url) => url.pathname === "/-/v1/search" ? response([pkg("plugin")]) : { ok: false, status: 429 });
    const { window, root, status } = setup(fetch);
    await vi.waitFor(() => expect(status.textContent).toBe("1 package shown."));
    changeSort(window, root, "newest");
    await vi.waitFor(() => expect(status.textContent).toContain("Could not load package creation dates"));
    expect(root.querySelector("select").value).toBe("popular");
    expect(resultNames(root)).toEqual(["plugin"]);
    fetch.mockImplementation(async () => ({ ok: true, json: async () => ({ time: { created: "2026-01-01" } }) }));
    changeSort(window, root, "newest");
    await vi.waitFor(() => expect(status.textContent).toBe("1 package shown."));
    expect(root.querySelector("select").value).toBe("newest");
  });

  it("does not replace newer results with a stale response", async () => {
    const pending = [];
    const fetch = vi.fn(() => new Promise((resolve) => pending.push(resolve)));
    const { window, root, status } = setup(fetch);
    const originalSignal = fetch.mock.calls[0][1].signal;
    submit(window, root, "new");
    expect(originalSignal.aborted).toBe(true);
    pending[2](response([pkg("new")]));
    pending[3](response());
    await vi.waitFor(() => expect(status.textContent).toBe("1 package shown."));
    pending[0](response([pkg("old")]));
    pending[1](response());
    await window.happyDOM.waitUntilComplete();
    expect(root.querySelectorAll(".plugin-result")).toHaveLength(1);
    expect(root.querySelector(".plugin-result a").textContent).toBe("new");
  });

  it.each([
    ["network failure", () => Promise.reject(new Error("Offline"))],
    ["rate limit", () => Promise.resolve({ ok: false, status: 429 })],
    ["malformed response", () => Promise.resolve({ ok: true, json: async () => ({}) })],
  ])("shows an actionable error for %s and allows retry", async (_, failure) => {
    const fetch = vi.fn(failure);
    const { window, root, status } = setup(fetch);
    await vi.waitFor(() => expect(status.textContent).toContain("Could not search npm"));
    expect(root.querySelector("[data-plugin-results]").getAttribute("aria-busy")).toBe("false");
    fetch.mockImplementation(async () => response());
    submit(window, root, "");
    await vi.waitFor(() => expect(status.textContent).toContain("No matching plugins found"));
  });

  it("does not present one keyword's results as a complete search when the other fails", async () => {
    const fetch = vi.fn(async (url) => url.searchParams.get("text").includes("pi-web.dev-plugin")
      ? response([pkg("specific")])
      : { ok: false, status: 503 });
    const { root, status } = setup(fetch);
    await vi.waitFor(() => expect(status.textContent).toContain("Could not search npm"));
    expect(root.querySelectorAll(".plugin-result")).toHaveLength(0);
  });

  it("does not display a partially fetched catalog when a later page fails", async () => {
    const fetch = vi.fn(async (url) => url.searchParams.get("from") === "0"
      ? response(Array.from({ length: 100 }, (_, i) => pkg(`plugin-${i}`)), 101)
      : { ok: false, status: 503 });
    const { root, status } = setup(fetch);
    await vi.waitFor(() => expect(status.textContent).toContain("Could not search npm"));
    expect(root.querySelectorAll(".plugin-result")).toHaveLength(0);
    expect(root.querySelector("[data-plugin-more]").hidden).toBe(true);
  });
});
