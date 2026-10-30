// @vitest-environment happy-dom
import { installNativeDialogFake } from "./nativeDialog.testSupport";
installNativeDialogFake();
import { installPopoverFake } from "./anchoredPopup.testSupport";
installPopoverFake();

import { afterEach, expect, it, vi } from "vitest";
import { localization } from "../localization/browser";
import { machineMessages as messages } from "../machineMessages";
import { MachineDialog, machineBaseUrlValidationMessage } from "./MachineDialog";
import { MachineList } from "./MachineList";
import { MachineSwitcher } from "./MachineSwitcher";
import { deepActiveElement, requiredElement, settleRenderedDialog } from "./modalSurfaceTestSupport";
import type { Machine } from "../api";

let release: (() => void) | undefined;
afterEach(async () => {
  document.body.replaceChildren();
  release?.();
  release = undefined;
  await localization.setPreferences({ language: "en", formatLocale: "en" });
  localStorage.clear();
  vi.restoreAllMocks();
});
const remote: Machine = { id: "remote", kind: "remote", name: "User <b>machine</b>", baseUrl: "https://remote.test/prefix", createdAt: "", updatedAt: "", status: "offline" };
const local: Machine = { id: "local", kind: "local", name: "Local user name", createdAt: "", updatedAt: "" };

it("updates dialog labels and validation while preserving edits, focus and submission values", async () => {
  release = localization.registerCatalog({ id: "machines-test", namespace: "core.machines", locale: "de", load: () => Promise.resolve({
    addTitle: "Rechner hinzufügen", urlCredentials: "Keine Zugangsdaten in der URL.", nameLabel: "Lokaler Name (optional)",
  }) });
  const dialog = new MachineDialog();
  const submit = vi.fn();
  dialog.onSubmit = submit;
  dialog.error = "Unchanged remote error";
  document.body.append(dialog);
  await settleRenderedDialog(dialog);
  const url = requiredElement(dialog.shadowRoot?.querySelector<HTMLInputElement>("input[name='baseUrl']"), "URL");
  url.value = "https://user@remote.test";
  url.dispatchEvent(new Event("input"));
  await settleRenderedDialog(dialog);
  url.focus();
  await localization.setPreferences({ language: "de", formatLocale: "de-DE" });
  await settleRenderedDialog(dialog);
  expect(deepActiveElement()).toBe(url);
  expect(url.value).toBe("https://user@remote.test");
  expect(dialog.shadowRoot?.querySelector(".ui-dialog-title")?.textContent).toBe("Rechner hinzufügen");
  expect(dialog.shadowRoot?.querySelector("#machine-url-help")?.textContent).toBe("Keine Zugangsdaten in der URL.");
  expect(machineBaseUrlValidationMessage(url.value)).toBe("Keine Zugangsdaten in der URL.");
  url.value = remote.baseUrl ?? "";
  url.dispatchEvent(new Event("input"));
  await settleRenderedDialog(dialog);
  const name = requiredElement(dialog.shadowRoot?.querySelector<HTMLInputElement>("input[name='name']"), "name");
  const token = requiredElement(dialog.shadowRoot?.querySelector<HTMLInputElement>("input[name='token']"), "token");
  name.value = "Unchanged alias";
  name.dispatchEvent(new Event("input"));
  token.value = "secret-token";
  token.dispatchEvent(new Event("input"));
  token.focus();
  for (const language of ["en-XA", "ar-XB"]) {
    await localization.setPreferences({ language, formatLocale: "de-DE" });
    await settleRenderedDialog(dialog);
    expect(deepActiveElement()).toBe(token);
    expect(name.value).toBe("Unchanged alias");
    expect(token.value).toBe("secret-token");
    expect(url.dir).toBe("ltr");
    expect(token.dir).toBe("ltr");
    expect(dialog.shadowRoot?.querySelector("#machine-error")?.textContent).toBe("Unchanged remote error");
    expect(dialog.shadowRoot?.querySelector(".ui-dialog-title")?.textContent).toBe(messages.t("addTitle"));
    expect(submit).not.toHaveBeenCalled();
  }
  dialog.shadowRoot?.querySelector("form")?.dispatchEvent(new Event("submit", { cancelable: true }));
  expect(submit).toHaveBeenCalledWith({ baseUrl: remote.baseUrl, name: "Unchanged alias", token: "secret-token" });
});

it("updates machine menus, statuses, accessible labels and counts without changing names or triggering actions", async () => {
  release = localization.registerCatalog({ id: "machines-test", namespace: "core.machines", locale: "de", load: () => Promise.resolve({
    machines: "Rechner", offline: "getrennt", subtitle: "{status}: {location}", actionsFor: "Aktionen: {name}", edit: "Name bearbeiten",
  }) });
  const list = new MachineList();
  const switcher = new MachineSwitcher();
  const onSelect = vi.fn();
  const onEdit = vi.fn();
  for (const element of [list, switcher]) {
    element.machines = [local, remote];
    element.selected = remote;
    element.onSelect = onSelect;
    element.onEdit = onEdit;
    document.body.append(element);
    await element.updateComplete;
  }
  list.collapsible = true;
  await list.updateComplete;
  requiredElement(list.shadowRoot?.querySelector<HTMLButtonElement>(`[data-machine-id="${remote.id}"] .action-menu-toggle`), "remote list actions").click();
  requiredElement(switcher.shadowRoot?.querySelector<HTMLButtonElement>(".machine-switcher-button"), "switcher").click();
  await Promise.all([list.updateComplete, switcher.updateComplete]);
  requiredElement(switcher.shadowRoot?.querySelector<HTMLButtonElement>(".machine-option-actions-toggle"), "switcher actions").click();
  await switcher.updateComplete;
  for (const language of ["de", "en-XA", "ar-XB"]) {
    await localization.setPreferences({ language, formatLocale: "ar-EG" });
    await Promise.all([list.updateComplete, switcher.updateComplete]);
    expect(list.shadowRoot?.textContent).toContain(messages.t("machines"));
    expect(list.shadowRoot?.querySelector(".section-count")?.textContent).toBe(localization.number(2));
    for (const element of [list, switcher]) {
      expect(element.shadowRoot?.textContent).toContain(remote.name);
      expect(element.shadowRoot?.querySelector("b")).toBeNull();
      expect(element.shadowRoot?.textContent).toContain(messages.t("offline"));
      const namedControl = element === list
        ? element.shadowRoot?.querySelector(`[data-machine-id="${remote.id}"] .action-menu-toggle`)
        : element.shadowRoot?.querySelector(".machine-switcher-button");
      expect(namedControl?.getAttribute("aria-label")).toContain(remote.name);
    }
    expect(switcher.shadowRoot?.querySelector(".machine-option-actions-panel")?.textContent).toContain(messages.t("edit"));
    expect(onSelect).not.toHaveBeenCalled();
    expect(onEdit).not.toHaveBeenCalled();
  }
  requiredElement(switcher.shadowRoot?.querySelector<HTMLButtonElement>(".machine-option-actions-panel button"), "edit action").click();
  expect(onEdit).toHaveBeenCalledWith(remote);
});

it("releases all machine component subscriptions on disconnect and refreshes on reconnect", async () => {
  for (const element of [new MachineDialog(), new MachineList(), new MachineSwitcher()]) {
    await localization.setPreferences({ language: "en", formatLocale: "en" });
    document.body.append(element);
    await element.updateComplete;
    element.remove();
    await element.updateComplete;
    const update = vi.spyOn(element, "requestUpdate");
    await localization.setPreferences({ language: "ar-XB", formatLocale: "en" });
    expect(update).not.toHaveBeenCalled();
    document.body.append(element);
    await element.updateComplete;
    expect(update).toHaveBeenCalled();
    element.remove();
  }
});
