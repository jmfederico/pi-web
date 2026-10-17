import type { StylesheetIntegrationCapabilityV1 } from "@jmfederico/pi-web/plugin-api";
import { LitElement, css, html } from "lit";
import { property } from "lit/decorators.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";

/** Markup must come exclusively from highlight.js, which escapes source text. */
export class HighlightedCode extends LitElement {
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

  override connectedCallback(): void {
    super.connectedCallback();
    if (this.renderRoot instanceof ShadowRoot) this.releaseStyles ??= this.integration?.registerRoot(this.renderRoot);
  }

  override disconnectedCallback(): void {
    this.releaseStyles?.();
    this.releaseStyles = undefined;
    super.disconnectedCallback();
  }

  @property({ attribute: false }) markup = "";

  override render() {
    return html`<pre><code>${unsafeHTML(this.markup)}</code></pre>`;
  }

  static override styles = css`
    :host { display: block; color: var(--pi-text); min-width: 0; }
    pre { margin: 0; white-space: pre; text-align: left; direction: ltr; }
    code { font: 13px/1.5 var(--pi-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace); }
    .hljs-comment, .hljs-quote { color: var(--pi-syntax-comment, var(--pi-muted)); font-style: italic; }
    .hljs-keyword, .hljs-selector-tag, .hljs-literal, .hljs-section, .hljs-link { color: var(--pi-syntax-keyword, var(--pi-accent)); }
    .hljs-string, .hljs-regexp, .hljs-addition, .hljs-attribute, .hljs-meta .hljs-string { color: var(--pi-syntax-string, var(--pi-success, #7cba83)); }
    .hljs-number, .hljs-symbol, .hljs-bullet, .hljs-variable, .hljs-template-variable { color: var(--pi-syntax-number, var(--pi-warning, #d5a75b)); }
    .hljs-title, .hljs-built_in, .hljs-type, .hljs-selector-id, .hljs-selector-class { color: var(--pi-syntax-title, var(--pi-accent)); }
    .hljs-meta, .hljs-deletion { color: var(--pi-syntax-deletion, var(--pi-error, var(--pi-danger, #e07b7b))); }
    .hljs-emphasis { font-style: italic; }
    .hljs-strong { font-weight: bold; }
  `;
}
