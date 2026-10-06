import { LitElement, type TemplateResult } from "lit";
import { customElement, property } from "lit/decorators.js";

/** Keep host directives inside the Lit runtime that created them, not a plugin's bundled copy. */
@customElement("pi-web-content-rendering-boundary")
export class ContentRenderingBoundary extends LitElement {
  @property({ attribute: false }) content: TemplateResult | undefined;

  protected override createRenderRoot(): HTMLElement {
    // Keep Markdown in the consumer's styling scope instead of adding a shadow root.
    return this;
  }

  override render(): TemplateResult | undefined {
    return this.content;
  }
}
