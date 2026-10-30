// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { PluginStyleRegistry } from "./styleRegistry";
import { PluginStyleRuntime } from "./styles";
import type { QualifiedThemeContribution } from "./types";

const palette = (id: string) => ({ id, url: `https://theme.test/${id}.css` });
function theme(id: string): QualifiedThemeContribution {
  return { id: `test:${id}`, pluginId: "test", localId: id, name: id, colorScheme: "light", stylesheets: [palette(id)] };
}
function deferred() {
  let resolve!: (sheet: CSSStyleSheet) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<CSSStyleSheet>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
afterEach(() => { document.adoptedStyleSheets = []; });

it("keeps the committed theme until all replacement sheets are ready, independently of plugin loading", async () => {
  const first = new CSSStyleSheet();
  const next = deferred();
  const extra = deferred();
  const plugin = deferred();
  const registry = new PluginStyleRegistry((url) => {
    if (url === palette("first").url) return Promise.resolve(first);
    if (url === palette("next").url) return next.promise;
    if (url === palette("extra").url) return extra.promise;
    return plugin.promise;
  });
  registry.registerRoot(document);
  const root = document.createElement("div").attachShadow({ mode: "closed" });
  registry.registerRoot(root);
  await registry.setTheme([palette("first")], () => undefined);
  const commit = vi.fn(() => {
    expect(document.adoptedStyleSheets).toEqual([second, third]);
    expect(root.adoptedStyleSheets).toEqual([second, third]);
  });
  const pendingPlugin = registry.setContributions([{ ...palette("plugin"), order: 0 }]);
  const pendingTheme = registry.setTheme([{ ...palette("next"), order: 1 }, { ...palette("extra"), order: 2 }], commit);
  const second = new CSSStyleSheet();
  const third = new CSSStyleSheet();
  next.resolve(second);
  await next.promise;
  expect(document.adoptedStyleSheets).toEqual([first]);
  expect(commit).not.toHaveBeenCalled();
  extra.resolve(third);
  await pendingTheme;
  expect(commit).toHaveBeenCalledOnce();
  const later = document.createElement("div").attachShadow({ mode: "closed" });
  registry.registerRoot(later);
  expect(later.adoptedStyleSheets).toEqual([second, third]);
  const unrelated = new CSSStyleSheet();
  plugin.resolve(unrelated);
  await pendingPlugin;
  expect(document.adoptedStyleSheets).toEqual([unrelated, second, third]);
  registry.clear();
  expect(root.adoptedStyleSheets).toEqual([]);
  expect(later.adoptedStyleSheets).toEqual([]);
});

it("does not commit failed or superseded themes and retries failed files", async () => {
  const old = deferred();
  const failed = deferred();
  const ready = new CSSStyleSheet();
  const load = vi.fn((url: string) => url === palette("old").url ? old.promise : failed.promise);
  const registry = new PluginStyleRegistry(load);
  const report = vi.fn();
  const runtime = new PluginStyleRuntime(registry, report);
  runtime.connect(document);
  const obsoleteCommit = vi.fn();
  runtime.updateTheme(theme("old"), obsoleteCommit);
  const failedCommit = vi.fn();
  runtime.updateTheme(theme("failed"), failedCommit);
  old.resolve(new CSSStyleSheet());
  failed.reject(new Error("offline"));
  await vi.waitFor(() => { expect(report).toHaveBeenCalledOnce(); });
  expect(obsoleteCommit).not.toHaveBeenCalled();
  expect(failedCommit).not.toHaveBeenCalled();
  expect(document.adoptedStyleSheets).toEqual([]);
  load.mockResolvedValue(ready);
  runtime.updateTheme(theme("failed"), failedCommit);
  await vi.waitFor(() => { expect(failedCommit).toHaveBeenCalledOnce(); });
  expect(document.adoptedStyleSheets).toEqual([ready]);
  runtime.disconnect();
  expect(document.adoptedStyleSheets).toEqual([]);
});

it("reports unrelated plugin failures without declaring the pending theme failed", async () => {
  const pending = deferred();
  const registry = new PluginStyleRegistry((url) => url === palette("theme").url ? pending.promise : Promise.reject(new Error("plugin unavailable")));
  const reportPlugin = vi.fn();
  const reportTheme = vi.fn();
  const commit = vi.fn();
  const runtime = new PluginStyleRuntime(registry, reportPlugin, reportTheme);
  runtime.connect(document);
  runtime.updateTheme(theme("theme"), commit);
  runtime.update([palette("plugin")]);
  await vi.waitFor(() => { expect(reportPlugin).toHaveBeenCalledOnce(); });
  expect(reportTheme).not.toHaveBeenCalled();
  expect(commit).not.toHaveBeenCalled();
  pending.resolve(new CSSStyleSheet());
  await vi.waitFor(() => { expect(commit).toHaveBeenCalledOnce(); });
  runtime.disconnect();
});

it("orders shared files by all active contribution descriptors, not the last publication", async () => {
  const shared = new CSSStyleSheet();
  const other = new CSSStyleSheet();
  const load = vi.fn((url: string) => Promise.resolve(url === palette("shared").url ? shared : other));
  const registry = new PluginStyleRegistry(load);
  registry.registerRoot(document);
  const ordinary = [{ ...palette("shared"), order: 0 }, { ...palette("other"), order: 10 }];
  await registry.setContributions(ordinary);
  await registry.setTheme([{ ...palette("shared"), id: "theme:shared", order: 20 }], () => undefined);
  expect(document.adoptedStyleSheets).toEqual([shared, other]);
  await registry.setContributions(ordinary);
  expect(document.adoptedStyleSheets).toEqual([shared, other]);
  expect(load).toHaveBeenCalledTimes(2);
  // Releasing the ordinary owner moves the shared theme file to its own order.
  await registry.setContributions([{ ...palette("other"), order: 10 }]);
  expect(document.adoptedStyleSheets).toEqual([other, shared]);
  registry.clear();
});

it("retains the committed theme cache through failed replacement and suspension", async () => {
  const first = new CSSStyleSheet();
  const load = vi.fn((url: string) => url === palette("first").url ? Promise.resolve(first) : Promise.reject(new Error("offline")));
  const registry = new PluginStyleRegistry(load);
  registry.registerRoot(document);
  await registry.setTheme([palette("first")], () => undefined);
  await expect(registry.setTheme([palette("failed")], () => undefined)).rejects.toThrow("Failed to load stylesheet");
  expect(document.adoptedStyleSheets).toEqual([first]);
  registry.cancelTheme();
  await registry.setTheme([palette("first")], () => undefined);
  expect(load).toHaveBeenCalledTimes(2);
  expect(document.adoptedStyleSheets).toEqual([first]);
  let committed = true;
  const changed = vi.fn(() => {
    expect(document.adoptedStyleSheets).toEqual([]);
    expect(committed).toBe(false);
  });
  registry.subscribe(changed);
  registry.clearTheme(() => { committed = false; });
  expect(changed).toHaveBeenCalledOnce();
  registry.clear();
});

it("invalidates pending publication on owner removal and disconnection, even if the loader ignores abort", async () => {
  const pending = deferred();
  const registry = new PluginStyleRegistry(() => pending.promise);
  const runtime = new PluginStyleRuntime(registry, () => undefined);
  runtime.connect(document);
  const commit = vi.fn();
  runtime.updateTheme(theme("pending"), commit);
  runtime.clearTheme();
  runtime.updateTheme(theme("pending"), commit);
  runtime.disconnect();
  pending.resolve(new CSSStyleSheet());
  await pending.promise;
  // Flush the production publication continuation, not a simulated clock.
  await registry.setTheme([], () => undefined);
  expect(commit).not.toHaveBeenCalled();
  expect(document.adoptedStyleSheets).toEqual([]);
});
