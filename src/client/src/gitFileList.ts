import type { GitStatusFile } from "./api";

/** A changed file inside a submodule, shown flat in list view. `path` is the
 * full superproject-relative path (the diff key); `relativePath` is shown in
 * the row and is relative to the submodule root (may still contain slashes). */
export interface GitFileListSubmoduleFile {
  readonly path: string;
  readonly relativePath: string;
  readonly file: GitStatusFile;
}

/** An expandable submodule group in list view. Children are flat (no nesting),
 * with the pointer row pinned first when present. The pointer is the
 * submodule's own moved commit, keyed by the submodule path; its `name` is the
 * `<old> → <new>` short-SHA summary. */
export interface GitFileListSubmoduleGroup {
  readonly path: string;
  readonly name: string;
  readonly pointer?: { readonly name: string; readonly file: GitStatusFile };
  readonly files: readonly GitFileListSubmoduleFile[];
}

/** List-view model: submodule groups first (alphabetical), then non-submodule
 * files in their original Git status order. */
export interface GitFileListModel {
  readonly submodules: readonly GitFileListSubmoduleGroup[];
  readonly files: readonly GitStatusFile[];
}

/**
 * Group the flat changed-file list for list view. Unlike the tree, submodule
 * contents are flattened: each submodule becomes one expandable group holding
 * its pointer row and its changed files, and everything else stays a flat list.
 */
export function buildGitFileList(files: readonly GitStatusFile[], submodules: readonly string[] = []): GitFileListModel {
  const submoduleSet = new Set(submodules);
  const pointers = new Map<string, { readonly name: string; readonly file: GitStatusFile }>();
  const grouped = new Map<string, GitFileListSubmoduleFile[]>();
  for (const submodule of submodules) grouped.set(submodule, []);
  const flat: GitStatusFile[] = [];

  for (const file of files) {
    if (submoduleSet.has(file.path)) {
      pointers.set(file.path, { name: pointerName(file), file });
      continue;
    }
    const owner = ownerSubmodule(file.path, submodules);
    if (owner !== undefined) {
      grouped.get(owner)?.push({ path: file.path, relativePath: file.path.slice(owner.length + 1), file });
      continue;
    }
    flat.push(file);
  }

  const groups: GitFileListSubmoduleGroup[] = submodules
    .map((submodule): GitFileListSubmoduleGroup => {
      const pointer = pointers.get(submodule);
      const inner = grouped.get(submodule) ?? [];
      return { path: submodule, name: segmentName(submodule), ...(pointer === undefined ? {} : { pointer }), files: [...inner].sort((left, right) => left.relativePath.localeCompare(right.relativePath)) };
    })
    .sort((left, right) => left.name.localeCompare(right.name));

  return { submodules: groups, files: flat };
}

function ownerSubmodule(path: string, submodules: readonly string[]): string | undefined {
  let best: string | undefined;
  for (const submodule of submodules) {
    if (submodule !== "" && path.startsWith(`${submodule}/`) && (best === undefined || submodule.length > best.length)) best = submodule;
  }
  return best;
}

function pointerName(file: GitStatusFile): string {
  const from = file.submoduleFromCommit;
  const to = file.submoduleToCommit;
  return from !== undefined && to !== undefined ? `${from} → ${to}` : "commit";
}

function segmentName(path: string): string {
  const segments = path.split("/");
  const last = segments[segments.length - 1];
  return last ?? path;
}
