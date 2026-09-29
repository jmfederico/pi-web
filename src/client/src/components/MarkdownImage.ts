import { LitElement, css, html, type PropertyValues } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { TransientChoiceMemory } from "../formatting/transientChoiceMemory";

const shownImageMemory = new TransientChoiceMemory<true>();

/** An outside-workspace URL stays inert until the user chooses to load it. */
@customElement("pi-web-markdown-image")
export class MarkdownImage extends LitElement {
  @property({ attribute: "preview-url" }) previewUrl = "";
  @property() path = "";
  @property() description = "";
  @property({ attribute: "intent-key" }) intentKey: string | undefined;
  @property({ type: Boolean }) outside = false;
  @state() private approved = false;
  @state() private failed = false;

  override willUpdate(changed: PropertyValues): void {
    if (changed.has("previewUrl") || changed.has("intentKey") || changed.has("outside")) {
      this.approved = this.outside && this.intentKey !== undefined
        && shownImageMemory.read(this.intentKey, this.previewUrl) === true;
      this.failed = false;
    }
  }

  override render() {
    const visible = !this.outside || this.approved;
    return html`
      ${!visible ? html`<button class="placeholder" type="button" @click=${(event: MouseEvent) => { event.preventDefault(); event.stopPropagation(); this.approved = true; if (this.intentKey !== undefined) shownImageMemory.choose(this.intentKey, this.previewUrl, true); }}>
        <span>Show image</span><code>${this.path}</code>
      </button>` : null}
      ${visible && !this.failed ? html`<img src=${this.previewUrl} alt=${this.description} @error=${() => { this.failed = true; }} />` : null}
      ${visible && this.failed ? html`<span role="status">Image unavailable: the file may be missing, inaccessible, unsupported, or too large.</span>
        <code>${this.path}</code>
        <button type="button" @click=${(event: MouseEvent) => { event.preventDefault(); event.stopPropagation(); this.failed = false; }}>Retry</button>` : null}
    `;
  }

  static override styles = css`
    :host { display: inline-block; max-width: 100%; vertical-align: middle; }
    code, [role="status"] { display: block; margin-bottom: .35em; }
    code { overflow-wrap: anywhere; font-size: .85em; }
    [role="status"] { color: var(--pi-text-secondary); font-size: .9em; }
    .placeholder { display: block; max-width: 100%; padding: 1em; border-style: dashed; text-align: center; }
    .placeholder code { margin: .5em 0 0; color: var(--pi-text-secondary); }
    button { font: inherit; color: inherit; background: var(--pi-surface); border: 1px solid var(--pi-border, #888); border-radius: 4px; padding: .3em .65em; cursor: pointer; margin-bottom: .5em; }
    img { display: block; max-width: 100%; height: auto; }
  `;
}
