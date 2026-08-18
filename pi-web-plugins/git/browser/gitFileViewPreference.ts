export const GIT_FILE_VIEW_STORAGE_KEY = "pi-web.gitFileView";

/**
 * How the Git panel lists changed files. `list` is the flat, full-path view
 * (the historical default); `tree` nests files under their directories.
 */
export type GitFileView = "list" | "tree";

export type GitFileViewStorage = Pick<Storage, "getItem" | "setItem">;

export function parseGitFileView(value: string | null): GitFileView {
  return value === "tree" ? "tree" : "list";
}

export function readGitFileView(storage = browserStorage()): GitFileView {
  if (storage === undefined) return "list";
  try {
    return parseGitFileView(storage.getItem(GIT_FILE_VIEW_STORAGE_KEY));
  } catch {
    return "list";
  }
}

export function writeGitFileView(view: GitFileView, storage = browserStorage()): void {
  if (storage === undefined) return;
  try {
    storage.setItem(GIT_FILE_VIEW_STORAGE_KEY, view);
  } catch {
    // Ignore localStorage quota/privacy errors; the chosen view still applies in memory for this tab.
  }
}

function browserStorage(): GitFileViewStorage | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}
