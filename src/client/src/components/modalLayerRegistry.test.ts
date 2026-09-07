// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import { hasRenderedModal, registerRenderedModal, type RenderedModalRegistration } from "./modalLayerRegistry";

interface TestModalLayer {
  /** Container standing in for a view or panel that responsive CSS can hide. */
  readonly view: HTMLElement;
  readonly element: HTMLElement;
  readonly focusTarget: HTMLButtonElement;
  readonly registration: RenderedModalRegistration;
}

const openLayers: RenderedModalRegistration[] = [];

afterEach(() => {
  while (openLayers.length > 0) openLayers.pop()?.unregister();
  document.body.replaceChildren();
});

describe("rendered modal layer visibility", () => {
  it("stops counting a layer that its view hides, and counts it again when the view returns", () => {
    const trigger = appendTrigger("Open review");
    trigger.focus();
    const layer = mountLayer("upload review");

    expect(hasRenderedModal(document)).toBe(true);
    expect(layer.registration.isTop).toBe(true);

    layer.view.style.display = "none";

    expect(hasRenderedModal(document)).toBe(false);
    expect(layer.registration.isTop).toBe(false);

    layer.view.style.display = "";

    expect(hasRenderedModal(document)).toBe(true);
    expect(layer.registration.isTop).toBe(true);
  });

  it("keeps a visible lower layer in charge while a higher layer is hidden", () => {
    appendTrigger("Open lower").focus();
    const lower = mountLayer("lower dialog");
    const upper = mountLayer("upper dialog");

    expect(upper.registration.isTop).toBe(true);
    expect(lower.registration.isTop).toBe(false);

    upper.view.style.display = "none";

    expect(hasRenderedModal(document)).toBe(true);
    expect(upper.registration.isTop).toBe(false);
    expect(lower.registration.isTop).toBe(true);
    expect(lower.registration.focus()).toBe(true);
    expect(document.activeElement).toBe(lower.focusTarget);
  });

  it("restores focus outside the stack instead of into a hidden lower layer", () => {
    const trigger = appendTrigger("Open lower");
    trigger.focus();
    const lower = mountLayer("lower dialog");
    lower.registration.focus();
    expect(document.activeElement).toBe(lower.focusTarget);
    const upper = mountLayer("upper dialog");
    upper.registration.focus();
    expect(document.activeElement).toBe(upper.focusTarget);

    lower.view.style.display = "none";
    upper.registration.unregister();
    openLayers.splice(openLayers.indexOf(upper.registration), 1);

    expect(document.activeElement).toBe(trigger);
    expect(hasRenderedModal(document)).toBe(false);
  });

  it("refuses focus for a hidden layer so the caller can tell it is not rendered", () => {
    const trigger = appendTrigger("Open review");
    trigger.focus();
    const layer = mountLayer("upload review");
    layer.view.style.display = "none";

    expect(layer.registration.focus()).toBe(false);
    expect(document.activeElement).toBe(trigger);
  });

  it("detects an unregistered native dialog through a plugin shadow boundary", () => {
    const host = document.createElement("div");
    const root = host.attachShadow({ mode: "open" });
    const dialog = document.createElement("dialog");
    root.append(dialog);
    document.body.append(host);

    expect(hasRenderedModal(document)).toBe(false);
    dialog.showModal();
    expect(hasRenderedModal(document)).toBe(true);
    dialog.close();
    expect(hasRenderedModal(document)).toBe(false);
  });

  it("keeps a native top-layer dialog registered while it is still closed", () => {
    // Hosts capture the pre-modal focus target by registering before
    // `showModal()`, so the dialog is still `display: none` at that moment and
    // must not be mistaken for a hidden phantom layer.
    appendTrigger("Zoom image").focus();
    const custom = mountLayer("custom dialog");
    const dialog = document.createElement("dialog");
    dialog.textContent = "Zoomed image";
    document.body.append(dialog);

    const registration = registerRenderedModal({ element: dialog, nativeTopLayer: true, focus: () => { dialog.focus(); } });
    openLayers.push(registration);

    expect(registration.isTop).toBe(true);
    expect(custom.registration.isTop).toBe(false);
    expect(hasRenderedModal(document)).toBe(true);
  });
});

function mountLayer(label: string): TestModalLayer {
  const view = document.createElement("div");
  const element = document.createElement("div");
  const focusTarget = document.createElement("button");
  focusTarget.textContent = `${label} action`;
  element.append(focusTarget);
  view.append(element);
  document.body.append(view);

  const registration = registerRenderedModal({ element, focus: () => { focusTarget.focus(); } });
  openLayers.push(registration);
  return { view, element, focusTarget, registration };
}

function appendTrigger(text: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.textContent = text;
  document.body.append(button);
  return button;
}
