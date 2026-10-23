// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsPluginsPanel } from "./SettingsPluginsPanel";
import { SettingsPackagesPanel } from "./SettingsPackagesPanel";
import { SettingsSessiondPanel } from "./SettingsSessiondPanel";
import { SettingsShortcutsPanel } from "./SettingsShortcutsPanel";
import { configResponse, pluginInfo, pluginsResponse } from "../SettingsDialog.testSupport";

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
});

describe("configuration accessibility and activation guidance", () => {
  it("names each plugin toggle and distinguishes saved enablement from running state", async () => {
    const panel = new SettingsPluginsPanel();
    const plugin = pluginInfo("example", false);
    plugin.server = { state: "disabled", staleRevision: false, restartRequired: true, disableCommand: "pi-web plugins disable example --restart" };
    panel.configResponse = configResponse({ plugins: { example: { enabled: true } } });
    panel.pluginsResponse = pluginsResponse([plugin]);
    panel.pluginsResponse.serverRuntime.restartRequired = true;
    panel.recoveryCommandsSupported = true;
    document.body.append(panel);
    await panel.updateComplete;

    const toggle = panel.shadowRoot?.querySelector<HTMLInputElement>('input[aria-label="Enable example"]');
    expect(toggle?.checked).toBe(true);
    expect(panel.shadowRoot?.textContent).toContain("Saved: enabled");
    expect(panel.shadowRoot?.textContent).toContain("Disabled");
    expect(panel.shadowRoot?.querySelector("settings-panel-frame")?.shadowRoot?.textContent).toContain("interrupts active sessions");
    expect(panel.shadowRoot?.textContent).toContain("Check safe mode");
    expect(panel.shadowRoot?.textContent).toContain("Start without server plugins (including Terminal)");
  });

  it("restores the saved plugin toggle when saving fails", async () => {
    const panel = new SettingsPluginsPanel();
    panel.configResponse = configResponse({ plugins: { example: { enabled: true } } });
    panel.pluginsResponse = pluginsResponse([pluginInfo("example", true)]);
    panel.onTogglePlugin = async () => {
      panel.saving = true;
      await panel.updateComplete;
      panel.error = "Could not save plugin settings";
      panel.saving = false;
    };
    document.body.append(panel);
    await panel.updateComplete;
    const toggle = panel.shadowRoot?.querySelector<HTMLInputElement>("input");
    if (toggle === null || toggle === undefined) throw new Error("Plugin toggle missing");
    toggle.click();
    await vi.waitFor(() => { expect(panel.error).toBe("Could not save plugin settings"); });
    await panel.updateComplete;
    expect(toggle.checked).toBe(true);
  });

  it("keeps required and unavailable plugin toggles disabled", async () => {
    const panel = new SettingsPluginsPanel();
    panel.pluginsResponse = pluginsResponse([{ ...pluginInfo("pi-web.terminal", true), required: true }, pluginInfo("example", true)]);
    panel.configResponse = configResponse({ plugins: { "pi-web.terminal": { enabled: false } } });
    document.body.append(panel);
    await panel.updateComplete;
    const required = panel.shadowRoot?.querySelector<HTMLInputElement>('input[aria-label="pi-web.terminal is required"]');
    expect(required?.checked).toBe(true);
    expect(required?.disabled).toBe(true);
    panel.configResponse = undefined;
    await panel.updateComplete;
    expect(panel.shadowRoot?.querySelector<HTMLInputElement>('input[aria-label="Enable example"]')?.disabled).toBe(true);
  });

  it("restores a saved agent permission after a failed change", async () => {
    const panel = new SettingsSessiondPanel();
    panel.configResponse = configResponse({ spawnSessions: true, subsessions: true, askUser: true });
    panel.onSave = async () => {
      panel.saving = true;
      await panel.updateComplete;
      panel.error = "Could not save agent permissions";
      panel.saving = false;
    };
    document.body.append(panel);
    await panel.updateComplete;
    const toggle = panel.shadowRoot?.querySelector<HTMLInputElement>("#spawn-sessions");
    if (toggle === null || toggle === undefined) throw new Error("Agent permission missing");
    toggle.click();
    await vi.waitFor(() => { expect(panel.error).toBe("Could not save agent permissions"); });
    await panel.updateComplete;
    expect(toggle.checked).toBe(true);
  });

  it("restores send behavior when a settings save fails", async () => {
    const panel = new SettingsShortcutsPanel();
    panel.configResponse = configResponse({ defaultStreamingBehavior: "steer" });
    panel.onSave = async () => {
      panel.saving = true;
      await panel.updateComplete;
      panel.error = "Could not save send behavior";
      panel.saving = false;
    };
    document.body.append(panel);
    await panel.updateComplete;
    const select = panel.shadowRoot?.querySelector<HTMLSelectElement>('select[aria-label="Send while agent is running"]');
    if (select === null || select === undefined) throw new Error("Send behavior missing");
    select.value = "followUp";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.waitFor(() => { expect(panel.error).toBe("Could not save send behavior"); });
    await panel.updateComplete;
    expect(select.value).toBe("steer");
  });

  it("links to community plugins even when the package list is unavailable", async () => {
    const panel = new SettingsPackagesPanel();
    document.body.append(panel);
    await panel.updateComplete;

    const link = panel.shadowRoot?.querySelector<HTMLAnchorElement>('a[href="https://pi-web.dev/community-plugins"]');
    expect(link?.textContent).toContain("Find community plugins");
    expect(link?.target).toBe("_blank");
    expect(link?.rel).toContain("noopener");
    expect(panel.shadowRoot?.querySelector("#package-source")).toBeNull();
  });

  it("associates package validation with the input and retains source after a failed install", async () => {
    const panel = new SettingsPackagesPanel();
    panel.packagesResponse = { packages: [] };
    panel.onInstallPackage = vi.fn().mockRejectedValue(new Error("Install failed"));
    document.body.append(panel);
    await panel.updateComplete;
    const input = panel.shadowRoot?.querySelector<HTMLInputElement>("#package-source");
    const form = panel.shadowRoot?.querySelector<HTMLFormElement>("form");
    if (input === null || input === undefined || form === null || form === undefined) throw new Error("Install form missing");
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await panel.updateComplete;
    expect(input.getAttribute("aria-invalid")).toBe("true");
    for (const id of input.getAttribute("aria-describedby")?.split(" ") ?? []) {
      expect(panel.shadowRoot?.getElementById(id)).not.toBeNull();
    }
    expect(panel.shadowRoot?.getElementById("package-source-error")?.getAttribute("role")).toBe("alert");
    input.value = "npm:example";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await panel.updateComplete;
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => { expect(panel.onInstallPackage).toHaveBeenCalledWith("npm:example"); });
    await panel.updateComplete;
    expect(input.value).toBe("npm:example");
    expect(input.getAttribute("aria-invalid")).toBe("false");
  });
});
