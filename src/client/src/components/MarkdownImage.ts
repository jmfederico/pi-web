import { stylesheetIntegrationCapability } from "../plugins/styles";
import { LitElement, css, html, type PropertyValues } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { ImageDimensions } from "../../../shared/sessionMedia";
import { readMarkdownImageDimensions, rememberMarkdownImageDimensions } from "../formatting/markdownImageDimensions";
import { TransientChoiceMemory } from "../formatting/transientChoiceMemory";
import "./ImagePresentation";

const shownImageMemory = new TransientChoiceMemory<true>();

/** An outside-workspace URL stays inert until the user chooses to load it. */
@customElement("pi-web-markdown-image")
export class MarkdownImage extends LitElement {
  constructor() {
    super();
    stylesheetIntegrationCapability.createController(this);
  }

  @property({ attribute: "preview-url" }) previewUrl = "";
  @property() path = "";
  @property() description = "";
  @property({ attribute: "intent-key" }) intentKey: string | undefined;
  @property({ type: Boolean }) outside = false;
  @property({ type: Boolean, attribute: "loading-disabled" }) loadingDisabled = false;
  @state() private approved = false;
  @state() private dimensions: ImageDimensions | undefined;

  override willUpdate(changed: PropertyValues): void {
    if (changed.has("previewUrl")) this.dimensions = readMarkdownImageDimensions(this.previewUrl);
    if (changed.has("previewUrl") || changed.has("intentKey") || changed.has("outside")) {
      this.approved = this.outside && this.intentKey !== undefined
        && shownImageMemory.read(this.intentKey, this.previewUrl) === true;
    }
  }

  private showImage(): void {
    if (this.loadingDisabled || !this.outside || this.previewUrl === "") return;
    this.approved = true;
    if (this.intentKey !== undefined) shownImageMemory.choose(this.intentKey, this.previewUrl, true);
  }

  private readonly rememberDimensions = (source: string, dimensions: ImageDimensions): void => {
    // Metadata cannot approve an outside image or outlive a source/permission change.
    if (source !== this.previewUrl || this.loadingDisabled || (this.outside && !this.approved)) return;
    rememberMarkdownImageDimensions(source, dimensions);
    if (this.dimensions?.width !== dimensions.width || this.dimensions.height !== dimensions.height) {
      this.dimensions = dimensions;
    }
  };

  override render() {
    return html`<pi-web-image-presentation
      .source=${!this.loadingDisabled && this.previewUrl !== "" && (!this.outside || this.approved) ? this.previewUrl : undefined}
      .dimensions=${this.dimensions} .onIntrinsicDimensions=${this.rememberDimensions}
      .requestDisabled=${this.loadingDisabled || !this.outside || this.previewUrl === ""}
      .pendingLabel=${this.loadingDisabled ? "Image loading disabled" : "Show image"}
      .description=${this.description} .label=${this.path}
      @image-request=${() => { this.showImage(); }}
    ></pi-web-image-presentation>`;
  }

  static override styles = css`
    :host { display: inline-block; max-width: 100%; vertical-align: middle; }
  `;
}
