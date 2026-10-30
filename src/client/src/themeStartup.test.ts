// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { beginThemeStartup, cancelInitialTheme, claimStartupDocument, revealApplication, showStartupFailure, themeStartup } from "./themeStartup";
import { configureThemePolicy, getThemePolicy, THEME_STORAGE_KEY } from "./theme";
import { pluginStyles } from "./plugins/styles";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const lightStylesheet = { id: "pack:light:palette", url: "pi-web-plugins/pack/assets/light.css?v=revision" };
const catalog = {
  themes: [{ id: "pack:light", pluginId: "pack", name: "Light", colorScheme: "light", stylesheets: [lightStylesheet] }],
  themePairs: [], defaultTheme: { themeId: "pack:light", auto: false },
};

afterEach(() => {
  themeStartup.releaseDocument?.();
  pluginStyles.clear();
  Object.assign(themeStartup, { started: false, pending: false, failed: false, catalog: Promise.resolve(undefined), ready: Promise.resolve(), releaseDocument: undefined, documentClaimed: false, cancelled: false });
  document.body.replaceChildren();
  document.getElementById("pi-web-theme-data")?.remove();
  document.documentElement.removeAttribute("data-pi-web-loading");
  document.documentElement.removeAttribute("data-pi-web-theme");
  document.documentElement.removeAttribute("style");
  localStorage.clear();
  configureThemePolicy({ effectiveConfig: {} });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function initialThemeData(data: unknown): void {
  const script = document.createElement("script");
  script.id = "pi-web-theme-data";
  script.type = "application/json";
  script.textContent = JSON.stringify(data);
  document.head.append(script);
}

it("uses the theme delivered with HTML without requesting catalog or CSS", async () => {
  initialThemeData({ catalog, stylesheets: [{ url: lightStylesheet.url, cssText: ":root { --pi-bg: #fff; }" }] });
  const fetch = vi.fn().mockRejectedValue(new Error("No startup theme request should be needed"));
  vi.stubGlobal("fetch", fetch);
  beginThemeStartup();
  await themeStartup.ready;
  expect(fetch).not.toHaveBeenCalled();
  expect(document.documentElement.dataset["piWebTheme"]).toBe("pack:light");
  expect(document.adoptedStyleSheets).toHaveLength(1);
});

it("prepares the delivered default without fetching or rewriting a saved browser override", async () => {
  const saved = { themeId: "legacy:theme", auto: false };
  localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify(saved));
  initialThemeData({ catalog, stylesheets: [{ url: lightStylesheet.url, cssText: ":root { --pi-bg: #fff; }" }] });
  const fetch = vi.fn().mockRejectedValue(new Error("The application owns browser overrides"));
  vi.stubGlobal("fetch", fetch);
  beginThemeStartup();
  await themeStartup.ready;
  expect(fetch).not.toHaveBeenCalled();
  expect(document.documentElement.dataset["piWebTheme"]).toBe("pack:light");
  expect(JSON.parse(localStorage.getItem(THEME_STORAGE_KEY) ?? "null")).toEqual(saved);
});

it("uses the delivered fallback while retaining the intended legacy default", async () => {
  const intended = { themeId: "legacy:theme", auto: false };
  initialThemeData({ catalog: { ...catalog, defaultTheme: intended }, stylesheets: [{ url: lightStylesheet.url, cssText: ":root { --pi-bg: #fff; }" }] });
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  beginThemeStartup();
  await themeStartup.ready;
  expect(document.documentElement.dataset["piWebTheme"]).toBe("pack:light");
  expect((await themeStartup.catalog)?.defaultTheme).toEqual(intended);
  expect(fetch).not.toHaveBeenCalled();
});

it("loads the default response asynchronously when HTML data is absent, retaining the loader and root ownership until ready", async () => {
  const catalogResponse = deferred<Response>();
  const fetch = vi.fn(() => catalogResponse.promise);
  vi.stubGlobal("fetch", fetch);
  document.documentElement.dataset["piWebLoading"] = "";
  document.body.innerHTML = '<div id="pi-web-startup" role="status">Loading</div>';
  beginThemeStartup();
  expect(themeStartup.pending).toBe(true);
  expect(fetch).toHaveBeenCalledOnce();
  expect(document.documentElement.dataset["piWebTheme"]).toBeUndefined();
  expect(document.getElementById("pi-web-startup")).not.toBeNull();
  catalogResponse.resolve(Response.json({ catalog, stylesheets: [{ url: lightStylesheet.url, cssText: ":root { --pi-bg: #fff; }" }] }));
  await themeStartup.ready;
  expect(document.documentElement.dataset["piWebTheme"]).toBe("pack:light");
  expect(document.adoptedStyleSheets).toHaveLength(1);
  const releaseApp = pluginStyles.registerRoot(document);
  claimStartupDocument();
  expect(document.adoptedStyleSheets).toHaveLength(1);
  expect(document.getElementById("pi-web-startup")).not.toBeNull();
  revealApplication();
  expect(document.getElementById("pi-web-startup")).toBeNull();
  expect(document.documentElement.hasAttribute("data-pi-web-loading")).toBe(false);
  releaseApp();
});

it("does not register or apply a late startup palette after application teardown", async () => {
  const response = deferred<Response>();
  const fetch = vi.fn(() => response.promise);
  vi.stubGlobal("fetch", fetch);
  beginThemeStartup();
  claimStartupDocument();
  cancelInitialTheme();
  response.resolve(Response.json({ catalog, stylesheets: [] }));
  await themeStartup.ready;
  expect(fetch).toHaveBeenCalledOnce();
  expect(document.documentElement.dataset["piWebTheme"]).toBeUndefined();
  expect(document.adoptedStyleSheets).toHaveLength(0);
});

it("applies enforcement before resolving the stored browser choice", async () => {
  localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify({ themeId: "legacy:theme", auto: false }));
  const saved = localStorage.getItem(THEME_STORAGE_KEY);
  initialThemeData({ catalog: { ...catalog, enforcedBy: "PI_WEB_DEFAULT_THEME" }, stylesheets: [{ url: lightStylesheet.url, cssText: ":root { --pi-bg: #fff; }" }] });
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  beginThemeStartup();
  await themeStartup.ready;
  expect(document.documentElement.dataset["piWebTheme"]).toBe("pack:light");
  expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe(saved);
  expect(fetch).not.toHaveBeenCalled();
});

it("uses its startup policy snapshot without overwriting application policy", async () => {
  configureThemePolicy({ effectiveConfig: { defaultTheme: { themeId: "application:theme", auto: false } }, enforcedSettings: { "/defaultTheme": "current-policy" } });
  const policy = getThemePolicy();
  initialThemeData({ catalog, stylesheets: [{ url: lightStylesheet.url, cssText: ":root { --pi-bg: #fff; }" }] });
  beginThemeStartup();
  await themeStartup.ready;
  expect(document.documentElement.dataset["piWebTheme"]).toBe("pack:light");
  expect(getThemePolicy()).toEqual(policy);
});

it("replaces the visual indicator and its loading label with accessible failure guidance", () => {
  document.body.innerHTML = '<div id="pi-web-startup" role="status" aria-label="Loading"><svg></svg><span></span></div>';
  showStartupFailure();
  const loader = document.getElementById("pi-web-startup");
  if (loader === null) throw new Error("Expected startup status");
  expect(loader.hasAttribute("aria-label")).toBe(false);
  expect(loader.querySelector("svg, span")).toBeNull();
  expect(loader.textContent.trim()).not.toBe("");
});

it("settles failed discovery without leaving startup pending or erasing preferences", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("unavailable", { status: 503 })));
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  beginThemeStartup();
  await themeStartup.ready;
  expect(themeStartup.pending).toBe(false);
  expect(themeStartup.failed).toBe(true);
  expect(warn).toHaveBeenCalledOnce();
});
