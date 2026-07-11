import type { SessionActivity, SessionInfo, SessionStatus } from "./api";
import { isSessionActive } from "../../shared/activity";
import { shortSessionId } from "./sessionLabels";

const BRAND = "PI WEB";

/**
 * Derive the browser document title from the current session state.
 *
 * - No session selected: `PI WEB`
 * - Active (streaming/busy) session: `● {label} — PI WEB`
 * - Archived session: `{label} (archived) — PI WEB`
 * - Regular session: `{label} — PI WEB`
 */
export function deriveDocumentTitle(
  session: SessionInfo | undefined,
  status: SessionStatus | undefined,
  activity: SessionActivity | undefined,
): string {
  if (session === undefined) return BRAND;

  const active = isSessionActive(status, activity);
  const archived = session.archived === true;
  const label = sessionLabel(session);
  const prefix = active ? "● " : "";
  const suffix = archived ? " (archived)" : "";

  return `${prefix}${label}${suffix} — ${BRAND}`;
}

function sessionLabel(session: SessionInfo): string {
  const name = session.name?.trim();
  if (name !== undefined && name !== "") return name;

  const firstMessage = session.firstMessage.trim();
  if (firstMessage !== "") return firstMessage;

  return shortSessionId(session.id);
}