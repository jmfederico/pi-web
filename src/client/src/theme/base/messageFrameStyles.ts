import { css } from "lit";

// Message layout is independent of whether the frame sits in a group or a reply.
export const messageFrameStyles = css`
  @layer pi-web-base {
  .message-frame-content { position: relative; isolation: isolate; min-width: 0; }
  .message-frame-header { display: flex; align-items: center; justify-content: space-between; gap: 10px; min-height: 28px; margin-bottom: 4px; padding: var(--message-frame-header-padding, 0); }
  .message-frame-body { min-width: 0; box-sizing: border-box; }
  .message-frame--corner > .message-frame-header { position: absolute; inset-block-end: 0; inset-inline-end: 0; z-index: 6; min-height: 0; margin: 0; padding: 0; }
  .message-frame--corner > .message-frame-body { min-height: 28px; }
  .message-frame-meta { padding: var(--message-frame-meta-padding, 6px 0); }
  }
`;
