import type { Extension } from "@codemirror/state";
import type { EditorView as CodeMirrorEditorView } from "@codemirror/view";
import { css, html, LitElement } from "lit";
import { property, query } from "lit/decorators.js";
import { loadFilesViewerDependencies, type FilesViewerDependencies } from "./viewerLoader";

/** Synchronously registered shell that initializes CodeMirror only when raw code is shown. */
export class FilesCodeViewer extends LitElement {
  @property() content = "";
  @property() language: string | undefined;
  @query(".host") private editorHost?: HTMLDivElement;

  private view: CodeMirrorEditorView | undefined;
  private recreateGeneration = 0;

  override firstUpdated(): void {
    void this.recreateEditor();
  }

  override updated(changed: Map<string, unknown>): void {
    if (changed.has("content") || changed.has("language")) void this.recreateEditor();
  }

  override disconnectedCallback(): void {
    this.recreateGeneration += 1;
    this.view?.destroy();
    this.view = undefined;
    super.disconnectedCallback();
  }

  override render() {
    return html`<div class="host"></div>`;
  }

  private async recreateEditor(): Promise<void> {
    const generation = ++this.recreateGeneration;
    const dependencies = await loadFilesViewerDependencies();
    if (generation !== this.recreateGeneration || !this.isConnected || this.editorHost === undefined) return;
    this.view?.destroy();
    this.view = new dependencies.EditorView({
      parent: this.editorHost,
      state: dependencies.EditorState.create({
        doc: this.content,
        extensions: [
          dependencies.lineNumbers(),
          dependencies.keymap.of(dependencies.defaultKeymap),
          dependencies.syntaxHighlighting(dependencies.defaultHighlightStyle, { fallback: true }),
          dependencies.EditorState.readOnly.of(true),
          dependencies.EditorView.editable.of(false),
          dependencies.EditorView.lineWrapping,
          viewerTheme(dependencies),
          ...bidiTextExtensions(dependencies, this.language),
          ...languageExtensions(dependencies, this.language),
        ],
      }),
    });
  }

  static override styles = css`
    :host { display: block; min-height: 0; height: 100%; }
    .host { height: 100%; min-height: 0; overflow: auto; }
  `;
}

function viewerTheme(dependencies: FilesViewerDependencies): Extension {
  return dependencies.EditorView.theme({
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
    ".cm-activeLineGutter": { backgroundColor: "transparent" },
    ".cm-activeLine": { backgroundColor: "transparent" },
    ".cm-content": { caretColor: "transparent" },
    "&.cm-focused": { outline: "none" },
  });
}

function bidiTextExtensions(dependencies: FilesViewerDependencies, language: string | undefined): Extension[] {
  if (language !== "markdown") return [];
  return [
    dependencies.EditorView.contentAttributes.of({ dir: "auto" }),
    dependencies.EditorView.theme({
      ".cm-content": { textAlign: "start" },
      ".cm-line": { unicodeBidi: "plaintext" },
    }),
  ];
}

function languageExtensions(dependencies: FilesViewerDependencies, language: string | undefined): Extension[] {
  switch (language) {
    case undefined: return [];
    case "typescript": return [dependencies.javascriptLanguage({ typescript: true })];
    case "javascript": return [dependencies.javascriptLanguage()];
    case "json": return [dependencies.jsonLanguage()];
    case "markdown": return [dependencies.markdownLanguage()];
    case "css": return [dependencies.cssLanguage()];
    case "html": return [dependencies.htmlLanguage()];
    case "python": return [dependencies.pythonLanguage()];
    case "rust": return [dependencies.rustLanguage()];
    case "go": return [dependencies.goLanguage()];
    case "diff": return [dependencies.StreamLanguage.define(dependencies.diffLanguage)];
    default: return [];
  }
}
