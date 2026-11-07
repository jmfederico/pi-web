// @vitest-environment happy-dom

import { afterEach, expect, it } from "vitest";
import { localization } from "../localization/browser";
import { ConfirmationDialog, type ConfirmationRequest } from "./ConfirmationDialog";
import { deepActiveElement, dialogSection, dialogSurface, pressKey, requiredElement, settleRenderedDialog, surfaceBackdrop } from "./modalSurfaceTestSupport";
import { installNativeDialogFake } from "./nativeDialog.testSupport";

installNativeDialogFake();

afterEach(async () => {
  document.body.replaceChildren();
  await localization.setPreferences({ language: "en", formatLocale: "en" });
  localStorage.clear();
});

const prompt: ConfirmationRequest = {
  title: "Remove item?", message: "This cannot be undone.", confirmLabel: "Remove", cancelLabel: "Keep",
};

async function mount(): Promise<ConfirmationDialog> {
  const dialog = new ConfirmationDialog();
  document.body.append(dialog);
  await dialog.updateComplete;
  return dialog;
}

function button(dialog: ConfirmationDialog, action: "confirm" | "cancel"): HTMLButtonElement {
  return requiredElement(dialog.shadowRoot?.querySelector<HTMLButtonElement>(`#confirmation-${action}`), action);
}

it("renders only while pending, focuses Cancel, and confirms once despite duplicate clicks", async () => {
  const dialog = await mount();
  expect(dialog.shadowRoot?.querySelector("modal-surface")).toBeNull();
  const result = dialog.request(prompt);
  await settleRenderedDialog(dialog);
  expect(deepActiveElement()).toBe(button(dialog, "cancel"));
  expect(dialogSection(dialog).getAttribute("aria-label")).toBe(prompt.title);

  const confirm = button(dialog, "confirm");
  confirm.click();
  confirm.click();
  button(dialog, "cancel").click();
  await expect(result).resolves.toBe(true);
  await dialog.updateComplete;
  expect(dialog.shadowRoot?.querySelector("modal-surface")).toBeNull();
});

it.each(["button", "Escape", "backdrop", "native cancel"])("resolves false on %s dismissal", async (dismissal) => {
  const dialog = await mount();
  const result = dialog.request(prompt);
  await settleRenderedDialog(dialog);
  if (dismissal === "button") button(dialog, "cancel").click();
  else if (dismissal === "Escape") pressKey(dialogSurface(dialog), "Escape");
  else if (dismissal === "backdrop") surfaceBackdrop(dialog).dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  else dialogSection(dialog).dispatchEvent(new Event("cancel", { cancelable: true }));
  await expect(result).resolves.toBe(false);
  await dialog.updateComplete;
  expect(dialog.shadowRoot?.querySelector("modal-surface")).toBeNull();
});

it("cancels on disconnect without reviving the prompt on reconnect", async () => {
  const dialog = await mount();
  const result = dialog.request(prompt);
  await settleRenderedDialog(dialog);
  dialog.remove();
  await expect(result).resolves.toBe(false);
  document.body.append(dialog);
  await dialog.updateComplete;
  expect(dialog.shadowRoot?.querySelector("modal-surface")).toBeNull();
  const next = dialog.request(prompt);
  await settleRenderedDialog(dialog);
  button(dialog, "confirm").click();
  await expect(next).resolves.toBe(true);
});

it("cancels a replaced request, ignores its stale controls, and resets focus to Cancel", async () => {
  const dialog = await mount();
  const first = dialog.request(prompt);
  await settleRenderedDialog(dialog);
  const oldConfirm = button(dialog, "confirm");
  oldConfirm.focus();
  const second = dialog.request({ ...prompt, title: "Replace item?" });
  // The previous render can still receive clicks before Lit updates.
  oldConfirm.click();
  await expect(first).resolves.toBe(false);
  await settleRenderedDialog(dialog);
  expect(dialogSection(dialog).getAttribute("aria-label")).toBe("Replace item?");
  expect(deepActiveElement()).toBe(button(dialog, "cancel"));
  button(dialog, "cancel").click();
  await expect(second).resolves.toBe(false);
});

it("reevaluates caller-owned lazy text on locale changes without replacing the pending prompt", async () => {
  const dialog = await mount();
  const label = (field: string) => () => `${localization.language}: ${field} <b>literal</b>`;
  const result = dialog.request({ title: label("title"), message: label("message"), confirmLabel: label("confirm"), cancelLabel: label("cancel") });
  await settleRenderedDialog(dialog);
  const confirm = button(dialog, "confirm");
  confirm.focus();
  await localization.setPreferences({ language: "en-XA", formatLocale: "en" });
  await settleRenderedDialog(dialog);
  expect(dialogSection(dialog).getAttribute("aria-label")).toBe(label("title")());
  expect(dialog.shadowRoot?.querySelector(".ui-dialog-body")?.textContent).toBe(label("message")());
  expect(confirm.textContent).toBe(label("confirm")());
  expect(button(dialog, "cancel").textContent).toBe(label("cancel")());
  expect(dialog.shadowRoot?.querySelector("b")).toBeNull();
  expect(deepActiveElement()).toBe(confirm);
  confirm.click();
  await expect(result).resolves.toBe(true);
});
