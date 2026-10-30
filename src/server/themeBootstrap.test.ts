import { afterEach, describe, expect, it, vi } from "vitest";
import type { PiWebThemeCatalogResponse } from "../shared/themeCatalog.js";
import { createThemeBootstrap, fetchThemeBootstrap, injectThemeBootstrap, THEME_BOOTSTRAP_MAX_BYTES, THEME_BOOTSTRAP_TIMEOUT_MS } from "./themeBootstrap.js";

function catalog(): PiWebThemeCatalogResponse {
  return {
    themes: (["light", "dark"] satisfies ("light" | "dark")[]).map((scheme) => ({
      id: `themes:pi-web-${scheme}`, pluginId: "themes", name: scheme,
      colorScheme: scheme,
      stylesheets: [{ id: `themes:${scheme}`, url: `pi-web-theme-assets/themes/revisions/sha256%3Atest/css/${scheme}.css` }],
    })),
    themePairs: [{ id: "themes:system", pluginId: "themes", name: "System", light: "themes:pi-web-light", dark: "themes:pi-web-dark" }],
  };
}
const readAsset = vi.fn(() => Promise.resolve({ content: Buffer.from("body { background: url('../image.svg'); }"), contentType: "text/css" }));
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); readAsset.mockClear(); });

describe("initial HTML theme bootstrap", () => {
  it("uses the shared default and includes both auto members with original sources and URLs", async () => {
    const bootstrap = await createThemeBootstrap(() => Promise.resolve(catalog()), { readAsset });
    expect(bootstrap?.stylesheets).toEqual(catalog().themes.map((theme) => ({
      url: theme.stylesheets[0]?.url, cssText: "body { background: url('../image.svg'); }",
    })));
    expect(readAsset.mock.calls).toEqual([
      ["themes", "css/light.css", "sha256:test"], ["themes", "css/dark.css", "sha256:test"],
    ]);
  });

  it("reuses artifacts already validated by the catalog instead of rediscovering packages for each CSS file", async () => {
    const readCapturedAsset = vi.fn(() => ({ content: Buffer.from(":root{}"), contentType: "text/css" }));
    const bootstrap = await createThemeBootstrap(() => Promise.resolve(catalog()), { readAsset, readCapturedAsset });
    expect(bootstrap?.stylesheets).toHaveLength(2);
    expect(readCapturedAsset.mock.calls).toEqual([
      ["themes", "css/light.css", "sha256:test"], ["themes", "css/dark.css", "sha256:test"],
    ]);
    expect(readAsset).not.toHaveBeenCalled();
  });

  it("includes a theme's pair details but preloads only its configured CSS when Auto is disabled", async () => {
    const data = catalog();
    data.defaultTheme = { themeId: "themes:pi-web-light", auto: false };
    const bootstrap = await createThemeBootstrap(() => Promise.resolve(data), { readAsset });
    expect(bootstrap?.stylesheets.map((sheet) => sheet.url)).toEqual([data.themes[0]?.stylesheets[0]?.url]);
    expect(bootstrap?.catalog).toEqual(data);
  });

  it.each(["legacy:runtime", "themes:system"])("bootstraps Classic for an unavailable initial default without changing policy: %s", async (themeId) => {
    const data: PiWebThemeCatalogResponse = {
      themes: [], themePairs: [], defaultTheme: { themeId, auto: true }, enforcedBy: "PI_WEB_DEFAULT_THEME",
    };
    const dark = catalog().themes[1];
    if (dark === undefined) throw new Error("Missing fixture theme");
    const classic = { ...dark, id: "themes:classic" };
    const readCatalog = vi.fn((preference?: { themeId: string; auto: boolean }) => Promise.resolve(
      preference?.themeId === "themes:classic" ? { themes: [classic], themePairs: [] } : data,
    ));
    const bootstrap = await createThemeBootstrap(readCatalog, { readAsset });
    expect(bootstrap?.catalog).toEqual({ ...data, themes: [classic] });
    expect(bootstrap?.stylesheets).toEqual([{ url: classic.stylesheets[0]?.url, cssText: "body { background: url('../image.svg'); }" }]);
    expect(readCatalog.mock.calls).toEqual([[undefined], [{ themeId: "themes:classic", auto: false }]]);
  });

  it("leaves an explicit legacy lookup empty even when a static fallback is available", async () => {
    const data = catalog();
    const dark = data.themes[1];
    if (dark === undefined) throw new Error("Missing fixture theme");
    data.themes.push({ ...dark, id: "themes:classic" });
    data.defaultTheme = { themeId: "legacy:runtime", auto: true };
    const readCatalog = vi.fn(() => Promise.resolve(data));
    expect(await createThemeBootstrap(readCatalog, { readAsset }, data.defaultTheme)).toEqual({
      catalog: { ...data, themes: [], themePairs: [] }, stylesheets: [],
    });
    expect(readCatalog).toHaveBeenCalledTimes(1);
    expect(readAsset).not.toHaveBeenCalled();
  });

  it("excludes a large unrelated catalog before applying the serialized size budget", async () => {
    const data = catalog();
    const unrelated = data.themes[0];
    if (unrelated === undefined) throw new Error("Missing fixture theme");
    for (let index = 0; index < 100; index++) {
      data.themes.push({ ...unrelated, id: `other:theme-${String(index)}`, description: "x".repeat(30_000) });
      data.themePairs.push({ id: `other:pair-${String(index)}`, pluginId: "other", name: "Other", light: `other:theme-${String(index)}`, dark: "other:dark" });
    }
    const bootstrap = await createThemeBootstrap(() => Promise.resolve(data), { readAsset });
    expect(bootstrap?.catalog).toEqual(catalog());
    expect(bootstrap?.stylesheets).toHaveLength(2);
    expect(readAsset).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])("targets a requested preference with auto=%s without rewriting global policy", async (auto) => {
    const data = catalog();
    data.defaultTheme = { themeId: "legacy:runtime", auto: false };
    const bootstrap = await createThemeBootstrap(() => Promise.resolve(data), { readAsset }, { themeId: "themes:pi-web-light", auto });
    expect(bootstrap?.catalog.defaultTheme).toEqual(data.defaultTheme);
    expect(bootstrap?.catalog.themes.map((theme) => theme.id)).toEqual(["themes:pi-web-light", "themes:pi-web-dark"]);
    expect(bootstrap?.catalog.themePairs).toHaveLength(1);
    expect(bootstrap?.stylesheets).toHaveLength(auto ? 2 : 1);
  });

  it("returns requested data while preserving enforcement policy for browser selection", async () => {
    const data = catalog();
    data.defaultTheme = { themeId: "themes:pi-web-dark", auto: false };
    data.enforcedBy = "PI_WEB_DEFAULT_THEME";
    const bootstrap = await createThemeBootstrap(() => Promise.resolve(data), { readAsset }, { themeId: "themes:pi-web-light", auto: true });
    expect(bootstrap?.catalog).toEqual(data);
    expect(bootstrap?.stylesheets).toHaveLength(2);
    const initial = await createThemeBootstrap(() => Promise.resolve(data), { readAsset });
    expect(initial?.catalog).toEqual(data);
    expect(initial?.stylesheets).toHaveLength(1);
  });

  it("round trips hostile CSS without allowing a script breakout", () => {
    const bootstrap = { catalog: catalog(), stylesheets: [{ url: "path", cssText: '</script><script>alert("&")</script>\u2028\u2029' }] };
    const html = injectThemeBootstrap('<script id="pi-web-theme-data" type="application/json"></script><main></main>', bootstrap);
    expect(html.match(/<script/gu)).toHaveLength(1);
    expect(html).not.toContain('<script>alert');
    expect(JSON.parse(/>(.*?)<\/script>/u.exec(html)?.[1] ?? "")).toEqual(bootstrap);
  });

  it("fails open on catalog errors, missing CSS and oversized CSS", async () => {
    expect(await createThemeBootstrap(() => Promise.reject(new Error("offline")), { readAsset })).toBeUndefined();
    expect(await createThemeBootstrap(() => Promise.resolve(catalog()), { readAsset: () => Promise.resolve(undefined) })).toBeUndefined();
    expect(await createThemeBootstrap(() => Promise.resolve(catalog()), { readAsset: () => Promise.resolve({
      content: Buffer.alloc(THEME_BOOTSTRAP_MAX_BYTES + 1), contentType: "text/css",
    }) })).toBeUndefined();
  });

  it("bounds a stalled catalog and leaves the shell unchanged", async () => {
    vi.useFakeTimers();
    const pending = createThemeBootstrap(() => new Promise(() => undefined), { readAsset });
    await vi.advanceTimersByTimeAsync(THEME_BOOTSTRAP_TIMEOUT_MS);
    const html = '<script id="pi-web-theme-data" type="application/json"></script>';
    expect(injectThemeBootstrap(html, await pending)).toBe(html);
  });

  it("bounds the Vite backend response and tolerates unavailable backends", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response("x".repeat(THEME_BOOTSTRAP_MAX_BYTES + 1)))));
    expect(await fetchThemeBootstrap("http://backend/api/theme-bootstrap")).toBeUndefined();
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("offline"))));
    expect(await fetchThemeBootstrap("http://backend/api/theme-bootstrap")).toBeUndefined();
  });
});
