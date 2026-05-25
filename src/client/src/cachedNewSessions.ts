import type { SessionInfo } from "./api";

const storageKey = "pi-web:cached-new-sessions:v1";
const markerProperty = "browserCachedNew";
const defaultMachineId = "local";

export type CachedNewSessionInfo = SessionInfo & { browserCachedNew: true; machineId: string };

function browserStorage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

export function rememberCachedNewSession(session: SessionInfo, machineId = defaultMachineId, storage = browserStorage()): void {
  if (session.messageCount !== 0 || session.archived === true) return;
  const sessions = loadCachedNewSessions(storage).filter((candidate) => candidate.id !== session.id || candidate.machineId !== machineId);
  saveCachedNewSessions([markCachedNewSessionInfo(session, machineId), ...sessions], storage);
}

export function markCachedNewSessionInfo(session: SessionInfo, machineId = defaultMachineId): CachedNewSessionInfo {
  return { ...session, browserCachedNew: true, machineId };
}

export function forgetCachedNewSession(sessionId: string, machineId = defaultMachineId, storage = browserStorage()): void {
  const sessions = loadCachedNewSessions(storage).filter((session) => session.id !== sessionId || session.machineId !== machineId);
  saveCachedNewSessions(sessions, storage);
}

export function mergeCachedNewSessions(cwd: string, sessions: SessionInfo[], machineId = defaultMachineId, storage = browserStorage()): SessionInfo[] {
  const sessionIds = new Set(sessions.map((session) => session.id));
  const cachedSessions = loadCachedNewSessions(storage);
  const retainedCachedSessions = cachedSessions.filter((session) => session.machineId !== machineId || !sessionIds.has(session.id));
  if (retainedCachedSessions.length !== cachedSessions.length) saveCachedNewSessions(retainedCachedSessions, storage);
  const cached = retainedCachedSessions.filter((session) => session.machineId === machineId && session.cwd === cwd);
  return [...cached, ...sessions];
}

export function isCachedNewSessionInfo(session: SessionInfo | undefined): session is CachedNewSessionInfo {
  if (session === undefined) return false;
  return hasCachedNewMarker(session) && session.browserCachedNew === true;
}

export function stripCachedNewSessionMarker(session: SessionInfo): SessionInfo {
  return {
    id: session.id,
    path: session.path,
    cwd: session.cwd,
    ...(session.name === undefined ? {} : { name: session.name }),
    created: session.created,
    modified: session.modified,
    messageCount: session.messageCount,
    firstMessage: session.firstMessage,
    ...(session.parentSessionPath === undefined ? {} : { parentSessionPath: session.parentSessionPath }),
    ...("machineId" in session && typeof session.machineId === "string" ? { machineId: session.machineId } : { machineId: defaultMachineId }),
    ...(session.archived === true ? { archived: true } : {}),
    ...(session.archivedAt === undefined ? {} : { archivedAt: session.archivedAt }),
  };
}

export function loadCachedNewSessions(storage = browserStorage()): CachedNewSessionInfo[] {
  try {
    const raw = storage?.getItem(storageKey);
    if (raw === undefined || raw === null || raw === "") return [];
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value.flatMap((candidate) => parseCachedSession(candidate));
  } catch {
    return [];
  }
}

function saveCachedNewSessions(sessions: CachedNewSessionInfo[], storage = browserStorage()): void {
  try {
    if (sessions.length === 0) storage?.removeItem(storageKey);
    else storage?.setItem(storageKey, JSON.stringify(sessions));
  } catch {
    // Ignore localStorage quota/privacy errors.
  }
}

function parseCachedSession(value: unknown): CachedNewSessionInfo[] {
  if (!isRecord(value)) return [];
  const id = stringField(value, "id");
  const path = stringField(value, "path");
  const cwd = stringField(value, "cwd");
  const created = stringField(value, "created");
  const modified = stringField(value, "modified");
  const firstMessage = stringField(value, "firstMessage");
  const messageCount = numberField(value, "messageCount");
  if (id === undefined || path === undefined || cwd === undefined || created === undefined || modified === undefined || firstMessage === undefined || messageCount !== 0) return [];
  const name = optionalStringField(value, "name");
  const parentSessionPath = optionalStringField(value, "parentSessionPath");
  const machineId = optionalStringField(value, "machineId") ?? defaultMachineId;
  return [{
    id,
    path,
    cwd,
    ...(name === undefined ? {} : { name }),
    created,
    modified,
    messageCount,
    firstMessage,
    ...(parentSessionPath === undefined ? {} : { parentSessionPath }),
    machineId,
    browserCachedNew: true,
  }];
}

function hasCachedNewMarker(session: SessionInfo): session is SessionInfo & { browserCachedNew: unknown } {
  return markerProperty in session;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function optionalStringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return value === undefined || typeof value !== "string" ? undefined : value;
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" ? value : undefined;
}
