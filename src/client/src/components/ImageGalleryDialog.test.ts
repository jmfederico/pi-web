// @vitest-environment happy-dom
import { installNativeDialogFake } from "./nativeDialog.testSupport";
installNativeDialogFake();

import { afterEach, describe, expect, it } from "vitest";
import { ImageGalleryDialog } from "./ImageGalleryDialog";
import { deepActiveElement, hasRenderedModal } from "./modalLayerRegistry";

const images = ["first", "second", "third"].map((alt) => ({ src: `data:image/png;base64,${alt}`, alt }));

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
});

describe("ImageGalleryDialog", () => {
  it("navigates without wrapping and moves focus only when its control becomes disabled", async () => {
    const gallery = await mountGallery();
    const next = button(gallery, "Next image");
    expect(button(gallery, "Previous image").disabled).toBe(true);
    next.focus();
    next.click();
    await gallery.updateComplete;
    expectSelection(gallery, 1);
    expect(deepActiveElement(document)).toBe(next);
    next.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
    await gallery.updateComplete;
    expectSelection(gallery, 2);
    const previous = button(gallery, "Previous image");
    expect(next.disabled).toBe(true);
    expect(deepActiveElement(document)).toBe(previous);
    previous.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    await gallery.updateComplete;
    expectSelection(gallery, 2);
    previous.click();
    await gallery.updateComplete;
    expectSelection(gallery, 1);
    expect(deepActiveElement(document)).toBe(previous);
    previous.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true }));
    await gallery.updateComplete;
    expectSelection(gallery, 0);
    expect(previous.disabled).toBe(true);
    expect(deepActiveElement(document)).toBe(next);
    next.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    await gallery.updateComplete;
    expectSelection(gallery, 0);
  });

  it("keeps focus on an enabled navigation control and ignores modified or composing arrows", async () => {
    const gallery = await mountGallery();
    const next = button(gallery, "Next image");
    next.focus();
    for (const key of ["ArrowRight", "ArrowLeft"]) {
      next.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
      await gallery.updateComplete;
      expectSelection(gallery, key === "ArrowRight" ? 1 : 0);
      expect(deepActiveElement(document)).toBe(next);
    }
    for (const modifier of [{ altKey: true }, { ctrlKey: true }, { metaKey: true }, { isComposing: true }]) {
      const event = new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true, ...modifier });
      next.dispatchEvent(event);
      await gallery.updateComplete;
      expect(event.defaultPrevented).toBe(false);
      expectSelection(gallery, 0);
    }
  });

  it("wraps Tab around enabled controls", async () => {
    const gallery = await mountGallery();
    const close = button(gallery, "Close image");
    const next = button(gallery, "Next image");
    close.focus();
    const backward = new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true });
    close.dispatchEvent(backward);
    expect(backward.defaultPrevented).toBe(true);
    expect(deepActiveElement(document)).toBe(next);
    const forward = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    next.dispatchEvent(forward);
    expect(forward.defaultPrevented).toBe(true);
    expect(deepActiveElement(document)).toBe(close);
  });

  it("navigates only on primary horizontal touch swipes of at least 48 pixels", async () => {
    const gallery = await mountGallery(1);
    const stage = required(gallery.renderRoot.querySelector<HTMLElement>(".image-gallery-stage"));
    const swipe = async (dx: number, dy = 0, pointerType = "touch", isPrimary = true) => {
      const init = { bubbles: true, pointerId: 1, pointerType, isPrimary };
      stage.dispatchEvent(new PointerEvent("pointerdown", { ...init, clientX: 100, clientY: 100 }));
      stage.dispatchEvent(new PointerEvent("pointerup", { ...init, clientX: 100 + dx, clientY: 100 + dy }));
      await gallery.updateComplete;
    };
    await swipe(-47);
    await swipe(-60, 100);
    await swipe(-60, 0, "mouse");
    await swipe(-60, 0, "touch", false);
    expectSelection(gallery, 1);
    await swipe(-48);
    expectSelection(gallery, 2);
    await swipe(-60);
    expectSelection(gallery, 2);
    await swipe(48);
    expectSelection(gallery, 1);
    await swipe(60);
    await swipe(60);
    expectSelection(gallery, 0);
    const init = { bubbles: true, pointerId: 1, pointerType: "touch", isPrimary: true, clientX: 100 };
    stage.dispatchEvent(new PointerEvent("pointerdown", init));
    stage.dispatchEvent(new PointerEvent("pointercancel", init));
    stage.dispatchEvent(new PointerEvent("pointerup", { ...init, clientX: 0 }));
    await gallery.updateComplete;
    expectSelection(gallery, 0);
  });

  it("releases native modality on disconnect and reconnects closed", async () => {
    const gallery = await mountGallery();
    const dialog = required(gallery.renderRoot.querySelector("dialog"));
    expect(dialog.open).toBe(true);
    expect(hasRenderedModal(document)).toBe(true);
    gallery.remove();
    expect(dialog.open).toBe(false);
    expect(hasRenderedModal(document)).toBe(false);
    document.body.append(gallery);
    await gallery.updateComplete;
    expect(dialog.open).toBe(false);
    expect(gallery.renderRoot.querySelector("img")).toBeNull();
    gallery.show(images, 2);
    await gallery.updateComplete;
    expect(dialog.open).toBe(true);
    expectSelection(gallery, 2);
    dialog.close();
    await gallery.updateComplete;
    expect(hasRenderedModal(document)).toBe(false);
    expect(gallery.renderRoot.querySelector("img")).toBeNull();
  });
});

async function mountGallery(index = 0): Promise<ImageGalleryDialog> {
  const gallery = new ImageGalleryDialog();
  document.body.append(gallery);
  await gallery.updateComplete;
  gallery.show(images, index);
  await gallery.updateComplete;
  return gallery;
}

function button(gallery: ImageGalleryDialog, label: string): HTMLButtonElement {
  return required(gallery.renderRoot.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`));
}

function expectSelection(gallery: ImageGalleryDialog, index: number): void {
  const image = required(gallery.renderRoot.querySelector("img"));
  expect(image.getAttribute("src")).toBe(images[index]?.src);
  expect(image.alt).toBe(images[index]?.alt);
  expect(gallery.renderRoot.querySelector('[role="status"]')?.textContent).toBe(`Image ${String(index + 1)} of 3`);
}

function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error("Expected gallery control");
  return value;
}
