import type { StylesheetIntegrationCapabilityV1, ContentRendererInput } from "@jmfederico/pi-web/plugin-api";
import { LitElement, css, html, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import type { MermaidContent } from "./mermaidLocalization";
import type { MermaidRenderer } from "./mermaidEngine";

interface Diagram { readonly url: string; readonly width: number; readonly height: number }

export class MermaidPreview extends LitElement {
  private localizedContent: MermaidContent | undefined;
  private releaseLocalization: (() => void) | undefined;

  // Portable machine copies share the element class, not an activation's messages.
  @property({ attribute: false })
  get content(): MermaidContent | undefined { return this.localizedContent; }
  set content(value: MermaidContent | undefined) {
    if (value === this.localizedContent) return;
    this.localizedContent = value;
    this.observeLocalization();
  }

  private observeLocalization(): void {
    this.releaseLocalization?.();
    this.releaseLocalization = this.isConnected
      ? this.localizedContent?.localization.subscribe(() => { this.requestUpdate(); })
      : undefined;
  }

  private integration: StylesheetIntegrationCapabilityV1 | undefined;
  private releaseStyles: (() => void) | undefined;

  @property({ attribute: false })
  get stylesheetIntegration(): StylesheetIntegrationCapabilityV1 | undefined { return this.integration; }
  set stylesheetIntegration(value: StylesheetIntegrationCapabilityV1 | undefined) {
    if (value === this.integration) return;
    this.releaseStyles?.();
    this.releaseStyles = undefined;
    this.integration = value;
    if (this.isConnected && this.renderRoot instanceof ShadowRoot) this.releaseStyles = value?.registerRoot(this.renderRoot);
  }

  @property({ attribute: false }) input: ContentRendererInput | undefined;
  /** The active package's shared engine; previews keep only its static output. */
  @property({ attribute: false }) engine: MermaidRenderer | undefined;
  @state() private diagram: Diagram | undefined;
  private generation = 0;

  protected override updated(changes: PropertyValues<this>): void {
    if (changes.has("input") || changes.has("engine")) void this.draw();
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this.observeLocalization();
    this.requestUpdate();
    if (this.renderRoot instanceof ShadowRoot) this.releaseStyles ??= this.integration?.registerRoot(this.renderRoot);
    if (this.hasUpdated) void this.draw();
  }

  override disconnectedCallback(): void {
    this.releaseLocalization?.();
    this.releaseLocalization = undefined;
    this.releaseStyles?.();
    this.releaseStyles = undefined;
    super.disconnectedCallback();
    this.generation += 1;
    this.diagram = undefined;
  }

  private async draw(): Promise<void> {
    this.diagram = undefined;
    const { input, engine } = this;
    const generation = ++this.generation;
    if (input === undefined || engine === undefined || input.signal.aborted) return;
    const current = () => this.isConnected && !input.signal.aborted && generation === this.generation;
    input.signal.addEventListener("abort", () => { if (generation === this.generation) this.diagram = undefined; }, { once: true });
    try {
      const { svg, width, height } = await engine.render({ text: input.text, width: this.clientWidth || 800, signal: input.signal });
      if (current()) this.diagram = { url: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`, width, height };
    } catch (error) {
      if (current()) input.fail(error);
    }
  }

  override render() {
    if (!this.isConnected || this.content === undefined) return null;
    const messages = this.content.messages;
    // An image cannot run scripts or load resources, even if sanitizing missed something.
    // Explicit dimensions reserve the scaled height before the image decodes.
    return this.diagram === undefined
      ? html`<p role="status">${messages.t("rendering")}</p>`
      : html`<img alt=${messages.t("frameTitle")} src=${this.diagram.url} width=${this.diagram.width} height=${this.diagram.height} decoding="async">`;
  }

  static override styles = css`
    :host { display: block; }
    img { display: block; max-width: 100%; height: auto; margin: auto; background: white; }
    p { color: var(--pi-muted); }
  `;
}
