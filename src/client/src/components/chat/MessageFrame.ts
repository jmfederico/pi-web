import { html, nothing, type TemplateResult } from "lit";

interface MessageFrameOptions {
  heading: string | TemplateResult;
  actions?: TemplateResult;
  body?: TemplateResult;
  metadata?: TemplateResult;
  actionPlacement: "corner" | "header";
  /** Only conversation bubbles expose the supported theme anatomy. */
  conversation?: boolean;
}

/** Layout only: callers own content, action policy, and metadata state. */
export function renderMessageFrame({ heading, actions, body, metadata, actionPlacement, conversation = false }: MessageFrameOptions) {
  return html`
    <div class=${`message-frame-content message-frame--${actionPlacement}${conversation ? " conversation-content chat-message-content" : ""}`}>
      <div class=${`message-frame-header msg-header${conversation ? " conversation-header chat-message-header" : ""}`}>
        <span class=${actionPlacement === "corner" ? "visually-hidden" : "label"}>${heading}</span>
        ${actions}
      </div>
      ${body === undefined ? nothing : html`<div class=${`message-frame-body${conversation ? " conversation-body chat-message-body" : ""}`}>${body}</div>`}
    </div>
    ${metadata}
  `;
}
