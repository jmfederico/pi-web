import type { SessionInfo, SessionStatus } from "./api";
import { isCachedNewSessionInfo } from "./cachedNewSessions";

export type SessionPersistenceState = "persisted" | "transient" | "unknown";

/**
 * All supported runtimes report persisted/transient session state
 * authoritatively, so a missing `persisted` signal is `unknown`, never an
 * implicit "persisted".
 */
export function sessionPersistenceState(session: SessionInfo | undefined, status?: SessionStatus): SessionPersistenceState {
  if (session === undefined) return "unknown";
  const statusPersisted = status?.sessionId === session.id ? status.persisted : undefined;
  const persisted = statusPersisted ?? session.persisted;
  if (persisted === true) return "persisted";
  if (persisted === false || isCachedNewSessionInfo(session)) return "transient";
  return "unknown";
}

export function isArchivableSessionInfo(session: SessionInfo | undefined, status?: SessionStatus): boolean {
  return session !== undefined && session.archived !== true && sessionPersistenceState(session, status) === "persisted";
}

export function isTransientNewSessionInfo(session: SessionInfo | undefined, status?: SessionStatus): boolean {
  return session !== undefined && session.archived !== true && sessionPersistenceState(session, status) === "transient";
}
