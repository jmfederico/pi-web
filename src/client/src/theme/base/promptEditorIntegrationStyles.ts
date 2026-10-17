import { css } from "lit";

/**
 * CodeMirror injects unlayered defaults into its shadow root. These narrowly
 * scoped integration rules must compete in that same cascade, not below it.
 * Appearance still comes from theme properties; surrounding layout stays layered.
 */
export const promptEditorIntegrationStyles = css`
  .editor-input:has(.editor-chat-navigation) .cm-content { min-height: max(50px, 2.8em); padding-right: 66px; }
  .markdown-editor .cm-editor { box-sizing: border-box; width: 100%; min-height: 54px; max-height: 220px; resize: none; overflow: hidden; border-radius: 0; border: 0; background: var(--pi-bg); color: var(--pi-text); font: var(--pi-control-font-size, 16px)/1.4 var(--pi-control-font-family, var(--pi-font, system-ui, sans-serif)); padding-block: 12px; }
  .markdown-editor .cm-scroller { max-height: 196px; overflow-y: auto; font-family: var(--pi-control-font-family, var(--pi-font, system-ui, sans-serif)); line-height: 1.4; }
  .markdown-editor .cm-content { min-height: 2.8em; padding: 0 52px 0 16px; caret-color: var(--pi-text); text-align: start; unicode-bidi: plaintext; }
  .markdown-editor .cm-line { padding: 0; unicode-bidi: plaintext; }
  .markdown-editor .cm-placeholder { color: var(--pi-dim); }
  .markdown-editor .prompt-placeholder::before { content: attr(data-placeholder); display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; }
  .markdown-editor .cm-argument-hint { color: var(--pi-dim); pointer-events: none; }
  .markdown-editor .cm-focused { outline: none; }
  /* drawSelection() supplies its own caret/selection; match the selected palette
     rather than CodeMirror's light defaults, including its focused selection. */
  .markdown-editor .cm-cursor { border-left-color: var(--pi-text); }
  .markdown-editor .cm-editor .cm-selectionBackground { background: color-mix(in srgb, var(--pi-text) 18%, transparent); }
  .markdown-editor .cm-editor.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground { background: color-mix(in srgb, var(--pi-accent) 32%, transparent); }
  .shell-mode .markdown-editor .cm-editor { background: var(--pi-success-bg); }
  .markdown-editor-disabled .cm-editor { opacity: .5; cursor: not-allowed; }
`;
