/** Full ordered IDs for one navigation scope; PUT replaces rather than merges. */
export interface NavigationPreference {
  ids: string[];
  /** Per-scope version returned by GET/PUT. Include in PUT for compare-and-swap. */
  revision: number;
}

export interface NavigationPreferenceWrite {
  ids: string[];
  revision?: number;
}

export const NAVIGATION_PREFERENCE_ROUTES = [
  "/navigation/projects",
  "/navigation/projects/:projectId/workspaces",
  "/navigation/projects/:projectId/workspaces/:workspaceId/session-pins",
] as const;
