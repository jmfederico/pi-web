import { LitElement, css, html } from "lit";
import { property } from "lit/decorators.js";
import type { MarkdownRenderingCapability, StylesheetIntegrationCapabilityV1 } from "../../src/plugin-api";
import { FormattedText } from "../../src/client/src/components/FormattedText";
import { markdownRenderingCapabilityToken } from "../../src/client/src/formatting/markdownRendering";
import { PluginRegistry } from "../../src/client/src/plugins/registry";
import { adaptPublicPlugin } from "../../src/client/src/plugins/publicContext";
import { pluginStyles, stylesheetIntegrationCapabilityToken } from "../../src/client/src/plugins/styles";
import { addThemeStylesheets } from "../../src/client/src/plugins/styleSources";

// This consumer knows only the public capabilities. The host owns parsing,
// sanitization, deferred rendering and invalidation of the mounted document.
class FixtureMarkdownDocument extends LitElement {
  @property({ attribute: false }) markdownRendering: MarkdownRenderingCapability | undefined;
  @property({ attribute: false }) integration: StylesheetIntegrationCapabilityV1 | undefined;
  @property() text = "";
  private release: (() => void) | undefined;

  protected override updated(): void {
    if (this.renderRoot instanceof ShadowRoot) this.release ??= this.integration?.registerRoot(this.renderRoot, { sharedUi: true });
  }

  override disconnectedCallback(): void {
    this.release?.();
    this.release = undefined;
    super.disconnectedCallback();
  }

  override render() {
    return html`${this.markdownRendering?.render({ machineId: "local", text: this.text })}`;
  }

  static override styles = css`:host { display: block; min-width: 0; } pre { overflow-x: auto; }`;
}
customElements.define("fixture-markdown-document", FixtureMarkdownDocument);

const pageStyle = document.createElement("style");
pageStyle.textContent = `
  body { margin: 0; font: 16px system-ui; background: #fff; color: #222; }
  main { max-width: 720px; margin: 16px auto; padding-inline: 16px; }
  nav { display: flex; flex-wrap: wrap; gap: 8px; }
  section { min-width: 0; }
  formatted-text, fixture-markdown-document { display: block; min-width: 0; }
`;
document.head.append(pageStyle);
pluginStyles.registerRoot(document);
const url = new URL("fixture-markdown-extension.css", document.baseURI).href;
addThemeStylesheets([{ url, cssText: `
  .fixture-expression { display: inline-block; box-sizing: border-box; max-width: 100%;
    overflow-x: auto; vertical-align: middle; border: 2px solid rgb(42, 97, 133); }
  .fixture-equation { display: block; width: 720px; white-space: nowrap; }
` }]);
await pluginStyles.setContributions([{ id: "fixture-markdown-style", url }]);

let eligible = true;
const registry = new PluginRegistry({ isContributionEnabled: () => eligible });
let markdownRendering: MarkdownRenderingCapability | undefined;
let integration: StylesheetIntegrationCapabilityV1 | undefined;
await registry.register({ id: "fixture-markdown", plugin: adaptPublicPlugin({
  apiVersion: 5,
  name: "Markdown fixture",
  requires: [markdownRenderingCapabilityToken, stylesheetIntegrationCapabilityToken],
  activate: () => ({
    start: ({ capabilities }) => {
      markdownRendering = capabilities.resolve(markdownRenderingCapabilityToken);
      integration = capabilities.resolve(stylesheetIntegrationCapabilityToken);
    },
    contributions: { markdownExtensions: [{
      id: "equation", level: "inline",
      start: (source) => { const index = source.indexOf("[[math:"); return index < 0 ? undefined : index; },
      // Intentionally one fixed fixture syntax, not an alternative Markdown parser.
      tokenize: (source) => source.startsWith("[[math:x]]") ? { raw: "[[math:x]]", text: "x" } : undefined,
      render: () => `<span class="fixture-expression"><span class="fixture-equation"><strong>Equation</strong> <math xmlns="http://www.w3.org/1998/Math/MathML"><msup><mi>x</mi><mn>2</mn></msup><mo>=</mo><mn>1</mn></math> <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 12 12"><path d="M1 6 L5 10 L11 1" stroke="green" fill="none"></path></svg></span></span>`,
    }] },
  }),
}) });

const incomplete = "Inline code: `[[math:x]]`.\n\n```text\n[[math:x]]\n```\n\nStreaming [[math:x";
const chat = new FormattedText();
chat.id = "chat";
chat.machineId = "local";
chat.text = incomplete;
chat.contentRendering = registry.getChatContentRendering("local");
const documentPreview = new FixtureMarkdownDocument();
documentPreview.id = "document";
documentPreview.markdownRendering = markdownRendering;
documentPreview.integration = integration;
documentPreview.text = `${incomplete}]]`;

const main = document.createElement("main");
const nav = document.createElement("nav");
const complete = document.createElement("button");
complete.textContent = "Complete stream";
complete.addEventListener("click", () => { chat.text = `${incomplete}]]`; complete.disabled = true; });
const disable = document.createElement("button");
disable.textContent = "Disable extension";
disable.addEventListener("click", () => {
  eligible = false;
  registry.notifySelectionChanged();
  chat.contentRendering = registry.getChatContentRendering("local");
  disable.disabled = true;
});
nav.append(complete, disable);
main.append(nav);
for (const [title, surface] of [["Chat", chat], ["Document", documentPreview]] as const) {
  const section = document.createElement("section");
  const heading = document.createElement("h2");
  heading.textContent = title;
  section.append(heading, surface);
  main.append(section);
}
document.body.append(main);
window.addEventListener("pagehide", () => { void registry.dispose(); pluginStyles.clear(); }, { once: true });
await Promise.all([chat.updateComplete, documentPreview.updateComplete]);
document.body.dataset["ready"] = "true";
