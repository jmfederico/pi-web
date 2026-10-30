// @vitest-environment happy-dom

import { LitElement } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, configApi, piPackagesApi, pluginsApi, type PiWebConfigValues } from "../api";
import { applyPiWebTheme, configureThemePolicy, THEME_STORAGE_KEY } from "../theme";
import { PiWebApp } from "./PiWebApp";
import { themeStylesheetFetch } from "./themeStylesheetFetch.testSupport";
import { SettingsDialog } from "./SettingsDialog";
import { configResponse, pluginsResponse } from "./SettingsDialog.testSupport";
import { SettingsThemePanel } from "./settings/SettingsThemePanel";
import { SettingsFileIconThemePanel } from "./settings/SettingsFileIconThemePanel";
import { FILE_ICON_STORAGE_KEY, NO_FILE_ICONS } from "../fileIconPreferences";
import { fileIconsCapabilityToken } from "../fileIconService";
import type { FileIconsCapability } from "../../../plugin-api";
import { PluginRegistry } from "../plugins/registry";
import { themeStartup } from "../themeStartup";
import { builtInThemeCatalog } from "../themeCatalog.testSupport";
import * as themeCatalogApi from "../themeCatalog";
import { setInitialThemeStylesheets } from "../plugins/styleSources";
import { pluginStyles } from "../plugins/styles";
import { loadExternalPlugins } from "../plugins/external";

vi.mock("../plugins/external", () => ({ loadExternalPlugins: vi.fn() }));

// Mount real settings and theme interactions, leaving unrelated session/socket
// startup out of this component-boundary test.
class ThemeSettingsApp extends PiWebApp {
  override connectedCallback(): void {
    LitElement.prototype.connectedCallback.call(this);
  }
}
customElements.define("theme-settings-test-app", ThemeSettingsApp);

let config: PiWebConfigValues;
let enforcedSettings: Record<string, string>;
const unexpectedRequest = vi.fn(() => Promise.reject(new Error("Theme tests must not make network requests")));

beforeEach(async () => {
  unexpectedRequest.mockClear();
  setInitialThemeStylesheets([]);
  const catalog = builtInThemeCatalog();
  themeStartup.catalog = Promise.resolve(catalog);
  vi.spyOn(themeCatalogApi, "loadThemeCatalog").mockResolvedValue(catalog);
  vi.spyOn(themeCatalogApi, "loadThemeBootstrap").mockResolvedValue({ catalog: { themes: [], themePairs: [] }, stylesheets: [] });
  vi.mocked(loadExternalPlugins).mockResolvedValue({ terminalMode: "recovery-disabled", declarations: [], registrations: [], failures: [] });
  vi.stubGlobal("fetch", themeStylesheetFetch(unexpectedRequest));
  config = { defaultTheme: { themeId: "themes:pi-web-light", auto: false } };
  enforcedSettings = {};
  configureThemePolicy({ effectiveConfig: {} });
  window.history.replaceState(null, "", "/?settings=general");
  vi.spyOn(configApi, "config").mockImplementation((machineId) => Promise.resolve({ ...configResponse(machineId === undefined ? config : {}), enforcedSettings: machineId === undefined ? enforcedSettings : {} }));
  vi.spyOn(configApi, "updateConfig").mockImplementation((update) => {
    config = { ...config, ...update.set };
    return Promise.resolve({ ...configResponse(config), enforcedSettings });
  });
  vi.spyOn(configApi, "namingModels").mockResolvedValue({ models: [] });
  vi.spyOn(pluginsApi, "plugins").mockResolvedValue(pluginsResponse([]));
  vi.spyOn(piPackagesApi, "packages").mockResolvedValue({ packages: [] });
  vi.spyOn(api, "runtime").mockResolvedValue({ machineId: "local", ok: true, checkedAt: "now", capabilities: [] });
  // Layout/transport work is unrelated to preferences; never open real sockets.
  vi.stubGlobal("WebSocket", class {
    static readonly CONNECTING = 0;
    readyState = 1;
    close(): void { this.readyState = 3; }
  });
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
  // The actual page prepares a backend palette before applying browser choices.
  const delivered = catalog.themes.find((theme) => theme.id === "themes:pi-web-light");
  if (delivered === undefined) throw new Error("Expected delivered palette");
  await pluginStyles.setTheme(delivered.stylesheets ?? [], () => { applyPiWebTheme(delivered); });
});

afterEach(() => {
  document.body.replaceChildren();
  themeStartup.catalog = Promise.resolve(undefined);
  localStorage.clear();
  configureThemePolicy({ effectiveConfig: {} });
  sessionStorage.clear();
  document.documentElement.removeAttribute("data-pi-web-theme");
  document.documentElement.removeAttribute("style");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  expect(unexpectedRequest).not.toHaveBeenCalled();
});

describe("app theme defaults and device overrides", () => {
  it.each([false, true])("retains Settings inventory when initial theme data arrives afterward (empty=%s)", async (empty) => {
    let deliver!: (catalog: ReturnType<typeof builtInThemeCatalog>) => void;
    themeStartup.catalog = new Promise((resolve) => { deliver = resolve; });
    const inventory = builtInThemeCatalog();
    if (empty) { inventory.themes = []; inventory.themePairs = []; }
    vi.mocked(themeCatalogApi.loadThemeCatalog).mockResolvedValue(inventory);
    const app = new ThemeSettingsApp();
    document.body.append(app);
    await vi.waitFor(() => {
      expect(themePanel(app).loading).toBe(false);
      expect(themePanel(app).catalogLoading).toBe(false);
      expect(themePanel(app).themes).toHaveLength(inventory.themes.length);
    });
    const panel = themePanel(app);
    const initial = builtInThemeCatalog();
    initial.themes = initial.themes.filter((theme) => theme.id === "themes:pi-web-light");
    initial.themePairs = [];
    deliver(initial);
    await themeStartup.catalog;
    await app.updateComplete;
    await settings(app).updateComplete;
    await panel.updateComplete;
    expect(panel.themes).toHaveLength(inventory.themes.length);
    expect(themeCatalogApi.loadThemeCatalog).toHaveBeenCalledOnce();
  });

  it("cancels superseded CSS preparation while discovering a newly selected theme", async () => {
    window.history.replaceState(null, "", "/");
    let releaseDark!: (response: Response) => void;
    const dark = new Promise<Response>((resolve) => { releaseDark = resolve; });
    let darkSignal: AbortSignal | null | undefined;
    const fallback = themeStylesheetFetch(unexpectedRequest);
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      if (typeof input === "string" && input.endsWith("/pi-web-dark.css")) {
        darkSignal = init?.signal;
        return dark;
      }
      return fallback(input, init);
    });
    let resolveTheme!: (response: Awaited<ReturnType<typeof themeCatalogApi.loadThemeBootstrap>>) => void;
    vi.mocked(themeCatalogApi.loadThemeBootstrap).mockReturnValue(new Promise((resolve) => { resolveTheme = resolve; }));
    const app = new ThemeSettingsApp();
    document.body.append(app);
    const apply: unknown = Reflect.get(app, "applyClientConfig");
    if (typeof apply !== "function") throw new Error("Expected configuration boundary");
    Reflect.apply(apply, app, [{ defaultTheme: { themeId: "themes:pi-web-light", auto: false } }]);
    await vi.waitFor(() => { expect(document.documentElement.dataset["piWebTheme"]).toBe("themes:pi-web-light"); });
    Reflect.apply(apply, app, [{ defaultTheme: { themeId: "themes:pi-web-dark", auto: false } }]);
    await vi.waitFor(() => { expect(darkSignal).toBeDefined(); });
    Reflect.apply(apply, app, [{ defaultTheme: { themeId: "custom:next", auto: false } }]);
    expect(darkSignal?.aborted).toBe(true);
    releaseDark(new Response(":root { --pi-bg: #111; }", { headers: { "Content-Type": "text/css" } }));
    await dark;
    expect(document.documentElement.dataset["piWebTheme"]).toBe("themes:pi-web-light");
    resolveTheme({
      catalog: {
        themes: [{ id: "custom:next", pluginId: "custom", localId: "next", name: "Next", colorScheme: "light", stylesheets: [{ id: "custom:next:palette", url: "https://theme.test/next.css" }] }],
        themePairs: [], defaultTheme: { themeId: "custom:next", auto: false },
      },
      stylesheets: [{ url: "https://theme.test/next.css", cssText: ":root { --pi-bg: #fff; }" }],
    });
    await vi.waitFor(() => { expect(document.documentElement.dataset["piWebTheme"]).toBe("custom:next"); });
    expect(themeCatalogApi.loadThemeCatalog).not.toHaveBeenCalled();
  });

  it("loads only the current browser choice and ignores an obsolete response", async () => {
    window.history.replaceState(null, "", "/");
    type DeliveredTheme = Awaited<ReturnType<typeof themeCatalogApi.loadThemeBootstrap>>;
    let first!: (response: DeliveredTheme) => void;
    let second!: (response: DeliveredTheme) => void;
    const earlier = new Promise<DeliveredTheme>((resolve) => { first = resolve; });
    const later = new Promise<DeliveredTheme>((resolve) => { second = resolve; });
    let firstSignal: AbortSignal | undefined;
    vi.mocked(themeCatalogApi.loadThemeBootstrap).mockImplementation((preference, signal) => {
      if (preference.themeId === "custom:first") { firstSignal = signal; return earlier; }
      return later;
    });
    const app = new ThemeSettingsApp();
    document.body.append(app);
    await app.updateComplete;
    const apply: unknown = Reflect.get(app, "applyClientConfig");
    if (typeof apply !== "function") throw new Error("Expected configuration boundary");
    Reflect.apply(apply, app, [{ defaultTheme: { themeId: "custom:first", auto: false } }]);
    app.requestUpdate();
    await app.updateComplete;
    expect(themeCatalogApi.loadThemeBootstrap).toHaveBeenCalledOnce();
    Reflect.apply(apply, app, [{ defaultTheme: { themeId: "custom:second", auto: false } }]);
    expect(firstSignal?.aborted).toBe(true);
    const response = (id: "first" | "second"): DeliveredTheme => ({
      catalog: { themes: [{ id: `custom:${id}`, pluginId: "custom", localId: id, name: id, colorScheme: "light", stylesheets: [] }], themePairs: [] }, stylesheets: [],
    });
    second(response("second"));
    await vi.waitFor(() => { expect(document.documentElement.dataset["piWebTheme"]).toBe("custom:second"); });
    first(response("first"));
    await earlier;
    await app.updateComplete;
    expect(document.documentElement.dataset["piWebTheme"]).toBe("custom:second");
    const registry: unknown = Reflect.get(app, "plugins");
    if (!(registry instanceof PluginRegistry)) throw new Error("Expected plugin registry");
    expect(registry.getThemes().some((theme) => theme.id === "custom:first")).toBe(false);
    expect(themeCatalogApi.loadThemeBootstrap).toHaveBeenCalledTimes(2);
    expect(themeCatalogApi.loadThemeCatalog).not.toHaveBeenCalled();
  });

  it("provides live file icons to plugins and keeps their browser selection independent of color themes", async () => {
    const app = await mountApp();
    // Isolated startup skips runtime discovery; allow gateway contributions in recovery mode.
    const mode: unknown = Reflect.get(app, "verifiedPluginModeByMachine");
    const registry: unknown = Reflect.get(app, "plugins");
    if (!(mode instanceof Map) || !(registry instanceof PluginRegistry)) throw new Error("Expected app plugin host");
    mode.set("local", "recovery-disabled");
    let icons: FileIconsCapability | undefined;
    await registry.register({ id: "icon-consumer", plugin: {
      apiVersion: 5, name: "Icons", requires: [fileIconsCapabilityToken],
      activate: () => ({ contributions: { fileIconThemes: [{ id: "custom", name: "Custom", file: { url: "https://icons.test/dark.svg", lightUrl: "https://icons.test/light.svg" } }] },
        start: ({ capabilities }) => { icons = capabilities.resolve(fileIconsCapabilityToken); },
      }),
    } });
    app.requestUpdate();
    await app.updateComplete;
    await settings(app).updateComplete;
    const panel = settings(app).shadowRoot?.querySelector("settings-general-panel")?.querySelector<SettingsFileIconThemePanel>("settings-file-icon-theme-panel");
    if (panel == null || icons === undefined) throw new Error("Expected app-provided icons and Appearance settings");
    await panel.updateComplete;
    const changed = vi.fn();
    const unsubscribe = icons.subscribe(changed);
    const select = panel.shadowRoot?.querySelector("select");
    if (select == null) throw new Error("Expected file icon selector");
    select.value = "icon-consumer:custom";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await app.updateComplete;
    expect(icons.resolveIcon("file.ts")).toBe("https://icons.test/light.svg");
    expect(JSON.parse(localStorage.getItem(FILE_ICON_STORAGE_KEY) ?? "null")).toBe("icon-consumer:custom");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
    settings(app).onConfigSaved?.({ defaultTheme: { themeId: "themes:pi-web-dark", auto: false } });
    await app.updateComplete;
    await vi.waitFor(() => { expect(icons?.resolveIcon("file.ts")).toBe("https://icons.test/dark.svg"); });
    expect(changed).toHaveBeenCalledTimes(2);
    settings(app).onSelectFileIconTheme?.(NO_FILE_ICONS);
    expect(icons.resolveIcon("file.ts")).toBeUndefined();
    settings(app).onResetFileIconTheme?.();
    expect(localStorage.getItem(FILE_ICON_STORAGE_KEY)).toBeNull();
    unsubscribe();
  });
  it("uses config without saving it locally, then supports device override and following the default", async () => {
    const app = await mountApp();
    expect(document.documentElement.dataset["piWebTheme"]).toBe("themes:pi-web-light");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
    const panel = themePanel(app);
    selectTheme(panel, "themes:classic");
    await panel.updateComplete;
    button(panel, "Use in this browser").click();
    await vi.waitFor(() => { expect(document.documentElement.dataset["piWebTheme"]).toBe("themes:classic"); });
    expect(JSON.parse(localStorage.getItem(THEME_STORAGE_KEY) ?? "null")).toEqual({ themeId: "themes:classic", auto: false });

    // A later config result must not overwrite a choice made on this device.
    settings(app).onConfigSaved?.({ defaultTheme: { themeId: "themes:pi-web-dark", auto: false } });
    await app.updateComplete;
    await panel.updateComplete;
    expect(document.documentElement.dataset["piWebTheme"]).toBe("themes:classic");
    button(panel, "Use the default").click();
    await app.updateComplete;
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
    await vi.waitFor(() => { expect(document.documentElement.dataset["piWebTheme"]).toBe("themes:pi-web-dark"); });
  });

  it("preserves existing device preferences when setting a different default", async () => {
    localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify({ themeId: "themes:classic", auto: false }));
    const app = await mountApp();
    const panel = themePanel(app);
    selectTheme(panel, "themes:pi-web-dark");
    await panel.updateComplete;
    button(panel, "Set gateway default").click();
    await vi.waitFor(() => { expect(config.defaultTheme).toEqual({ themeId: "themes:pi-web-dark", auto: false }); });
    await app.updateComplete;
    expect(document.documentElement.dataset["piWebTheme"]).toBe("themes:classic");
    expect(JSON.parse(localStorage.getItem(THEME_STORAGE_KEY) ?? "null")).toEqual({ themeId: "themes:classic", auto: false });
  });

  it("applies refreshed enforcement without erasing the saved browser theme", async () => {
    const saved = { themeId: "themes:classic", auto: false };
    localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify(saved));
    config.defaultTheme = { themeId: "themes:pi-web-dark", auto: false };
    enforcedSettings = { "/defaultTheme": "PI_WEB_DEFAULT_THEME" };
    const app = await mountApp();
    expect(document.documentElement.dataset["piWebTheme"]).toBe("themes:pi-web-dark");
    expect(themePanel(app).shadowRoot?.querySelector("select")?.disabled).toBe(true);
    expect(JSON.parse(localStorage.getItem(THEME_STORAGE_KEY) ?? "null")).toEqual(saved);

    enforcedSettings = {};
    const general = settings(app).shadowRoot?.querySelector("settings-general-panel");
    const refresh = general?.shadowRoot?.querySelector("settings-panel-frame")?.shadowRoot?.querySelector<HTMLButtonElement>('button[title="Refresh settings"]');
    expect(refresh).not.toBeNull();
    refresh?.click();
    await vi.waitFor(() => { expect(document.documentElement.dataset["piWebTheme"]).toBe("themes:classic"); });
    expect(JSON.parse(localStorage.getItem(THEME_STORAGE_KEY) ?? "null")).toEqual(saved);
  });

  it("keeps the delivered palette and saved choice when a plugin theme is unavailable", async () => {
    const saved = { themeId: "custom:temporarily-missing", auto: true };
    localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify(saved));
    const app = await mountApp();
    expect(document.documentElement.dataset["piWebTheme"]).toBe("themes:pi-web-light");
    expect(JSON.parse(localStorage.getItem(THEME_STORAGE_KEY) ?? "null")).toEqual(saved);
    expect(themePanel(app).hasLocalOverride).toBe(true);
    await discoverGatewayPlugins(app);
    expect(document.documentElement.dataset["piWebTheme"]).toBe("themes:pi-web-light");
    expect(JSON.parse(localStorage.getItem(THEME_STORAGE_KEY) ?? "null")).toEqual(saved);
  });

  it("commits a discovered plugin preference without an intermediate Classic theme", async () => {
    localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify({ themeId: "custom:light", auto: false }));
    const app = await mountApp();
    expect(document.documentElement.dataset["piWebTheme"]).toBe("themes:pi-web-light");
    const seen: string[] = [];
    const observer = new MutationObserver(() => { seen.push(document.documentElement.dataset["piWebTheme"] ?? ""); });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-pi-web-theme"] });
    try {
      vi.mocked(loadExternalPlugins).mockResolvedValue({
        terminalMode: "recovery-disabled", declarations: [{ id: "custom" }], failures: [],
        registrations: [{ id: "custom", plugin: { apiVersion: 4, name: "Custom", activate: () => ({ contributions: {
          themes: [{ id: "light", name: "Light", colorScheme: "light", tokens: { "--pi-bg": "#fff" } }],
        } }) } }],
      });
      await discoverGatewayPlugins(app);
      await vi.waitFor(() => { expect(document.documentElement.dataset["piWebTheme"]).toBe("custom:light"); });
      expect(seen).not.toContain("themes:classic");
    } finally {
      observer.disconnect();
    }
  });

  it("waits for configuration even if discovery finishes first", async () => {
    let resolve!: (value: ReturnType<typeof configResponse>) => void;
    vi.mocked(configApi.config).mockReturnValue(new Promise((done) => { resolve = done; }));
    const app = new ThemeSettingsApp();
    document.body.append(app);
    await discoverGatewayPlugins(app);
    expect(document.documentElement.dataset["piWebTheme"]).toBe("themes:pi-web-light");
    resolve(configResponse({ defaultTheme: { themeId: "themes:pi-web-light", auto: false } }));
    await vi.waitFor(() => { expect(document.documentElement.dataset["piWebTheme"]).toBe("themes:pi-web-light"); });
  });
});

// Drive the actual discovery boundary without starting unrelated session transports.
async function discoverGatewayPlugins(app: PiWebApp): Promise<void> {
  const discover: unknown = Reflect.get(app, "ensureGatewayPluginsLoaded");
  if (typeof discover !== "function") throw new Error("Expected gateway discovery boundary");
  await Reflect.apply(discover, app, []);
}

async function mountApp(): Promise<ThemeSettingsApp> {
  const app = new ThemeSettingsApp();
  document.body.append(app);
  await vi.waitFor(() => {
    const panel = themePanel(app);
    expect(panel.loading).toBe(false);
    expect(panel.themes.length).toBeGreaterThan(0);
  });
  await app.updateComplete;
  await settings(app).updateComplete;
  await themePanel(app).updateComplete;
  return app;
}

function settings(app: ThemeSettingsApp): SettingsDialog {
  const dialog = app.shadowRoot?.querySelector<SettingsDialog>("settings-dialog");
  if (dialog == null) throw new Error("Expected settings dialog");
  return dialog;
}

function themePanel(app: ThemeSettingsApp): SettingsThemePanel {
  const panel = settings(app).shadowRoot?.querySelector("settings-general-panel")?.querySelector<SettingsThemePanel>("settings-theme-panel");
  if (panel == null) throw new Error("Expected theme settings");
  return panel;
}

function selectTheme(panel: SettingsThemePanel, id: string): void {
  const select = panel.shadowRoot?.querySelector<HTMLSelectElement>("select");
  if (select == null) throw new Error("Expected theme selector");
  select.value = id;
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

function button(panel: SettingsThemePanel, label: string): HTMLButtonElement {
  const control = [...panel.shadowRoot?.querySelectorAll<HTMLButtonElement>("button") ?? []].find((element) => element.textContent === label);
  if (control === undefined) throw new Error(`Expected ${label}`);
  return control;
}
