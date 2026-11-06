import { stylesheetIntegrationCapability } from "../plugins/styles";
import { LitElement, css, html, nothing, type TemplateResult } from "lit";
import { customElement, property, query } from "lit/decorators.js";
import { deepActiveElement, focusElement, registerRenderedModal, type RenderedModalRegistration } from "./modalLayerRegistry";
import { composedFocusableElements } from "./focusableElements";

/**
 * Shared modal surface for the client's custom overlay dialogs. It owns the
 * cross-cutting modal behaviors so each dialog only renders its own content:
 *
 * - moves focus into the dialog on open (the `initialFocus` target, or the
 *   native dialog itself when no target matches),
 * - routes Escape and backdrop presses to `onClose`, unless the host sets the
 *   `busy` opt-out (Escape is then routed to the optional `onBusyEscape`),
 * - traps Tab/Shift+Tab within the dialog's focusable elements, including
 *   controls inside nested shadow roots, and counts a named radio group as the
 *   one sequential stop the platform gives it,
 * - keeps focus and modal accessibility ownership on the visually top surface,
 * - restores focus to the previous control or surviving lower dialog on disconnect.
 *
 * An internal native dialog owns top-layer paint order and background inertness.
 * Hosts render content as children and tune the existing backdrop/section shell
 * through the `--modal-surface-*` custom properties in `styles`.
 */
@customElement("modal-surface")
export class ModalSurface extends LitElement {
  constructor() {
    super();
    stylesheetIntegrationCapability.createController(this);
  }

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
  /** Selector of the content element focused on open; falls back to the native dialog. */
  @property({ attribute: false }) initialFocus?: string;
  /** Accessible name applied as `aria-label` on the native dialog. */
  @property({ attribute: false }) label?: string;

  @query("dialog") private dialog?: HTMLDialogElement;

  private modalRegistration: RenderedModalRegistration | undefined;
  private activationAttempted = false;

  override connectedCallback(): void {
    super.connectedCallback();
    this.activationAttempted = false;
    this.requestUpdate();
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
    this.dialog?.close();
    super.disconnectedCallback();
    registration?.unregister();
  }

  protected override updated(): void {
    const dialog = this.dialog;
    if (!this.isConnected || dialog === undefined || this.activationAttempted) return;
    this.activationAttempted = true;
    const registration = registerRenderedModal({
      element: dialog,
      focus: () => { this.focusDialogContent(); },
      onTopChange: (isTop) => { this.syncModalAccessibility(isTop); },
    });
    this.modalRegistration = registration;
    try {
      dialog.showModal();
      this.syncModalAccessibility(registration.isTop);
      registration.focus();
    } catch (error) {
      this.modalRegistration = undefined;
      registration.unregister();
      this.syncModalAccessibility(false);
      throw error;
    }
  }

  /**
   * Moves focus into the dialog: the `initialFocus` target when one matches,
   * otherwise the native dialog. Hosts call this after swapping content that
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
    if (this.dialog !== undefined) focusElement(this.dialog);
  }

  // Ownership depends on the opened native dialog, not just Lit properties.
  // Keep these attributes registry-owned so opening or changing layers does
  // not need a corrective render. The template supplies closed defaults only.
  private syncModalAccessibility(isTop: boolean): void {
    const dialog = this.dialog;
    if (dialog === undefined) return;
    dialog.setAttribute("aria-modal", isTop ? "true" : "false");
    if (isTop) dialog.removeAttribute("aria-hidden");
    else dialog.setAttribute("aria-hidden", "true");
  }

  override render(): TemplateResult {
    return html`
      <dialog role="dialog" @cancel=${this.handleCancel}
        aria-modal="false"
        aria-hidden="true"
        aria-busy=${this.busy ? "true" : "false"}
        aria-label=${this.label ?? nothing}>
        <div class="backdrop" @mousedown=${(event: MouseEvent) => { this.handleBackdropMouseDown(event); }}>
          <section class="surface"><slot></slot></section>
        </div>
      </dialog>
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

  private readonly handleCancel = (event: Event): void => {
    // Native cancel must never close independently of the consumer's state.
    event.preventDefault();
    event.stopPropagation();
    if (this.modalRegistration?.isTop !== true) return;
    if (this.busy) this.onBusyEscape?.();
    else this.onClose?.();
  };

  private readonly handleKeyDown = (event: KeyboardEvent): void => {
    if (this.modalRegistration?.isTop !== true || event.defaultPrevented) return;
    if (event.key === "Tab") {
      this.trapTabFocus(event);
      return;
    }
    if (event.key !== "Escape") return;
    // Escape may cancel an IME candidate without dismissing its containing dialog.
    if (event.isComposing) {
      event.stopPropagation();
      return;
    }
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
    const focusable = composedFocusableElements(this);
    if (focusable.length === 0) {
      event.preventDefault();
      this.dialog?.focus();
      return;
    }
    const active = deepActiveElement(this.ownerDocument);
    const activeIndex = focusable.findIndex((element) => element === active);
    if (activeIndex === -1) {
      // Focus rests on the native dialog itself (or an untracked element):
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
    if (event.target !== event.currentTarget || this.busy || this.modalRegistration?.isTop !== true) return;
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
    dialog { position: fixed; inset: 0; box-sizing: border-box; width: 100%; height: 100%; max-width: none; max-height: none; margin: 0; padding: 0; border: 0; background: transparent; color: inherit; overflow: hidden; }
    dialog::backdrop { background: transparent; }
    .backdrop { box-sizing: border-box; width: 100%; height: 100%; display: grid; place-items: var(--modal-surface-place-items, center); padding: var(--modal-surface-backdrop-padding, 0); background: var(--pi-overlay); overflow: hidden; }
    .surface { box-sizing: border-box; width: var(--modal-surface-width, min(720px, 100%)); max-width: var(--modal-surface-max-width, 100%); height: var(--modal-surface-height, auto); max-height: var(--modal-surface-max-height, 100%); min-height: var(--modal-surface-min-height, auto); display: flex; flex-direction: column; border: var(--modal-surface-border, 1px solid var(--pi-border)); border-radius: var(--modal-surface-radius, 12px); background: var(--pi-bg); box-shadow: var(--modal-surface-shadow, 0 20px 60px var(--pi-shadow-strong)); overflow: hidden; }
  `;
}
