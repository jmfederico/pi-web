import type { ContentRendererInputV5 as ContentRendererInput, StylesheetIntegrationCapabilityV1, SyntaxHighlightToken } from "@jmfederico/pi-web/plugin-api";
import { html, LitElement, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import { HighlightedCode } from "./HighlightedCode";

/** Render validated semantic tokens as text; grammar plugins never supply markup or styles. */
export class TokenHighlightedCode extends LitElement {
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
  @property({ attribute: false }) highlight: ((text: string, signal: AbortSignal) => Promise<readonly SyntaxHighlightToken[] | undefined>) | undefined;
  @state() private tokens: readonly SyntaxHighlightToken[] = [];
  private controller: AbortController | undefined;

  override connectedCallback(): void {
    super.connectedCallback();
    if (this.renderRoot instanceof ShadowRoot) this.releaseStyles ??= this.integration?.registerRoot(this.renderRoot);
    this.requestUpdate("input");
  }

  override disconnectedCallback(): void {
    this.controller?.abort();
    this.releaseStyles?.();
    this.releaseStyles = undefined;
    super.disconnectedCallback();
  }

  protected override willUpdate(changes: PropertyValues<this>): void {
    if (!changes.has("input") && !changes.has("highlight")) return;
    this.controller?.abort();
    this.tokens = [];
    const input = this.input;
    const highlight = this.highlight;
    if (!this.isConnected || input === undefined || highlight === undefined) return;
    const controller = new AbortController();
    this.controller = controller;
    const signal = AbortSignal.any([input.signal, controller.signal]);
    void Promise.resolve().then(() => {
      signal.throwIfAborted();
      return highlight(input.text, signal);
    }).then((tokens) => {
      if (signal.aborted) return;
      if (tokens === undefined) throw new Error("Syntax highlighter is no longer available");
      this.tokens = tokens;
    }).catch((error: unknown) => {
      if (!signal.aborted) input.fail(error);
    });
  }

  override render() {
    const text = this.input?.text ?? "";
    let end = 0;
    const parts = this.tokens.map(({ from, to, kind }) => {
      const gap = text.slice(end, from);
      end = to;
      const tokenClass = kind === "function" || kind === "property" ? "title" : kind === "operator" ? "keyword" : kind;
      return html`${gap}<span class=${`hljs-${tokenClass}`}>${text.slice(from, to)}</span>`;
    });
    return html`<pre><code>${parts}${text.slice(end)}</code></pre>`;
  }

  static override styles = HighlightedCode.styles;
}
