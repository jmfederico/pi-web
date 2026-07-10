import type { SessionInfo } from "../api";
import { browserLocalStorage, parseStoredString, PersistentValueMap, type KeyValueStorage } from "./sessionStorageMemory";

export interface SessionSelectionMemory {
  latestSessionId(cwd: string): string | undefined;
  rememberSession(session: SessionInfo): void;
  forgetWorkspace(cwd: string): void;
}

export class InMemorySessionSelectionMemory implements SessionSelectionMemory {
  private readonly sessionIdsByCwd = new Map<string, string>();

  latestSessionId(cwd: string): string | undefined {
    return this.sessionIdsByCwd.get(cwd);
  }

  rememberSession(session: SessionInfo): void {
    this.sessionIdsByCwd.set(session.cwd, session.id);
  }

  forgetWorkspace(cwd: string): void {
    this.sessionIdsByCwd.delete(cwd);
  }
}

const sessionSelectionStorageKey = "pi-web:session-selection:v1";

export class SessionStorageSessionSelectionMemory implements SessionSelectionMemory {
  private readonly sessionIdsByCwd: PersistentValueMap<string>;

  constructor(storage: KeyValueStorage | undefined = browserLocalStorage()) {
    this.sessionIdsByCwd = new PersistentValueMap(sessionSelectionStorageKey, parseStoredString, storage);
  }

  latestSessionId(cwd: string): string | undefined {
    return this.sessionIdsByCwd.get(cwd);
  }

  rememberSession(session: SessionInfo): void {
    this.sessionIdsByCwd.set(session.cwd, session.id);
  }

  forgetWorkspace(cwd: string): void {
    this.sessionIdsByCwd.delete(cwd);
  }
}

export function selectPreferredSession(sessions: SessionInfo[], options?: { targetSessionId?: string | undefined; latestSessionId?: string | undefined }): SessionInfo | undefined {
  const targetSessionId = options?.targetSessionId;
  if (targetSessionId !== undefined && targetSessionId !== "") return sessionByIdOrPrefix(sessions, targetSessionId);

  const latestSessionId = options?.latestSessionId;
  if (latestSessionId !== undefined && latestSessionId !== "") return sessions.find((session) => session.id === latestSessionId) ?? sessions.find((session) => session.archived !== true);

  return sessions.find((session) => session.archived !== true);
}

export function shouldDeselectAfterArchivedCollapse(sessions: SessionInfo[], selectedSession: SessionInfo | undefined): boolean {
  if (selectedSession?.archived !== true) return false;
  return !sessions.some((session) => session.archived !== true);
}

function sessionByIdOrPrefix(sessions: SessionInfo[], sessionId: string): SessionInfo | undefined {
  return sessions.find((session) => session.id === sessionId || session.id.startsWith(sessionId));
}

export type ArchiveSelectionChange =
  | { type: "unchanged" }
  | { type: "select"; session: SessionInfo }
  | { type: "clear" };

export function markSessionArchived(sessions: SessionInfo[], sessionId: string, archivedAt: string): SessionInfo[] {
  return markSessionsArchived(sessions, [sessionId], archivedAt);
}

export function markSessionsArchived(sessions: SessionInfo[], sessionIds: readonly string[], archivedAt: string): SessionInfo[] {
  const archivedIds = new Set(sessionIds);
  return sessions.map((session) => archivedIds.has(session.id) ? { ...session, archived: true, archivedAt } : session);
}

export function selectionAfterArchivingSession(sessions: SessionInfo[], selectedSessionId: string | undefined, archivedSessionId: string): ArchiveSelectionChange {
  return selectionAfterArchivingSessions(sessions, selectedSessionId, [archivedSessionId]);
}

export function selectionAfterArchivingSessions(sessions: SessionInfo[], selectedSessionId: string | undefined, archivedSessionIds: readonly string[]): ArchiveSelectionChange {
  if (selectedSessionId === undefined || !archivedSessionIds.includes(selectedSessionId)) return { type: "unchanged" };

  const archivedIds = new Set(archivedSessionIds);
  const nextSession = sessions.find((session) => !archivedIds.has(session.id) && session.archived !== true);
  return nextSession === undefined ? { type: "clear" } : { type: "select", session: nextSession };
}
