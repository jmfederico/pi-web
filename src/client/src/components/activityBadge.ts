import { html, type TemplateResult } from "lit";
import { CORE_STATUS_FLAGS, type StatusFlags } from "../../../shared/machineStatus";
import { localization } from "../localization/browser";
import definitions from "./activityBadge.messages";

const messages = localization.registerMessages("core.activityBadge", definitions);

export function interventionRequiredLabel(): string {
  return messages.t("needsInput");
}

/**
 * Activity or intervention signals a row can show. At most one kind renders
 * at a time; intervention takes priority over ordinary work.
 */
export type ActivityIndicatorKind = "session" | "terminal" | "sending" | "intervention-required";

/**
 * Render the single indicator mark for a row.
 *
 * Unread is independent of activity and intervention: pass `unreadLabel` and
 * it renders as a static accent ring around the activity mark (which keeps its
 * own color, shape, and animation), or as a filled static accent dot when the
 * row is idle. Intervention is a static hollow ring, not an unread mark. The label
 * is the flag — pass undefined when the row has nothing unread.
 */
export function renderActivityIndicator(kind: ActivityIndicatorKind | undefined, label = "Active", unreadLabel?: string): TemplateResult | undefined {
  if (kind === "intervention-required") label = interventionRequiredLabel();
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
  if (flags[CORE_STATUS_FLAGS.interventionRequired] === true) return "intervention-required";
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
  return html`<span class="action-activity ui-nav-row-leading">${indicator}</span>`;
}
