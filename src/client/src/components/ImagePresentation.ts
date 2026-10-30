import { LocalizationController } from "../localization/browser";
import { imageMessages } from "../imageMessages";
import { stylesheetIntegrationCapability } from "../plugins/styles";
import { LitElement, css, html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import { styleMap } from "lit/directives/style-map.js";
import { validImageDimensions, type ImageDimensions } from "../../../shared/sessionMedia";
import { uiButtonStyles } from "./ui/controlStyles";

export interface ImageOpenDetail {
  src: string;
  alt: string;
}

/** The owner authorizes sources; the browser owns image loading and failure display. */
@customElement("pi-web-image-presentation")
export class ImagePresentation extends LitElement {
  constructor() {
    super();
    stylesheetIntegrationCapability.createController(this);
    new LocalizationController(this);
  }

  @property({ attribute: false }) source: string | undefined;
  @property({ type: Boolean, reflect: true }) thumbnail = false;
  @property({ attribute: false }) dimensions: ImageDimensions | undefined;
  /** Optional metadata report; loading never changes this component's own state. */
  @property({ attribute: false }) onIntrinsicDimensions: ((source: string, dimensions: ImageDimensions) => void) | undefined;
  /** A callback keeps generated alt text live while an independently owned gallery is open. */
  @property() description: string | (() => string) = "";
  @property() label = "";
  @property({ type: Boolean }) requestDisabled = false;
  @property() pendingLabel: string | undefined;

  private requestImage(event: MouseEvent): void {
    if (this.requestDisabled) return;
    event.preventDefault();
    event.stopPropagation();
    this.dispatchEvent(new Event("image-request", { bubbles: true, composed: true }));
  }

  private reportIntrinsicDimensions(event: Event): void {
    const image = event.currentTarget;
    const source = this.source;
    if (this.onIntrinsicDimensions === undefined || !(image instanceof HTMLImageElement)
      || source === undefined || source === "" || image.getAttribute("src") !== source || !image.complete) return;
    const dimensions = validImageDimensions(image.naturalWidth, image.naturalHeight);
    if (dimensions !== undefined) this.onIntrinsicDimensions(source, dimensions);
  }

  private open(event: Event): void {
    event.preventDefault();
    event.stopPropagation();
    if (this.source === undefined || this.source === "") return;
    const description = this.description;
    this.dispatchEvent(new CustomEvent<ImageOpenDetail>("image-open", {
      detail: { src: this.source, get alt() { return typeof description === "function" ? description() : description; } }, bubbles: true, composed: true,
    }));
  }

  override render() {
    const pending = this.source === undefined || this.source === "";
    const dimensions = this.dimensions;
    const description = typeof this.description === "function" ? this.description() : this.description;
    return html`
      <div class="frame">
        <button class="placeholder ui-button" type="button" ?hidden=${!pending} ?disabled=${this.requestDisabled}
          @click=${(event: MouseEvent) => { this.requestImage(event); }}>
          <span>${this.pendingLabel ?? imageMessages.t("show")}</span>${this.label === "" ? null : html`<code dir="auto">${this.label}</code>`}
        </button>
        <button class="image-button ui-button" type="button" ?hidden=${pending} ?disabled=${pending}
          aria-label=${description === "" ? imageMessages.t("enlargeImage") : imageMessages.t("enlarge", { description })} title=${imageMessages.t("enlargeHint")}
          @click=${(event: MouseEvent) => { this.open(event); }}
          @keydown=${(event: KeyboardEvent) => { if (event.key === "Enter" || event.key === " ") this.open(event); }}>
          <img loading="lazy" decoding="async" src=${pending ? nothing : this.source} alt=${description}
            @load=${(event: Event) => { this.reportIntrinsicDimensions(event); }}
            width=${dimensions?.width ?? nothing} height=${dimensions?.height ?? nothing}
            style=${styleMap(dimensions === undefined ? {} : {
              "--image-width": `${String(dimensions.width)}px`,
              "--image-height": `${String(dimensions.height)}px`,
              "--image-ratio": String(dimensions.width / dimensions.height),
            })} />
        </button>
      </div>
    `;
  }

  static override styles = [uiButtonStyles, css`
    @layer pi-web-base {
    :host { display: block; max-width: 100%; min-width: 0; }
    .frame { max-width: 100%; }
    button { font: inherit; color: inherit; }
    .placeholder { box-sizing: border-box; display: grid; align-content: center; justify-items: center; gap: .5em; width: 320px; max-width: 100%; min-height: 110px; padding: 1em; border: 1px dashed var(--pi-border, #888); border-radius: 4px; background: var(--pi-surface); text-align: center; }
    .placeholder:disabled { cursor: default; }
    code { display: block; max-width: 100%; margin: 0; overflow-wrap: anywhere; color: var(--pi-text-secondary); font-size: .85em; }
    .image-button { display: block; max-width: 100%; padding: 0; border: 0; background: transparent; cursor: zoom-in; }
    [hidden] { display: none !important; }
    img { display: block; max-width: 100%; max-height: var(--pi-image-max-height, none); width: auto; height: auto; object-fit: contain; border-radius: var(--pi-image-radius, 0); }
    /* A definite width plus the declared ratio reserves the final, height-capped
       footprint before lazy loading. CSS still handles narrow viewports. */
    img[width][height] { width: min(var(--image-width), calc(var(--pi-image-max-height, var(--image-height)) * var(--image-ratio))); }
    :host([thumbnail]) .frame { width: 128px; height: 96px; }
    :host([thumbnail]) button { box-sizing: border-box; width: 100%; height: 96px; min-height: 96px; border-radius: 0; padding: 6px; background: var(--pi-surface); }
    :host([thumbnail]) .image-button:hover { background: var(--pi-surface-hover); }
    :host([thumbnail]) .placeholder code { display: none; }
    :host([thumbnail]) img { width: 100%; height: 100%; max-height: none; border-radius: 0; }
    }
  `];
}
