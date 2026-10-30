import { describe, expect, it } from "vitest";
import type { SessionCleanupPreviewResponse } from "./api";
import { canRunSessionCleanup, confirmSessionCleanup, selectedSessionCleanupProjectCwds, sessionCleanupConfirmationMessage, sessionCleanupPreviewForSelectedProjects, sessionCleanupRequestKey, validateSessionCleanupDraft, type SessionCleanupDraft } from "./sessionCleanupUi";

const draft: SessionCleanupDraft = {
  skipPinned: true,
  archiveIdleEnabled: true,
  archiveIdleDays: "30",
  deleteArchivedEnabled: true,
  deleteArchivedDays: "90",
};

const preview: SessionCleanupPreviewResponse = {
  generatedAt: "2026-06-25T12:00:00.000Z",
  thresholds: { archiveIdleDays: 30, deleteArchivedDays: 90 },
  projects: [{ cwd: "/repo", archiveCount: 2, deleteCount: 1 }],
  totals: { archiveCount: 2, deleteCount: 1 },
};

describe("session cleanup UI helpers", () => {
  it("builds request thresholds from enabled runtime inputs", () => {
    expect(validateSessionCleanupDraft(draft)).toEqual({
      ok: true,
      request: { archiveIdleDays: 30, deleteArchivedDays: 90, skipPinned: true },
    });
    expect(validateSessionCleanupDraft({ ...draft, archiveIdleEnabled: false })).toEqual({
      ok: true,
      request: { archiveIdleDays: null, deleteArchivedDays: 90, skipPinned: true },
    });
  });

  it.each([
    { input: { archiveIdleEnabled: false, deleteArchivedEnabled: false }, code: "disabled", error: "Enable at least one cleanup action." },
    { input: { archiveIdleDays: " \t" }, code: "archiveRequired", error: "Archive idle sessions after must be set." },
    { input: { deleteArchivedDays: "" }, code: "deleteRequired", error: "Delete archived sessions after must be set." },
    ...["1.5", "-1", "abc", "Infinity"].flatMap((value) => [
      { input: { archiveIdleDays: value }, code: "archiveInvalid", error: "Archive idle sessions after must be a non-negative whole number of days." },
      { input: { deleteArchivedDays: value }, code: "deleteInvalid", error: "Delete archived sessions after must be a non-negative whole number of days." },
    ]),
  ])("returns $code with its compatibility error for $input", ({ input, code, error }) => {
    expect(validateSessionCleanupDraft({ ...draft, ...input })).toEqual({ ok: false, code, error });
  });

  it("preserves validation precedence and ignores disabled thresholds", () => {
    expect(validateSessionCleanupDraft({ ...draft, archiveIdleDays: "", deleteArchivedDays: "-1" })).toEqual({
      ok: false, code: "archiveRequired", error: "Archive idle sessions after must be set.",
    });
    expect(validateSessionCleanupDraft({ ...draft, archiveIdleEnabled: false, archiveIdleDays: "invalid", deleteArchivedDays: " 0 " })).toEqual({
      ok: true, request: { archiveIdleDays: null, deleteArchivedDays: 0, skipPinned: true },
    });
    expect(validateSessionCleanupDraft({ ...draft, deleteArchivedEnabled: false, deleteArchivedDays: "", archiveIdleDays: " 30 " })).toEqual({
      ok: true, request: { archiveIdleDays: 30, deleteArchivedDays: null, skipPinned: true },
    });
    expect(canRunSessionCleanup({ draft: { ...draft, archiveIdleDays: "" }, preview, previewRequest: preview.thresholds })).toBe(false);
  });

  it("requires a current preview before cleanup can run", () => {
    const validation = validateSessionCleanupDraft(draft);
    if (!validation.ok) throw new Error(validation.error);

    expect(canRunSessionCleanup({ draft, preview, previewRequest: validation.request })).toBe(true);
    expect(canRunSessionCleanup({ draft: { ...draft, archiveIdleDays: "31" }, preview, previewRequest: validation.request })).toBe(false);
    expect(canRunSessionCleanup({ draft, preview: { ...preview, totals: { archiveCount: 0, deleteCount: 0 } }, previewRequest: validation.request })).toBe(false);
  });

  it("normalizes request keys for null, omitted disabled actions, and selected projects", () => {
    expect(sessionCleanupRequestKey({ archiveIdleDays: 30 })).toBe(sessionCleanupRequestKey({ archiveIdleDays: 30, deleteArchivedDays: null, projectCwds: ["/repo"] }));
  });

  it("invalidates the preview when pinned-session protection changes", () => {
    const request = { archiveIdleDays: 30, deleteArchivedDays: 90, skipPinned: true };
    expect(canRunSessionCleanup({ draft: { ...draft, skipPinned: false }, preview, previewRequest: request })).toBe(false);
    expect(validateSessionCleanupDraft({ ...draft, skipPinned: false })).toEqual({ ok: true, request: { ...request, skipPinned: false } });
    expect(sessionCleanupRequestKey({ archiveIdleDays: 30 })).toBe(sessionCleanupRequestKey({ archiveIdleDays: 30, skipPinned: false }));
  });

  it("summarizes the preview for selected projects", () => {
    const multiProjectPreview: SessionCleanupPreviewResponse = {
      ...preview,
      projects: [
        { cwd: "/repo-a", archiveCount: 2, deleteCount: 1 },
        { cwd: "/repo-b", archiveCount: 0, deleteCount: 3 },
      ],
      totals: { archiveCount: 2, deleteCount: 4 },
    };

    expect(selectedSessionCleanupProjectCwds(multiProjectPreview, undefined)).toEqual(["/repo-a", "/repo-b"]);
    expect(selectedSessionCleanupProjectCwds(multiProjectPreview, ["/missing", "/repo-b"])).toEqual(["/repo-b"]);
    expect(sessionCleanupPreviewForSelectedProjects(multiProjectPreview, ["/repo-b"])).toMatchObject({
      projects: [{ cwd: "/repo-b", archiveCount: 0, deleteCount: 3 }],
      totals: { archiveCount: 0, deleteCount: 3 },
    });
    expect(sessionCleanupPreviewForSelectedProjects(multiProjectPreview, [])).toMatchObject({
      projects: [],
      totals: { archiveCount: 0, deleteCount: 0 },
    });
  });

  it("uses explicit permanent deletion copy in the confirmation message", () => {
    const confirmMessages: string[] = [];
    expect(confirmSessionCleanup(preview, (message) => {
      confirmMessages.push(message);
      return true;
    })).toBe(true);
    expect(confirmMessages[0]).toContain("permanently delete 1 archived session");
    expect(sessionCleanupConfirmationMessage(preview)).toContain("cannot be undone");
  });
});
