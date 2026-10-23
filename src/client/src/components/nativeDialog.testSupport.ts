import { beforeEach, afterEach, vi } from "vitest";

/** Model native modality/toggle events missing from happy-dom, not geometry or inertness. */
export function installNativeDialogFake(): void {
  const assignedSlot = Object.getOwnPropertyDescriptor(Element.prototype, "assignedSlot");
  beforeEach(() => {
    // happy-dom exposes assignedElements(), but not the inverse slot ancestry
    // needed to determine whether light-DOM content belongs to a native dialog.
    Object.defineProperty(Element.prototype, "assignedSlot", { configurable: true, get(this: Element) {
      const name = this.getAttribute("slot") ?? "";
      return [...(this.parentElement?.shadowRoot?.querySelectorAll("slot") ?? [])].find((slot) => slot.name === name) ?? null;
    } });
    const modal = new WeakSet<HTMLDialogElement>();
    vi.spyOn(HTMLDialogElement.prototype, "showModal").mockImplementation(function (this: HTMLDialogElement) {
      this.dispatchEvent(Object.assign(new Event("beforetoggle"), { oldState: "closed", newState: "open" }));
      modal.add(this);
      this.setAttribute("open", "");
    });
    vi.spyOn(HTMLDialogElement.prototype, "matches").mockImplementation(function (this: HTMLDialogElement, selector: string) {
      return selector === ":modal" ? this.open && modal.has(this) : Element.prototype.matches.call(this, selector);
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    if (assignedSlot === undefined) Reflect.deleteProperty(Element.prototype, "assignedSlot");
    else Object.defineProperty(Element.prototype, "assignedSlot", assignedSlot);
  });
}
