// @vitest-environment happy-dom
import { installNativeDialogFake } from "./nativeDialog.testSupport";
installNativeDialogFake();

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Project } from "../api";
import { ProjectRenameDialog } from "./ProjectRenameDialog";
import { deepActiveElement, requiredElement, settleRenderedDialog } from "./modalSurfaceTestSupport";

const project: Project = { id: "p1", name: "app", path: "/srv/billing/app", createdAt: "now" };

afterEach(() => {
  document.body.replaceChildren();
});

describe("project-rename-dialog", () => {
  it("starts from the current name and submits the trimmed new name", async () => {
    const onSubmit = vi.fn(() => Promise.resolve());
    const dialog = await mountDialog(onSubmit);
    const input = nameInput(dialog);
    expect(deepActiveElement()).toBe(input);
    expect(input.value).toBe("app");
    expect(submitButton(dialog).disabled).toBe(true);

    await type(dialog, "  Billing  ");
    submitButton(dialog).click();
    await settleRenderedDialog(dialog);

    expect(onSubmit).toHaveBeenCalledExactlyOnceWith("Billing");
  });

  it("submits a blank name so the folder name is restored", async () => {
    const onSubmit = vi.fn(() => Promise.resolve());
    const dialog = await mountDialog(onSubmit, { ...project, name: "Billing" });
    await type(dialog, " ");
    submitButton(dialog).click();
    await settleRenderedDialog(dialog);

    expect(onSubmit).toHaveBeenCalledExactlyOnceWith("");
  });

  it("stays open with the failure announced and allows a retry", async () => {
    const onSubmit = vi.fn<(name: string) => Promise<void>>().mockRejectedValueOnce(new Error("Project not found")).mockResolvedValueOnce(undefined);
    const dialog = await mountDialog(onSubmit);
    await type(dialog, "Billing");
    submitButton(dialog).click();
    await settleRenderedDialog(dialog);

    const alert = requiredElement(dialog.shadowRoot?.querySelector("[role='alert']"), "rename error");
    expect(alert.textContent).toContain("Project not found");
    expect(dialog.isConnected).toBe(true);
    expect(submitButton(dialog).disabled).toBe(false);

    submitButton(dialog).click();
    await settleRenderedDialog(dialog);
    expect(onSubmit).toHaveBeenCalledTimes(2);
    expect(dialog.shadowRoot?.querySelector("[role='alert']")).toBeNull();
  });
});

async function mountDialog(onSubmit: (name: string) => Promise<void>, value: Project = project): Promise<ProjectRenameDialog> {
  const dialog = new ProjectRenameDialog();
  dialog.project = value;
  dialog.onSubmit = onSubmit;
  document.body.append(dialog);
  await settleRenderedDialog(dialog);
  return dialog;
}

async function type(dialog: ProjectRenameDialog, value: string): Promise<void> {
  const input = nameInput(dialog);
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  await settleRenderedDialog(dialog);
}

function nameInput(dialog: ProjectRenameDialog): HTMLInputElement {
  return requiredElement(dialog.shadowRoot?.querySelector<HTMLInputElement>("input[name='name']"), "project name input");
}

function submitButton(dialog: ProjectRenameDialog): HTMLButtonElement {
  return requiredElement(dialog.shadowRoot?.querySelector<HTMLButtonElement>("button[type='submit']"), "rename submit button");
}
