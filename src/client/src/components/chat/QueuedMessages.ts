import { html, nothing } from "lit";
import type { QueuedSessionMessage } from "../../api";
import { queuedMessageAttachmentLabel, type QueuedMessageAction } from "../../queuedMessageActions";
import type { ChatBehaviors } from "../../chatBehaviors";
import type { ChatContentRendering } from "../../formatting/contentRendering";
import type { MarkdownWorkspaceContext } from "../../formatting/workspaceLinks";
import { renderCopyIcon, renderGoBackIcon, renderTrashIcon } from "../messageActionIcons";
import { renderQueueIcon, renderSteerIcon } from "../promptEditorIcons";

export interface QueuedMessageSection {
  source: "client" | "server";
  heading: string;
  detail: string;
  messages: QueuedSessionMessage[];
}

export function chatQueuedMessageSections(clientQueued: QueuedSessionMessage[], serverQueued: QueuedSessionMessage[]): QueuedMessageSection[] {
  return [
    clientQueued.length === 0 ? undefined : { source: "client", heading: "Queued until session starts", detail: "Will send once the backend session is ready", messages: clientQueued },
    serverQueued.length === 0 ? undefined : { source: "server", heading: "Queued messages", detail: `${String(serverQueued.length)} pending`, messages: serverQueued },
  ].filter((section): section is QueuedMessageSection => section !== undefined);
}

export function chatQueuedSectionShowsClearAction(section: QueuedMessageSection, hasClearHandler: boolean): boolean {
  return section.source === "server" && hasClearHandler;
}

export interface QueuedMessagesOptions {
  machineId: string;
  sessionId: string;
  behaviors: ChatBehaviors;
  contentRendering: ChatContentRendering | undefined;
  workspaceContext: MarkdownWorkspaceContext | undefined;
  pending: boolean;
  unavailable: string | undefined;
  onClear: (() => void) | undefined;
  onCopy: (text: string) => void;
  onAction: ((action: QueuedMessageAction, index: number, messages: QueuedSessionMessage[]) => void) | undefined;
}

/** Templates deliberately share the transcript root: layout and scroll observation stay with ChatView. */
export function renderQueuedMessageSection(section: QueuedMessageSection, options: QueuedMessagesOptions) {
  const unavailable = section.source === "server" ? options.unavailable : undefined;
  const reason = unavailable === undefined ? undefined : unavailable === "" ? "Individual queue controls are unavailable with this runtime." : unavailable;
  const disabled = options.pending || unavailable !== undefined;
  return html`
    <aside class="queued-messages ui-transcript-surface" aria-live="polite">
      <div class="queued-header">
        <div class="queued-heading"><strong>${section.heading}</strong><small>${section.detail}</small></div>
        ${chatQueuedSectionShowsClearAction(section, options.onClear !== undefined) ? html`
          <button type="button" class="queued-clear-button ui-button ui-button--icon ui-button--compact" ?disabled=${options.pending} aria-label="Clear queue" title="Clear queued messages without stopping active work" @click=${options.onClear}>${renderTrashIcon()}</button>
        ` : nothing}
      </div>
      ${reason === undefined ? nothing : html`<small role="status">${reason}</small>`}
      ${section.messages.map((message, index) => html`
        <div class="queued-message">
          <div class="queued-message-header">
            <div class="queued-message-meta">
              <span class="queued-kind">${message.kind === "steer" ? "Steer" : "Queue"} ${String(section.messages.slice(0, index + 1).filter((entry) => entry.kind === message.kind).length)}</span>
              ${queuedMessageAttachmentLabel(message) === undefined ? nothing : html`<span class="queued-attachments" title="Attachments included with this queued message"><span aria-hidden="true">📎</span> ${queuedMessageAttachmentLabel(message)}</span>`}
            </div>
            <div class="queued-message-actions ui-toolbar-group">
              <button type="button" class="queued-action ui-button ui-button--icon ui-button--compact" aria-label="Copy queued message" title="Copy message" @click=${() => { options.onCopy(message.text); }}>${renderCopyIcon()}</button>
              ${section.source !== "server" || options.onAction === undefined ? nothing : html`
                <button type="button" class="queued-action ui-button ui-button--icon ui-button--compact" ?disabled=${disabled} title=${reason ?? (message.kind === "steer" ? "Move to the end of the follow-up queue" : "Move to the end of the steering queue")} aria-label=${message.kind === "steer" ? "Switch to Queue" : "Switch to Steer"} @click=${() => { options.onAction?.("toggle", index, section.messages); }}>${message.kind === "steer" ? renderQueueIcon() : renderSteerIcon()}</button>
                <button type="button" class="queued-action ui-button ui-button--icon ui-button--compact" ?disabled=${disabled} aria-label="Recall queued message" title=${reason ?? "Recall this message's text and clear later queued messages"} @click=${() => { options.onAction?.("edit", index, section.messages); }}>${renderGoBackIcon()}</button>
                <button type="button" class="queued-action ui-button ui-button--icon ui-button--compact" ?disabled=${disabled} aria-label="Remove queued message" title=${reason ?? "Remove only this message"} @click=${() => { options.onAction?.("remove", index, section.messages); }}>${renderTrashIcon()}</button>
              `}
            </div>
          </div>
          <formatted-text .imagesEnabled=${options.behaviors.loadImages} .codeBlocks=${options.behaviors.codeBlocks} .intentKey=${JSON.stringify([options.machineId, options.sessionId, "queue", section.source, index, message.kind])} .contentRendering=${options.contentRendering} .machineId=${options.machineId} .workspaceContext=${options.workspaceContext} .text=${message.text}></formatted-text>
        </div>
      `)}
    </aside>
  `;
}
