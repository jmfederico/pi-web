// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { activeModalElement, hasRenderedModal, registerRenderedModal, type RenderedModalRegistration } from "./modalLayerRegistry";
import { installNativeDialogFake } from "./nativeDialog.testSupport";
installNativeDialogFake();

const registrations: RenderedModalRegistration[] = [];
afterEach(() => {
  document.body.replaceChildren();
  for (const registration of registrations.splice(0)) registration.unregister();
  vi.restoreAllMocks();
});

function dialog(): HTMLDialogElement {
  const element = document.createElement("dialog");
  document.body.append(element);
  return element;
}
function register(element: HTMLDialogElement): RenderedModalRegistration {
  const registration = registerRenderedModal({ element, focus: () => { element.focus(); } });
  registrations.push(registration);
  return registration;
}

describe("native modal ownership", () => {
  it("captures focus before activation but owns interaction only until close", () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    const element = dialog();
    const registration = register(element);
    expect(registration.isTop).toBe(false);
    expect(registration.focus()).toBe(false);
    expect(hasRenderedModal(document)).toBe(false);
    element.showModal();
    expect(registration.isTop).toBe(true);
    expect(registration.focus()).toBe(true);
    element.close();
    expect(registration.isTop).toBe(false);
    registration.unregister();
    expect(document.activeElement).toBe(opener);
    expect(hasRenderedModal(document)).toBe(false);
  });

  it("uses native activation order, never host z-index or registration order", () => {
    const first = dialog();
    const second = dialog();
    second.style.zIndex = "99999";
    const a = register(first);
    const b = register(second);
    second.showModal();
    first.showModal();
    expect(a.isTop).toBe(true);
    expect(b.isTop).toBe(false);
    first.close();
    expect(b.isTop).toBe(true);
    first.showModal();
    expect(a.isTop).toBe(true);
    expect(activeModalElement(document)).toBe(first);
  });

  it("detects plugin dialogs across shadow boundaries without private registrations", () => {
    const host = document.createElement("div");
    const root = host.attachShadow({ mode: "open" });
    const element = document.createElement("dialog");
    root.append(element);
    document.body.append(host);
    expect(hasRenderedModal(document)).toBe(false);
    element.showModal();
    expect(hasRenderedModal(document)).toBe(true);
    expect(activeModalElement(document)).toBe(element);
    element.close();
    expect(hasRenderedModal(document)).toBe(false);
  });

  it("does not treat a nonmodal dialog as an interaction boundary", () => {
    const element = dialog();
    register(element);
    element.show();
    expect(hasRenderedModal(document)).toBe(false);
    expect(activeModalElement(document)).toBeUndefined();
  });

  it("keeps a native modal active even when its ordinary host is hidden", () => {
    const host = document.createElement("div");
    const element = dialog();
    document.body.append(host);
    host.append(element);
    const registration = register(element);
    element.showModal();
    host.hidden = true;
    // Native top-layer modality ends with close(), not ancestor layout. An
    // owner that hides its view must close the dialog explicitly.
    expect(registration.isTop).toBe(true);
    element.close();
    expect(registration.isTop).toBe(false);
  });

  it("closing an older registration cannot steal focus from a newer dialog", () => {
    const first = dialog();
    const second = dialog();
    const older = register(first);
    first.showModal();
    const newer = register(second);
    second.showModal();
    newer.focus();
    first.close();
    older.unregister();
    expect(document.activeElement).toBe(second);
    expect(newer.isTop).toBe(true);
  });
});
