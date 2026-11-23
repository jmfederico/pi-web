import { LocalizationController, localization } from "../localization/browser";
import { imageMessages } from "../imageMessages";
import { stylesheetIntegrationCapability } from "../plugins/styles";
import { LitElement, css, html } from "lit";
import { customElement, query, state } from "lit/decorators.js";
import type { ImageOpenDetail } from "./ImagePresentation";
import { deepActiveElement, registerRenderedModal, type RenderedModalRegistration } from "./modalLayerRegistry";
import { uiButtonStyles, uiToolbarStyles } from "./ui/controlStyles";

/** Native image preview; callers own source selection and gallery membership. */
@customElement("pi-web-image-gallery-dialog")
export class ImageGalleryDialog extends LitElement {
  constructor() {
    super();
    stylesheetIntegrationCapability.createController(this);
    new LocalizationController(this);
  }

  @query("dialog") private dialog?: HTMLDialogElement;
  @state() private gallery: { images: readonly ImageOpenDetail[]; index: number } | undefined;
  @state() private browserZoomed = false;
  private viewport: VisualViewport | null | undefined;
  private swipe: { pointerId: number; x: number; y: number } | undefined;
  private navigationFocus: "previous" | "next" | undefined;
  private modalRegistration: RenderedModalRegistration | undefined;

  show(images: readonly ImageOpenDetail[], index = 0): void {
    if (images[index] === undefined) return;
    this.swipe = undefined;
    this.navigationFocus = undefined;
    this.gallery = { images, index };
  }

  readonly close = (): void => {
    this.swipe = undefined;
    this.navigationFocus = undefined;
    if (this.gallery !== undefined) this.gallery = undefined;
  };

  override connectedCallback(): void {
    super.connectedCallback();
    this.viewport = this.ownerDocument.defaultView?.visualViewport;
    this.viewport?.addEventListener("resize", this.onViewportResize);
    this.onViewportResize();
  }

  override disconnectedCallback(): void {
    this.viewport?.removeEventListener("resize", this.onViewportResize);
    this.viewport = undefined;
    this.close();
    if (this.dialog?.open === true) this.dialog.close();
    this.releaseModal();
    super.disconnectedCallback();
  }

  protected override updated(): void {
    this.syncDialog();
  }

  private syncDialog(): void {
    const dialog = this.dialog;
    if (dialog === undefined) return;
    if (this.gallery !== undefined && this.isConnected) {
      if (this.modalRegistration === undefined) {
        const registration = registerRenderedModal({
          element: dialog,
          focus: () => {
            const close = this.renderRoot.querySelector<HTMLElement>(".image-zoom-close");
            (close ?? dialog).focus();
          },
        });
        this.modalRegistration = registration;
        try {
          if (!dialog.open) dialog.showModal();
          registration.focus();
        } catch (error) {
          this.modalRegistration = undefined;
          registration.unregister();
          throw error;
        }
      }
      const navigationFocus = this.navigationFocus;
      this.navigationFocus = undefined;
      if (navigationFocus !== undefined) {
        dialog.querySelector<HTMLButtonElement>(`[data-navigation="${navigationFocus}"]`)?.focus();
      }
      return;
    }
    if (dialog.open) dialog.close();
    this.releaseModal();
  }

  private releaseModal(): void {
    const registration = this.modalRegistration;
    this.modalRegistration = undefined;
    registration?.unregister();
  }

  private move(direction: -1 | 1): void {
    const gallery = this.gallery;
    if (gallery === undefined) return;
    const index = gallery.index + direction;
    if (index < 0 || index >= gallery.images.length) return;
    const active = deepActiveElement(this.ownerDocument);
    if (index === 0 && active === this.dialog?.querySelector('[data-navigation="previous"]')) this.navigationFocus = "next";
    else if (index === gallery.images.length - 1 && active === this.dialog?.querySelector('[data-navigation="next"]')) this.navigationFocus = "previous";
    this.gallery = { ...gallery, index };
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Tab") {
      const buttons = [...(this.dialog?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
      const activeIndex = buttons.findIndex((button) => button === deepActiveElement(this.ownerDocument));
      if (activeIndex === -1 || (event.shiftKey ? activeIndex === 0 : activeIndex === buttons.length - 1)) {
        event.preventDefault();
        (event.shiftKey ? buttons.at(-1) : buttons[0])?.focus();
      }
      return;
    }
    if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
    event.preventDefault();
    event.stopPropagation();
    this.move((event.key === "ArrowLeft") !== (localization.direction === "rtl") ? -1 : 1);
  };

  private readonly onViewportResize = (): void => {
    // At native pinch zoom, horizontal drags belong to the browser, not gallery navigation.
    this.browserZoomed = (this.viewport?.scale ?? 1) > 1;
    if (this.browserZoomed) this.swipe = undefined;
  };

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (event.pointerType !== "touch") return;
    this.onViewportResize();
    if (!event.isPrimary || this.browserZoomed) { this.swipe = undefined; return; }
    this.swipe = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
    if (event.currentTarget instanceof HTMLElement) event.currentTarget.setPointerCapture(event.pointerId);
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    this.onViewportResize();
    const start = this.swipe;
    if (start?.pointerId !== event.pointerId) return;
    this.swipe = undefined;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    if (Math.abs(dx) >= 48 && Math.abs(dx) > Math.abs(dy) * 1.5) this.move((dx > 0) !== (localization.direction === "rtl") ? -1 : 1);
  };

  private readonly onDialogClick = (event: MouseEvent): void => {
    if (event.target === this.dialog) this.close();
  };

  override render() {
    const gallery = this.gallery;
    const image = gallery?.images[gallery.index];
    return html`
      <dialog class="image-zoom" aria-label=${imageMessages.t("preview")} aria-describedby="image-gallery-position"
        @keydown=${this.onKeyDown} @click=${this.onDialogClick} @close=${this.close} @cancel=${this.close}>
        ${gallery === undefined || image === undefined ? null : html`
          <div class="image-gallery-header ui-toolbar ui-toolbar--primary">
            <span id="image-gallery-position" class="image-gallery-position ui-toolbar-title" role="status" aria-live="polite" aria-atomic="true">${imageMessages.t("position", { index: gallery.index + 1, count: gallery.images.length })}</span>
            <div class="ui-toolbar-group"><button type="button" class="image-zoom-close ui-button ui-button--icon" aria-label=${imageMessages.t("close")} title=${imageMessages.t("close")} @click=${this.close}>×</button></div>
          </div>
          <div class="image-gallery-stage" ?data-browser-zoomed=${this.browserZoomed} @pointerdown=${this.onPointerDown} @pointerup=${this.onPointerUp} @pointercancel=${() => { this.swipe = undefined; }}>
            <img class="image-zoom-full" src=${image.src} alt=${image.alt} decoding="async" draggable="false" />
          </div>
          ${gallery.images.length < 2 ? null : html`
            <div class="image-gallery-navigation ui-toolbar ui-toolbar--primary ui-toolbar--borderless">
              <button type="button" class="ui-button" data-navigation="previous" aria-label=${imageMessages.t("previousImage")} ?disabled=${gallery.index === 0} @click=${() => { this.move(-1); }}>${imageMessages.t("previous")}</button>
              <button type="button" class="ui-button" data-navigation="next" aria-label=${imageMessages.t("nextImage")} ?disabled=${gallery.index === gallery.images.length - 1} @click=${() => { this.move(1); }}>${imageMessages.t("next")}</button>
            </div>
          `}
        `}
      </dialog>
    `;
  }

  static override styles = [uiButtonStyles, uiToolbarStyles, css`
    dialog.image-zoom { position: fixed; inset: 0; margin: auto; box-sizing: border-box; width: min(1100px, calc(100vw - 32px - env(safe-area-inset-left) - env(safe-area-inset-right))); height: min(900px, calc(100dvh - 32px - env(safe-area-inset-top) - env(safe-area-inset-bottom))); max-width: none; max-height: none; padding: 0; border: 1px solid var(--pi-border); border-radius: 0; color: var(--pi-text); background: var(--pi-bg); overflow: hidden; }
    dialog.image-zoom[open] { display: flex; flex-direction: column; }
    dialog.image-zoom::backdrop { background: var(--pi-overlay); }
    .image-gallery-header { border-bottom-color: var(--pi-border); }
    .image-gallery-position { padding-inline: 12px; min-width: 0; overflow-wrap: anywhere; white-space: normal; }
    .image-gallery-stage { flex: 1 1 auto; min-width: 0; min-height: 0; display: flex; align-items: center; justify-content: center; overflow: hidden; background: var(--pi-surface); touch-action: pan-y pinch-zoom; }
    .image-gallery-stage[data-browser-zoomed] { touch-action: pan-x pan-y pinch-zoom; }
    .image-zoom-full { display: block; width: 100%; height: 100%; min-width: 0; min-height: 0; object-fit: contain; }
    .image-gallery-navigation { border-top: 1px solid var(--pi-border); }
    .image-gallery-navigation .ui-button { flex: 1 1 0; min-width: 0; white-space: normal; overflow-wrap: anywhere; }
  `];
}
