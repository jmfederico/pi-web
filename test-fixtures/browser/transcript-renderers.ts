import { LitElement, html } from "lit";
import { property } from "lit/decorators.js";
import type { StylesheetIntegrationCapabilityV1 } from "../../src/plugin-api";
import { ChatView } from "../../src/client/src/components/ChatView";
import { normalizeMessages } from "../../src/client/src/chatMessages";
import { PluginRegistry } from "../../src/client/src/plugins/registry";
import { adaptPublicPlugin } from "../../src/client/src/plugins/publicContext";
import { pluginStyles, stylesheetIntegrationCapabilityToken } from "../../src/client/src/plugins/styles";
import { addThemeStylesheets } from "../../src/client/src/plugins/styleSources";

// A plugin-owned shadow root, registered through the public capability. The
// renderer also emits light DOM to exercise both stylesheet adoption boundaries.
class FixtureTranscriptCard extends LitElement {
  @property() label = "";
  @property({ attribute: false }) integration: StylesheetIntegrationCapabilityV1 | undefined;
  private release: (() => void) | undefined;
  @property({ type: Number }) clicks = 0;

  protected override updated(): void {
    if (this.renderRoot instanceof ShadowRoot) this.release ??= this.integration?.registerRoot(this.renderRoot, { sharedUi: true });
  }

  override disconnectedCallback(): void {
    this.release?.();
    this.release = undefined;
    super.disconnectedCallback();
  }

  override render() {
    return html`<button class="fixture-action" @click=${() => { this.clicks++; }}>${this.label}: ${this.clicks}</button>`;
  }
}
customElements.define("fixture-transcript-card", FixtureTranscriptCard);

const pageStyle = document.createElement("style");
pageStyle.textContent = `
  body { margin: 0; font-family: system-ui; background: var(--pi-bg); color: var(--pi-text); }
  main { display: flex; flex-direction: column; height: 100dvh; overflow: hidden; }
  nav { padding: 8px; flex: none; }
  chat-view { flex: 1; min-height: 0; min-width: 0; }
`;
document.head.append(pageStyle);
pluginStyles.registerRoot(document);
const cssSource = (id: string, cssText: string) => {
  const url = new URL(`fixture-${id}.css`, document.baseURI).href;
  addThemeStylesheets([{ url, cssText }]);
  return { id, url };
};
const theme = (dark: boolean) => cssSource(dark ? "dark" : "light", `
  :root, :host {
    --pi-bg: ${dark ? "#161616" : "#fafafa"};
    --pi-surface: ${dark ? "#252525" : "#eeeeee"};
    --pi-text: ${dark ? "#eeeeee" : "#222222"};
    --pi-border: #888888; --pi-muted: #777777;
    --pi-accent: ${dark ? "#aabbff" : "#334499"};
  }
`);
const dark = theme(true);
const light = theme(false);
const contribution = cssSource("contribution", `
  .fixture-action { display: block; box-sizing: border-box; max-width: 100%; margin-block: 4px;
    background: var(--pi-surface); color: var(--pi-text); border: 2px solid var(--pi-accent); padding: 8px; }
`);
await pluginStyles.setTheme([dark], () => undefined);
await pluginStyles.setContributions([contribution]);

const registry = new PluginRegistry();
let integration: StylesheetIntegrationCapabilityV1 | undefined;
await registry.register({ id: "fixture", plugin: adaptPublicPlugin({
  apiVersion: 5, name: "Transcript fixture", requires: [stylesheetIntegrationCapabilityToken],
  activate: ({ html }) => ({
    start: ({ capabilities }) => { integration = capabilities.resolve(stylesheetIntegrationCapabilityToken); },
    contributions: { transcriptRenderers: [
      { id: "tool-wrapper", target: "tool", resolve: (name, next) => {
        if (name !== "fixture_tool") return next();
        const downstream = next();
        if (downstream === undefined) return undefined;
        return { render: (input) => {
          const body = downstream.render(input);
          return body === undefined ? undefined : html`<section><p>Plugin annotation</p>${body}</section>`;
        } };
      } },
      { id: "tool", target: "tool", resolve: (name, next) => name !== "fixture_tool" ? next() : { render: () => html`
        <button class="fixture-action" @click=${() => { document.body.dataset["toolClicked"] = "true"; }}>Tool preview action</button>
        <fixture-transcript-card label="Tool card" .integration=${integration}></fixture-transcript-card>` } },
      { id: "core-wrapper", target: "tool", resolve: (name, next) => {
        const downstream = next();
        if (name !== "read" || downstream === undefined) return downstream;
        return { render: (input) => html`<section><p>Core card annotation</p>${downstream.render(input)}</section>` };
      } },
      { id: "card", target: "custom-message", customType: "fixture.card", render: () => html`
        <button class="fixture-action" @click=${() => { document.body.dataset["customClicked"] = "true"; }}>Custom preview action</button>
        <fixture-transcript-card label="Custom card" .integration=${integration}></fixture-transcript-card>` },
    ] },
  }),
}) });
const chat = new ChatView();
chat.sessionId = "fixture";
chat.machineId = "local";
chat.transcriptRenderers = registry.getTranscriptRenderers("local");
chat.messages = normalizeMessages([
  { role: "user", entryId: "request", content: "Show the result." },
  { role: "custom", customType: "fixture.card", entryId: "card", content: "Original custom fallback", details: { state: "ready" } },
  { role: "assistant", entryId: "call", content: [{ type: "toolCall", id: "call", name: "fixture_tool", arguments: {} }] },
  { role: "toolResult", entryId: "tool", toolName: "fixture_tool", toolCallId: "call", content: "Original tool fallback", isError: false },
  { role: "assistant", entryId: "read-call", content: [{ type: "toolCall", id: "read-call", name: "read", arguments: { path: "example.txt" } }] },
  { role: "toolResult", entryId: "read-result", toolName: "read", toolCallId: "read-call", content: "Core fallback output", isError: false },
]);
const main = document.createElement("main");
const nav = document.createElement("nav");
const themeButton = document.createElement("button");
themeButton.textContent = "Switch theme";
themeButton.addEventListener("click", () => { void pluginStyles.setTheme([light], () => { document.body.dataset["theme"] = "light"; }); });
nav.append(themeButton);
main.append(nav, chat);
document.body.append(main);
window.addEventListener("pagehide", () => { void registry.dispose(); pluginStyles.clear(); }, { once: true });
await chat.updateComplete;
document.body.dataset["ready"] = "true";
