import { css } from "lit";

/** Shared mark appearance; consumers own placement within their rows or controls. */
export const activityIndicatorStyles = css`
  @layer pi-web-base {
    .activity-indicator { flex: 0 0 auto; display: inline-block; width: 7px; height: 7px; background: var(--pi-success); animation: activity-pulse 1s ease-in-out infinite; }
    .activity-indicator.session { border-radius: 50%; background: var(--pi-success); }
    .activity-indicator.intervention-required { box-sizing: border-box; border: 1.5px solid var(--pi-warning); border-radius: 50%; background: transparent; animation: none; }
    .activity-indicator.terminal { border-radius: 2px; background: var(--pi-accent); }
    /* Client-side sending is distinct from daemon-owned work and intervention. */
    .activity-indicator.sending { border-radius: 50%; background: var(--pi-warning); }
    .activity-indicator.unread { border-radius: 50%; background: var(--pi-accent); animation: none; box-shadow: 0 0 0 2px color-mix(in srgb, var(--pi-accent) 20%, transparent); }
    /* Unread stays independent: wrap the activity/intervention mark, not its state. */
    .unread-ring { flex: 0 0 auto; box-sizing: border-box; display: inline-grid; place-items: center; width: 9px; height: 9px; border: 1.5px solid var(--pi-accent); border-radius: 50%; }
    .unread-ring .activity-indicator { width: 5px; height: 5px; }
    @keyframes activity-pulse { 0%, 100% { transform: scale(.75); opacity: .55; } 50% { transform: scale(1.2); opacity: 1; } }
  }
`;
