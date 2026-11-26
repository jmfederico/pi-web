import type { PluginCatalogV1, PluginWorkspaceSelection } from "@jmfederico/pi-web/server-plugin-api";

export type AbsenceReason = "session-deleted" | "workspace-removed" | "project-removed";

/**
 * `absent` is reported only when a catalog read succeeded and lacked the
 * target. Failed reads are `unknown`: the host reports missing and
 * temporarily unavailable targets with the same untyped error, so an error is
 * never evidence that a session is gone.
 */
export type Presence =
  | { readonly kind: "present" }
  | { readonly kind: "archived" }
  | { readonly kind: "absent"; readonly reason: AbsenceReason }
  | { readonly kind: "unknown"; readonly error: string };

export async function sessionPresence(
  catalog: PluginCatalogV1,
  selection: PluginWorkspaceSelection,
  sessionIds: readonly string[],
  signal: AbortSignal,
): Promise<Map<string, Presence>> {
  const result = new Map<string, Presence>();
  try {
    const sessions = await catalog.sessions.list(selection, { signal });
    for (const id of sessionIds) {
      const session = sessions.find((candidate) => candidate.id === id);
      result.set(id, session === undefined ? { kind: "absent", reason: "session-deleted" } : session.archived ? { kind: "archived" } : { kind: "present" });
    }
    return result;
  } catch (error) {
    signal.throwIfAborted();
    const reason = await confirmedWorkspaceAbsence(catalog, selection, signal);
    const presence: Presence = reason === undefined
      ? { kind: "unknown", error: error instanceof Error ? error.message : String(error) }
      : { kind: "absent", reason };
    for (const id of sessionIds) result.set(id, presence);
    return result;
  }
}

async function confirmedWorkspaceAbsence(catalog: PluginCatalogV1, selection: PluginWorkspaceSelection, signal: AbortSignal): Promise<AbsenceReason | undefined> {
  try {
    const projects = await catalog.projects.list({ signal });
    if (!projects.some((project) => project.id === selection.projectId)) return "project-removed";
    const workspaces = await catalog.workspaces.list(selection.projectId, { signal });
    if (!workspaces.some((workspace) => workspace.id === selection.workspaceId)) return "workspace-removed";
  } catch {
    signal.throwIfAborted();
    // Discovery that is not ready or failing proves nothing either way.
  }
  return undefined;
}
