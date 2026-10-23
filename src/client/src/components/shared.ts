import { svg, type TemplateResult } from "lit";
export type { ChatLine } from "../chatTypes";
import type { SessionWarningSeverity } from "../api";

// Internal import bridge; presentation belongs to the base theme, not component behaviour.
export {
  appStyles, workspacePanelStyles, listStyles, statusBarStyles,
  autocompleteStyles, promptEditorStyles, scrollBoundaryShadow,
} from "../theme/base/shellStyles";

export function renderSessionWarningIcon(severity: SessionWarningSeverity, className: string): TemplateResult {
  if (severity === "error") {
    return svg`
      <svg class=${className} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <circle cx="12" cy="12" r="10"></circle>
        <path d="m15 9-6 6"></path>
        <path d="m9 9 6 6"></path>
      </svg>
    `;
  }
  if (severity === "info") {
    return svg`
      <svg class=${className} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <circle cx="12" cy="12" r="10"></circle>
        <path d="M12 11v5"></path>
        <path d="M12 8h.01"></path>
      </svg>
    `;
  }
  return svg`
    <svg class=${className} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M10.3 3.7 2.2 18a2 2 0 0 0 1.7 3h16.2a2 2 0 0 0 1.7-3L13.7 3.7a2 2 0 0 0-3.4 0Z"></path>
      <path d="M12 9v4"></path>
      <path d="M12 17h.01"></path>
    </svg>
  `;
}

export interface CompletionItem {
  kind: "command" | "file" | "model";
  replaceFrom: number;
  replaceTo: number;
  insertText: string;
  detail: string;
  description?: string;
  /** Pi-style argument hint (e.g. `<PR-URL>`) for commands that declare one. */
  argumentHint?: string;
  cursorOffset?: number;
}
