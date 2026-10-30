import type { SessionCleanupPreviewResponse, SessionCleanupRequest } from "./api";

export interface SessionCleanupDraft {
  skipPinned: boolean;
  archiveIdleEnabled: boolean;
  archiveIdleDays: string;
  deleteArchivedEnabled: boolean;
  deleteArchivedDays: string;
}

export type SessionCleanupDraftValidation =
  | { ok: true; request: SessionCleanupRequest }
  | { ok: false; code: "disabled" | "archiveRequired" | "archiveInvalid" | "deleteRequired" | "deleteInvalid"; error: string };

export const DEFAULT_SESSION_CLEANUP_DRAFT: SessionCleanupDraft = {
  skipPinned: true,
  archiveIdleEnabled: true,
  archiveIdleDays: "30",
  deleteArchivedEnabled: false,
  deleteArchivedDays: "90",
};

export function validateSessionCleanupDraft(draft: SessionCleanupDraft): SessionCleanupDraftValidation {
  if (!draft.archiveIdleEnabled && !draft.deleteArchivedEnabled) return { ok: false, code: "disabled", error: "Enable at least one cleanup action." };

  const request: SessionCleanupRequest = {
    skipPinned: draft.skipPinned,
    archiveIdleDays: null,
    deleteArchivedDays: null,
  };

  if (draft.archiveIdleEnabled) {
    const archiveIdleDays = parseDayThreshold(draft.archiveIdleDays, "Archive idle sessions after");
    if (typeof archiveIdleDays !== "number") return { ok: false, code: archiveIdleDays.code === "required" ? "archiveRequired" : "archiveInvalid", error: archiveIdleDays.error };
    request.archiveIdleDays = archiveIdleDays;
  }

  if (draft.deleteArchivedEnabled) {
    const deleteArchivedDays = parseDayThreshold(draft.deleteArchivedDays, "Delete archived sessions after");
    if (typeof deleteArchivedDays !== "number") return { ok: false, code: deleteArchivedDays.code === "required" ? "deleteRequired" : "deleteInvalid", error: deleteArchivedDays.error };
    request.deleteArchivedDays = deleteArchivedDays;
  }

  return { ok: true, request };
}

export function sessionCleanupRequestKey(request: SessionCleanupRequest | undefined): string {
  // Project selection filters the existing preview; eligibility changes need a new one.
  return JSON.stringify({
    skipPinned: request?.skipPinned ?? false,
    archiveIdleDays: request?.archiveIdleDays ?? null,
    deleteArchivedDays: request?.deleteArchivedDays ?? null,
  });
}

export function canRunSessionCleanup(input: {
  draft: SessionCleanupDraft;
  preview: SessionCleanupPreviewResponse | undefined;
  previewRequest: SessionCleanupRequest | undefined;
  loading?: boolean;
  running?: boolean;
}): boolean {
  if (input.loading === true || input.running === true || input.preview === undefined) return false;
  const validation = validateSessionCleanupDraft(input.draft);
  if (!validation.ok) return false;
  if (sessionCleanupRequestKey(validation.request) !== sessionCleanupRequestKey(input.previewRequest)) return false;
  return sessionCleanupPreviewHasTargets(input.preview);
}

export function sessionCleanupPreviewHasTargets(preview: Pick<SessionCleanupPreviewResponse, "totals">): boolean {
  return preview.totals.archiveCount > 0 || preview.totals.deleteCount > 0;
}

export function selectedSessionCleanupProjectCwds(preview: Pick<SessionCleanupPreviewResponse, "projects">, selectedProjectCwds: readonly string[] | undefined): string[] {
  const previewCwds = preview.projects.map((project) => project.cwd);
  if (selectedProjectCwds === undefined) return previewCwds;
  const selected = new Set(selectedProjectCwds);
  return previewCwds.filter((cwd) => selected.has(cwd));
}

export function sessionCleanupPreviewForSelectedProjects(preview: SessionCleanupPreviewResponse, selectedProjectCwds: readonly string[] | undefined): SessionCleanupPreviewResponse {
  const selected = new Set(selectedSessionCleanupProjectCwds(preview, selectedProjectCwds));
  const projects = preview.projects.filter((project) => selected.has(project.cwd));
  return {
    ...preview,
    projects,
    totals: projects.reduce((totals, project) => ({
      archiveCount: totals.archiveCount + project.archiveCount,
      deleteCount: totals.deleteCount + project.deleteCount,
    }), { archiveCount: 0, deleteCount: 0 }),
  };
}

export function confirmSessionCleanup(preview: Pick<SessionCleanupPreviewResponse, "totals">, confirmCleanup: (message: string) => boolean): boolean {
  return confirmCleanup(sessionCleanupConfirmationMessage(preview));
}

export function sessionCleanupConfirmationMessage(preview: Pick<SessionCleanupPreviewResponse, "totals">): string {
  const archiveCount = preview.totals.archiveCount;
  const deleteCount = preview.totals.deleteCount;
  const parts: string[] = [];
  if (archiveCount > 0) parts.push(`archive ${String(archiveCount)} idle ${archiveCount === 1 ? "session" : "sessions"}`);
  if (deleteCount > 0) parts.push(`permanently delete ${String(deleteCount)} archived ${deleteCount === 1 ? "session" : "sessions"}`);
  const action = parts.length === 0 ? "run cleanup" : parts.join(" and ");
  return `Run cleanup and ${action}?\n\nPermanent deletion only applies to archived sessions and cannot be undone.`;
}

function parseDayThreshold(value: string, label: string): number | { code: "required" | "invalid"; error: string } {
  const trimmed = value.trim();
  if (trimmed === "") return { code: "required", error: `${label} must be set.` };
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed < 0) return { code: "invalid", error: `${label} must be a non-negative whole number of days.` };
  return parsed;
}
