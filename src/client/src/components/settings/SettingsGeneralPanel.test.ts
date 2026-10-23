// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { PiWebConfigResponse, PiWebConfigValues } from "../../api";
import { SettingsGeneralPanel } from "./SettingsGeneralPanel";

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
});

describe("General settings", () => {
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
    expect(panel.shadowRoot?.textContent).toContain("File access settings are unavailable. Choose Refresh settings to try again.");
    expect(panel.shadowRoot?.querySelector("form")).toBeNull();
    expect(save).not.toHaveBeenCalled();
  });

  it("shows scope and environment priority without hiding saved values", async () => {
    const panel = await mountPanel();
    panel.targetLabel = "Lab Mac (remote machine)";
    panel.configResponse = { ...configResponse({ host: "saved.local" }), effectiveConfig: { host: "env.local" }, envOverrides: { ...configResponse({}).envOverrides, host: true } };
    await settle(panel);
    expect(panel.shadowRoot?.textContent).toContain("Save file access and upload defaults on Lab Mac (remote machine)");
    expect(panel.shadowRoot?.textContent).toContain("Environment overrides take priority.");
    expect(panel.shadowRoot?.textContent).toContain("env.local");
    expect(input(panel, "input").value).toBe("saved.local");
  });

  it("preserves dirty fields across refresh while updating untouched fields and save remainders", async () => {
    const panel = await mountPanel();
    edit(panel, "input", "draft.local");
    edit(panel, machineInput, "draft/uploads");
    panel.configResponse = configResponse({ host: "refreshed.local", port: 9000, plugins: { info: { enabled: false } } });
    panel.machineConfigResponse = configResponse({ uploads: { defaultFolder: "remote/uploads" }, attachments: { defaultFolder: "new/attachments" } });
    await settle(panel);
    expect(input(panel, "input").value).toBe("draft.local");
    expect(input(panel, "input[inputmode]").value).toBe("9000");
    expect(input(panel, machineInput).value).toBe("draft/uploads");
    const save = vi.fn();
    panel.onSave = save;
    submit(panel, 0);
    await settle(panel);
    expect(save).toHaveBeenCalledWith({ host: "draft.local", port: 9000, allowedHosts: [], plugins: { info: { enabled: false } } });
  });

  it("acknowledges only the saved scope, including normalized values", async () => {
    const panel = await mountPanel();
    edit(panel, "input", " saved.local ");
    edit(panel, machineInput, "dirty/uploads");
    panel.onSave = (config) => { panel.configResponse = configResponse(config); };
    submit(panel, 0);
    await settle(panel);
    expect(input(panel, "input").value).toBe("saved.local");
    expect(input(panel, machineInput).value).toBe("dirty/uploads");
    panel.configResponse = configResponse({ host: "later.local" });
    await settle(panel);
    expect(input(panel, "input").value).toBe("later.local");

    edit(panel, "input", "unsaved-gateway.local");
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
    expect(input(panel, "input").value).toBe("unsaved-gateway.local");
  });

  it("preserves edits made during save and after failed saves", async () => {
    const panel = await mountPanel();
    let acknowledge: (() => void) | undefined;
    panel.onSave = (config) => new Promise<void>((resolve) => {
      acknowledge = () => { panel.configResponse = configResponse(config); resolve(); };
    });
    edit(panel, "input", "submitted.local");
    submit(panel, 0);
    edit(panel, "input", "newer.local");
    required(acknowledge)();
    await settle(panel);
    expect(input(panel, "input").value).toBe("newer.local");
    panel.onSave = () => { throw new Error("Save failed"); };
    submit(panel, 0);
    await settle(panel);
    panel.configResponse = configResponse({ host: "server.local" });
    await settle(panel);
    expect(input(panel, "input").value).toBe("newer.local");
  });

  it("does not carry machine drafts across a target change or unavailable transition", async () => {
    const panel = await mountPanel();
    edit(panel, "input", "gateway-draft.local");
    edit(panel, machineInput, "old-machine/uploads");
    panel.targetLabel = "Other machine";
    panel.machineConfigResponse = configResponse({ uploads: { defaultFolder: "other/uploads" } });
    await settle(panel);
    expect(input(panel, machineInput).value).toBe("other/uploads");
    expect(input(panel, "input").value).toBe("gateway-draft.local");
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
    expect(save).toHaveBeenCalledWith({ pathAccess: { allowedPaths: [] }, uploads: { defaultFolder: "manual/uploads" }, attachments: {} });
    expect(gatewaySave).not.toHaveBeenCalled();
  });
});

const machineInput = 'section[aria-label="Selected machine file access and upload settings"] input';

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
    envOverrides: { host: false, port: false, allowedHosts: false, spawnSessions: false, subsessions: false, askUser: false },
  };
}
