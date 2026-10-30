// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { localization } from "../../localization/browser";
import type { PiWebConfigResponse } from "../../api";
import { SettingsGeneralPanel } from "./SettingsGeneralPanel";
import { generalMessages as messages } from "./settingsGeneralMessages";

const releases: (() => void)[] = [];
afterEach(async () => {
  document.body.replaceChildren();
  releases.splice(0).forEach((release) => { release(); });
  await localization.setPreferences({ language: "en", formatLocale: "en" });
  localStorage.clear();
});
function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error("Expected General settings control");
  return value;
}
const config: PiWebConfigResponse = {
  path: "/raw/<img>/config.json", exists: true, config: { port: 8504 },
  effectiveConfig: { port: 8504, allowedHosts: ["a.local", "b.local", "c.local"], pathAccess: { allowedPaths: ["/a", "/b", "/c"] } },
  envOverrides: { host: false, port: false, allowedHosts: true, spawnSessions: false, subsessions: false, sessionMessages: false, askUser: false },
};
async function settle(panel: SettingsGeneralPanel): Promise<void> {
  await panel.updateComplete;
  await panel.renderRoot.querySelector("settings-panel-frame")?.updateComplete;
}
async function mount(): Promise<SettingsGeneralPanel> {
  const panel = new SettingsGeneralPanel();
  panel.configResponse = config;
  panel.machineConfigResponse = config;
  panel.targetId = "raw-machine";
  panel.targetLabel = "Raw <img> العربية";
  panel.onReload = vi.fn();
  panel.onReloadMachine = vi.fn();
  panel.onSave = vi.fn();
  panel.onSaveMachineConfig = vi.fn();
  panel.onSetQuietMode = vi.fn();
  document.body.append(panel);
  await settle(panel);
  return panel;
}
function edit(panel: SettingsGeneralPanel, selector: string, value: string): HTMLInputElement | HTMLTextAreaElement {
  const field = required(panel.renderRoot.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector));
  field.value = value;
  field.dispatchEvent(new Event("input", { bubbles: true }));
  return field;
}
function submit(panel: SettingsGeneralPanel, index: number): void {
  required(panel.renderRoot.querySelectorAll("form")[index]).dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
}
function notice(panel: SettingsGeneralPanel): string {
  return panel.renderRoot.querySelector("settings-panel-frame")?.shadowRoot?.querySelector(".notice-content")?.textContent ?? "";
}
async function language(panel: SettingsGeneralPanel, language: string): Promise<void> {
  await localization.setPreferences({ language, formatLocale: "ar-EG" });
  await settle(panel);
}

it("updates the entire General panel without resetting draft controls, focus or invoking actions", async () => {
  releases.push(localization.registerCatalog({ id: "general-test", namespace: "core.settingsGeneral", locale: "de", load: () => Promise.resolve({ heading: "Allgemein", machine: "Maschine", host: "Adresse", refresh: "Aktualisieren" }) }));
  const panel = await mount();
  const host = edit(panel, 'form input[placeholder="127.0.0.1"]', "draft.local");
  const name = edit(panel, 'input[name="installationName"]', "Draft <img>");
  const roots = edit(panel, 'textarea[placeholder^="~/SDKs"]', "~/Draft");
  const checkbox = required(panel.renderRoot.querySelector<HTMLInputElement>("#quiet-mode"));
  host.focus();
  for (const locale of ["de", "en-XA", "ar-XB"]) {
    await language(panel, locale);
    expect(panel.renderRoot.querySelector('input[placeholder="127.0.0.1"]')).toBe(host);
    expect(panel.shadowRoot?.activeElement).toBe(host);
    expect(host.value).toBe("draft.local");
    expect(name.value).toBe("Draft <img>");
    expect(roots.value).toBe("~/Draft");
    expect(panel.hasUnsavedMachineChanges).toBe(true);
    expect(panel.renderRoot.querySelector("#quiet-mode")).toBe(checkbox);
    expect(panel.renderRoot.querySelector("settings-panel-frame")?.heading).toBe(messages.t("heading"));
    expect(panel.renderRoot.querySelector("settings-panel-frame")?.actionLabel).toBe(messages.t("refresh"));
    expect(panel.renderRoot.querySelector("form")?.closest("section")?.getAttribute("aria-label")).toBe(messages.t("gatewayAria"));
    expect(panel.renderRoot.textContent).toContain("PI_WEB_ALLOWED_HOSTS");
    expect(panel.renderRoot.textContent).toContain(localization.number(8504));
    expect(panel.renderRoot.textContent).toContain(localization.list(["a.local", "b.local", "c.local"]));
    expect(panel.renderRoot.textContent).toContain(localization.list(["/a", "/b", "/c"]));
    expect(panel.renderRoot.querySelector("code")?.textContent).toBe(config.path);
    expect(panel.renderRoot.textContent).toContain(panel.targetLabel);
    expect(panel.renderRoot.querySelector("img")).toBeNull();
    for (const callback of [panel.onSave, panel.onSaveMachineConfig, panel.onReload, panel.onReloadMachine, panel.onSetQuietMode]) expect(callback).not.toHaveBeenCalled();
  }
  // A display label may change with language or a rename; identity owns draft lifetime.
  panel.targetLabel = "Translated target";
  await settle(panel);
  expect(name.value).toBe("Draft <img>");
  submit(panel, 1);
  await settle(panel);
  expect(panel.onSaveMachineConfig).toHaveBeenCalledExactlyOnceWith({ installationName: "Draft <img>", pathAccess: { allowedPaths: ["~/Draft"] } });
});

it.each([
  [0, 'input[inputmode="numeric"]', "65536", () => messages.t("invalidPort", { min: 1, max: 65535 })],
  [1, 'textarea[placeholder^="~/SDKs"]', "relative/<img>", () => messages.t("externalPath", { value: "relative/<img>" })],
  [1, 'input[placeholder=".pi-web/uploads"]', "/absolute", () => messages.t("folderRelative", { field: "upload" })],
  [1, 'input[placeholder=".pi-web/uploads"]', "../escape", () => messages.t("folderTraversal", { field: "upload" })],
  [1, 'input[placeholder=".pi-web/attachments"]', "/absolute", () => messages.t("folderRelative", { field: "attachment" })],
  [1, 'input[placeholder=".pi-web/attachments"]', "../escape", () => messages.t("folderTraversal", { field: "attachment" })],
] as const)("keeps validation provenance for form %s %s %s live without saving", async (index, selector, value, expected) => {
  const panel = await mount();
  const field = edit(panel, selector, value);
  submit(panel, index);
  await settle(panel);
  for (const locale of ["en", "en-XA", "ar-XB"]) {
    await language(panel, locale);
    expect(index === 0 ? notice(panel) : panel.renderRoot.querySelector('[role="alert"]')?.textContent).toBe(expected());
    expect(field.value).toBe(value);
    expect(panel.renderRoot.querySelector("img")).toBeNull();
  }
  expect(panel.onSave).not.toHaveBeenCalled();
  expect(panel.onSaveMachineConfig).not.toHaveBeenCalled();
});

it("updates loading, unavailable and default summaries while retaining parent-owned notices verbatim", async () => {
  const panel = await mount();
  panel.configResponse = undefined;
  panel.machineConfigResponse = undefined;
  panel.loading = true;
  panel.machineLoading = true;
  panel.error = "Raw <img> gateway error";
  panel.machineError = "Raw machine error";
  panel.savedMessage = "Raw saved message";
  panel.targetLabel = "";
  await language(panel, "ar-XB");
  expect(panel.renderRoot.textContent).toContain(messages.t("loadingGateway"));
  expect(panel.renderRoot.textContent).toContain(messages.t("loadingMachine"));
  expect(panel.renderRoot.querySelector("settings-panel-frame")?.shadowRoot?.textContent).toContain(panel.error);
  expect(panel.renderRoot.querySelector("settings-panel-frame")?.shadowRoot?.textContent).toContain(panel.savedMessage);
  expect(panel.renderRoot.textContent).toContain(panel.machineError);
  expect(panel.renderRoot.textContent).toContain(messages.t("machineHelp", { target: messages.t("selectedMachine") }));
  panel.loading = false;
  panel.machineLoading = false;
  await settle(panel);
  for (const key of ["chatUnavailable", "gatewayUnavailable", "machineUnavailable"] as const) expect(panel.renderRoot.textContent).toContain(messages.t(key));
  panel.configResponse = { ...config, effectiveConfig: { allowedHosts: true } };
  panel.machineConfigResponse = { ...config, effectiveConfig: {} };
  await settle(panel);
  for (const key of ["anyHost", "denied"] as const) expect(panel.renderRoot.textContent).toContain(messages.t(key));
  expect(panel.renderRoot.textContent).toContain(messages.t("defaultValue", { value: "127.0.0.1" }));
  for (const hosts of [[], undefined]) {
    panel.configResponse = { ...config, effectiveConfig: { ...(hosts === undefined ? {} : { allowedHosts: hosts }) } };
    await settle(panel);
    expect(panel.renderRoot.textContent).toContain(messages.t(hosts === undefined ? "unset" : "noHosts"));
  }
});

it("retains pending saves and reconnects without discarding edits or repeating effects", async () => {
  const panel = await mount();
  let resolve: () => void = () => { throw new Error("Save not started"); };
  panel.onSaveMachineConfig = vi.fn(() => new Promise<void>((done) => { resolve = done; }));
  const name = edit(panel, 'input[name="installationName"]', "Submitted");
  submit(panel, 1);
  panel.saving = true;
  await language(panel, "ar-XB");
  expect(panel.renderRoot.textContent).toContain(messages.t("saving"));
  expect(name.value).toBe("Submitted");
  panel.remove();
  await language(panel, "en-XA");
  document.body.append(panel);
  await settle(panel);
  expect(panel.renderRoot.querySelector('input[name="installationName"]')).toBe(name);
  expect(name.value).toBe("Submitted");
  expect(panel.onSaveMachineConfig).toHaveBeenCalledOnce();
  resolve();
  await settle(panel);
});
