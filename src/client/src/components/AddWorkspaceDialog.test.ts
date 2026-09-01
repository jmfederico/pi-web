// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import { AddWorkspaceDialog } from "./AddWorkspaceDialog";
import { pressKey, requiredElement, settleRenderedDialog } from "./modalSurfaceTestSupport";

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe("add-workspace-dialog", () => {
  it("opens in the project's parent folder and lists its folders", async () => {
    const dialog = await mountDialog();

    expect(location(dialog).textContent).toBe("/work");
    expect(folderButtons(dialog).map((button) => button.textContent.trim())).toEqual(["../", "proj/", "other/"]);
  });

  it("browses into a folder and back out again", async () => {
    const dialog = await mountDialog();

    folderButtons(dialog)[1]?.click();
    await settleRenderedDialog(dialog);
    expect(location(dialog).textContent).toBe("/work/proj");
    expect(api.projectDirectories).toHaveBeenCalledWith("/work/proj/", "local");

    folderButtons(dialog)[0]?.click();
    await settleRenderedDialog(dialog);
    expect(location(dialog).textContent).toBe("/work");
  });

  it("submits the browsed folder and typed name on Enter", async () => {
    const onSubmit = vi.fn<(parentPath: string, name: string) => void>();
    const dialog = await mountDialog({ onSubmit });
    const input = nameInput(dialog);
    input.value = "My Feature";
    input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    await settleRenderedDialog(dialog);

    pressKey(input, "Enter");

    expect(onSubmit).toHaveBeenCalledWith("/work", "My Feature");
  });

  it("keeps the create button disabled until a name is typed", async () => {
    const dialog = await mountDialog();
    expect(createButton(dialog).disabled).toBe(true);

    const input = nameInput(dialog);
    input.value = "feature";
    input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    await settleRenderedDialog(dialog);

    expect(createButton(dialog).disabled).toBe(false);
  });

  it("shows the browse failure instead of an empty folder list", async () => {
    const dialog = await mountDialog();
    vi.mocked(api.projectDirectories).mockRejectedValue(new Error("permission denied"));

    folderButtons(dialog)[1]?.click();
    await vi.waitFor(() => {
      expect(dialog.shadowRoot?.querySelector(".hint.error")?.textContent).toContain("permission denied");
    });
  });
});

interface AddWorkspaceDialogProps {
  onSubmit?: (parentPath: string, name: string) => void;
}

async function mountDialog(props: AddWorkspaceDialogProps = {}): Promise<AddWorkspaceDialog> {
  vi.spyOn(api, "projectDirectories").mockResolvedValue([
    { path: "/work/proj/", kind: "other" },
    { path: "/work/other/", kind: "other" },
  ]);
  const dialog = new AddWorkspaceDialog();
  dialog.projectPath = "/work/proj";
  if (props.onSubmit !== undefined) dialog.onSubmit = props.onSubmit;
  document.body.append(dialog);
  await settleRenderedDialog(dialog);
  await vi.waitFor(() => { expect(dialog.shadowRoot?.querySelector(".browser button")).not.toBeNull(); });
  await settleRenderedDialog(dialog);
  return dialog;
}

function location(dialog: AddWorkspaceDialog): HTMLElement {
  return requiredElement(dialog.shadowRoot?.querySelector<HTMLElement>("output.location"), "add-workspace-dialog location");
}

function folderButtons(dialog: AddWorkspaceDialog): HTMLButtonElement[] {
  return [...dialog.shadowRoot?.querySelectorAll<HTMLButtonElement>(".browser button") ?? []];
}

function nameInput(dialog: AddWorkspaceDialog): HTMLInputElement {
  return requiredElement(dialog.shadowRoot?.querySelector<HTMLInputElement>("input.name"), "add-workspace-dialog name input");
}

function createButton(dialog: AddWorkspaceDialog): HTMLButtonElement {
  return requiredElement(dialog.shadowRoot?.querySelector<HTMLButtonElement>("button.primary"), "add-workspace-dialog create button");
}
