// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { builtInThemeCatalog } from "../../themeCatalog.testSupport";
import { PluginRegistry } from "../../plugins/registry";
import { SettingsThemePanel } from "./SettingsThemePanel";
import { configResponse } from "../SettingsDialog.testSupport";

const registries: PluginRegistry[] = [];
afterEach(async () => {
  document.body.replaceChildren();
  for (const registry of registries.splice(0)) await registry.dispose();
  localStorage.clear();
});

describe("theme settings controls", () => {
  it("selects the saved theme when first opened and when options arrive later", async () => {
    const registry = new PluginRegistry();
    const catalog = builtInThemeCatalog();
    registry.setDeclarativeThemes(catalog.themes, catalog.themePairs);
    const themes = registry.getThemes();
    for (const delayed of [false, true]) {
      const panel = new SettingsThemePanel();
      panel.preference = { themeId: "themes:graphite", auto: false };
      panel.themes = delayed ? [] : themes;
      document.body.append(panel);
      await panel.updateComplete;
      if (delayed) {
        panel.themes = themes;
        await panel.updateComplete;
      }
      const select = required(panel.shadowRoot?.querySelector<HTMLSelectElement>("select"));
      expect(select.value).toBe("themes:graphite");
      panel.preference = { themeId: "themes:paper", auto: false };
      await panel.updateComplete;
      expect(select.value).toBe("themes:paper");
      selectTheme(panel, "themes:classic");
      await panel.updateComplete;
      expect(select.value).toBe("themes:classic");
      panel.remove();
    }
    await registry.dispose();
  });

  it("stages theme and Auto choices, then offers distinct browser/default actions", async () => {
    const panel = await mountPanel();
    const useLocal = vi.fn();
    const setDefault = vi.fn();
    const useDefault = vi.fn();
    panel.onUseLocal = useLocal;
    panel.onSetDefault = setDefault;
    panel.onUseDefault = useDefault;
    panel.hasLocalOverride = true;
    await panel.updateComplete;
    selectTheme(panel, "themes:pi-web-light");
    const auto = required(panel.shadowRoot?.querySelector<HTMLInputElement>('input[type="checkbox"]'));
    auto.click();
    await panel.updateComplete;
    expect(useLocal).not.toHaveBeenCalled();
    expect(setDefault).not.toHaveBeenCalled();

    button(panel, "Use in this browser").click();
    button(panel, "Set gateway default").click();
    button(panel, "Use the default").click();
    expect(useLocal).toHaveBeenCalledWith({ themeId: "themes:pi-web-light", auto: false });
    expect(setDefault).toHaveBeenCalledWith({ themeId: "themes:pi-web-light", auto: false });
    expect(useDefault).toHaveBeenCalledOnce();
    expect(panel.preference).toEqual({ themeId: "themes:pi-web-dark", auto: true });
  });

  it("shows the preference source and default independently", async () => {
    const panel = await mountPanel();
    panel.preference = { themeId: "themes:classic", auto: false };
    panel.defaultPreference = { themeId: "themes:pi-web-light", auto: true };
    panel.hasLocalOverride = true;
    await panel.updateComplete;
    expect(panel.shadowRoot?.textContent).toContain("Using a theme saved in this browser");
    expect(panel.shadowRoot?.textContent).toContain("Default: PI WEB Light · Follows system appearance");
    panel.hasLocalOverride = false;
    await panel.updateComplete;
    expect(panel.shadowRoot?.textContent).toContain("Using the default theme");
  });

  it("keeps an unavailable requested theme visible rather than saving its fallback", async () => {
    const panel = await mountPanel();
    panel.preference = { themeId: "custom:missing", auto: false };
    panel.hasLocalOverride = true;
    await panel.updateComplete;
    expect(panel.shadowRoot?.textContent).toContain("custom:missing (unavailable)");
    expect(button(panel, "Use in this browser").disabled).toBe(true);
    const select = required(panel.shadowRoot?.querySelector("select"));
    const guidance = required(panel.shadowRoot?.getElementById("theme-unavailable-help"));
    expect(select.getAttribute("aria-describedby")).toContain(guidance.id);
    expect(guidance.textContent).toContain("Choose an available theme");
    expect(button(panel, "Set gateway default").disabled).toBe(true);
    expect(button(panel, "Use the default").disabled).toBe(false);
    selectTheme(panel, "themes:pi-web-light");
    await panel.updateComplete;
    expect(panel.shadowRoot?.getElementById("theme-unavailable-help")).toBeNull();
    expect(button(panel, "Use in this browser").disabled).toBe(false);
  });

  it("preserves the draft through catalog loading while allowing default and reset recovery", async () => {
    const panel = await mountPanel();
    selectTheme(panel, "themes:classic");
    const themes = panel.themes;
    const useLocal = vi.fn();
    const useDefault = vi.fn();
    const reset = vi.fn();
    panel.onUseLocal = useLocal;
    panel.onUseDefault = useDefault;
    panel.onReset = reset;
    panel.configResponse = configResponse({ defaultTheme: panel.defaultPreference });
    panel.hasLocalOverride = true;
    panel.catalogLoading = true;
    panel.themes = [];
    await panel.updateComplete;

    const select = required(panel.shadowRoot?.querySelector("select"));
    expect(select.disabled).toBe(true);
    expect(select.value).toBe("themes:classic");
    expect(panel.shadowRoot?.getElementById("theme-unavailable-help")).toBeNull();
    expect(panel.shadowRoot?.textContent).not.toContain("(unavailable)");
    expect([...panel.shadowRoot?.querySelectorAll('[role="status"]') ?? []].some((status) => status.textContent.includes("Loading"))).toBe(true);
    expect(required(panel.shadowRoot?.querySelector<HTMLInputElement>('input[type="checkbox"]')).disabled).toBe(true);
    button(panel, "Use in this browser").click();
    expect(useLocal).not.toHaveBeenCalled();
    expect(button(panel, "Set gateway default").disabled).toBe(true);
    button(panel, "Use the default").click();
    required(panel.shadowRoot?.querySelector<HTMLButtonElement>('button[aria-label="Reset saved override for /defaultTheme"]')).click();
    expect(useDefault).toHaveBeenCalledOnce();
    expect(reset).toHaveBeenCalledWith(["/defaultTheme"]);
    expect(panel.hasLocalOverride).toBe(true);

    panel.themes = themes;
    panel.catalogLoading = false;
    await panel.updateComplete;
    expect(select.disabled).toBe(false);
    expect(select.value).toBe("themes:classic");
    button(panel, "Use in this browser").click();
    expect(useLocal).toHaveBeenCalledWith({ themeId: "themes:classic", auto: true });
  });

  it("reports catalog failure and retries without changing the preference", async () => {
    const panel = await mountPanel();
    const retry = vi.fn();
    panel.catalogError = "Network offline";
    panel.onRetryCatalog = retry;
    await panel.updateComplete;
    expect(panel.shadowRoot?.querySelector('[role="alert"]')?.textContent).toContain("Network offline");
    button(panel, "Retry").click();
    expect(retry).toHaveBeenCalledOnce();
    panel.catalogError = "";
    await panel.updateComplete;
    expect(panel.shadowRoot?.querySelector('[role="alert"]')).toBeNull();
    expect(panel.preference).toEqual({ themeId: "themes:pi-web-dark", auto: true });
  });

  it("disables edits while config is loading or saving", async () => {
    const panel = await mountPanel();
    panel.hasLocalOverride = true;
    for (const property of ["loading", "saving"] as const) {
      panel[property] = true;
      await panel.updateComplete;
      expect([...panel.shadowRoot?.querySelectorAll<HTMLButtonElement>("button") ?? []].every((element) => element.disabled)).toBe(true);
      panel[property] = false;
    }
  });
});

async function mountPanel(): Promise<SettingsThemePanel> {
  const registry = new PluginRegistry();
  registries.push(registry);
  const catalog = builtInThemeCatalog();
  registry.setDeclarativeThemes(catalog.themes, catalog.themePairs);
  const panel = new SettingsThemePanel();
  panel.themes = registry.getThemes();
  document.body.append(panel);
  await panel.updateComplete;
  return panel;
}

function selectTheme(panel: SettingsThemePanel, id: string): void {
  const select = required(panel.shadowRoot?.querySelector<HTMLSelectElement>("select"));
  select.value = id;
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

function button(panel: SettingsThemePanel, label: string): HTMLButtonElement {
  return required([...panel.shadowRoot?.querySelectorAll<HTMLButtonElement>("button") ?? []].find((element) => element.textContent === label));
}

function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error("Expected rendered theme control");
  return value;
}
