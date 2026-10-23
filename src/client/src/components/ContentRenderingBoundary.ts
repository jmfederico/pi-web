import { LitElement, html, type PropertyValues, type TemplateResult } from "lit";
import { customElement, property } from "lit/decorators.js";
import { VisibleContentController } from "../formatting/deferredContent";

/** Keep host directives inside their Lit runtime; plugin callers only pass plain templates. */
@customElement("pi-web-content-rendering-boundary")
export class ContentRenderingBoundary extends LitElement {
  @property() source = "";
  @property({ attribute: false }) renderContent: (() => TemplateResult) | undefined;
  private content: TemplateResult | undefined;
  private displayedSource = "";
  private dirty = true;
  private scheduled = false;
  private readonly enhancement = new VisibleContentController(this, () => { this.requestUpdate(); },
    () => this.querySelector(".content-rendering-body") ?? undefined);

  protected override createRenderRoot(): HTMLElement {
    // Keep Markdown in the consumer's styling scope instead of adding a shadow root.
    return this;
  }

  protected override willUpdate(changes: PropertyValues<this>): void {
    if (!changes.has("source") && !changes.has("renderContent")) return;
    this.enhancement.cancel();
    this.scheduled = false;
    this.dirty = true;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this.requestUpdate();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.scheduled = false;
  }

  protected override updated(): void {
    if (!this.dirty || this.scheduled || this.renderContent === undefined) return;
    this.scheduled = true;
    this.enhancement.request(() => {
      try {
        this.content = this.renderContent?.();
        this.displayedSource = this.source;
      } catch (error) {
        console.warn("Markdown content enhancement failed; source remains available", error);
      }
      // Do not retry a failing contribution on every unrelated host update.
      this.scheduled = false;
      this.dirty = false;
      this.requestUpdate();
    });
  }

  override render(): TemplateResult {
    const continuation = this.source.startsWith(this.displayedSource);
    return html`<div class="content-rendering-body"><div style=${continuation ? "display: contents" : "display: none"}>${this.content}</div><span style="white-space: pre-wrap; overflow-wrap: anywhere">${this.source.slice(continuation ? this.displayedSource.length : 0)}</span></div>`;
  }
}
