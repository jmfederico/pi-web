// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsGeneralPanel } from "./SettingsGeneralPanel";
import { SettingsThemePanel } from "./SettingsThemePanel";
import { SettingsPluginsPanel } from "./SettingsPluginsPanel";
import { SettingsLocalizationPanel } from "./SettingsLocalizationPanel";
import { localization } from "../../localization/browser";
import { configResponse, pluginInfo, pluginsResponse } from "../SettingsDialog.testSupport";

afterEach(() => { document.body.replaceChildren(); localStorage.clear(); vi.restoreAllMocks(); });

function resetButton(panel: HTMLElement, path: string): HTMLButtonElement {
  const button = panel.shadowRoot?.querySelector<HTMLButtonElement>(`button[aria-label="Reset saved override for ${path}"]`);
  if (!button) throw new Error(`Missing reset for ${path}`);
  return button;
}

describe("Settings source, enforcement and reset controls", () => {
  it("shows effective defaults but saves only changed machine fields and resets at the machine scope", async () => {
    const panel = new SettingsGeneralPanel();
    panel.configResponse = configResponse({ host: "gateway" });
    panel.machineConfigResponse = { ...configResponse({ installationName: "Saved", uploads: { defaultFolder: "hidden" } }), effectiveConfig: { installationName: "Saved", uploads: { defaultFolder: "enforced" }, attachments: { defaultFolder: "deployed" } }, enforcedSettings: { "/uploads/defaultFolder": "PI_WEB_UPLOADS" }, configSources: { "/attachments/defaultFolder": "defaults" } };
    panel.targetId = "remote";
    panel.onSaveMachineConfig = vi.fn();
    panel.onResetMachine = vi.fn();
    panel.onReset = vi.fn();
    document.body.append(panel);
    await panel.updateComplete;
    const upload = panel.shadowRoot?.querySelector<HTMLInputElement>('input[placeholder=".pi-web/uploads"]');
    expect(upload?.value).toBe("enforced");
    expect(upload?.disabled).toBe(true);
    expect(panel.shadowRoot?.textContent).toContain("PI_WEB_UPLOADS");
    expect(resetButton(panel, "/uploads/defaultFolder").disabled).toBe(true);
    const name = panel.shadowRoot?.querySelector<HTMLInputElement>('[name="installationName"]');
    if (!name) throw new Error("Missing name input");
    name.value = "Changed";
    name.dispatchEvent(new Event("input"));
    panel.shadowRoot?.querySelectorAll("form")[1]?.dispatchEvent(new Event("submit", { cancelable: true }));
    expect(panel.onSaveMachineConfig).toHaveBeenCalledExactlyOnceWith({ installationName: "Changed" });
    resetButton(panel, "/installationName").click();
    expect(panel.onResetMachine).toHaveBeenCalledExactlyOnceWith(["/installationName"]);
    expect(panel.onReset).not.toHaveBeenCalled();
  });

  it("locks theme browser and gateway actions and preserves a hidden browser choice", async () => {
    const panel = new SettingsThemePanel();
    panel.configResponse = { ...configResponse({ defaultTheme: { themeId: "saved", auto: false } }), enforcedSettings: { "/defaultTheme": "PI_WEB_DEFAULT_THEME" } };
    panel.hasLocalOverride = true;
    panel.onReset = vi.fn();
    panel.onUseLocal = vi.fn();
    panel.onUseDefault = vi.fn();
    document.body.append(panel);
    await panel.updateComplete;
    expect(panel.shadowRoot?.textContent).toContain("PI_WEB_DEFAULT_THEME");
    for (const control of panel.shadowRoot?.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>("button,input,select") ?? []) expect(control.disabled).toBe(true);
    expect(panel.onUseDefault).not.toHaveBeenCalled();
  });

  it("locks escaped plugin enablement and emits a leaf reset for an editable plugin", async () => {
    const panel = new SettingsPluginsPanel();
    const id = "plugin/~id";
    panel.configResponse = { ...configResponse({ plugins: { [id]: { enabled: false }, editable: { enabled: true } } }), effectiveConfig: { plugins: { [id]: { enabled: true }, editable: { enabled: true } } }, enforcedSettings: { "/plugins/plugin~1~0id/enabled": "PI_WEB_PLUGINS" } };
    panel.pluginsResponse = pluginsResponse([pluginInfo(id, true), pluginInfo("editable", true)]);
    panel.onResetPlugin = vi.fn();
    document.body.append(panel);
    await panel.updateComplete;
    expect(resetButton(panel, "/plugins/plugin~1~0id/enabled").disabled).toBe(true);
    const toggle = panel.shadowRoot?.querySelector<HTMLInputElement>(`input[aria-label="Enable ${id}"]`);
    expect(toggle?.checked).toBe(true);
    expect(toggle?.disabled).toBe(true);
    resetButton(panel, "/plugins/editable/enabled").click();
    expect(panel.onResetPlugin).toHaveBeenCalledExactlyOnceWith("editable");
  });

  it("locks localization fields independently and preserves hidden browser overrides on apply and browser reset", async () => {
    await localization.setPreferenceOverrides({ language: "en", timeZone: "Europe/Paris" });
    const panel = new SettingsLocalizationPanel();
    panel.configResponse = { ...configResponse({}), effectiveConfig: { defaultLocalization: { timeZone: "UTC" } }, enforcedSettings: { "/defaultLocalization/timeZone": "PI_WEB_DEFAULT_LOCALIZATION" } };
    document.body.append(panel);
    await panel.updateComplete;
    const zone = panel.shadowRoot?.querySelector<HTMLInputElement>("#timeZone");
    const region = panel.shadowRoot?.querySelector<HTMLInputElement>("#formatLocale");
    expect(zone?.value).toBe("UTC");
    expect(zone?.disabled).toBe(true);
    if (!region) throw new Error("Missing region input");
    region.value = "de-DE";
    region.dispatchEvent(new Event("input"));
    panel.shadowRoot?.querySelector("form")?.dispatchEvent(new Event("submit", { cancelable: true }));
    await panel.updateComplete;
    expect(localization.preferenceOverrides).toMatchObject({ timeZone: "Europe/Paris", formatLocale: "de-DE" });
    panel.shadowRoot?.querySelector<HTMLButtonElement>('button[type="button"]')?.click();
    await panel.updateComplete;
    expect(localization.preferenceOverrides).toEqual({ timeZone: "Europe/Paris" });
    await localization.setPreferenceOverrides({});
  });

  it("clears folder overrides and saves other machine changes in one update", async () => {
    const panel = new SettingsGeneralPanel();
    panel.machineConfigResponse = configResponse({ installationName: "Saved", uploads: { defaultFolder: "saved-uploads" }, attachments: { defaultFolder: "saved-attachments" }, pathAccess: { allowedPaths: ["/saved"] } });
    panel.onSaveMachineConfig = vi.fn();
    document.body.append(panel);
    await panel.updateComplete;
    const root = panel.shadowRoot;
    for (const placeholder of [".pi-web/uploads", ".pi-web/attachments"]) {
      const input = root?.querySelector<HTMLInputElement>(`input[placeholder="${placeholder}"]`);
      if (!input) throw new Error("Missing folder input");
      input.value = "";
      input.dispatchEvent(new Event("input"));
    }
    const paths = root?.querySelector<HTMLTextAreaElement>("textarea");
    if (!paths) throw new Error("Missing paths input");
    paths.value = "";
    paths.dispatchEvent(new Event("input"));
    root?.querySelector("form")?.dispatchEvent(new Event("submit", { cancelable: true }));
    expect(panel.onSaveMachineConfig).toHaveBeenCalledExactlyOnceWith({ pathAccess: { allowedPaths: [] } }, ["/uploads/defaultFolder", "/attachments/defaultFolder"]);
  });

});
