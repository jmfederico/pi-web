// @vitest-environment happy-dom
import { installNativeDialogFake } from "./nativeDialog.testSupport";
installNativeDialogFake();

import { LitElement } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configApi, piPackagesApi, pluginsApi, type Machine, type PiWebConfigResponse } from "../api";
import * as themeCatalog from "../themeCatalog";
import type { SettingsSection } from "../settingsRoute";
import { SettingsDialog } from "./SettingsDialog";
import { configResponse, deferred, pluginInfo, pluginsResponse, remoteMachine, secondRemoteMachine } from "./SettingsDialog.testSupport";
import type { SettingsGeneralPanel } from "./settings/SettingsGeneralPanel";
import { SettingsRestartAction } from "./settings/SettingsRestartAction";

const gateway: Machine = { ...remoteMachine, id: "local", name: "Gateway", kind: "local" };
let gatewayConfig: PiWebConfigResponse;
let pluginRestartRequired: boolean;

beforeEach(() => {
  gatewayConfig = { ...configResponse({ host: "127.0.0.1", port: 8504, hostAccess: { mode: "any" } }), activeHostAccess: { mode: "any" } };
  pluginRestartRequired = false;
  vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(() => undefined);
  vi.spyOn(themeCatalog, "loadThemeCatalog").mockResolvedValue({ themes: [], themePairs: [] });
  vi.spyOn(configApi, "config").mockImplementation((id) => Promise.resolve(id === undefined ? gatewayConfig : configResponse({ spawnSessions: true })));
  vi.spyOn(configApi, "updateConfig").mockImplementation((update, id) => {
    if (id !== undefined) return Promise.resolve(configResponse(update.set ?? {}));
    gatewayConfig = { ...gatewayConfig, ...configResponse({ ...gatewayConfig.effectiveConfig, ...update.set }) };
    return Promise.resolve(gatewayConfig);
  });
  vi.spyOn(pluginsApi, "plugins").mockImplementation(() => {
    const response = pluginsResponse([pluginInfo("info", true)]);
    response.serverRuntime.restartRequired = pluginRestartRequired;
    return Promise.resolve(response);
  });
  vi.spyOn(piPackagesApi, "packages").mockResolvedValue({ packages: [] });
});

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  vi.restoreAllMocks();
});

function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error("Missing rendered control");
  return value;
}

// Drain API continuations and Lit updates through the nested panel/notice roots.
async function settle(element: LitElement): Promise<void> {
  for (let pass = 0; pass < 3; pass += 1) {
    await element.updateComplete;
    for (const child of element.shadowRoot?.querySelectorAll("*") ?? []) {
      if (child instanceof LitElement) await settle(child);
    }
  }
}

function findAction(root: ParentNode): SettingsRestartAction | undefined {
  for (const child of root.querySelectorAll("*")) {
    if (child instanceof SettingsRestartAction) return child;
    if (child.shadowRoot !== null) {
      const found = findAction(child.shadowRoot);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

function action(dialog: SettingsDialog): SettingsRestartAction {
  return required(findAction(required(dialog.shadowRoot)));
}

function restartButton(dialog: SettingsDialog): HTMLButtonElement {
  return required(action(dialog).shadowRoot?.querySelector("button"));
}

async function mount(section: SettingsSection, withRestart = true): Promise<SettingsDialog> {
  const dialog = new SettingsDialog();
  dialog.section = section;
  dialog.machine = remoteMachine;
  dialog.machines = [gateway, remoteMachine, secondRemoteMachine];
  dialog.onNavigate = (next) => { dialog.section = next; };
  if (withRestart) dialog.onRestart = vi.fn(() => Promise.resolve());
  dialog.onClose = vi.fn();
  document.body.append(dialog);
  await settle(dialog);
  return dialog;
}

async function selectMachine(dialog: SettingsDialog, id: string): Promise<void> {
  const select = required(dialog.shadowRoot?.querySelector<HTMLSelectElement>("#settings-machine"));
  select.value = id;
  select.dispatchEvent(new Event("change", { bubbles: true }));
  await settle(dialog);
}

function general(dialog: SettingsDialog): SettingsGeneralPanel {
  return required(dialog.shadowRoot?.querySelector<SettingsGeneralPanel>("settings-general-panel"));
}

async function editPort(dialog: SettingsDialog, value: string): Promise<void> {
  const panel = general(dialog);
  const input = required(panel.shadowRoot?.querySelector<HTMLInputElement>('input[inputmode="numeric"]'));
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await settle(dialog);
}

function submitGateway(dialog: SettingsDialog): void {
  required(general(dialog).shadowRoot?.querySelector("form")).dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
}

describe("Settings direct restart shortcuts", () => {
  it("captures the Settings machine, keeps saves separate, and handles pending launch/failure without closing or confirming", async () => {
    const dialog = await mount("sessiond");
    await selectMachine(dialog, secondRemoteMachine.id);
    const panel = required(dialog.shadowRoot?.querySelector("settings-sessiond-panel"));
    required(panel.shadowRoot?.querySelector<HTMLInputElement>("#spawn-sessions")).click();
    await settle(dialog);
    expect(configApi.updateConfig).toHaveBeenCalledExactlyOnceWith({ set: { spawnSessions: false }, unset: [] }, "remote-b");
    expect(dialog.onRestart).not.toHaveBeenCalled();
    expect(dialog.machine).toBe(remoteMachine);
    const warning = required(action(dialog).shadowRoot?.querySelector("#restart-warning")).textContent;
    expect(warning).toContain("Build Box");
    expect(warning).toMatch(/session daemon.*interrupts active sessions.*terminals/s);
    expect(restartButton(dialog).getAttribute("aria-describedby")).toBe("restart-warning");

    const pending = deferred<undefined>();
    dialog.onRestart = vi.fn(() => pending.promise);
    restartButton(dialog).click();
    restartButton(dialog).click();
    await settle(dialog);
    expect(dialog.onRestart).toHaveBeenCalledExactlyOnceWith("remote-b", "sessiond");
    expect(restartButton(dialog).disabled).toBe(true);
    expect(required(dialog.shadowRoot?.querySelector<HTMLSelectElement>("#settings-machine")).disabled).toBe(true);
    expect(dialog.onClose).not.toHaveBeenCalled();
    expect(dialog.shadowRoot?.querySelector("confirmation-dialog")?.shadowRoot?.querySelector("modal-surface")).toBeNull();
    // Sidebar changes while launching cannot retarget the captured request.
    dialog.machine = gateway;
    await settle(dialog);
    pending.reject(new Error("Terminal unavailable <img>"));
    await settle(dialog);
    expect(restartButton(dialog).disabled).toBe(false);
    const error = required(action(dialog).shadowRoot?.querySelector('[role="alert"]'));
    expect(error.textContent).toContain("Terminal unavailable <img>");
    expect(error.querySelector("img")).toBeNull();
    expect(dialog.onRestart).toHaveBeenCalledExactlyOnceWith("remote-b", "sessiond");
    expect(configApi.updateConfig).toHaveBeenCalledTimes(1);

    dialog.onRestart = vi.fn(() => { dialog.remove(); return Promise.resolve(); });
    restartButton(dialog).click();
    await settle(dialog);
    expect(dialog.onRestart).toHaveBeenCalledExactlyOnceWith("remote-b", "sessiond");
    expect(dialog.isConnected).toBe(false);
    expect(dialog.onClose).not.toHaveBeenCalled();
  });

  it("offers plugin restart only for restart-required runtime feedback and targets the Settings machine", async () => {
    const dialog = await mount("plugins");
    await selectMachine(dialog, secondRemoteMachine.id);
    expect(findAction(required(dialog.shadowRoot))).toBeUndefined();
    pluginRestartRequired = true;
    const panel = required(dialog.shadowRoot?.querySelector("settings-plugins-panel"));
    required(panel.shadowRoot?.querySelector<HTMLInputElement>('input[aria-label="Enable info"]')).click();
    await settle(dialog);
    expect(configApi.updateConfig).toHaveBeenCalledExactlyOnceWith({ set: { plugins: { info: { enabled: false } } } }, "remote-b");
    expect(dialog.onRestart).not.toHaveBeenCalled();
    expect(action(dialog).shadowRoot?.textContent).toContain("Build Box");
    dialog.onRestart = vi.fn(() => Promise.reject(new Error("Build Box offline")));
    restartButton(dialog).click();
    await settle(dialog);
    expect(dialog.onRestart).toHaveBeenCalledExactlyOnceWith("remote-b", "sessiond");
    expect(action(dialog).shadowRoot?.querySelector('[role="alert"]')?.textContent).toContain("Build Box offline");
    await selectMachine(dialog, "local");
    expect(action(dialog).shadowRoot?.querySelector('[role="alert"]')).toBeNull();
    expect(dialog.machine).toBe(remoteMachine);
    expect(configApi.updateConfig).toHaveBeenCalledTimes(1);
  });

  it("keeps gateway restart explicit and blocks it during saves even when matching hostname policy cannot confirm network activation", async () => {
    const dialog = await mount("general");
    await selectMachine(dialog, secondRemoteMachine.id);
    expect(restartButton(dialog).disabled).toBe(false);
    expect(configApi.updateConfig).not.toHaveBeenCalled();
    required(general(dialog).shadowRoot?.querySelector<HTMLInputElement>("#quiet-mode")).click();
    await settle(dialog);
    expect(restartButton(dialog).disabled).toBe(false);
    await editPort(dialog, "9000");
    expect(restartButton(dialog).disabled).toBe(false);
    const save = deferred<PiWebConfigResponse>();
    vi.mocked(configApi.updateConfig).mockReturnValueOnce(save.promise);
    submitGateway(dialog);
    await settle(dialog);
    expect(restartButton(dialog).disabled).toBe(true);
    restartButton(dialog).click();
    expect(dialog.onRestart).not.toHaveBeenCalled();
    save.resolve({ ...gatewayConfig, ...configResponse({ ...gatewayConfig.effectiveConfig, port: 9000 }) });
    await settle(dialog);
    const warning = required(action(dialog).shadowRoot?.querySelector("#restart-warning")).textContent;
    expect(warning).toContain("Gateway (local gateway)");
    expect(warning).toMatch(/only the web\/API.*Browsers will disconnect; sessions and terminals keep running/s);
    restartButton(dialog).click();
    await settle(dialog);
    expect(dialog.onRestart).toHaveBeenCalledExactlyOnceWith("local", "web");
    expect(configApi.updateConfig).toHaveBeenCalledTimes(2);
    expect(dialog.machine).toBe(remoteMachine);
    expect(dialog.onClose).not.toHaveBeenCalled();
    // A successful launch does not prove activation or clear the reminder.
    expect(findAction(required(dialog.shadowRoot))).toBeDefined();
    expect(action(dialog).shadowRoot?.querySelector('[role="alert"]')).toBeNull();
  });

  it.each([
    { field: "port", selector: 'input[inputmode="numeric"]', value: "9000", saved: { port: 9000 } },
    { field: "host", selector: 'input[placeholder="127.0.0.1"]', value: "0.0.0.0", saved: { host: "0.0.0.0" } },
  ])("keeps gateway restart available after saving $field and recreating Settings with matching hostname policy", async ({ selector, value, saved }) => {
    const dialog = await mount("general");
    const input = required(general(dialog).shadowRoot?.querySelector<HTMLInputElement>(selector));
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    submitGateway(dialog);
    await settle(dialog);
    expect(configApi.updateConfig).toHaveBeenCalledExactlyOnceWith({ set: saved, unset: [] });
    expect(gatewayConfig.effectiveConfig).toMatchObject(saved);
    expect(gatewayConfig.activeHostAccess).toEqual(gatewayConfig.effectiveConfig.hostAccess);
    expect(dialog.onRestart).not.toHaveBeenCalled();

    dialog.onClose = () => { dialog.remove(); };
    required(dialog.shadowRoot?.querySelector<HTMLButtonElement>('button[aria-label="Close settings"]')).click();
    expect(dialog.isConnected).toBe(false);
    const reopened = await mount("general");
    await selectMachine(reopened, secondRemoteMachine.id);
    expect(restartButton(reopened).disabled).toBe(false);
    restartButton(reopened).click();
    await settle(reopened);
    expect(reopened.onRestart).toHaveBeenCalledExactlyOnceWith("local", "web");
    expect(configApi.updateConfig).toHaveBeenCalledTimes(1);
    // Launching a command is not evidence that the saved network values are active.
    reopened.remove();
    const afterLaunch = await mount("general");
    expect(restartButton(afterLaunch).disabled).toBe(false);
  });

  it("reports a failed save without changing saved network config or launching a restart", async () => {
    const dialog = await mount("general");
    vi.mocked(configApi.updateConfig).mockRejectedValueOnce(new Error("Read-only config"));
    await editPort(dialog, "9000");
    submitGateway(dialog);
    await settle(dialog);
    expect(general(dialog).error).toContain("Read-only config");
    expect(gatewayConfig.effectiveConfig.port).toBe(8504);
    expect(restartButton(dialog).disabled).toBe(false);
    expect(dialog.onRestart).not.toHaveBeenCalled();
  });

  it("offers no gateway restart until configuration is available and disables it while refreshing", async () => {
    vi.mocked(configApi.config).mockRejectedValueOnce(new Error("Gateway unavailable"));
    const dialog = await mount("general");
    expect(general(dialog).error).toContain("Gateway unavailable");
    expect(findAction(required(dialog.shadowRoot))).toBeUndefined();
    const pending = deferred<PiWebConfigResponse>();
    vi.mocked(configApi.config).mockReturnValueOnce(pending.promise);
    const loaded = dialog.reloadGatewayConfig();
    await settle(dialog);
    expect(findAction(required(dialog.shadowRoot))).toBeUndefined();
    pending.resolve(gatewayConfig);
    await loaded;
    await settle(dialog);
    expect(restartButton(dialog).disabled).toBe(false);

    const refresh = deferred<PiWebConfigResponse>();
    vi.mocked(configApi.config).mockReturnValueOnce(refresh.promise);
    const refreshed = dialog.reloadGatewayConfig();
    await settle(dialog);
    expect(restartButton(dialog).disabled).toBe(true);
    restartButton(dialog).click();
    expect(dialog.onRestart).not.toHaveBeenCalled();
    refresh.resolve(gatewayConfig);
    await refreshed;
    await settle(dialog);
    expect(restartButton(dialog).disabled).toBe(false);
  });

  it.each([null, undefined, { mode: "restricted" as const, hosts: ["old.example"] }])("offers a local web shortcut for a saved hostname policy not confirmed active (%j)", async (activeHostAccess) => {
    if (activeHostAccess === undefined) delete gatewayConfig.activeHostAccess;
    else gatewayConfig = { ...gatewayConfig, activeHostAccess };
    const dialog = await mount("general");
    await selectMachine(dialog, secondRemoteMachine.id);
    restartButton(dialog).click();
    await settle(dialog);
    expect(dialog.onRestart).toHaveBeenCalledExactlyOnceWith("local", "web");
    expect(configApi.updateConfig).not.toHaveBeenCalled();
  });

  it("keeps all restart shortcuts disabled across panel navigation while a launch is pending", async () => {
    pluginRestartRequired = true;
    gatewayConfig.activeHostAccess = null;
    const dialog = await mount("sessiond");
    const pending = deferred<undefined>();
    dialog.onRestart = vi.fn(() => pending.promise);
    restartButton(dialog).click();
    dialog.section = "plugins";
    await settle(dialog);
    expect(restartButton(dialog).disabled).toBe(true);
    restartButton(dialog).click();
    expect(dialog.onRestart).toHaveBeenCalledExactlyOnceWith("remote-a", "sessiond");
    dialog.section = "general";
    await settle(dialog);
    expect(restartButton(dialog).disabled).toBe(true);
    // Another target/service is blocked, not described as already launching.
    expect(action(dialog).pending).toBe(false);
    pending.resolve(undefined);
    await settle(dialog);
    expect(restartButton(dialog).disabled).toBe(false);
  });

  it.each(["general", "sessiond", "plugins"] as const)("offers no %s restart control without the launch callback", async (section) => {
    gatewayConfig.activeHostAccess = null;
    pluginRestartRequired = true;
    const dialog = await mount(section, false);
    expect(findAction(required(dialog.shadowRoot))).toBeUndefined();
  });
});
