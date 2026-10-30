// @vitest-environment happy-dom
import { installNativeDialogFake } from "./nativeDialog.testSupport";
installNativeDialogFake();

import { afterEach, describe, expect, it, vi } from "vitest";
import { deepActiveElement, dialogSection, dialogSurface, pressKey, requiredElement, settleRenderedDialog, surfaceBackdrop } from "./modalSurfaceTestSupport";
import { SessionCleanupDialog } from "./SessionCleanupDialog";
import type { SessionCleanupRequest } from "../api";

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
});

describe("session-cleanup-dialog modal surface", () => {
  it("moves focus into the labelled dialog when opened", async () => {
    const dialog = await mountDialog();

    expect(deepActiveElement()).toBe(dialogSection(dialog));
    expect(dialogSection(dialog).getAttribute("aria-label")).toBe("Clean up sessions");
  });

  it("shows completion feedback outside the scrolling body in a live region", async () => {
    const dialog = await mountDialog();
    const status = requiredElement(dialog.shadowRoot?.querySelector('[role="status"]'), "cleanup status");
    expect(status.textContent.trim()).toBe("");

    dialog.result = {
      generatedAt: "2026-10-21T12:00:00Z",
      thresholds: { archiveIdleDays: 30, deleteArchivedDays: 90 },
      projects: [],
      totals: { archiveCount: 1, deleteCount: 2 },
      archivedSessionIds: ["archived"],
      deletedSessionIds: ["deleted-1", "deleted-2"],
    };
    await dialog.updateComplete;

    expect(status.textContent).toContain("Cleanup complete");
    expect(status.textContent).toContain("Archived 1 session; permanently deleted 2 archived sessions.");
    expect(status.closest(".body")).toBeNull();
    expect(status.nextElementSibling?.tagName).toBe("FOOTER");
    expect(status.getAttribute("aria-atomic")).toBe("true");
    expect(dialog.shadowRoot?.querySelectorAll("footer button")).toHaveLength(1);
    expect(dialog.shadowRoot?.querySelector("fieldset, .preview, footer .danger")).toBeNull();
  });

  it("separates rules from review, preserves edits on Back, and reviews only successful previews", async () => {
    const dialog = await mountDialog();
    const onPreview = vi.fn<(request: SessionCleanupRequest) => void>();
    dialog.onPreview = onPreview;
    expect(dialog.shadowRoot?.querySelector("footer .danger")).toBeNull();
    requiredElement(dialog.shadowRoot?.querySelector<HTMLButtonElement>("footer button:nth-child(2)"), "preview button").click();
    expect(onPreview).toHaveBeenCalledWith({ archiveIdleDays: 30, deleteArchivedDays: null, skipPinned: true });
    dialog.loading = true;
    await dialog.updateComplete;
    expect(dialog.shadowRoot?.querySelector("fieldset")).not.toBeNull();
    dialog.previewRequest = { archiveIdleDays: 30, skipPinned: true };
    dialog.preview = { generatedAt: "2026-10-21T12:00:00Z", thresholds: { archiveIdleDays: 30 }, projects: [{ cwd: "/repo", archiveCount: 2, deleteCount: 0 }], totals: { archiveCount: 2, deleteCount: 0 } };
    dialog.loading = false;
    await dialog.updateComplete;
    expect(dialog.shadowRoot?.querySelector("fieldset")).toBeNull();
    expect(requiredElement(dialog.shadowRoot?.querySelector<HTMLButtonElement>("footer .danger"), "run button").disabled).toBe(false);
    expect(deepActiveElement()).toBe(dialog.shadowRoot?.querySelector("#step-heading"));
    requiredElement(dialog.shadowRoot?.querySelector<HTMLButtonElement>("footer button:first-child"), "back button").click();
    await dialog.updateComplete;
    expect(dialog.shadowRoot?.querySelector(".preview, footer .danger")).toBeNull();
    const days = requiredElement(dialog.shadowRoot?.querySelector<HTMLInputElement>(".days"), "archive days");
    expect(days.value).toBe("30");
    days.value = "14";
    days.dispatchEvent(new InputEvent("input", { bubbles: true }));
    requiredElement(dialog.shadowRoot?.querySelector<HTMLInputElement>("#skip-pinned"), "skip pinned checkbox").click();
    await dialog.updateComplete;
    requiredElement(dialog.shadowRoot?.querySelector<HTMLButtonElement>("footer button:nth-child(2)"), "preview button").click();
    expect(onPreview).toHaveBeenLastCalledWith({ archiveIdleDays: 14, deleteArchivedDays: null, skipPinned: false });
    dialog.error = "Preview failed";
    await dialog.updateComplete;
    expect(dialog.shadowRoot?.querySelector(".preview, footer .danger")).toBeNull();
    expect(requiredElement(dialog.shadowRoot?.querySelector<HTMLInputElement>(".days"), "archive days").value).toBe("14");
    dialog.preview = { ...dialog.preview, totals: { archiveCount: 0, deleteCount: 0 }, projects: [] };
    await dialog.updateComplete;
    expect(requiredElement(dialog.shadowRoot?.querySelector<HTMLButtonElement>("footer .danger"), "run button").disabled).toBe(true);
    dialog.running = true;
    await dialog.updateComplete;
    expect(requiredElement(dialog.shadowRoot?.querySelector<HTMLButtonElement>("footer button:first-child"), "back button").disabled).toBe(true);
  });

  it("closes on Escape", async () => {
    const onClose = vi.fn<() => void>();
    const dialog = await mountDialog({ onClose });

    pressKey(dialogSurface(dialog), "Escape");

    expect(onClose).toHaveBeenCalledOnce();
  });

  it("closes when the backdrop itself is pressed", async () => {
    const onClose = vi.fn<() => void>();
    const dialog = await mountDialog({ onClose });

    surfaceBackdrop(dialog).dispatchEvent(new MouseEvent("mousedown", { bubbles: true, composed: true }));

    expect(onClose).toHaveBeenCalledOnce();
  });

  it("moves focus from the dialog section to the first dialog control on Tab", async () => {
    const dialog = await mountDialog();
    const closeButton = requiredElement(dialog.shadowRoot?.querySelector<HTMLButtonElement>("header .close-button"), "cleanup close button");
    expect(deepActiveElement()).toBe(dialogSection(dialog));

    pressKey(dialogSurface(dialog), "Tab");

    expect(deepActiveElement()).toBe(closeButton);
  });
});

interface SessionCleanupDialogCallbacks {
  onClose?: () => void;
}

async function mountDialog(callbacks: SessionCleanupDialogCallbacks = {}): Promise<SessionCleanupDialog> {
  const dialog = new SessionCleanupDialog();
  Object.assign(dialog, callbacks);
  document.body.append(dialog);
  await settleRenderedDialog(dialog);
  return dialog;
}
