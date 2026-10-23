import { css } from "lit";

export const conversationLayoutStyles = css`
  @layer pi-web-base {
    :host { display: flex; flex-direction: column; flex: 1 1 auto; min-width: 0; min-height: 0; isolation: isolate; }
    :host([hidden]) { display: none; }
    .transcript { display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; min-width: 0; isolation: isolate; }
    ::slotted(chat-view) { flex: 1 1 auto; min-height: 0; min-width: 0; }
    .composer-boundary { position: relative; flex: 0 0 auto; min-width: 0; }
    ::slotted([slot="composer"]) { isolation: isolate; }
    ::slotted([slot="status"]) { flex: 0 0 auto; }
    /* Only this decoration crosses the boundary, never the whole transcript. */
    .activity-region { position: absolute; top: -9px; inset-inline: 8px; z-index: 1; display: flex; justify-content: center; pointer-events: none; }
    .activity-dock { display: flex; align-items: center; gap: 4px; max-width: 100%; height: 18px; min-width: 0; box-sizing: border-box; background: var(--pi-success-surface); color: var(--pi-text); padding: 1px 6px; font: 11px/16px var(--pi-font, system-ui, sans-serif); }
    .activity-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .dot { width: 5px; height: 5px; border-radius: 50%; background: var(--pi-success); flex: 0 0 auto; animation: pulse 1s ease-in-out infinite; }
    .plain .dot { animation: none; }
    @media (prefers-reduced-motion: reduce) { .dot { animation: none; } }
    @keyframes pulse { 0%, 100% { transform: scale(.75); opacity: .55; } 50% { transform: scale(1.2); opacity: 1; } }
  }
`;
