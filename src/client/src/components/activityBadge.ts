import { html, type TemplateResult } from "lit";
import { CORE_STATUS_FLAGS, type StatusFlags } from "../../../shared/machineStatus";
import { localization } from "../localization/browser";
import definitions from "./activityBadge.messages";

const messages = localization.registerMessages("core.activityBadge", definitions);

export function interventionRequiredLabel(): string {
  return messages.t("needsInput");
}

/**
 * Primary signal for navigation state hooks. Intervention takes priority,
 * but its ring can contain a separate work mark.
 */
export type ActivityIndicatorKind = "session" | "terminal" | "sending" | "intervention-required";

/**
 * Render the single indicator mark for a row.
 *
 * Unread is independent of activity and intervention: pass `unreadLabel` and
 * it renders as a static accent ring around the activity mark (which keeps its
 * own color, shape, and animation), or as a filled static accent dot when the
 * row is idle. Intervention is a static hollow ring, not an unread mark; pass
 * `workKind` to retain concurrent work inside it. The unread label is the flag
 * — pass undefined when the row has nothing unread.
 */
export function renderActivityIndicator(kind: ActivityIndicatorKind | undefined, label = "Active", unreadLabel?: string, workKind?: "session" | "terminal"): TemplateResult | undefined {
  const interventionWork = kind === "intervention-required" ? workKind : undefined;
  if (kind === "intervention-required") label = interventionWork === undefined ? interventionRequiredLabel() : `${interventionRequiredLabel()} · ${label}`;
  if (kind === undefined) {
    if (unreadLabel === undefined) return undefined;
    return html`<span class="activity-indicator unread" role="img" aria-label=${unreadLabel} title=${unreadLabel}></span>`;
  }
  const markClass = `activity-indicator ${kind}${interventionWork === undefined ? "" : " with-work"}`;
  const innerMark = interventionWork === undefined ? undefined : html`<span class=${`activity-indicator ${interventionWork}`} aria-hidden="true"></span>`;
  if (unreadLabel === undefined) {
    return html`<span class=${markClass} role="img" aria-label=${label} title=${label}>${innerMark}</span>`;
  }
  const combinedLabel = `${unreadLabel} · ${label}`;
  return html`<span class=${`unread-ring${interventionWork === undefined ? "" : " with-intervention-work"}`} role="img" aria-label=${combinedLabel} title=${combinedLabel}><span class=${markClass} aria-hidden="true">${innerMark}</span></span>`;
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
  return statusWorkKind(flags);
}

/** Work remains independent of attention flags, including rolled-up intervention. */
export function statusWorkKind(flags: StatusFlags | undefined): "session" | "terminal" | undefined {
  if (flags === undefined) return undefined;
  if (flags[CORE_STATUS_FLAGS.working] === true) return "session";
  if (flags[CORE_STATUS_FLAGS.terminal] === true) return "terminal";
  const hasOtherFlag = Object.entries(flags).some(([flagId, isSet]) => isSet && flagId !== CORE_STATUS_FLAGS.unread && flagId !== CORE_STATUS_FLAGS.interventionRequired);
  return hasOtherFlag ? "session" : undefined;
}

/** Whether a status node carries unread work below it. */
export function hasStatusUnread(flags: StatusFlags | undefined): boolean {
  return flags?.[CORE_STATUS_FLAGS.unread] === true;
}

export function renderActionActivityIndicator(kind: ActivityIndicatorKind | undefined, label = "Active", unreadLabel?: string, workKind?: "session" | "terminal"): TemplateResult | undefined {
  const indicator = renderActivityIndicator(kind, label, unreadLabel, workKind);
  if (indicator === undefined) return undefined;
  return html`<span class="action-activity ui-nav-row-leading">${indicator}</span>`;
}
