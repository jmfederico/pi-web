// @vitest-environment happy-dom
import { installNativeDialogFake } from "./nativeDialog.testSupport";
installNativeDialogFake();

import { afterEach, expect, it, vi } from "vitest";
import { configApi, piPackagesApi, pluginsApi, type PiWebConfigResponse } from "../api";
import * as themeCatalog from "../themeCatalog";
import { SettingsDialog } from "./SettingsDialog";
import type { SettingsGeneralPanel } from "./settings/SettingsGeneralPanel";
import type { ConfirmationDialog } from "./ConfirmationDialog";
import { configResponse, pluginsResponse, remoteMachine } from "./SettingsDialog.testSupport";

const blocked = { mode: "restricted" as const, hosts: ["other.example.test"] };

async function mount(snapshot: PiWebConfigResponse = configResponse({ hostAccess: { mode: "any" } })) {
  vi.spyOn(configApi, "config").mockResolvedValue(snapshot);
  vi.spyOn(pluginsApi, "plugins").mockResolvedValue(pluginsResponse([]));
  vi.spyOn(piPackagesApi, "packages").mockResolvedValue({ packages: [] });
  vi.spyOn(themeCatalog, "loadThemeCatalog").mockResolvedValue({ themes: [], themePairs: [] });
  const save = vi.spyOn(configApi, "updateConfig").mockResolvedValue(configResponse({ hostAccess: blocked }));
  const dialog = new SettingsDialog();
  dialog.currentHostname = "pi.example.test";
  dialog.machine = remoteMachine;
  document.body.append(dialog);
  await vi.waitFor(() => { expect(panel(dialog).shadowRoot?.querySelector("#host-access")).not.toBeNull(); });
  return { dialog, save };
}

function panel(dialog: SettingsDialog): SettingsGeneralPanel {
  return required(dialog.shadowRoot?.querySelector<SettingsGeneralPanel>("settings-general-panel"));
}
function confirmation(dialog: SettingsDialog): ConfirmationDialog {
  return required(dialog.shadowRoot?.querySelector<ConfirmationDialog>("confirmation-dialog"));
}
function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error("Missing rendered control");
  return value;
}
async function editPolicy(dialog: SettingsDialog, hosts = "other.example.test") {
  const general = panel(dialog);
  const select = required(general.shadowRoot?.querySelector<HTMLSelectElement>("#host-access"));
  select.value = "restricted";
  select.dispatchEvent(new Event("change", { bubbles: true }));
  await general.updateComplete;
  const list = required(general.shadowRoot?.querySelector<HTMLTextAreaElement>("#host-access-list"));
  list.value = hosts;
  list.dispatchEvent(new Event("input", { bubbles: true }));
  await general.updateComplete;
}
function submit(dialog: SettingsDialog) {
  required(panel(dialog).shadowRoot?.querySelector("form")).dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
}
async function waitForPrompt(dialog: SettingsDialog) {
  await vi.waitFor(() => { expect(confirmation(dialog).shadowRoot?.querySelector("#confirmation-cancel")).not.toBeNull(); });
}
function choose(dialog: SettingsDialog, answer: "cancel" | "confirm") {
  required(confirmation(dialog).shadowRoot?.querySelector<HTMLButtonElement>(`#confirmation-${answer}`)).click();
}

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });

it("requires explicit confirmation for the gateway hostname, preserves a cancelled draft, and saves the unchanged policy once", async () => {
  const { dialog, save } = await mount();
  await editPolicy(dialog);
  submit(dialog);
  await waitForPrompt(dialog);
  expect(confirmation(dialog).shadowRoot?.textContent).toContain("pi.example.test");
  expect(save).not.toHaveBeenCalled();
  choose(dialog, "cancel");
  await vi.waitFor(() => { expect(required(panel(dialog).shadowRoot?.querySelector<HTMLButtonElement>('form button[type="submit"], form button.primary')).disabled).toBe(false); });
  expect(required(panel(dialog).shadowRoot?.querySelector<HTMLTextAreaElement>("#host-access-list")).value).toBe("other.example.test");
  expect(save).not.toHaveBeenCalled();
  submit(dialog);
  await waitForPrompt(dialog);
  choose(dialog, "confirm");
  choose(dialog, "confirm");
  await vi.waitFor(() => { expect(save).toHaveBeenCalledExactlyOnceWith({ set: { hostAccess: blocked }, unset: [] }); });
});

it("saves an allowed hostname normally without confirmation", async () => {
  const { dialog, save } = await mount();
  await editPolicy(dialog, ".example.test");
  submit(dialog);
  await vi.waitFor(() => { expect(save).toHaveBeenCalledOnce(); });
  expect(confirmation(dialog).shadowRoot?.querySelector("modal-surface")).toBeNull();
});

it("also confirms a reset that would reveal a blocking inherited policy", async () => {
  const { dialog, save } = await mount({ ...configResponse({ hostAccess: { mode: "any" } }), defaultsConfig: { hostAccess: blocked } });
  required(panel(dialog).shadowRoot?.querySelector<HTMLButtonElement>('button[aria-label="Reset saved override for /hostAccess"]')).click();
  await waitForPrompt(dialog);
  expect(save).not.toHaveBeenCalled();
  choose(dialog, "confirm");
  await vi.waitFor(() => { expect(save).toHaveBeenCalledExactlyOnceWith({ unset: ["/hostAccess"] }); });
});

it("does not warn for unchanged enforced policy when another gateway field is saved", async () => {
  const { dialog, save } = await mount({ ...configResponse({ hostAccess: { mode: "any" } }), effectiveConfig: { hostAccess: blocked }, enforcedSettings: { "/hostAccess": "PI_WEB_HOST_ACCESS" } });
  const port = required(panel(dialog).shadowRoot?.querySelector<HTMLInputElement>('input[inputmode="numeric"]'));
  port.value = "9000";
  port.dispatchEvent(new Event("input", { bubbles: true }));
  submit(dialog);
  await vi.waitFor(() => { expect(save).toHaveBeenCalledExactlyOnceWith({ set: { port: 9000 }, unset: [] }); });
  expect(confirmation(dialog).shadowRoot?.querySelector("modal-surface")).toBeNull();
});

it("closing Settings cancels a pending approval without writing", async () => {
  const { dialog, save } = await mount();
  await editPolicy(dialog);
  submit(dialog);
  await waitForPrompt(dialog);
  dialog.remove();
  await dialog.updateComplete;
  expect(save).not.toHaveBeenCalled();
});

it("does not apply approval to a refreshed configuration snapshot", async () => {
  const { dialog, save } = await mount();
  await editPolicy(dialog);
  submit(dialog);
  await waitForPrompt(dialog);
  vi.mocked(configApi.config).mockResolvedValue(configResponse({ port: 9000, hostAccess: { mode: "any" } }));
  await dialog.reloadGatewayConfig();
  choose(dialog, "confirm");
  await dialog.updateComplete;
  expect(save).not.toHaveBeenCalled();
});

it("uses existing Settings error reporting when an approved save fails", async () => {
  const { dialog, save } = await mount();
  save.mockRejectedValue(new Error("Read-only configuration"));
  await editPolicy(dialog);
  submit(dialog);
  await waitForPrompt(dialog);
  choose(dialog, "confirm");
  await vi.waitFor(() => { expect(panel(dialog).error).toContain("Read-only configuration"); });
  expect(save).toHaveBeenCalledOnce();
});
