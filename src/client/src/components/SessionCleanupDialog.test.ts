// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { deepActiveElement, dialogSection, dialogSurface, pressKey, requiredElement, settleRenderedDialog, surfaceBackdrop } from "./modalSurfaceTestSupport";
import { SessionCleanupDialog } from "./SessionCleanupDialog";

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
