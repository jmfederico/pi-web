// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { PiWebConfigResponse, PiWebConfigValues } from "../../api";
import { SettingsGeneralPanel } from "./SettingsGeneralPanel";
import { hostAccessNotices } from "../hostAccessNotices";
import { generalMessages as messages } from "./settingsGeneralMessages";

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
});

describe("General settings", () => {
  it("keeps the hostname decision gateway-scoped and preserves drafts until save acknowledgement", async () => {
    const panel = await mountPanel();
    const mode = policySelect(panel);
    expect(mode.value).toBe("");
    const save = vi.fn((patch: PiWebConfigValues) => {
      panel.configResponse = { ...configResponse({ ...panel.configResponse?.effectiveConfig, ...patch }), activeHostAccess: null };
    });
    panel.onSave = save;
    await choosePolicy(panel, "restricted");
    panel.targetId = "remote";
    panel.machineConfigResponse = configResponse({ hostAccess: { mode: "any" } });
    panel.configResponse = configResponse({ host: "gateway.local", port: 9000 });
    await settle(panel);
    expect(mode.value).toBe("restricted");
    submit(panel, 0);
    await settle(panel);
    expect(save).toHaveBeenCalledExactlyOnceWith({ hostAccess: { mode: "restricted", hosts: [] } });
    expect(mode.value).toBe("restricted");
    expect(panel.shadowRoot?.querySelector(".form-actions small")).toBeNull();
  });

  it.each([{}, { allowedHosts: true }, { allowedHosts: ["legacy.local"] }] satisfies PiWebConfigValues[])("never saves an implicit policy while editing host or port (%j)", async (config) => {
    const panel = await mountPanel();
    panel.configResponse = configResponse(config);
    panel.onSave = vi.fn();
    await settle(panel);
    expect(policySelect(panel).value).toBe("");
    expect(panel.shadowRoot?.querySelector("#host-access-list")).toBeNull();
    edit(panel, gatewayHostInput, "new.local");
    edit(panel, gatewayHostInput + "[inputmode]", "9000");
    submit(panel, 0);
    await settle(panel);
    expect(panel.onSave).toHaveBeenCalledExactlyOnceWith({ host: "new.local", port: 9000 });
  });

  it("prefills the legacy list only until a policy exists and retains list edits across unsaved mode switches", async () => {
    const panel = await mountPanel();
    panel.configResponse = configResponse({ allowedHosts: ["legacy.local"] });
    panel.onSave = vi.fn();
    await settle(panel);
    await choosePolicy(panel, "restricted");
    expect(input(panel, "#host-access-list").value).toBe("legacy.local");
    edit(panel, "#host-access-list", "new.local");
    await choosePolicy(panel, "any");
    expect(panel.shadowRoot?.querySelector("#host-access-list")).toBeNull();
    submit(panel, 0);
    await settle(panel);
    expect(panel.onSave).toHaveBeenLastCalledWith({ hostAccess: { mode: "any" } });
    await choosePolicy(panel, "restricted");
    expect(input(panel, "#host-access-list").value).toBe("new.local");
    submit(panel, 0);
    await settle(panel);
    expect(panel.onSave).toHaveBeenLastCalledWith({ hostAccess: { mode: "restricted", hosts: ["new.local"] } });
  });

  it("leaves the new policy editable under legacy environment enforcement and explains migration", async () => {
    const panel = await mountPanel();
    panel.configResponse = { ...configResponse({ allowedHosts: ["legacy.local"] }), enforcedSettings: { "/allowedHosts": "PI_WEB_ALLOWED_HOSTS" }, envOverrides: { ...configResponse({}).envOverrides, allowedHosts: true } };
    panel.onSave = vi.fn();
    await settle(panel);
    expect(policySelect(panel).disabled).toBe(false);
    expect(policySelect(panel).value).toBe("");
    expect(panel.shadowRoot?.textContent).toContain(messages.t("hostAccessLegacyEnv", { variable: "PI_WEB_ALLOWED_HOSTS" }));
    await choosePolicy(panel, "restricted");
    expect(input(panel, "#host-access-list").disabled).toBe(false);
    submit(panel, 0);
    await settle(panel);
    expect(panel.onSave).toHaveBeenCalledExactlyOnceWith({ hostAccess: { mode: "restricted", hosts: ["legacy.local"] } });
  });

  it.each([undefined, { mode: "restricted" as const, hosts: ["default.local"] }])("resets the whole saved policy to its lower layer (%j)", async (inherited) => {
    const panel = await mountPanel();
    panel.configResponse = configResponse({ hostAccess: { mode: "any" } });
    panel.onReset = vi.fn(() => { panel.configResponse = { ...configResponse({}), effectiveConfig: inherited ? { hostAccess: inherited } : {}, activeHostAccess: { mode: "any" } }; });
    await settle(panel);
    required(panel.shadowRoot?.querySelector<HTMLButtonElement>('button[aria-label="Reset saved override for /hostAccess"]')).click();
    await settle(panel);
    expect(panel.onReset).toHaveBeenCalledExactlyOnceWith(["/hostAccess"]);
    expect(policySelect(panel).value).toBe(inherited?.mode ?? "");
    const notice = hostAccessNotices(panel.configResponse, vi.fn())[0]?.message ?? "";
    if (inherited) expect(notice).not.toContain(messages.t("hostAccessDecision"));
    else expect(notice).toContain(messages.t("hostAccessDecision"));
  });

  it("locks the entire environment policy without modifying the hidden saved value", async () => {
    const panel = await mountPanel();
    await choosePolicy(panel, "any");
    panel.onSave = vi.fn();
    panel.onReset = vi.fn();
    panel.configResponse = {
      ...configResponse({ hostAccess: { mode: "any" } }),
      effectiveConfig: { hostAccess: { mode: "restricted", hosts: ["env.local"] } },
      enforcedSettings: { "/hostAccess": "PI_WEB_HOST_ACCESS" },
    };
    await settle(panel);
    expect(policySelect(panel).value).toBe("restricted");
    expect(policySelect(panel).disabled).toBe(true);
    expect(input(panel, "#host-access-list").value).toBe("env.local");
    expect(input(panel, "#host-access-list").disabled).toBe(true);
    expect(panel.configResponse.config.hostAccess).toEqual({ mode: "any" });
    expect(panel.shadowRoot?.textContent).toContain("PI_WEB_HOST_ACCESS");
    expect(required(panel.shadowRoot?.querySelector<HTMLButtonElement>('button[aria-label="Reset saved override for /hostAccess"]')).disabled).toBe(true);
    submit(panel, 0);
    await settle(panel);
    expect(panel.onSave).toHaveBeenCalledExactlyOnceWith({});
  });

  it("saves list-only changes atomically and keeps the startup snapshot distinct", async () => {
    const panel = await mountPanel();
    const activeHostAccess = { mode: "restricted" as const, hosts: ["old.local"] };
    panel.configResponse = { ...configResponse({ hostAccess: activeHostAccess }), activeHostAccess };
    panel.onSave = vi.fn((patch: PiWebConfigValues) => { panel.configResponse = { ...configResponse(patch), activeHostAccess }; });
    await settle(panel);
    edit(panel, "#host-access-list", " new.local \n");
    submit(panel, 0);
    await settle(panel);
    expect(panel.onSave).toHaveBeenCalledExactlyOnceWith({ hostAccess: { mode: "restricted", hosts: ["new.local"] } });
    expect(panel.configResponse.activeHostAccess).toEqual(activeHostAccess);
    expect(input(panel, "#host-access-list").value).toBe("new.local");
    expect(panel.shadowRoot?.querySelector(".form-actions small")).toBeNull();
    expect(hostAccessNotices(panel.configResponse, vi.fn())).toHaveLength(1);
    const summary = panel.shadowRoot?.querySelector('[aria-label="Gateway settings after environment overrides"]');
    expect(summary?.textContent).toContain("old.local");
    expect(summary?.textContent).toContain("new.local");
  });

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

  it("labels hostname controls and associates their guidance", async () => {
    const panel = await mountPanel();
    await choosePolicy(panel, "restricted");
    for (const id of ["host-access", "host-access-list"]) {
      const control = required(panel.shadowRoot?.getElementById(id));
      expect(panel.shadowRoot?.querySelector(`label[for="${id}"]`)?.textContent).toBeTruthy();
      const help = required(control.getAttribute("aria-describedby"));
      expect(panel.shadowRoot?.getElementById(help)?.textContent.trim()).toBeTruthy();
    }
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

function policySelect(panel: SettingsGeneralPanel): HTMLSelectElement {
  return required(panel.shadowRoot?.querySelector<HTMLSelectElement>("#host-access"));
}

async function choosePolicy(panel: SettingsGeneralPanel, value: "restricted" | "any"): Promise<void> {
  const mode = policySelect(panel);
  mode.value = value;
  mode.dispatchEvent(new Event("change", { bubbles: true }));
  await settle(panel);
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
