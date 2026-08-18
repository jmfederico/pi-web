/**
 * Shared harness for dialog tests that exercise the `<modal-surface>` shell:
 * locating the surface/section inside nested shadow roots, settling the
 * nested render cycles, and dispatching input the happy-dom way.
 *
 * Registration of the elements under test comes from the dialog modules
 * themselves (their side-effect imports of `./ModalSurface`); this helper
 * only type-imports `ModalSurface` so esbuild cannot drop the registration
 * for the component under test.
 */
import type { LitElement } from "lit";
import type { ModalSurface } from "./ModalSurface";

/**
 * Awaits the host dialog, the nested modal-surface it renders, and one more
 * host cycle so any render scheduled from within `updated()` has settled.
 */
export async function settleRenderedDialog(host: LitElement): Promise<void> {
  await host.updateComplete;
  await dialogSurface(host).updateComplete;
  await host.updateComplete;
}

/** The modal-surface element a dialog renders in its shadow root. */
export function dialogSurface(host: LitElement): ModalSurface {
  return requiredElement(host.shadowRoot?.querySelector<ModalSurface>("modal-surface"), `${host.tagName.toLowerCase()} modal-surface`);
}

/** The `role="dialog"` section inside the surface's shadow root. */
export function dialogSection(host: LitElement): HTMLElement {
  return requiredElement(dialogSurface(host).shadowRoot?.querySelector("section[role='dialog']"), `${host.tagName.toLowerCase()} dialog section`);
}

/** The backdrop element inside the surface's shadow root. */
export function surfaceBackdrop(host: LitElement): HTMLElement {
  return requiredElement(dialogSurface(host).shadowRoot?.querySelector(".backdrop"), `${host.tagName.toLowerCase()} surface backdrop`);
}

/**
 * Dispatches a cancelable keydown. happy-dom does not propagate events out of
 * shadow roots, so presses that would bubble from the dialog section to the
 * modal-surface host in a browser are dispatched on the host itself (see
 * ModalSurface.test.ts).
 */
export function pressKey(target: Element, key: string): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, composed: true });
  target.dispatchEvent(event);
  return event;
}

/** Models the browser's native button click default, which happy-dom omits. */
export function pressNativeButtonEnter(button: HTMLButtonElement): KeyboardEvent {
  const event = pressKey(button, "Enter");
  if (!event.defaultPrevented) button.click();
  return event;
}

/** Deepest element holding focus, resolving through nested shadow roots. */
export function deepActiveElement(): Element | null {
  let active: Element | null = document.activeElement;
  while (active instanceof HTMLElement && active.shadowRoot?.activeElement instanceof Element) {
    active = active.shadowRoot.activeElement;
  }
  // happy-dom reports activeElement as undefined when nothing is focused;
  // the runtime value is normalized even though the type says Element | null.
  return active ?? null;
}

export function requiredElement<T extends Element>(element: T | null | undefined, description: string): T {
  if (element === null || element === undefined) throw new Error(`Expected ${description} to exist`);
  return element;
}
