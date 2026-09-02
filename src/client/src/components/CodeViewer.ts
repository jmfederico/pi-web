import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { defaultKeymap } from "@codemirror/commands";
import { syntaxHighlighting, defaultHighlightStyle, StreamLanguage } from "@codemirror/language";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { css as cssLang } from "@codemirror/lang-css";
import { html as htmlLang } from "@codemirror/lang-html";
import { python } from "@codemirror/lang-python";
import { rust } from "@codemirror/lang-rust";
import { go } from "@codemirror/lang-go";
import { diff } from "@codemirror/legacy-modes/mode/diff";
import { LitElement, css, html } from "lit";
import { nix } from "@replit/codemirror-lang-nix";
import { customElement, property, query } from "lit/decorators.js";

@customElement("code-viewer")
export class CodeViewer extends LitElement {
  @property() content = "";
  @property() language: string | undefined;
  @query(".host") private editorHost?: HTMLDivElement;

  private view: EditorView | undefined;

  override firstUpdated(): void {
    this.recreateEditor();
  }

  override updated(changed: Map<string, unknown>): void {
    if (changed.has("content") || changed.has("language")) this.recreateEditor();
  }

  override disconnectedCallback(): void {
    this.view?.destroy();
    this.view = undefined;
    super.disconnectedCallback();
  }

  override render() {
    return html`<div class="host"></div>`;
  }

  private recreateEditor(): void {
    if (!this.editorHost) return;
    this.view?.destroy();
    this.view = new EditorView({
      parent: this.editorHost,
      state: EditorState.create({
        doc: this.content,
        extensions: [
          lineNumbers(),
          keymap.of(defaultKeymap),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          EditorView.lineWrapping,
          viewerTheme,
          ...bidiTextExtensions(this.language),
          ...languageExtensions(this.language),
        ],
      }),
    });
  }

  static override styles = css`
    :host { display: block; min-height: 0; height: 100%; }
    .host { height: 100%; min-height: 0; overflow: auto; }
  `;
}

const viewerTheme = EditorView.theme({
  "&": {
    height: "100%",
    color: "var(--pi-text)",
    backgroundColor: "var(--pi-bg)",
    fontSize: "12px",
  },
  ".cm-scroller": {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
    lineHeight: "1.45",
  },
  ".cm-gutters": {
    backgroundColor: "var(--pi-bg)",
    color: "var(--pi-dim)",
    borderRight: "1px solid var(--pi-border-muted)",
  },
  ".cm-activeLineGutter": {
    backgroundColor: "transparent",
  },
  ".cm-activeLine": {
    backgroundColor: "transparent",
  },
  ".cm-content": {
    caretColor: "transparent",
  },
  "&.cm-focused": {
    outline: "none",
  },
});

const bidiTextTheme = EditorView.theme({
  ".cm-content": {
    textAlign: "start",
  },
  ".cm-line": {
    unicodeBidi: "plaintext",
  },
});

function bidiTextExtensions(language: string | undefined): Extension[] {
  return language === "markdown" ? [EditorView.contentAttributes.of({ dir: "auto" }), bidiTextTheme] : [];
}

function languageExtensions(language: string | undefined): Extension[] {
  if (language === undefined) return [];
  switch (language) {
    case "typescript": return [javascript({ typescript: true })];
    case "javascript": return [javascript()];
    case "json": return [json()];
    case "markdown": return [markdown()];
    case "css": return [cssLang()];
    case "html": return [htmlLang()];
    case "python": return [python()];
    case "rust": return [rust()];
    case "go": return [go()];
    case "diff": return [StreamLanguage.define(diff)];
    case "nix": return [nix()];
    default: return [];
  }
}
