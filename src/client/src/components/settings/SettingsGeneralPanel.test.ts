// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { TemplateResult } from "lit";
import type { PiWebConfigResponse, PiWebConfigValues } from "../../api";
import { SettingsGeneralPanel } from "./SettingsGeneralPanel";
import type { SettingsPanelFrame } from "./SettingsPanelFrame";
import { localeStore } from "../../i18n/locale";
import type { GatewayServerConfigDraft, MachineAccessConfigDraft } from "./settingsConfigDraft";

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  localeStore.dispose();
});

describe("settings-general-panel copy", () => {
  it("uses factual scope copy for gateway and selected-machine settings", async () => {
    const panel = new SettingsGeneralPanel();
    panel.targetLabel = "Lab Mac (remote machine)";
    panel.configResponse = configResponse({ host: "127.0.0.1" });
    panel.machineConfigResponse = configResponse({ pathAccess: { allowedPaths: ["/mnt/share"] }, uploads: { defaultFolder: "manual/uploads" }, attachments: { defaultFolder: "manual/attachments" } });

    document.body.append(panel);
    await panel.updateComplete;
    const frame = panel.shadowRoot?.querySelector<SettingsPanelFrame>("settings-panel-frame");
    if (frame === undefined || frame === null) throw new Error("Expected settings frame");
    await frame.updateComplete;
    expect(frame.shadowRoot?.textContent).toContain("Gateway server fields edit this local gateway. File access and upload defaults edit Lab Mac (remote machine).");
    expect(panel.shadowRoot?.textContent).toContain("Host, port, and allowed hosts are saved in the gateway config.");
    expect(panel.shadowRoot?.textContent).toContain("External filesystem roots and upload defaults are saved on Lab Mac (remote machine).");
  });

  it("shows reload copy when selected-machine access config is unavailable", () => {
    const panel = new SettingsGeneralPanel();
    panel.targetLabel = "Lab Mac (remote machine)";
    panel.configResponse = configResponse({ host: "127.0.0.1" });
    panel.machineError = "Failed to load file access/upload config from Lab Mac (remote machine): unsupported";

    const template = panel.render();
    const values = collectTemplateValues(template);

    expect(values).toContain("Save gateway server config");
    expect(values).not.toContain("Save file/upload config");
    expect(values).toContain("Selected-machine file access config is unavailable. Reload before saving file/upload settings.");
    expect(values).toContain("Failed to load file access/upload config from Lab Mac (remote machine): unsupported");
  });

  it("uses frame notices for saved and gateway messages while keeping selected-machine errors scoped", () => {
    const panel = new SettingsGeneralPanel();
    panel.error = "Gateway failed";
    panel.machineError = "Selected-machine failed";
    panel.savedMessage = "Config saved.";

    const values = collectTemplateValues(panel.render());
    const notices = values.find(isSettingsNoticeArray);

    expect(notices).toEqual([
      { type: "error", title: "Gateway server", content: "Gateway failed" },
      { type: "success", content: "Config saved." },
    ]);
    expect(values).toContain("Selected-machine failed");
  });
});

describe("settings-general-panel save payloads", () => {
  it("saves gateway server fields through the gateway save callback only", async () => {
    const panel = new SettingsGeneralPanel();
    const onSave = vi.fn();
    const onSaveMachineConfig = vi.fn();
    const event = new Event("submit", { cancelable: true });
    panel.configResponse = configResponse({
      host: "127.0.0.1",
      port: 8504,
      allowedHosts: ["old.local"],
      shortcuts: { "core:view.chat": "mod+1" },
      plugins: { info: { enabled: false } },
      pathAccess: { allowedPaths: ["/gateway"] },
      uploads: { defaultFolder: "gateway/uploads" },
      spawnSessions: true,
    });
    panel.onSave = onSave;
    panel.onSaveMachineConfig = onSaveMachineConfig;
    setPanelProperty(panel, "gatewayDraft", {
      host: " 0.0.0.0 ",
      port: "9000",
      allowedHostsMode: "all",
      allowedHostsText: "ignored.local",
    } satisfies GatewayServerConfigDraft);

    await callPanelPromise(panel, "saveGatewayConfig", event);

    expect(event.defaultPrevented).toBe(true);
    expect(onSave.mock.calls).toEqual([[
      {
        host: "0.0.0.0",
        port: 9000,
        allowedHosts: true,
        shortcuts: { "core:view.chat": "mod+1" },
        plugins: { info: { enabled: false } },
        pathAccess: { allowedPaths: ["/gateway"] },
        uploads: { defaultFolder: "gateway/uploads" },
        spawnSessions: true,
      },
    ]]);
    expect(onSaveMachineConfig).not.toHaveBeenCalled();
    expect(getPanelProperty(panel, "gatewayLocalError")).toBe("");
  });

  it("saves external roots and upload defaults through the selected-machine save callback only", async () => {
    const panel = new SettingsGeneralPanel();
    const onSave = vi.fn();
    const onSaveMachineConfig = vi.fn();
    const event = new Event("submit", { cancelable: true });
    panel.onSave = onSave;
    panel.onSaveMachineConfig = onSaveMachineConfig;
    setPanelProperty(panel, "machineDraft", {
      allowedPathsText: "/tmp\n~/SDKs\n",
      uploadDefaultFolder: " manual\\uploads/. ",
      attachmentDefaultFolder: " saved\\attachments/. ",
    } satisfies MachineAccessConfigDraft);

    await callPanelPromise(panel, "saveMachineAccessConfig", event);

    expect(event.defaultPrevented).toBe(true);
    expect(onSaveMachineConfig.mock.calls).toEqual([[
      {
        pathAccess: { allowedPaths: ["/tmp", "~/SDKs"] },
        uploads: { defaultFolder: "manual/uploads" },
        attachments: { defaultFolder: "saved/attachments" },
      },
    ]]);
    expect(onSave).not.toHaveBeenCalled();
    expect(getPanelProperty(panel, "machineLocalError")).toBe("");
  });

  it("keeps invalid upload folders local and does not save selected-machine config", async () => {
    const panel = new SettingsGeneralPanel();
    const onSaveMachineConfig = vi.fn();
    panel.onSaveMachineConfig = onSaveMachineConfig;
    setPanelProperty(panel, "machineDraft", {
      allowedPathsText: "",
      uploadDefaultFolder: "/tmp/uploads",
      attachmentDefaultFolder: "",
    } satisfies MachineAccessConfigDraft);

    await callPanelPromise(panel, "saveMachineAccessConfig", new Event("submit", { cancelable: true }));

    expect(onSaveMachineConfig).not.toHaveBeenCalled();
    expect(getPanelProperty(panel, "machineLocalError")).toBe("Upload default folder must be workspace-relative.");
  });

  it("keeps invalid attachment folders local and does not save selected-machine config", async () => {
    const panel = new SettingsGeneralPanel();
    const onSaveMachineConfig = vi.fn();
    panel.onSaveMachineConfig = onSaveMachineConfig;
    setPanelProperty(panel, "machineDraft", {
      allowedPathsText: "",
      uploadDefaultFolder: "",
      attachmentDefaultFolder: "../attachments",
    } satisfies MachineAccessConfigDraft);

    await callPanelPromise(panel, "saveMachineAccessConfig", new Event("submit", { cancelable: true }));

    expect(onSaveMachineConfig).not.toHaveBeenCalled();
    expect(getPanelProperty(panel, "machineLocalError")).toBe("Attachment default folder must not contain path traversal.");
  });
});

function collectTemplateValues(template: TemplateResult): unknown[] {
  const values: unknown[] = [];
  visit(template);
  return values;

  function visit(current: unknown): void {
    if (Array.isArray(current)) {
      for (const item of current) visit(item);
      return;
    }
    if (!isTemplateResult(current)) return;
    for (const value of templateValues(current)) {
      values.push(value);
      visit(value);
    }
  }
}

function templateValues(template: TemplateResult): readonly unknown[] {
  const values = Reflect.get(template, "values");
  if (!Array.isArray(values)) throw new Error("TemplateResult values were unavailable");
  return values.map((value: unknown) => value);
}

function isTemplateResult(value: unknown): value is TemplateResult {
  return typeof value === "object" && value !== null && isStringArray(Reflect.get(value, "strings")) && Array.isArray(Reflect.get(value, "values"));
}

function isSettingsNoticeArray(value: unknown): value is readonly { type: string; content: unknown; title?: string }[] {
  return Array.isArray(value)
    && value.length > 0
    && value.every((item: unknown) => typeof item === "object" && item !== null && typeof Reflect.get(item, "type") === "string" && Reflect.has(item, "content"));
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item: unknown) => typeof item === "string");
}

function setPanelProperty(panel: SettingsGeneralPanel, property: string, value: unknown): void {
  if (!Reflect.set(panel, property, value)) throw new Error(`Failed to set SettingsGeneralPanel property ${property}`);
}

function getPanelProperty(panel: SettingsGeneralPanel, property: string): unknown {
  return Reflect.get(panel, property);
}

async function callPanelPromise(panel: SettingsGeneralPanel, methodName: string, ...args: readonly unknown[]): Promise<void> {
  const result = callPanelMethod(panel, methodName, ...args);
  if (!(result instanceof Promise)) throw new Error(`SettingsGeneralPanel.${methodName} did not return a promise`);
  await result;
}

function callPanelMethod(panel: SettingsGeneralPanel, methodName: string, ...args: readonly unknown[]): unknown {
  const method: unknown = Reflect.get(panel, methodName);
  if (!isPanelMethod(method)) throw new Error(`SettingsGeneralPanel.${methodName} is not callable`);
  return method.call(panel, ...args);
}

function isPanelMethod(value: unknown): value is (this: SettingsGeneralPanel, ...args: readonly unknown[]) => unknown {
  return typeof value === "function";
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
