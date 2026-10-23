// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { installNativeDialogFake } from "./nativeDialog.testSupport";
installNativeDialogFake();
import { canOpenTransientPopup, registerTransientPopup } from "./popupScope";
import { ModalSurface } from "./ModalSurface";

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  document.body.replaceChildren();
  localStorage.clear();
  vi.restoreAllMocks();
});

function owner(parent: HTMLElement | ShadowRoot = document.body): HTMLButtonElement {
  const button = document.createElement("button");
  parent.append(button);
  return button;
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("transient popup modality scope", () => {
  it.each(["hidden", "inert"])("closes when an owner ancestor becomes %s", async (attribute) => {
    const container = document.createElement("div");
    document.body.append(container);
    const trigger = owner(container);
    const close = vi.fn();
    cleanups.push(registerTransientPopup(trigger, close));
    container.setAttribute(attribute, "");
    await vi.waitFor(() => { expect(close).toHaveBeenCalledOnce(); });
    expect(canOpenTransientPopup(trigger)).toBe(false);
  });

  it("closes a background popup when ModalSurface opens and blocks reopening", async () => {
    const trigger = owner();
    const close = vi.fn();
    cleanups.push(registerTransientPopup(trigger, close));
    const surface = new ModalSurface();
    const inside = owner(surface);
    document.body.append(surface);
    await surface.updateComplete;
    // happy-dom reports assignedElements but omits the inverse assignedSlot.
    Object.defineProperty(inside, "assignedSlot", { get: () => surface.shadowRoot?.querySelector("slot") });
    await settle();

    expect(close).toHaveBeenCalledOnce();
    expect(canOpenTransientPopup(trigger)).toBe(false);
    expect(canOpenTransientPopup(inside)).toBe(true);
    const rejectedClose = vi.fn();
    cleanups.push(registerTransientPopup(trigger, rejectedClose));
    expect(rejectedClose).toHaveBeenCalledOnce();
    surface.remove();
    expect(canOpenTransientPopup(trigger)).toBe(true);
  });

  it("allows dialog-owned shadow popups, then closes them for a newer nested dialog", async () => {
    const dialog = document.createElement("dialog");
    document.body.append(dialog);
    dialog.showModal();
    const host = document.createElement("div");
    dialog.append(host);
    const trigger = owner(host.attachShadow({ mode: "open" }));
    const close = vi.fn();
    cleanups.push(registerTransientPopup(trigger, close));
    await settle();
    expect(close).not.toHaveBeenCalled();

    const nested = document.createElement("dialog");
    dialog.append(nested);
    const nestedOwner = owner(nested);
    nested.showModal();
    await settle();
    expect(close).toHaveBeenCalledOnce();
    expect(canOpenTransientPopup(trigger)).toBe(false);
    expect(canOpenTransientPopup(nestedOwner)).toBe(true);
  });

  it("observes plugin native dialogs in shadow roots without registry imports", async () => {
    const trigger = owner();
    const plugin = document.createElement("div");
    const root = plugin.attachShadow({ mode: "open" });
    const dialog = document.createElement("dialog");
    root.append(dialog);
    document.body.append(plugin);
    const close = vi.fn();
    cleanups.push(registerTransientPopup(trigger, close));

    dialog.showModal();
    await settle();
    expect(close).toHaveBeenCalledOnce();
    expect(canOpenTransientPopup(trigger)).toBe(false);
    dialog.close();
    expect(canOpenTransientPopup(trigger)).toBe(true);
  });

  it("closes a popup when its connected native dialog closes", async () => {
    const dialog = document.createElement("dialog");
    document.body.append(dialog);
    const trigger = owner(dialog);
    dialog.showModal();
    const close = vi.fn();
    cleanups.push(registerTransientPopup(trigger, close));
    dialog.close();
    await settle();
    expect(close).toHaveBeenCalledOnce();
    expect(canOpenTransientPopup(trigger)).toBe(false);
  });

  it("does not close or block popups for a nonmodal dialog.show()", async () => {
    const trigger = owner();
    const close = vi.fn();
    cleanups.push(registerTransientPopup(trigger, close));
    const dialog = document.createElement("dialog");
    document.body.append(dialog);
    dialog.show();
    await settle();
    expect(close).not.toHaveBeenCalled();
    expect(canOpenTransientPopup(trigger)).toBe(true);
  });

  it("honors native opening order rather than DOM order, including reopen", async () => {
    const first = document.createElement("dialog");
    const second = document.createElement("dialog");
    document.body.append(first, second);
    const a = owner(first);
    const b = owner(second);
    // Install root observation before either modal opens.
    expect(canOpenTransientPopup(owner())).toBe(true);
    expect(canOpenTransientPopup(a)).toBe(false);
    second.showModal();
    first.showModal();
    expect(canOpenTransientPopup(a)).toBe(true);
    expect(canOpenTransientPopup(b)).toBe(false);
    first.close();
    first.showModal();
    expect(canOpenTransientPopup(a)).toBe(true);
    await settle();
  });

  it("unregisters without closing and keeps stale cleanup from disposing a newer scope", async () => {
    const trigger = owner();
    const close = vi.fn();
    const oldCleanup = registerTransientPopup(trigger, close);
    const dialog = document.createElement("dialog");
    document.body.append(dialog);
    dialog.showModal();
    await settle();
    expect(close).toHaveBeenCalledOnce();
    dialog.close();
    const nextClose = vi.fn();
    cleanups.push(registerTransientPopup(trigger, nextClose));
    oldCleanup();
    dialog.showModal();
    await settle();
    expect(nextClose).toHaveBeenCalledOnce();

    dialog.close();
    const voluntaryClose = vi.fn();
    registerTransientPopup(trigger, voluntaryClose)();
    dialog.showModal();
    await settle();
    expect(voluntaryClose).not.toHaveBeenCalled();
  });
});
