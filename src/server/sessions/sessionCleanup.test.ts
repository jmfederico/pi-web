import { describe, expect, it } from "vitest";
import { normalizeSessionCleanupRequest, normalizeSessionCleanupThresholds, planSessionCleanup } from "./sessionCleanup.js";
import type { PiSessionListEntry } from "./piSessionService.js";
import type { ArchivedSessionRecord } from "./sessionArchiveStore.js";

describe("session cleanup planning", () => {
  it("plans cleanup by strict cutoffs and groups counts by stored cwd", () => {
    const now = new Date("2026-06-25T00:00:00.000Z");
    const archivedRecords: ArchivedSessionRecord[] = [
      archivedRecord("already-archived", "/unregistered", "2026-06-20T00:00:00.000Z"),
      archivedRecord("delete-old", "/other", "2026-06-14T23:59:59.999Z"),
      archivedRecord("keep-exact", "/other", "2026-06-15T00:00:00.000Z"),
    ];

    const plan = planSessionCleanup({
      now,
      thresholds: { archiveIdleDays: 30, deleteArchivedDays: 10 },
      archivedRecords,
      sessions: [
        sessionEntry("archive-old", "/unregistered", "2026-05-25T23:59:59.999Z"),
        sessionEntry("keep-exact", "/unregistered", "2026-05-26T00:00:00.000Z"),
        sessionEntry("keep-new", "/unregistered", "2026-05-26T00:00:00.001Z"),
        sessionEntry("already-archived", "/unregistered", "2026-05-01T00:00:00.000Z"),
      ],
    });

    expect(plan.archiveInputs.map((input) => input.sessionId)).toEqual(["archive-old"]);
    expect(plan.deleteRecords.map((record) => record.sessionId)).toEqual(["delete-old"]);
    expect(plan.projects).toEqual([
      { cwd: "/other", archiveCount: 0, deleteCount: 1 },
      { cwd: "/unregistered", archiveCount: 1, deleteCount: 0 },
    ]);
    expect(plan.totals).toEqual({ archiveCount: 1, deleteCount: 1 });
  });

  it("filters cleanup candidates to selected project cwd paths", () => {
    const plan = planSessionCleanup({
      now: new Date("2026-06-25T00:00:00.000Z"),
      thresholds: { archiveIdleDays: 30, deleteArchivedDays: 30 },
      projectCwds: ["/repo-a"],
      sessions: [
        sessionEntry("archive-a", "/repo-a", "2026-05-01T00:00:00.000Z"),
        sessionEntry("archive-b", "/repo-b", "2026-05-01T00:00:00.000Z"),
      ],
      archivedRecords: [
        archivedRecord("delete-a", "/repo-a", "2026-05-01T00:00:00.000Z"),
        archivedRecord("delete-b", "/repo-b", "2026-05-01T00:00:00.000Z"),
      ],
    });

    expect(plan.archiveInputs.map((input) => input.sessionId)).toEqual(["archive-a"]);
    expect(plan.deleteRecords.map((record) => record.sessionId)).toEqual(["delete-a"]);
    expect(plan.projects).toEqual([{ cwd: "/repo-a", archiveCount: 1, deleteCount: 1 }]);
    expect(plan.totals).toEqual({ archiveCount: 1, deleteCount: 1 });
  });

  it("skips archive and delete candidates that are busy in memory", () => {
    const plan = planSessionCleanup({
      now: new Date("2026-06-25T00:00:00.000Z"),
      thresholds: { archiveIdleDays: 1, deleteArchivedDays: 1 },
      sessions: [sessionEntry("busy-open", "/repo", "2026-06-01T00:00:00.000Z")],
      archivedRecords: [archivedRecord("busy-archived", "/repo", "2026-06-01T00:00:00.000Z")],
      activeSessions: [
        { sessionId: "busy-open", hasActiveWork: true },
        { sessionId: "busy-archived", hasActiveWork: true },
      ],
    });

    expect(plan.archiveInputs).toHaveLength(0);
    expect(plan.deleteRecords).toHaveLength(0);
    expect(plan.skippedBusySessionIds).toEqual(["busy-archived", "busy-open"]);
    expect(plan.totals).toEqual({ archiveCount: 0, deleteCount: 0 });
  });

  it("excludes pinned candidates from archive and delete without reporting unrelated pins", () => {
    const plan = planSessionCleanup({
      now: new Date("2026-06-25T00:00:00.000Z"),
      thresholds: { archiveIdleDays: 1, deleteArchivedDays: 1 },
      projectCwds: ["/repo"],
      excludedPinnedSessionIds: ["pinned-open", "pinned-archived", "outside", "recent", "stale"],
      sessions: [
        sessionEntry("pinned-open", "/repo", "2026-06-01T00:00:00.000Z"),
        sessionEntry("unpinned-open", "/repo", "2026-06-01T00:00:00.000Z"),
        sessionEntry("outside", "/other", "2026-06-01T00:00:00.000Z"),
        sessionEntry("recent", "/repo", "2026-06-25T00:00:00.000Z"),
      ],
      archivedRecords: [
        archivedRecord("pinned-archived", "/repo", "2026-06-01T00:00:00.000Z"),
        archivedRecord("unpinned-archived", "/repo", "2026-06-01T00:00:00.000Z"),
      ],
    });
    expect(plan.archiveInputs.map((entry) => entry.sessionId)).toEqual(["unpinned-open"]);
    expect(plan.deleteRecords.map((entry) => entry.sessionId)).toEqual(["unpinned-archived"]);
    expect(plan.skippedPinnedSessionIds).toEqual(["pinned-archived", "pinned-open"]);
    expect(plan.totals).toEqual({ archiveCount: 1, deleteCount: 1 });
  });

  it("requires a resolved pin snapshot only when skipPinned is enabled", () => {
    expect(normalizeSessionCleanupRequest({ skipPinned: true, excludedPinnedSessionIds: ["a", "a"] })).toEqual({ thresholds: {}, excludedPinnedSessionIds: ["a"] });
    expect(normalizeSessionCleanupRequest({ skipPinned: true, excludedPinnedSessionIds: [] })).toEqual({ thresholds: {}, excludedPinnedSessionIds: [] });
    expect(normalizeSessionCleanupRequest({ skipPinned: false, excludedPinnedSessionIds: ["a"] })).toEqual({ thresholds: {} });
    for (const skipPinned of [null, "true", 1]) {
      expect(() => normalizeSessionCleanupRequest({ skipPinned })).toThrow("skipPinned field must be a boolean");
    }
    for (const excludedPinnedSessionIds of [undefined, null, "a", [1], [""]]) {
      expect(() => normalizeSessionCleanupRequest({ skipPinned: true, excludedPinnedSessionIds })).toThrow("requires resolved");
    }
  });

  it("validates optional runtime thresholds", () => {
    expect(normalizeSessionCleanupThresholds({ archiveIdleDays: 30, deleteArchivedDays: null })).toEqual({ archiveIdleDays: 30 });
    expect(normalizeSessionCleanupThresholds({})).toEqual({});
    expect(() => normalizeSessionCleanupThresholds({ archiveIdleDays: -1 })).toThrow("archiveIdleDays field must be a non-negative integer");
    expect(() => normalizeSessionCleanupThresholds({ deleteArchivedDays: 1.5 })).toThrow("deleteArchivedDays field must be a non-negative integer");
    expect(() => normalizeSessionCleanupThresholds({ archiveIdleDays: "30" })).toThrow("archiveIdleDays field must be a non-negative integer");
  });

  it("validates optional selected project cwd paths", () => {
    expect(normalizeSessionCleanupRequest({ archiveIdleDays: 30, projectCwds: ["/repo", "/repo"] })).toEqual({
      thresholds: { archiveIdleDays: 30 },
      projectCwds: ["/repo"],
    });
    expect(normalizeSessionCleanupRequest({ projectCwds: null })).toEqual({ thresholds: {} });
    expect(() => normalizeSessionCleanupRequest({ projectCwds: ["/repo", 1] })).toThrow("projectCwds field must be an array of strings");
  });
});

function sessionEntry(id: string, cwd: string, modified: string): PiSessionListEntry {
  return {
    id,
    cwd,
    path: `/sessions/${id}.jsonl`,
    created: new Date("2026-01-01T00:00:00.000Z"),
    modified: new Date(modified),
    messageCount: 1,
    firstMessage: "hello",
    allMessagesText: "hello",
  };
}

function archivedRecord(sessionId: string, cwd: string, archivedAt: string): ArchivedSessionRecord {
  return { sessionId, cwd, archivedAt };
}
