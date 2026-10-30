// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { PiWebConfigResponse, PiWebConfigValues } from "../../api";
import { SettingsGeneralPanel } from "./SettingsGeneralPanel";

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
});

describe("General settings", () => {
  it("shows effective machine base roots without claiming external access is denied", async () => {
    const panel = await mountPanel();
    panel.onResetMachine = vi.fn();
    panel.machineConfigResponse = {
      ...configResponse({ basePaths: ["/saved-root"] }),
      effectiveConfig: { basePaths: ["/effective-root"] },
      enforcedSettings: { "/basePaths": "PI_WEB_BASE_PATHS" },
    };
    await settle(panel);
    const summary = required(panel.shadowRoot?.querySelector('[aria-label="Effective selected machine file access and upload summary"]'));
    expect(summary.textContent).toContain("/effective-root");
    expect(summary.textContent).not.toContain("/saved-root");
    expect(summary.textContent).not.toContain("No machine-wide external roots");
    expect(summary.textContent).not.toContain("External paths denied");
    expect(summary.textContent).toContain("PI_WEB_BASE_PATHS");
    expect(summary.textContent).toContain("project additions are not shown here");
    expect(summary.querySelector("button")).toBeNull();
    expect(required(panel.shadowRoot?.querySelector<HTMLTextAreaElement>('textarea[placeholder^="~/SDKs"]')).value).toBe("");

    panel.machineConfigResponse = {
      ...configResponse({ basePaths: ["/file-root"] }),
      configSources: { "/basePaths": "user config" },
    };
    await settle(panel);
    expect(summary.textContent).toContain("user config");
    expect(summary.textContent).not.toContain("PI_WEB_BASE_PATHS");
    expect(summary.querySelector("button")).toBeNull();
  });

  it("lists base roots separately from global additions and does not save base roots with edits", async () => {
    const panel = await mountPanel();
    panel.machineConfigResponse = configResponse({ basePaths: ["/base"], pathAccess: { allowedPaths: ["/additional"] } });
    await settle(panel);
    const summary = required(panel.shadowRoot?.querySelector('[aria-label="Effective selected machine file access and upload summary"]'));
    const rows = Array.from(summary.querySelectorAll("dl > div"));
    expect(rows[0]?.querySelector("dt")?.textContent).toBe("Machine base roots");
    expect(rows[0]?.querySelector("dd")?.textContent).toContain("/base");
    expect(rows[0]?.textContent).not.toContain("/additional");
    expect(rows[1]?.querySelector("dt")?.textContent).toBe("Global additions");
    expect(rows[1]?.querySelector("dd")?.textContent).toBe("/additional");
    expect(summary.textContent).not.toContain("No machine-wide external roots");
    const save = vi.fn();
    panel.onSaveMachineConfig = save;
    edit(panel, machineInput, "manual/uploads");
    submit(panel, 1);
    await settle(panel);
    expect(save).toHaveBeenCalledExactlyOnceWith({ uploads: { defaultFolder: "manual/uploads" } });
  });

  it("edits and clears the selected machine name through the machine config save", async () => {
    const panel = await mountPanel();
    panel.machineConfigResponse = configResponse({ installationName: "Studio" });
    await settle(panel);
    const selector = 'input[name="installationName"]';
    expect(input(panel, selector).value).toBe("Studio");
    expect(input(panel, selector).closest("label")?.textContent).toContain("Machine name");
    expect(panel.shadowRoot?.textContent).toContain("Shown in the machine selector and installed app. Leave blank to use PI-WEB.");
    const save = vi.fn();
    panel.onSaveMachineConfig = save;
    edit(panel, selector, " Lab ");
    submit(panel, 1);
    await settle(panel);
    expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ installationName: "Lab" }));
    edit(panel, selector, " ");
    submit(panel, 1);
    await settle(panel);
    expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ installationName: "" }));
  });

  it("labels allowed-host controls and associates their guidance", async () => {
    const panel = await mountPanel();
    for (const id of ["allowed-hosts-mode", "allowed-hosts-list"]) {
      const control = required(panel.shadowRoot?.getElementById(id));
      expect(panel.shadowRoot?.querySelector(`label[for="${id}"]`)?.textContent).toBeTruthy();
      expect(panel.shadowRoot?.getElementById(required(control.getAttribute("aria-describedby")))?.textContent).toContain("Enter one host per line");
    }
    const mode = required(panel.shadowRoot?.querySelector<HTMLSelectElement>("select"));
    mode.value = "all";
    mode.dispatchEvent(new Event("change", { bubbles: true }));
    await settle(panel);
    expect(required(panel.shadowRoot?.querySelector<HTMLTextAreaElement>("#allowed-hosts-list")).disabled).toBe(true);
  });

  it("scopes machine errors as alerts and explains unavailable configurations", async () => {
    const panel = await mountPanel();
    panel.configResponse = undefined;
    panel.machineConfigResponse = undefined;
    panel.machineError = "Machine unavailable";
    const save = vi.fn();
    panel.onSave = save;
    await settle(panel);
    expect(panel.shadowRoot?.querySelector('[role="alert"]')?.textContent).toBe("Machine unavailable");
    expect(panel.shadowRoot?.textContent).toContain("Gateway settings are unavailable. Choose Refresh settings to try again.");
    expect(panel.shadowRoot?.textContent).toContain("Machine settings are unavailable. Choose Refresh settings to try again.");
    expect(panel.shadowRoot?.querySelector("form")).toBeNull();
    expect(save).not.toHaveBeenCalled();
  });

  it("shows and locks the effective environment value without modifying the hidden saved value", async () => {
    const panel = await mountPanel();
    panel.targetLabel = "Lab Mac (remote machine)";
    panel.configResponse = { ...configResponse({ host: "saved.local" }), effectiveConfig: { host: "env.local" }, envOverrides: { ...configResponse({}).envOverrides, host: true } };
    await settle(panel);
    expect(panel.shadowRoot?.textContent).toContain("Save the machine name, file access, and upload defaults on Lab Mac (remote machine)");
    expect(panel.shadowRoot?.textContent).toContain("Environment overrides take priority.");
    expect(panel.shadowRoot?.textContent).toContain("env.local");
    expect(input(panel, gatewayHostInput).value).toBe("env.local");
    expect(input(panel, gatewayHostInput).disabled).toBe(true);
    expect(panel.configResponse.config.host).toBe("saved.local");
    expect(panel.shadowRoot?.textContent).toContain("PI_WEB_HOST");
  });

  it("preserves dirty fields across refresh while updating untouched fields and save remainders", async () => {
    const panel = await mountPanel();
    edit(panel, gatewayHostInput, "draft.local");
    edit(panel, machineInput, "draft/uploads");
    panel.configResponse = configResponse({ host: "refreshed.local", port: 9000, plugins: { info: { enabled: false } } });
    panel.machineConfigResponse = configResponse({ uploads: { defaultFolder: "remote/uploads" }, attachments: { defaultFolder: "new/attachments" } });
    await settle(panel);
    expect(input(panel, gatewayHostInput).value).toBe("draft.local");
    expect(input(panel, gatewayHostInput + "[inputmode]").value).toBe("9000");
    expect(input(panel, machineInput).value).toBe("draft/uploads");
    const save = vi.fn();
    panel.onSave = save;
    submit(panel, 0);
    await settle(panel);
    expect(save).toHaveBeenCalledWith({ host: "draft.local" });
  });

  it("combines cleared server overrides and changed values in one update", async () => {
    const panel = await mountPanel();
    panel.configResponse = { ...configResponse({ host: "saved.local", port: 8504 }), defaultsConfig: { host: "deployment.local" } };
    await settle(panel);
    edit(panel, gatewayHostInput, "");
    edit(panel, gatewayHostInput + "[inputmode]", "9000");
    const save = vi.fn((config: PiWebConfigValues) => {
      panel.configResponse = { ...configResponse(config), effectiveConfig: { host: "deployment.local", ...config } };
    });
    panel.onSave = save;
    submit(panel, 0);
    await settle(panel);
    expect(save).toHaveBeenCalledExactlyOnceWith({ port: 9000 }, ["/host"]);
    expect(input(panel, gatewayHostInput).value).toBe("deployment.local");
  });

  it("acknowledges only the saved scope, including normalized values", async () => {
    const panel = await mountPanel();
    edit(panel, gatewayHostInput, " saved.local ");
    edit(panel, machineInput, "dirty/uploads");
    panel.onSave = (config) => { panel.configResponse = configResponse(config); };
    submit(panel, 0);
    await settle(panel);
    expect(input(panel, gatewayHostInput).value).toBe("saved.local");
    expect(input(panel, machineInput).value).toBe("dirty/uploads");
    panel.configResponse = configResponse({ host: "later.local" });
    await settle(panel);
    expect(input(panel, gatewayHostInput).value).toBe("later.local");

    edit(panel, gatewayHostInput, "unsaved-gateway.local");
    edit(panel, machineInput, " normalized\\uploads/. ");
    panel.onSaveMachineConfig = (config) => {
      panel.machineConfigResponse = configResponse(config);
      // Local-machine saves also refresh the gateway snapshot in the parent.
      panel.configResponse = configResponse({ host: "later.local", ...config });
    };
    submit(panel, 1);
    await settle(panel);
    panel.machineConfigResponse = configResponse({ uploads: { defaultFolder: "later/uploads" } });
    await settle(panel);
    expect(input(panel, machineInput).value).toBe("later/uploads");
    expect(input(panel, gatewayHostInput).value).toBe("unsaved-gateway.local");
  });

  it("preserves edits made during save and after failed saves", async () => {
    const panel = await mountPanel();
    let acknowledge: (() => void) | undefined;
    panel.onSave = (config) => new Promise<void>((resolve) => {
      acknowledge = () => { panel.configResponse = configResponse(config); resolve(); };
    });
    edit(panel, gatewayHostInput, "submitted.local");
    submit(panel, 0);
    edit(panel, gatewayHostInput, "newer.local");
    required(acknowledge)();
    await settle(panel);
    expect(input(panel, gatewayHostInput).value).toBe("newer.local");
    panel.onSave = () => { throw new Error("Save failed"); };
    submit(panel, 0);
    await settle(panel);
    panel.configResponse = configResponse({ host: "server.local" });
    await settle(panel);
    expect(input(panel, gatewayHostInput).value).toBe("newer.local");
  });

  it("does not carry machine drafts across a target change or unavailable transition", async () => {
    const panel = await mountPanel();
    edit(panel, gatewayHostInput, "gateway-draft.local");
    edit(panel, machineInput, "old-machine/uploads");
    panel.targetId = "other-machine";
    panel.targetLabel = "Other machine";
    panel.machineConfigResponse = configResponse({ uploads: { defaultFolder: "other/uploads" } });
    await settle(panel);
    expect(input(panel, machineInput).value).toBe("other/uploads");
    expect(input(panel, gatewayHostInput).value).toBe("gateway-draft.local");
    edit(panel, machineInput, "dirty/uploads");
    panel.machineConfigResponse = undefined;
    await settle(panel);
    panel.machineConfigResponse = configResponse({ uploads: { defaultFolder: "fresh/uploads" } });
    await settle(panel);
    expect(input(panel, machineInput).value).toBe("fresh/uploads");
  });

  it("resets machine drafts when two machines share the same display label", async () => {
    const panel = await mountPanel();
    panel.targetId = "machine-a";
    await settle(panel);
    edit(panel, machineInput, "machine-a/unsaved");
    panel.targetId = "machine-b";
    panel.machineConfigResponse = configResponse({ uploads: { defaultFolder: "machine-b/uploads" } });
    await settle(panel);
    expect(input(panel, machineInput).value).toBe("machine-b/uploads");
  });

  it("saves only machine-safe fields and announces validation errors", async () => {
    const panel = await mountPanel();
    const save = vi.fn();
    const gatewaySave = vi.fn();
    panel.onSaveMachineConfig = save;
    panel.onSave = gatewaySave;
    edit(panel, machineInput, "/absolute/uploads");
    submit(panel, 1);
    await settle(panel);
    expect(panel.shadowRoot?.querySelector('[role="alert"]')?.textContent).toBe("Upload default folder must be workspace-relative.");
    expect(save).not.toHaveBeenCalled();
    edit(panel, machineInput, "manual\\uploads/.");
    submit(panel, 1);
    await settle(panel);
    expect(save).toHaveBeenCalledWith({ uploads: { defaultFolder: "manual/uploads" } });
    expect(gatewaySave).not.toHaveBeenCalled();
  });
  it("reflects the saved quiet-mode setting and shows dialog save failures", async () => {
    const panel = await mountPanel();
    panel.configResponse = configResponse({ host: "gateway.local", quietMode: true });
    await settle(panel);
    const toggle = quietToggle(panel);
    expect(toggle.checked).toBe(true);

    const setQuietMode = vi.fn();
    panel.onSetQuietMode = setQuietMode;
    toggle.checked = false;
    toggle.dispatchEvent(new Event("change", { bubbles: true }));
    await settle(panel);
    expect(setQuietMode).toHaveBeenCalledWith(false);

    // The dialog owns quiet-mode failures and passes them down as its error prop.
    panel.error = "Couldn't save quiet mode: Disk is read-only";
    await settle(panel);
    const notices = panel.shadowRoot?.querySelector("settings-panel-frame")?.shadowRoot?.querySelector('[role="alert"]');
    expect(notices?.textContent).toContain("Disk is read-only");
  });

  it("does not save quiet mode while the gateway configuration is loading or unavailable", async () => {
    const panel = await mountPanel();
    const setQuietMode = vi.fn();
    panel.onSetQuietMode = setQuietMode;
    panel.loading = true;
    await settle(panel);
    expect(quietToggle(panel).disabled).toBe(true);
    panel.loading = false;
    panel.configResponse = undefined;
    await settle(panel);
    expect(panel.shadowRoot?.querySelector("#quiet-mode")).toBeNull();
    expect(setQuietMode).not.toHaveBeenCalled();
  });
});

const gatewayHostInput = 'section[aria-label="Gateway server settings"] input';
const machineInput = 'section[aria-label="Selected machine settings"] input:not([name="installationName"])';

async function mountPanel(): Promise<SettingsGeneralPanel> {
  const panel = new SettingsGeneralPanel();
  panel.configResponse = configResponse({ host: "gateway.local" });
  panel.machineConfigResponse = configResponse({});
  document.body.append(panel);
  await settle(panel);
  return panel;
}

async function settle(panel: SettingsGeneralPanel): Promise<void> {
  await panel.updateComplete;
  await panel.updateComplete;
}

function quietToggle(panel: SettingsGeneralPanel): HTMLInputElement {
  const toggle = panel.shadowRoot?.querySelector<HTMLInputElement>("#quiet-mode");
  if (toggle === null || toggle === undefined) throw new Error("Expected the quiet-mode toggle");
  return toggle;
}

function input(panel: SettingsGeneralPanel, selector: string): HTMLInputElement {
  return required(panel.shadowRoot?.querySelector<HTMLInputElement>(selector));
}

function edit(panel: SettingsGeneralPanel, selector: string, value: string): void {
  const control = input(panel, selector);
  control.value = value;
  control.dispatchEvent(new Event("input", { bubbles: true }));
}

function submit(panel: SettingsGeneralPanel, index: number): void {
  required(panel.shadowRoot?.querySelectorAll("form")[index]).dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
}

function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error("Expected rendered General control");
  return value;
}

function configResponse(config: PiWebConfigValues): PiWebConfigResponse {
  return {
    path: "/tmp/pi-web/config.json",
    exists: true,
    config,
    effectiveConfig: config,
    envOverrides: { host: false, port: false, allowedHosts: false, spawnSessions: false, subsessions: false, sessionMessages: false, askUser: false },
  };
}
