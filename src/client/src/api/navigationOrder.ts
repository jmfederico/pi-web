import type { NavigationPreference } from "../../../shared/navigationPreferences";
import type { NavigationOrderPort, NavigationOrderScope, NavigationOrderSnapshot } from "../controllers/navigationOrderController";
import { request } from "./http";

/** Unresolved application-relative reference, through the selected machine proxy. */
export function navigationOrderPath(scope: NavigationOrderScope): string {
  const prefix = `api/machines/${encodeURIComponent(scope.machineId)}/navigation/projects`;
  switch (scope.kind) {
    case "projects": return prefix;
    case "workspaces": return `${prefix}/${encodeURIComponent(scope.projectId)}/workspaces`;
    case "sessionPins": return `${prefix}/${encodeURIComponent(scope.projectId)}/workspaces/${encodeURIComponent(scope.workspaceId)}/session-pins`;
  }
}

export function parseNavigationOrderSnapshot(value: unknown): NavigationOrderSnapshot {
  if (!isRecord(value)) throw new Error("Invalid navigation order response");
  const ids = value["ids"];
  const revision = value["revision"];
  if (!Array.isArray(ids) || !ids.every((id): id is string => typeof id === "string" && id.trim() !== "")
    || new Set(ids).size !== ids.length || typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0) {
    // Refuse legacy unconditional-write servers instead of inventing a revision.
    throw new Error("Invalid navigation order response: ids and revision are required");
  }
  return { ids: [...ids], revision };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const navigationOrderPort: NavigationOrderPort = {
  load: (scope) => request(navigationOrderPath(scope), parseNavigationOrderSnapshot, { cache: "no-store" }),
  save: (scope, ids, revision) => {
    const preference: NavigationPreference & { revision: number } = { ids: [...ids], revision };
    return request(navigationOrderPath(scope), parseNavigationOrderSnapshot, { method: "PUT", body: JSON.stringify(preference) });
  },
};
