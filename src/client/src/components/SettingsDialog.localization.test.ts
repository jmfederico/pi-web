// @vitest-environment happy-dom
import { LitElement } from "lit";
import * as themeCatalog from "../themeCatalog";
import { builtInThemeCatalog } from "../themeCatalog.testSupport";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { configApi, piPackagesApi, pluginsApi, type Machine } from "../api";
import { localization } from "../localization/browser";
import { SettingsDialog, settingsDialogMessages as messages } from "./SettingsDialog";
import { configResponse, deferred, pluginsResponse, remoteMachine, secondRemoteMachine } from "./SettingsDialog.testSupport";
import type { ModalSurface } from "./ModalSurface";
import type { SettingsGeneralPanel } from "./settings/SettingsGeneralPanel";
import type { SettingsSessiondPanel } from "./settings/SettingsSessiondPanel";
import type { SettingsPackagesPanel } from "./settings/SettingsPackagesPanel";
import type { SettingsPluginsPanel } from "./settings/SettingsPluginsPanel";
import { settingsFeedbackPackageFollowUp, settingsFeedbackTargetLabel } from "./settings/settingsFeedback";

const raw = "Raw <img> العربية";
const remote: Machine = { ...remoteMachine, name: raw };
const releases: (() => void)[] = [];
beforeEach(() => {
  vi.spyOn(themeCatalog, "loadThemeCatalog").mockResolvedValue(builtInThemeCatalog());
  vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(() => undefined);
  vi.spyOn(configApi, "config").mockResolvedValue(configResponse({ uploads: { defaultFolder: "original" } }));
  vi.spyOn(configApi, "updateConfig").mockImplementation((update) => Promise.resolve(configResponse(update.set ?? {})));
  vi.spyOn(pluginsApi, "plugins").mockResolvedValue(pluginsResponse([]));
  vi.spyOn(piPackagesApi, "packages").mockResolvedValue({ packages: [] });
});
afterEach(async () => {
  document.body.replaceChildren();
  releases.splice(0).forEach((release) => { release(); });
  await localization.setPreferences({ language: "en", formatLocale: "en-US" });
  localStorage.clear();
  vi.restoreAllMocks();
});
function required<T>(value: T | null | undefined): T {
  if (value === undefined || value === null) throw new Error("Missing settings fixture control");
  return value;
}
async function settle(element: LitElement): Promise<void> {
  for (let pass = 0; pass < 3; pass++) {
    await element.updateComplete;
    for (const child of element.shadowRoot?.querySelectorAll("*") ?? []) {
      if (child instanceof LitElement) await child.updateComplete;
    }
  }
}
async function mount(): Promise<SettingsDialog> {
  const dialog = new SettingsDialog();
  dialog.machine = remote;
  dialog.machines = [remote, secondRemoteMachine];
  dialog.onNavigate = (section) => { dialog.section = section; };
  dialog.onClose = vi.fn();
  document.body.append(dialog);
  await settle(dialog);
  return dialog;
}
async function language(dialog: SettingsDialog, language: string): Promise<void> {
  await localization.setPreferences({ language, formatLocale: "ar-EG" });
  await settle(dialog);
}
function general(dialog: SettingsDialog): SettingsGeneralPanel {
  return required(dialog.shadowRoot?.querySelector<SettingsGeneralPanel>("settings-general-panel"));
}
function switchRequest(dialog: SettingsDialog): HTMLSelectElement {
  const select = required(dialog.shadowRoot?.querySelector<HTMLSelectElement>("#settings-machine"));
  select.value = secondRemoteMachine.id;
  select.dispatchEvent(new Event("change"));
  return select;
}

it("keeps draft controls, focus, disclosure and machine-switch confirmation live without reloading", async () => {
  releases.push(localization.registerCatalog({ id: "settings-dialog-test", namespace: "core.settingsDialog", locale: "de", load: () => Promise.resolve({ heading: "Einstellungen", keepEditing: "Weiter bearbeiten" }) }));
  const dialog = await mount();
  const panel = general(dialog);
  const draft = required(panel.shadowRoot?.querySelector<HTMLInputElement>('input[placeholder=".pi-web/uploads"]'));
  draft.value = "uncommitted/raw";
  draft.dispatchEvent(new Event("input"));
  await settle(panel);
  const select = switchRequest(dialog);
  await settle(dialog);
  const confirmation = required(dialog.shadowRoot?.querySelector(".machine-switch-confirmation"));
  const keep = required(confirmation.querySelectorAll("button")[1]);
  const details = required(dialog.shadowRoot?.querySelector("details"));
  details.open = true;
  keep.focus();
  const calls = vi.mocked(configApi.config).mock.calls.length;
  for (const locale of ["de", "en-XA", "ar-XB", "en"]) {
    await language(dialog, locale);
    expect(dialog.shadowRoot?.querySelector("h1")?.textContent).toBe(messages.t("heading"));
    expect(dialog.shadowRoot?.querySelector<ModalSurface>("modal-surface")?.label).toBe(messages.t("label"));
    expect(dialog.shadowRoot?.querySelector(".machine-switch-confirmation")).toBe(confirmation);
    expect(confirmation.querySelector("p")?.textContent).toBe(messages.t("switchPrompt", { current: raw, next: secondRemoteMachine.name }));
    expect(keep.textContent).toBe(messages.t("keepEditing"));
    expect(dialog.shadowRoot?.activeElement).toBe(keep);
    expect(details.open).toBe(true);
    expect(select.value).toBe(remote.id);
    expect(general(dialog)).toBe(panel);
    expect(draft.value).toBe("uncommitted/raw");
    expect(panel.targetLabel).toBe(settingsFeedbackTargetLabel(remote));
    expect(dialog.shadowRoot?.querySelector("img")).toBeNull();
  }
  expect(configApi.config).toHaveBeenCalledTimes(calls);
  expect(configApi.updateConfig).not.toHaveBeenCalled();
  keep.click();
  await settle(dialog);
  expect(dialog.shadowRoot?.querySelector(".machine-switch-confirmation")).toBeNull();
  expect(draft.value).toBe("uncommitted/raw");
});

it("retains pending save state and resolves its success and failure in the current language", async () => {
  const dialog = await mount();
  const pending = deferred<ReturnType<typeof configResponse>>();
  vi.mocked(configApi.updateConfig).mockReturnValueOnce(pending.promise);
  const save = general(dialog).onSaveMachineConfig?.({ uploads: { defaultFolder: "new" } });
  await settle(dialog);
  for (const locale of ["en-XA", "ar-XB"]) {
    await language(dialog, locale);
    expect(general(dialog).saving).toBe(true);
    expect(configApi.updateConfig).toHaveBeenCalledExactlyOnceWith({ set: { uploads: { defaultFolder: "new" } }, unset: [] }, remote.id);
  }
  pending.resolve(configResponse({ uploads: { defaultFolder: "new" } }));
  await save;
  await settle(dialog);
  for (const locale of ["en-XA", "ar-XB", "en"]) {
    await language(dialog, locale);
    expect(general(dialog).savedMessage).toBe(messages.t("machineSaved", { name: raw }));
    expect(general(dialog).saving).toBe(false);
  }
  vi.mocked(configApi.updateConfig).mockRejectedValueOnce(new Error(raw));
  await general(dialog).onSaveMachineConfig?.({ uploads: { defaultFolder: "failed" } });
  for (const locale of ["en-XA", "ar-XB", "en"]) {
    await language(dialog, locale);
    expect(general(dialog).machineError).toBe(messages.t("saveAccess", { target: settingsFeedbackTargetLabel(remote), error: raw }));
    expect(general(dialog).savedMessage).toBe("");
  }
});

it("localizes delayed and settled load failures in every settings owner without translating diagnostics", async () => {
  vi.mocked(configApi.config).mockRejectedValue(new Error(raw));
  vi.mocked(pluginsApi.plugins).mockRejectedValue(new Error(raw));
  vi.mocked(piPackagesApi.packages).mockRejectedValue(new Error(raw));
  const dialog = await mount();
  const calls = vi.mocked(configApi.config).mock.calls.length;
  for (const locale of ["en-XA", "ar-XB", "en"]) {
    await language(dialog, locale);
    dialog.section = "general";
    await settle(dialog);
    expect(general(dialog).error).toBe(messages.t("loadGateway", { errors: localization.list([messages.t("configDiagnostic", { error: raw }), messages.t("pluginsDiagnostic", { error: raw })]) }));
    expect(general(dialog).machineError).toBe(messages.t("loadAccess", { target: settingsFeedbackTargetLabel(remote), error: raw }));
    dialog.section = "sessiond";
    await settle(dialog);
    const daemon = required(dialog.shadowRoot?.querySelector<SettingsSessiondPanel>("settings-sessiond-panel"));
    expect(daemon.error).toBe(messages.t("loadSessiond", { target: settingsFeedbackTargetLabel(remote), error: raw }));
    dialog.section = "plugins";
    await settle(dialog);
    expect(required(dialog.shadowRoot?.querySelector<SettingsPluginsPanel>("settings-plugins-panel")).error).toBe(messages.t("loadPluginSettings", { target: settingsFeedbackTargetLabel(remote), errors: localization.list([messages.t("configDiagnostic", { error: raw }), messages.t("pluginsDiagnostic", { error: raw })]) }));
    dialog.section = "packages";
    await settle(dialog);
    expect(required(dialog.shadowRoot?.querySelector<SettingsPackagesPanel>("settings-packages-panel")).error).toBe(messages.t("loadPackages", { target: settingsFeedbackTargetLabel(remote), error: raw }));
  }
  expect(configApi.config).toHaveBeenCalledTimes(calls);
});

it("keeps package-operation follow-up and failures live after completion without repeating mutations", async () => {
  const dialog = await mount();
  dialog.section = "packages";
  await settle(dialog);
  const panel = required(dialog.shadowRoot?.querySelector<SettingsPackagesPanel>("settings-packages-panel"));
  const install = vi.spyOn(piPackagesApi, "install").mockResolvedValue({ action: "install", packages: [] });
  await panel.onInstallPackage?.("npm:raw");
  for (const locale of ["en-XA", "ar-XB", "en"]) {
    await language(dialog, locale);
    expect(panel.operationMessage).toBe(settingsFeedbackPackageFollowUp("install", remote));
    expect(panel.operationMessage).toContain("/reload");
    expect(panel.operationMessage).toContain(raw);
    expect(panel.operation).toBeUndefined();
  }
  expect(install).toHaveBeenCalledExactlyOnceWith("npm:raw", remote.id);
  install.mockRejectedValueOnce(new Error(raw));
  await expect(panel.onInstallPackage?.("npm:failed")).rejects.toThrow(raw);
  for (const locale of ["en-XA", "ar-XB"]) {
    await language(dialog, locale);
    expect(panel.error).toBe(messages.t("packageMutationFailure", { operation: "install", target: settingsFeedbackTargetLabel(remote), error: raw }));
    expect(panel.operationMessage).toBe("");
  }
});
