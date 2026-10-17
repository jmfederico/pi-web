// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { PluginStyleRegistry } from "./styleRegistry";
import { PluginStyleRuntime } from "./styles";

const plugin = { id: "plugin:global", url: "https://plugins.test/global.css" };
const dark = { id: "themes:dark:file", url: "https://plugins.test/dark.css" };
const light = { id: "themes:light:file", url: "https://plugins.test/light.css" };

afterEach(() => { document.adoptedStyleSheets = []; });

it("publishes plugin and selected-theme files to the document and participating roots, then cleans up", async () => {
  const sheets = new Map([plugin, dark, light].map((file) => [file.url, new CSSStyleSheet()]));
  const load = vi.fn((url: string) => {
    const sheet = sheets.get(url);
    if (sheet === undefined) throw new Error(`Unexpected URL ${url}`);
    return Promise.resolve(sheet);
  });
  const registry = new PluginStyleRegistry(load);
  const report = vi.fn();
  const runtime = new PluginStyleRuntime(registry, report);
  const root = document.createElement("div").attachShadow({ mode: "closed" });
  registry.registerRoot(root);
  runtime.connect(document);
  runtime.update([plugin, dark]);
  await vi.waitFor(() => { expect(root.adoptedStyleSheets).toEqual([sheets.get(plugin.url), sheets.get(dark.url)]); });
  runtime.update([plugin, dark]);
  expect(load).toHaveBeenCalledTimes(2);
  runtime.update([plugin, light]);
  expect(root.adoptedStyleSheets).not.toContain(sheets.get(dark.url));
  await vi.waitFor(() => { expect(document.adoptedStyleSheets).toEqual([sheets.get(plugin.url), sheets.get(light.url)]); });
  expect(report).not.toHaveBeenCalled();
  runtime.disconnect();
  expect(root.adoptedStyleSheets).toEqual([]);
  expect(document.adoptedStyleSheets).toEqual([]);
});

it("applies the selected theme despite a broken plugin and retries that file on the next publication", async () => {
  const failure = new Error("network failed");
  const themeSheet = new CSSStyleSheet();
  const pluginSheet = new CSSStyleSheet();
  let pluginAttempts = 0;
  const load = vi.fn((url: string) => {
    if (url === dark.url) return Promise.resolve(themeSheet);
    return ++pluginAttempts === 1 ? Promise.reject(failure) : Promise.resolve(pluginSheet);
  });
  const registry = new PluginStyleRegistry(load);
  const report = vi.fn();
  const runtime = new PluginStyleRuntime(registry, report);
  runtime.connect(document);
  runtime.update([plugin, dark]);
  // Repeated renders while loading do not start duplicate requests.
  runtime.update([plugin, dark]);
  await vi.waitFor(() => { expect(report).toHaveBeenCalledTimes(1); });
  expect(report.mock.calls[0]?.[0]).toMatchObject({ cause: failure });
  expect(document.adoptedStyleSheets).toEqual([themeSheet]);
  runtime.update([plugin, dark]);
  await vi.waitFor(() => { expect(document.adoptedStyleSheets).toEqual([pluginSheet, themeSheet]); });
  expect(load).toHaveBeenCalledTimes(3);
  expect(report).toHaveBeenCalledTimes(1);
  runtime.update([plugin, dark]);
  expect(load).toHaveBeenCalledTimes(3);
  runtime.disconnect();
});

it("does not report aborted or failed work after a selection replacement or shutdown", async () => {
  let reject!: (error: Error) => void;
  const registry = new PluginStyleRegistry(() => new Promise((_resolve, fail) => { reject = fail; }));
  const report = vi.fn();
  const runtime = new PluginStyleRuntime(registry, report);
  runtime.connect(document);
  runtime.update([dark]);
  await Promise.resolve();
  runtime.update([]);
  reject(new Error("superseded"));
  await vi.waitFor(() => { expect(document.adoptedStyleSheets).toEqual([]); });
  runtime.disconnect();
  expect(report).not.toHaveBeenCalled();
});
