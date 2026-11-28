// @vitest-environment happy-dom
import { installNativeDialogFake } from "./nativeDialog.testSupport";
installNativeDialogFake();

import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectSettings, ProjectSettingsUpdate } from "../../../shared/apiTypes";
import { ProjectSettingsDialog } from "./ProjectSettingsDialog";
import { requiredElement, settleRenderedDialog } from "./modalSurfaceTestSupport";

const settings: ProjectSettings = {
  project: { id: "p1", name: "App", path: "/srv/billing/app", createdAt: "now", worktreeFolder: "trees" },
  worktreeFolder: { path: "/srv/billing/app/trees", source: "project" },
};

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
});

describe("project settings dialog", () => {
  it("submits trimmed changes while keeping the displayed effective path tied to saved settings", async () => {
    const onSubmit = vi.fn(() => Promise.resolve());
    const dialog = await mountDialog(onSubmit);
    expect(input(dialog, "name").value).toBe("App");
    expect(input(dialog, "worktree-folder").value).toBe("trees");
    expect(submitButton(dialog).disabled).toBe(true);

    await type(dialog, "name", "  Billing  ");
    await type(dialog, "worktree-folder", "  /mnt/new-trees  ");
    expect(dialog.shadowRoot?.textContent).toContain(settings.worktreeFolder.path);
    submitButton(dialog).click();
    await settleRenderedDialog(dialog);

    expect(onSubmit).toHaveBeenCalledExactlyOnceWith({ set: { name: "Billing", worktreeFolder: "/mnt/new-trees" } });
  });

  it("unsets a blank override without changing the display name", async () => {
    const onSubmit = vi.fn(() => Promise.resolve());
    const dialog = await mountDialog(onSubmit);
    await type(dialog, "worktree-folder", " ");
    submitButton(dialog).click();
    await settleRenderedDialog(dialog);

    expect(onSubmit).toHaveBeenCalledExactlyOnceWith({ unset: ["/worktreeFolder"] });
  });

  it("locks an enforced folder without touching the saved override when renaming", async () => {
    const onSubmit = vi.fn(() => Promise.resolve());
    const enforcedBy = "PI_WEB_DEFAULT_WORKTREE_FOLDER";
    const path = "/enforced/app";
    const dialog = await mountDialog(onSubmit, () => Promise.resolve({
      ...settings, worktreeFolder: { path, source: "environment", enforcedBy },
    }));
    expect(input(dialog, "worktree-folder").readOnly).toBe(true);
    expect(input(dialog, "worktree-folder").value).toBe("trees");
    expect(dialog.shadowRoot?.textContent).toContain(path);
    expect(dialog.shadowRoot?.textContent).toContain(enforcedBy);
    expect(input(dialog, "name").readOnly).toBe(false);

    await type(dialog, "name", "Billing");
    submitButton(dialog).click();
    await settleRenderedDialog(dialog);
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith({ set: { name: "Billing" } });
  });

  it("keeps edits and allows retry after a save error", async () => {
    const onSubmit = vi.fn<(update: ProjectSettingsUpdate) => Promise<void>>().mockRejectedValueOnce(new Error("Project not found")).mockResolvedValueOnce(undefined);
    const dialog = await mountDialog(onSubmit);
    await type(dialog, "name", " ");
    submitButton(dialog).click();
    await settleRenderedDialog(dialog);

    expect(alert(dialog)?.textContent).toContain("Project not found");
    expect(input(dialog, "name").value).toBe(" ");
    expect(submitButton(dialog).disabled).toBe(false);
    submitButton(dialog).click();
    await settleRenderedDialog(dialog);
    expect(onSubmit.mock.calls).toEqual([[{ set: { name: "" } }], [{ set: { name: "" } }]]);
    expect(alert(dialog)).toBeNull();
  });

  it("prevents edits when settings cannot be loaded and retries the read", async () => {
    const loadSettings = vi.fn<() => Promise<ProjectSettings>>().mockRejectedValueOnce(new Error("Machine unavailable")).mockResolvedValueOnce(settings);
    const dialog = await mountDialog(vi.fn(), loadSettings);

    expect(alert(dialog)?.textContent).toContain("Machine unavailable");
    expect(submitButton(dialog).disabled).toBe(true);
    requiredElement(dialog.shadowRoot?.querySelector<HTMLButtonElement>(".ui-dialog-body button"), "retry button").click();
    await settleRenderedDialog(dialog);

    expect(loadSettings).toHaveBeenCalledTimes(2);
    expect(alert(dialog)).toBeNull();
    expect(input(dialog, "worktree-folder").value).toBe("trees");
  });
});

async function mountDialog(onSubmit: (update: ProjectSettingsUpdate) => Promise<void>, loadSettings = () => Promise.resolve(settings)): Promise<ProjectSettingsDialog> {
  const dialog = new ProjectSettingsDialog();
  dialog.loadSettings = loadSettings;
  dialog.onSubmit = onSubmit;
  document.body.append(dialog);
  await settleRenderedDialog(dialog);
  return dialog;
}

async function type(dialog: ProjectSettingsDialog, field: string, value: string): Promise<void> {
  const control = input(dialog, field);
  control.value = value;
  control.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  await settleRenderedDialog(dialog);
}

function input(dialog: ProjectSettingsDialog, field: string): HTMLInputElement {
  return requiredElement(dialog.shadowRoot?.querySelector<HTMLInputElement>(`input[name='${field}']`), field);
}

function submitButton(dialog: ProjectSettingsDialog): HTMLButtonElement {
  return requiredElement(dialog.shadowRoot?.querySelector<HTMLButtonElement>("button[type='submit']"), "save button");
}

function alert(dialog: ProjectSettingsDialog): Element | null | undefined {
  return dialog.shadowRoot?.querySelector("[role='alert']");
}
