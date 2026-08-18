import { html, type TemplateResult } from "lit";
import { CORE_STATUS_FLAGS, type StatusFlags } from "../../../shared/machineStatus";

/**
 * Work signals a row can show. At most one kind renders at a time; call sites
 * resolve precedence (sending > session > terminal) before rendering.
 */
export type ActivityIndicatorKind = "session" | "terminal" | "sending";

/**
 * Render the single indicator mark for a row.
 *
 * Unread is an attention flag, not a work signal, so it never competes with
 * the activity kinds for the slot: pass `unreadLabel` and it renders as a
 * static accent ring around the work dot (which keeps its own color, shape,
 * and pulse), or as a filled static accent dot when the row is idle. The label
 * is the flag — pass undefined when the row has nothing unread.
 */
export function renderActivityIndicator(kind: ActivityIndicatorKind | undefined, label = "Active", unreadLabel?: string): TemplateResult | undefined {
  if (kind === undefined) {
    if (unreadLabel === undefined) return undefined;
    return html`<span class="activity-indicator unread" role="img" aria-label=${unreadLabel} title=${unreadLabel}></span>`;
  }
  if (unreadLabel === undefined) {
    return html`<span class=${`activity-indicator ${kind}`} role="img" aria-label=${label} title=${label}></span>`;
  }
  const combinedLabel = `${unreadLabel} · ${label}`;
  return html`<span class="unread-ring" role="img" aria-label=${combinedLabel} title=${combinedLabel}><span class=${`activity-indicator ${kind}`} aria-hidden="true"></span></span>`;
}

/**
 * Map a status node's flags onto the row's work mark.
 *
 * sessiond rolls the tree up, so a node can carry a flag id this build does
 * not know; such a flag must still light the row rather than blank it, hence
 * the generic session mark. Unread is an attention flag, not work, so it never
 * claims the mark here — call sites pass it to the renderers as a label.
 */
export function statusActivityKind(flags: StatusFlags | undefined): ActivityIndicatorKind | undefined {
  if (flags === undefined) return undefined;
  if (flags[CORE_STATUS_FLAGS.working] === true) return "session";
  if (flags[CORE_STATUS_FLAGS.terminal] === true) return "terminal";
  const hasOtherFlag = Object.entries(flags).some(([flagId, isSet]) => isSet && flagId !== CORE_STATUS_FLAGS.unread);
  return hasOtherFlag ? "session" : undefined;
}

/** Whether a status node carries unread work below it. */
export function hasStatusUnread(flags: StatusFlags | undefined): boolean {
  return flags?.[CORE_STATUS_FLAGS.unread] === true;
}

export function renderActionActivityIndicator(kind: ActivityIndicatorKind | undefined, label = "Active", unreadLabel?: string): TemplateResult | undefined {
  const indicator = renderActivityIndicator(kind, label, unreadLabel);
  if (indicator === undefined) return undefined;
  return html`<span class="action-activity">${indicator}</span>`;
}
