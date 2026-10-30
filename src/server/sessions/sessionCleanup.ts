import type { SessionCleanupExecuteResponse, SessionCleanupPreviewResponse, SessionCleanupProjectSummary, SessionCleanupThresholds } from "../../shared/apiTypes.js";
import type { PiSessionListEntry } from "./piSessionService.js";
import type { ArchivedSessionRecord, ArchiveSessionInput } from "./sessionArchiveStore.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface CleanupActiveSessionStatus {
  sessionId: string;
  hasActiveWork: boolean;
}

export interface PlanSessionCleanupInput {
  sessions: readonly PiSessionListEntry[];
  archivedRecords: readonly ArchivedSessionRecord[];
  activeSessions?: readonly CleanupActiveSessionStatus[];
  excludedPinnedSessionIds?: readonly string[];
  thresholds: SessionCleanupThresholds;
  projectCwds?: readonly string[];
  now: Date;
}

export interface SessionCleanupPlan extends SessionCleanupPreviewResponse {
  archiveInputs: ArchiveSessionInput[];
  deleteRecords: ArchivedSessionRecord[];
  skippedBusySessionIds: string[];
}

export interface NormalizedSessionCleanupRequest {
  thresholds: SessionCleanupThresholds;
  /** Resolved by the web/API boundary; sessiond must not load navigation preferences. */
  excludedPinnedSessionIds?: string[];
  /** Stored cwd paths to include. Undefined means all discovered projects/workspaces. */
  projectCwds?: string[];
}

export function normalizeSessionCleanupRequest(record: Record<string, unknown>): NormalizedSessionCleanupRequest {
  const projectCwds = optionalProjectCwds(record);
  const skipPinned = record["skipPinned"];
  if (skipPinned !== undefined && typeof skipPinned !== "boolean") throw new Error("skipPinned field must be a boolean");
  let excludedPinnedSessionIds: string[] | undefined;
  if (skipPinned === true) {
    const ids = record["excludedPinnedSessionIds"];
    // A direct daemon request must not silently bypass protection without a web-owned snapshot.
    if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string" && id.trim() !== "")) {
      throw new Error("skipPinned requires resolved excludedPinnedSessionIds");
    }
    excludedPinnedSessionIds = [...new Set(ids)];
  }
  return {
    thresholds: normalizeSessionCleanupThresholds(record),
    ...(excludedPinnedSessionIds === undefined ? {} : { excludedPinnedSessionIds }),
    ...(projectCwds === undefined ? {} : { projectCwds }),
  };
}

export function normalizeSessionCleanupThresholds(record: Record<string, unknown>): SessionCleanupThresholds {
  const thresholds: SessionCleanupThresholds = {};
  const archiveIdleDays = optionalDayThreshold(record, "archiveIdleDays");
  const deleteArchivedDays = optionalDayThreshold(record, "deleteArchivedDays");
  if (archiveIdleDays !== undefined) thresholds.archiveIdleDays = archiveIdleDays;
  if (deleteArchivedDays !== undefined) thresholds.deleteArchivedDays = deleteArchivedDays;
  return thresholds;
}

export function planSessionCleanup(input: PlanSessionCleanupInput): SessionCleanupPlan {
  const thresholds = copyThresholds(input.thresholds);
  const archiveCutoff = cutoffTime(input.now, thresholds.archiveIdleDays);
  const deleteCutoff = cutoffTime(input.now, thresholds.deleteArchivedDays);
  const archivedIds = new Set(input.archivedRecords.map((record) => record.sessionId));
  const includedCwds = input.projectCwds === undefined ? undefined : new Set(input.projectCwds);
  const busySessionIds = new Set((input.activeSessions ?? []).filter((session) => session.hasActiveWork).map((session) => session.sessionId));
  const skippedBusy = new Set<string>();
  const pinnedSessionIds = new Set(input.excludedPinnedSessionIds ?? []);
  const skippedPinned = new Set<string>();
  const archiveInputs: ArchiveSessionInput[] = [];
  const deleteRecords: ArchivedSessionRecord[] = [];

  if (archiveCutoff !== undefined) {
    for (const session of uniqueSessionsById(input.sessions)) {
      if (archivedIds.has(session.id)) continue;
      if (includedCwds !== undefined && !includedCwds.has(session.cwd)) continue;
      if (!isBefore(session.modified, archiveCutoff)) continue;
      if (pinnedSessionIds.has(session.id)) {
        skippedPinned.add(session.id);
        continue;
      }
      if (busySessionIds.has(session.id)) {
        skippedBusy.add(session.id);
        continue;
      }
      archiveInputs.push(archiveInputFromListEntry(session));
    }
  }

  if (deleteCutoff !== undefined) {
    for (const record of input.archivedRecords) {
      if (includedCwds !== undefined && !includedCwds.has(record.cwd)) continue;
      if (!isTimestampBefore(record.archivedAt, deleteCutoff)) continue;
      if (pinnedSessionIds.has(record.sessionId)) {
        skippedPinned.add(record.sessionId);
        continue;
      }
      if (busySessionIds.has(record.sessionId)) {
        skippedBusy.add(record.sessionId);
        continue;
      }
      deleteRecords.push(record);
    }
  }

  return {
    ...summarizeSessionCleanupTargets({ archiveInputs, deleteRecords, thresholds, generatedAt: input.now.toISOString(), skippedBusySessionIds: [...skippedBusy], skippedPinnedSessionIds: [...skippedPinned] }),
    archiveInputs,
    deleteRecords,
    skippedBusySessionIds: [...skippedBusy].sort(),
  };
}

export function summarizeSessionCleanupTargets(input: {
  archiveInputs: readonly ArchiveSessionInput[];
  deleteRecords: readonly ArchivedSessionRecord[];
  thresholds: SessionCleanupThresholds;
  generatedAt: string;
  skippedBusySessionIds?: readonly string[];
  skippedPinnedSessionIds?: readonly string[];
}): SessionCleanupPreviewResponse {
  const projectsByCwd = new Map<string, SessionCleanupProjectSummary>();
  let archiveCount = 0;
  let deleteCount = 0;

  for (const session of input.archiveInputs) {
    archiveCount += 1;
    projectSummary(projectsByCwd, session.cwd).archiveCount += 1;
  }

  for (const record of input.deleteRecords) {
    deleteCount += 1;
    projectSummary(projectsByCwd, record.cwd).deleteCount += 1;
  }

  const skippedBusySessionIds = [...new Set(input.skippedBusySessionIds ?? [])].sort();
  const skippedPinnedSessionIds = [...new Set(input.skippedPinnedSessionIds ?? [])].sort();
  return {
    generatedAt: input.generatedAt,
    thresholds: copyThresholds(input.thresholds),
    projects: [...projectsByCwd.values()].sort((a, b) => a.cwd.localeCompare(b.cwd)),
    totals: { archiveCount, deleteCount },
    ...(skippedBusySessionIds.length === 0 ? {} : { skippedBusySessionIds }),
    ...(skippedPinnedSessionIds.length === 0 ? {} : { skippedPinnedSessionIds }),
  };
}

export function summarizeSessionCleanupExecution(input: {
  archiveInputs: readonly ArchiveSessionInput[];
  deleteRecords: readonly ArchivedSessionRecord[];
  thresholds: SessionCleanupThresholds;
  generatedAt: string;
  skippedBusySessionIds?: readonly string[];
  skippedPinnedSessionIds?: readonly string[];
}): SessionCleanupExecuteResponse {
  return {
    ...summarizeSessionCleanupTargets(input),
    archivedSessionIds: input.archiveInputs.map((session) => session.sessionId),
    deletedSessionIds: input.deleteRecords.map((record) => record.sessionId),
  };
}

function optionalDayThreshold(record: Record<string, unknown>, field: keyof SessionCleanupThresholds): number | undefined {
  const value = record[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) throw new Error(`${field} field must be a non-negative integer`);
  return value;
}

function optionalProjectCwds(record: Record<string, unknown>): string[] | undefined {
  const value = record["projectCwds"];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) throw new Error("projectCwds field must be an array of strings");
  return [...new Set(value)];
}

function cutoffTime(now: Date, days: number | undefined): number | undefined {
  return days === undefined ? undefined : now.getTime() - days * DAY_MS;
}

function isBefore(value: Date, cutoff: number): boolean {
  const time = value.getTime();
  return Number.isFinite(time) && time < cutoff;
}

function isTimestampBefore(value: string, cutoff: number): boolean {
  const time = Date.parse(value);
  return Number.isFinite(time) && time < cutoff;
}

function uniqueSessionsById(sessions: readonly PiSessionListEntry[]): PiSessionListEntry[] {
  const sessionsById = new Map<string, PiSessionListEntry>();
  for (const session of sessions) {
    const existing = sessionsById.get(session.id);
    if (existing === undefined || session.modified.getTime() > existing.modified.getTime()) sessionsById.set(session.id, session);
  }
  return [...sessionsById.values()];
}

function archiveInputFromListEntry(session: PiSessionListEntry): ArchiveSessionInput {
  return {
    sessionId: session.id,
    cwd: session.cwd,
    path: session.path,
    created: session.created.toISOString(),
    modified: session.modified.toISOString(),
    messageCount: session.messageCount,
    firstMessage: session.firstMessage,
    ...(session.name === undefined ? {} : { name: session.name }),
    ...(session.parentSessionPath === undefined ? {} : { parentSessionPath: session.parentSessionPath }),
  };
}

function projectSummary(projectsByCwd: Map<string, SessionCleanupProjectSummary>, cwd: string): SessionCleanupProjectSummary {
  const existing = projectsByCwd.get(cwd);
  if (existing !== undefined) return existing;
  const created = { cwd, archiveCount: 0, deleteCount: 0 };
  projectsByCwd.set(cwd, created);
  return created;
}

function copyThresholds(thresholds: SessionCleanupThresholds): SessionCleanupThresholds {
  const copy: SessionCleanupThresholds = {};
  if (thresholds.archiveIdleDays !== undefined) copy.archiveIdleDays = thresholds.archiveIdleDays;
  if (thresholds.deleteArchivedDays !== undefined) copy.deleteArchivedDays = thresholds.deleteArchivedDays;
  return copy;
}
