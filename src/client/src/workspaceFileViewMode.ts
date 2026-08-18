import { queryNamespace, readNamespacedString, setNamespacedQueryKey } from "./namespacedQueryArgs";

export type WorkspaceFileViewMode = "preview" | "raw";

/**
 * Raw source is the default: a workspace file opens as its literal, escaped
 * bytes, and a rendered preview is something the user asks for.
 */
export const DEFAULT_WORKSPACE_FILE_VIEW_MODE: WorkspaceFileViewMode = "raw";
export const WORKSPACE_FILE_VIEW_MODE_STORAGE_KEY = "pi-web.workspace.files.viewMode";
export const WORKSPACE_FILE_VIEW_MODE_QUERY_KEY = "mode";

const FILES_ROUTE_NAMESPACE = queryNamespace("core:workspace.files");

export type WorkspaceFileViewModeStorage = Pick<Storage, "getItem" | "setItem">;

/** Address-bar seam, so the deep-link contract can be tested without a browser. */
export interface WorkspaceFileViewModeRoute {
  read(): string | undefined;
  write(mode: WorkspaceFileViewMode): void;
}

export interface WorkspaceFileViewModeStore {
  /**
   * Effective mode for a viewer that has not been switched yet: a deep link
   * wins and is adopted as this device's preference, otherwise the stored
   * preference applies, otherwise raw.
   */
  adopt(): WorkspaceFileViewMode;
  /** Record the displayed mode as the device preference and in the address bar. */
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
    // A shared link reproduces what its author saw, and becomes the preference.
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
    // Ignore storage quota/privacy errors; the mode still applies to this tab.
  }
}

/** Default store bound to the live address bar and this device's storage. */
export const workspaceFileViewModeStore: WorkspaceFileViewModeStore = {
  adopt: () => adoptWorkspaceFileViewMode(browserRoute(), browserStorage()),
  publish: (mode) => { publishWorkspaceFileViewMode(mode, browserRoute(), browserStorage()); },
};

function browserRoute(): WorkspaceFileViewModeRoute {
  return {
    read: () => (typeof window === "undefined" ? undefined : readNamespacedString(FILES_ROUTE_NAMESPACE, WORKSPACE_FILE_VIEW_MODE_QUERY_KEY)),
    write: (mode) => {
      if (typeof window === "undefined") return;
      setNamespacedQueryKey(FILES_ROUTE_NAMESPACE, WORKSPACE_FILE_VIEW_MODE_QUERY_KEY, mode, { replace: true });
    },
  };
}

function browserStorage(): WorkspaceFileViewModeStorage | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}
