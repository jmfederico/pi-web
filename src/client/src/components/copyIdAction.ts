import { html, type TemplateResult } from "lit";
import { writeClipboardText } from "../clipboard";
import { localization } from "../localization/browser";
import { message } from "../localization/service";

const messages = localization.registerMessages("core.copyId", {
  session: message("Copy session ID", "Session action menu clipboard action"),
  workspace: message("Copy workspace ID", "Workspace action menu clipboard action"),
  project: message("Copy project ID", "Project action menu clipboard action"),
  machine: message("Copy machine ID", "Machine action menu clipboard action"),
  failed: message("Unable to copy ID. Try again.", "Clipboard failure alert"),
});

export function renderCopyIdAction(kind: "session" | "workspace" | "project" | "machine", id: string, onCopied: () => void): TemplateResult {
  return html`<button type="button" class="ui-button ui-menu-item" data-copy-id @click=${async () => {
    if (await writeClipboardText(id)) onCopied();
    else window.alert(messages.t("failed"));
  }}>${messages.t(kind)}</button>`;
}
