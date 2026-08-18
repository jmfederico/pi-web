import { LitElement, css, html, nothing, type TemplateResult } from "lit";
import { customElement, property, query } from "lit/decorators.js";
import { deepActiveElement, focusElement, isHiddenOrInertInComposedTree, registerRenderedModal, type RenderedModalRegistration } from "./modalLayerRegistry";

const FOCUSABLE_SELECTOR = "button, input, select, textarea, a[href], [tabindex]";

/**
 * Shared modal surface for the client's custom overlay dialogs. It owns the
 * cross-cutting modal behaviors so each dialog only renders its own content:
 *
 * - moves focus into the dialog on open (the `initialFocus` target, or the
 *   `role="dialog"` section itself when no target matches),
 * - routes Escape and backdrop presses to `onClose`, unless the host sets the
 *   `busy` opt-out (Escape is then routed to the optional `onBusyEscape`),
 * - traps Tab/Shift+Tab within the dialog's focusable elements, including
 *   controls inside nested shadow roots, and counts a named radio group as the
 *   one sequential stop the platform gives it,
 * - keeps focus and modal accessibility ownership on the visually top surface,
 * - restores focus to the previous control or surviving lower dialog on disconnect.
 *
 * The host dialog keeps its own fixed positioning and z-index, renders its
 * content as this element's children, and tunes the shared backdrop/section
 * shell through the `--modal-surface-*` custom properties in `styles`.
 */
@customElement("modal-surface")
export class ModalSurface extends LitElement {
  /** Called when Escape or a backdrop press requests closing. Not called while `busy`. */
  @property({ attribute: false }) onClose?: () => void;
  /**
   * Busy/opt-out contract: while true, Escape and backdrop presses do not call
   * `onClose`; Escape is routed to `onBusyEscape` instead, so hosts can abort
   * in-flight work (or swallow the key) explicitly.
   */
  @property({ type: Boolean }) busy = false;
  /** Optional Escape route used only while `busy`. */
  @property({ attribute: false }) onBusyEscape?: () => void;
  /** Selector of the content element focused on open; falls back to the dialog section. */
  @property({ attribute: false }) initialFocus?: string;
  /** Accessible name applied as `aria-label` on the dialog section. */
  @property({ attribute: false }) label?: string;

  @query("section") private section?: HTMLElement;

  private modalRegistration: RenderedModalRegistration | undefined;

  override connectedCallback(): void {
    super.connectedCallback();
    this.modalRegistration = registerRenderedModal({
      element: this,
      paintElement: modalLayerHost(this),
      focus: () => { this.focusDialogContent(); },
      onTopChange: () => { this.requestUpdate(); },
    });
    // Key handling lives on the host, not the shadow section: slotted dialog
    // content bubbles key events up its light-DOM tree to this element, and
    // key presses inside the surface's own shadow section reach it as composed
    // events. One listener therefore covers the whole dialog.
    this.addEventListener("keydown", this.handleKeyDown);
  }

  override disconnectedCallback(): void {
    this.removeEventListener("keydown", this.handleKeyDown);
    const registration = this.modalRegistration;
    this.modalRegistration = undefined;
    super.disconnectedCallback();
    registration?.unregister();
  }

  protected override firstUpdated(): void {
    this.focusDialog();
  }

  /**
   * Moves focus into the dialog: the `initialFocus` target when one matches,
   * otherwise the dialog section. Hosts call this after swapping content that
   * held focus (for example a step change) so keys keep reaching the dialog.
   */
  focusDialog(): void {
    // Async dialog data can resolve after a visually higher modal has opened.
    // Only the actual top layer may claim focus; when that layer closes, the
    // rendered-modal registry reapplies the surviving layer's focus contract.
    this.modalRegistration?.focus();
  }

  private focusDialogContent(): void {
    const initialTarget = this.initialFocusTarget();
    if (initialTarget !== null && focusElement(initialTarget)) return;
    if (this.section !== undefined) focusElement(this.section);
  }

  override render(): TemplateResult {
    const isTop = this.modalRegistration?.isTop === true;
    return html`
      <div class="backdrop" @mousedown=${(event: MouseEvent) => { this.handleBackdropMouseDown(event); }}>
        <section
          role="dialog"
          aria-modal=${isTop ? "true" : "false"}
          aria-hidden=${isTop ? nothing : "true"}
          aria-busy=${this.busy ? "true" : "false"}
          aria-label=${this.label ?? nothing}
          tabindex="-1"
        ><slot></slot></section>
      </div>
    `;
  }

  private initialFocusTarget(): HTMLElement | null {
    if (this.initialFocus === undefined) return null;
    try {
      return this.querySelector<HTMLElement>(this.initialFocus);
    } catch {
      // An invalid selector is a host authoring error; fall back to the section.
      return null;
    }
  }

  private readonly handleKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Tab") {
      this.trapTabFocus(event);
      return;
    }
    if (event.key !== "Escape") return;
    // A modal owns Escape completely: it either closes or exercises the busy
    // contract, but it never leaks the key to global shortcut handlers.
    event.preventDefault();
    event.stopPropagation();
    if (this.busy) {
      this.onBusyEscape?.();
      return;
    }
    this.onClose?.();
  };

  private trapTabFocus(event: KeyboardEvent): void {
    const focusable = modalSurfaceFocusableElements(this);
    if (focusable.length === 0) {
      event.preventDefault();
      this.section?.focus();
      return;
    }
    const active = deepActiveElement(this.ownerDocument);
    const activeIndex = focusable.findIndex((element) => element === active);
    if (activeIndex === -1) {
      // Focus rests on the dialog section itself (or an untracked element):
      // enter the cycle at the edge matching the direction.
      event.preventDefault();
      (event.shiftKey ? focusable.at(-1) : focusable[0])?.focus();
      return;
    }
    const wrapForward = !event.shiftKey && activeIndex === focusable.length - 1;
    const wrapBackward = event.shiftKey && activeIndex === 0;
    if (!wrapForward && !wrapBackward) return;
    event.preventDefault();
    (event.shiftKey ? focusable.at(-1) : focusable[0])?.focus();
  }

  private handleBackdropMouseDown(event: MouseEvent): void {
    // Presses that start on dialog content bubble through the slot; only a
    // press targeting the backdrop itself counts as a dismissal.
    if (event.target !== event.currentTarget || this.busy) return;
    this.onClose?.();
  }

  static override styles = css`
    /* Host dialogs tune this shell with custom properties (defaults match a
       centered 720px dialog):
         --modal-surface-place-items      backdrop grid alignment (default center)
         --modal-surface-backdrop-padding backdrop padding (default 0)
         --modal-surface-width / --modal-surface-max-width
         --modal-surface-height / --modal-surface-max-height / --modal-surface-min-height
         --modal-surface-border / --modal-surface-radius / --modal-surface-shadow */
    :host { display: block; width: 100%; height: 100%; }
    .backdrop { box-sizing: border-box; width: 100%; height: 100%; display: grid; place-items: var(--modal-surface-place-items, center); padding: var(--modal-surface-backdrop-padding, 0); background: var(--pi-overlay); overflow: hidden; }
    section[role="dialog"] { box-sizing: border-box; width: var(--modal-surface-width, min(720px, 100%)); max-width: var(--modal-surface-max-width, 100%); height: var(--modal-surface-height, auto); max-height: var(--modal-surface-max-height, 100%); min-height: var(--modal-surface-min-height, auto); display: flex; flex-direction: column; border: var(--modal-surface-border, 1px solid var(--pi-border)); border-radius: var(--modal-surface-radius, 12px); background: var(--pi-bg); box-shadow: var(--modal-surface-shadow, 0 20px 60px var(--pi-shadow-strong)); overflow: hidden; }
  `;
}

/**
 * Focusable elements inside the surface's dialog content in flattened Tab-cycle
 * order. Open shadow roots replace a host's light children, and slots insert
 * their assigned children where the slot is rendered.
 */
function modalSurfaceFocusableElements(surface: ModalSurface): HTMLElement[] {
  const focusable: HTMLElement[] = [];
  const collect = (element: Element): void => {
    if (element instanceof HTMLElement && isSequentiallyFocusable(element)) focusable.push(element);
    for (const child of flattenedChildElements(element)) collect(child);
  };
  for (const child of flattenedChildElements(surface)) collect(child);
  return withOneStopPerRadioGroup(focusable);
}

/**
 * Collapses every named radio group to the single Tab stop the platform gives
 * it: the checked member, or the group's first focusable member when none is
 * checked. Counting each radio separately would put the trap's last stop
 * before the group's real end, so Tab from the checked radio of a trailing
 * group would be treated as mid-cycle and walk focus out of the dialog.
 *
 * Groups are keyed by form owner and name, matching how HTML scopes a radio
 * group; radios with no name are independent stops and keep their own.
 */
function withOneStopPerRadioGroup(focusable: readonly HTMLElement[]): HTMLElement[] {
  const stopsByOwner = new Map<HTMLFormElement | null, Map<string, HTMLInputElement>>();
  for (const element of focusable) {
    const radio = namedRadio(element);
    if (radio === null) continue;
    const stopsByName = stopsByOwner.get(radio.form) ?? new Map<string, HTMLInputElement>();
    stopsByOwner.set(radio.form, stopsByName);
    const stop = stopsByName.get(radio.name);
    // First member wins until a checked member appears; a group has at most one
    // checked radio, so the checked member then keeps the stop for good.
    if (stop === undefined || (radio.checked && !stop.checked)) stopsByName.set(radio.name, radio);
  }
  const stops = new Set<HTMLElement>(Array.from(stopsByOwner.values()).flatMap((stopsByName) => Array.from(stopsByName.values())));
  return focusable.filter((element) => namedRadio(element) === null || stops.has(element));
}

function namedRadio(element: HTMLElement): HTMLInputElement | null {
  if (!(element instanceof HTMLInputElement) || element.type !== "radio" || element.name === "") return null;
  return element;
}

function isSequentiallyFocusable(element: HTMLElement): boolean {
  if (element.matches(":disabled") || isHiddenOrInertInComposedTree(element)) return false;
  if (element instanceof HTMLInputElement && element.type === "hidden") return false;
  // Native controls match by tag even when an explicit negative tabindex has
  // removed them from sequential keyboard navigation.
  return element.matches(FOCUSABLE_SELECTOR) && element.tabIndex >= 0;
}

function flattenedChildElements(parent: Element | ShadowRoot): Element[] {
  if (parent instanceof HTMLSlotElement) {
    const assigned = parent.assignedNodes({ flatten: true });
    // Preserve fallback content when a DOM implementation reports an empty
    // assigned list; assigned text keeps the list nonempty and suppresses it.
    const rendered = assigned.length === 0 ? parent.childNodes : assigned;
    return Array.from(rendered).filter((node): node is Element => node instanceof Element);
  }
  const renderedRoot = parent instanceof Element ? parent.shadowRoot ?? parent : parent;
  return Array.from(renderedRoot.children);
}

function modalLayerHost(surface: ModalSurface): HTMLElement {
  const root = surface.getRootNode();
  return root instanceof ShadowRoot && root.host instanceof HTMLElement ? root.host : surface;
}
