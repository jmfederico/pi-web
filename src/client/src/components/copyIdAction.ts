import { html, type TemplateResult } from "lit";
import { localization } from "../localization/browser";
import { message } from "../localization/service";
import type { DetailCopyController } from "./detailCopy";

const messages = localization.registerMessages("core.copyId", {
  session: message("Copy session ID", "Session identifier copy button"),
  workspace: message("Copy workspace ID", "Workspace identifier copy button"),
  project: message("Copy project ID", "Project identifier copy button"),
  machine: message("Copy machine ID", "Machine identifier copy button"),
});

/** Offer ID copying in Details without displaying the opaque value. */
export function renderCopyIdAction(kind: "session" | "workspace" | "project" | "machine", id: string, copy: DetailCopyController): TemplateResult {
  return html`<div data-id-detail>${copy.render(JSON.stringify([kind, id]), id, messages.t(kind), "menu-item")}</div>`;
}
