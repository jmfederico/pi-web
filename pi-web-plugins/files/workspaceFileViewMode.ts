import type { WorkspacePanelNavigationV1 } from "@jmfederico/pi-web/plugin-api";

export type WorkspaceFileViewMode = "preview" | "raw";

/** Raw source remains the safe default until the user asks for a preview. */
export const DEFAULT_WORKSPACE_FILE_VIEW_MODE: WorkspaceFileViewMode = "raw";
export const WORKSPACE_FILE_VIEW_MODE_STORAGE_KEY = "pi-web.workspace.files.viewMode";
export const WORKSPACE_FILE_VIEW_MODE_QUERY_KEY = "mode";

export type WorkspaceFileViewModeStorage = Pick<Storage, "getItem" | "setItem">;

export interface WorkspaceFileViewModeRoute {
  read(): string | undefined;
  write(mode: WorkspaceFileViewMode): void;
}

export interface WorkspaceFileViewModeStore {
  adopt(): WorkspaceFileViewMode;
  publish(mode: WorkspaceFileViewMode): void;
}

export function parseWorkspaceFileViewMode(value: string | null | undefined): WorkspaceFileViewMode | undefined {
  return value === "preview" || value === "raw" ? value : undefined;
}

export function adoptWorkspaceFileViewMode(
  route: WorkspaceFileViewModeRoute,
  storage: WorkspaceFileViewModeStorage | undefined,
): WorkspaceFileViewMode {
  const linked = parseWorkspaceFileViewMode(route.read());
  if (linked !== undefined) {
    writeStoredWorkspaceFileViewMode(linked, storage);
    return linked;
  }
  return readStoredWorkspaceFileViewMode(storage) ?? DEFAULT_WORKSPACE_FILE_VIEW_MODE;
}

export function publishWorkspaceFileViewMode(
  mode: WorkspaceFileViewMode,
  route: WorkspaceFileViewModeRoute,
  storage: WorkspaceFileViewModeStorage | undefined,
): void {
  writeStoredWorkspaceFileViewMode(mode, storage);
  route.write(mode);
}

export function readStoredWorkspaceFileViewMode(storage: WorkspaceFileViewModeStorage | undefined): WorkspaceFileViewMode | undefined {
  if (storage === undefined) return undefined;
  try {
    return parseWorkspaceFileViewMode(storage.getItem(WORKSPACE_FILE_VIEW_MODE_STORAGE_KEY));
  } catch {
    return undefined;
  }
}

export function writeStoredWorkspaceFileViewMode(mode: WorkspaceFileViewMode, storage: WorkspaceFileViewModeStorage | undefined): void {
  if (storage === undefined) return;
  try {
    storage.setItem(WORKSPACE_FILE_VIEW_MODE_STORAGE_KEY, mode);
  } catch {
    // The tab still owns the selected mode when storage is unavailable.
  }
}

export function createWorkspaceFileViewModeStore(
  navigation: WorkspacePanelNavigationV1 | undefined,
  storage: WorkspaceFileViewModeStorage | undefined = browserStorage(),
): WorkspaceFileViewModeStore {
  const route: WorkspaceFileViewModeRoute = {
    read: () => firstQueryString(navigation?.query[WORKSPACE_FILE_VIEW_MODE_QUERY_KEY]),
    write: (mode) => { navigation?.set(WORKSPACE_FILE_VIEW_MODE_QUERY_KEY, mode, { replace: true }); },
  };
  return {
    adopt: () => adoptWorkspaceFileViewMode(route, storage),
    publish: (mode) => { publishWorkspaceFileViewMode(mode, route, storage); },
  };
}

/** Test/default store used when no scoped host navigation is supplied. */
export const workspaceFileViewModeStore: WorkspaceFileViewModeStore = createWorkspaceFileViewModeStore(undefined);

function firstQueryString(value: string | readonly string[] | undefined): string | undefined {
  return typeof value === "string" ? value : value?.[0];
}

function browserStorage(): WorkspaceFileViewModeStorage | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}
