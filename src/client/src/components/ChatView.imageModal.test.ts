// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatView } from "./ChatView";
import { ModalSurface } from "./ModalSurface";
import { hasRenderedModal } from "./modalLayerRegistry";

const IMAGE_DATA = "iVBORw0KGgo=";

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("ChatView native image modal", () => {
  it("preserves cancel and backdrop close behavior while restoring the image trigger", async () => {
    const view = await mountImageView();
    const image = chatImage(view);

    image.focus();
    image.click();
    await view.updateComplete;
    const firstDialog = imageDialog(view);
    expect(firstDialog.open).toBe(true);
    expect(view.shadowRoot?.activeElement).toBe(imageCloseButton(firstDialog));
    expect(hasRenderedModal(document)).toBe(true);

    const cancel = new Event("cancel", { cancelable: true });
    firstDialog.dispatchEvent(cancel);
    await view.updateComplete;
    expect(cancel.defaultPrevented).toBe(false);
    expect(firstDialog.open).toBe(false);
    expect(view.shadowRoot?.activeElement).toBe(image);
    expect(hasRenderedModal(document)).toBe(false);

    image.click();
    await view.updateComplete;
    const secondDialog = imageDialog(view);
    secondDialog.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, composed: true }));
    await view.updateComplete;

    expect(secondDialog.open).toBe(false);
    expect(view.shadowRoot?.activeElement).toBe(image);
    expect(hasRenderedModal(document)).toBe(false);
  });

  it("keeps the native top layer above a shared modal and restores focus into the survivor", async () => {
    const trigger = appendButton("Open lower dialog");
    trigger.focus();
    const lower = new ModalSurface();
    lower.initialFocus = "button";
    lower.innerHTML = "<button>Lower action</button>";
    document.body.append(lower);
    await lower.updateComplete;
    const lowerButton = requiredElement(lower.querySelector<HTMLButtonElement>("button"), "lower modal button");
    expect(document.activeElement).toBe(lowerButton);

    const view = await mountImageView();
    chatImage(view).click();
    await view.updateComplete;
    await lower.updateComplete;
    const dialog = imageDialog(view);

    expect(dialog.open).toBe(true);
    expect(lowerDialogSection(lower).getAttribute("aria-modal")).toBe("false");
    expect(lowerDialogSection(lower).getAttribute("aria-hidden")).toBe("true");
    expect(view.shadowRoot?.activeElement).toBe(imageCloseButton(dialog));

    dialog.dispatchEvent(new Event("cancel", { cancelable: true }));
    await view.updateComplete;
    await lower.updateComplete;

    expect(dialog.open).toBe(false);
    expect(document.activeElement).toBe(lowerButton);
    expect(lowerDialogSection(lower).getAttribute("aria-modal")).toBe("true");
    expect(lowerDialogSection(lower).getAttribute("aria-hidden")).toBeNull();

    lower.remove();
    expect(document.activeElement).toBe(trigger);
  });
});

async function mountImageView(): Promise<ChatView> {
  const view = new ChatView();
  view.sessionId = "session-image";
  view.messages = [{ role: "user", parts: [{ type: "image", mimeType: "image/png", data: IMAGE_DATA }] }];
  document.body.append(view);
  await view.updateComplete;
  return view;
}

function chatImage(view: ChatView): HTMLElement {
  return requiredElement(view.shadowRoot?.querySelector<HTMLElement>(".chat-image"), "chat image");
}

function imageDialog(view: ChatView): HTMLDialogElement {
  return requiredElement(view.shadowRoot?.querySelector<HTMLDialogElement>("dialog.image-zoom"), "image zoom dialog");
}

function imageCloseButton(dialog: HTMLDialogElement): HTMLButtonElement {
  return requiredElement(dialog.querySelector<HTMLButtonElement>(".image-zoom-close"), "image close button");
}

function lowerDialogSection(surface: ModalSurface): HTMLElement {
  return requiredElement(surface.shadowRoot?.querySelector<HTMLElement>("section[role='dialog']"), "lower dialog section");
}

function appendButton(text: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.textContent = text;
  document.body.append(button);
  return button;
}

function requiredElement<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) throw new Error(`Expected ${label}`);
  return value;
}
