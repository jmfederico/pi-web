import { afterEach, beforeEach } from "vitest";

/** Only the missing native API: activation, auto ancestry and light dismissal.
 * Real top-layer geometry and browser focus remain browser-test concerns. */
export function installPopoverFake(): void {
  let cleanup: (() => void) | undefined;
  afterEach(() => { cleanup?.(); });
  beforeEach(() => {
    const showDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "showPopover");
    const hideDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "hidePopover");
    const open = new Set<HTMLElement>();
    const contains = (parent: HTMLElement, child: HTMLElement): boolean => {
      let node: Node | null = child;
      while (node) {
        if (node === parent) return true;
        node = node instanceof ShadowRoot ? node.host : node.parentNode;
      }
      return false;
    };
    const hide = (panel: HTMLElement): void => {
      if (!open.delete(panel)) return;
      panel.dispatchEvent(Object.assign(new Event("beforetoggle"), { newState: "closed" }));
      panel.dispatchEvent(Object.assign(new Event("toggle"), { newState: "closed" }));
    };
    Object.defineProperty(HTMLElement.prototype, "showPopover", { configurable: true, writable: true, value: function (this: HTMLElement, options?: { source?: HTMLElement }) {
      for (const panel of [...open].reverse()) if (!contains(panel, options?.source ?? this)) hide(panel);
      open.add(this);
      this.dispatchEvent(Object.assign(new Event("toggle"), { newState: "open" }));
    } });
    Object.defineProperty(HTMLElement.prototype, "hidePopover", { configurable: true, writable: true, value: function (this: HTMLElement) { hide(this); } });
    // Happy-dom exposes the API but does not provide native dismissal.
    const click = (event: MouseEvent): void => {
      for (const panel of [...open].reverse()) {
        if (event.composedPath().includes(panel)) break;
        hide(panel);
      }
    };
    document.addEventListener("click", click);
    cleanup = () => {
      document.removeEventListener("click", click);
      if (showDescriptor) Object.defineProperty(HTMLElement.prototype, "showPopover", showDescriptor);
      else Reflect.deleteProperty(HTMLElement.prototype, "showPopover");
      if (hideDescriptor) Object.defineProperty(HTMLElement.prototype, "hidePopover", hideDescriptor);
      else Reflect.deleteProperty(HTMLElement.prototype, "hidePopover");
    };
  });
}
