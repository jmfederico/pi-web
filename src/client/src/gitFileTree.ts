import type { GitStatusFile } from "./api";

/**
 * A changed file placed at a leaf of the Git file tree. `path` is the full
 * repository-relative path (used to load its diff); `name` is just the final
 * segment shown in the tree row. A submodule commit-pointer row reuses this
 * shape: `isSubmodulePointer` is set, `path` is the submodule path, and `name`
 * is the `<old> → <new>` short-SHA summary.
 */
export interface GitFileTreeFileNode {
  readonly kind: "file";
  readonly name: string;
  readonly path: string;
  readonly file: GitStatusFile;
  readonly isSubmodulePointer?: boolean;
}

/**
 * A directory grouping in the Git file tree. `path` is the full directory path
 * and doubles as the stable key used to track expand/collapse state.
 * `isSubmodule` marks a directory that is actually a submodule root so the UI
 * can label it and treat its contents as the submodule's own changes.
 */
export interface GitFileTreeDirectoryNode {
  readonly kind: "directory";
  readonly name: string;
  readonly path: string;
  readonly isSubmodule?: boolean;
  readonly children: readonly GitFileTreeNode[];
}

export type GitFileTreeNode = GitFileTreeDirectoryNode | GitFileTreeFileNode;

interface DirectoryAccumulator {
  readonly path: string;
  readonly directories: Map<string, DirectoryAccumulator>;
  readonly files: GitFileTreeFileNode[];
  isSubmodule: boolean;
  pointer?: GitFileTreeFileNode;
}

/**
 * Build a nested directory/file tree from Git's flat changed-file list. The
 * status response already carries every changed path, so this is a pure
 * client-side transform (no lazy per-directory loading like the Files tab).
 *
 * `submodules` lists submodule roots: a directory matching one is marked as a
 * submodule, a file whose path equals one becomes that submodule's pinned
 * commit-pointer row, and files below one nest inside it. Directories sort
 * before files (pointer row first within a submodule), both alphabetically.
 */
export function buildGitFileTree(files: readonly GitStatusFile[], submodules: readonly string[] = []): GitFileTreeNode[] {
  const root = createDirectoryAccumulator("");
  const submoduleSet = new Set(submodules);
  // Ensure a node exists (and is marked) for every submodule, so a submodule
  // whose only change is a moved pointer still renders as an expandable root.
  for (const submodule of submodules) ensureDirectory(root, submodule).isSubmodule = true;

  for (const file of files) {
    if (submoduleSet.has(file.path)) {
      const directory = ensureDirectory(root, file.path);
      directory.isSubmodule = true;
      directory.pointer = { kind: "file", name: pointerName(file), path: file.path, file, isSubmodulePointer: true };
      continue;
    }
    const segments = file.path.split("/").filter((segment) => segment.length > 0);
    const name = segments[segments.length - 1];
    if (name === undefined) continue;
    let directory = root;
    for (let index = 0; index < segments.length - 1; index += 1) {
      const segment = segments[index];
      if (segment === undefined) continue;
      directory = childDirectory(directory, segment);
    }
    directory.files.push({ kind: "file", name, path: file.path, file });
  }
  return finalizeChildren(root);
}

/**
 * Every directory path in the tree, in a stable order. Used to drive the
 * expand-all / collapse-all control and to decide whether the tree is fully
 * expanded. Submodule roots are directories and are included.
 */
export function collectGitFileTreeDirectoryPaths(nodes: readonly GitFileTreeNode[]): string[] {
  const paths: string[] = [];
  for (const node of nodes) {
    if (node.kind === "directory") {
      paths.push(node.path);
      paths.push(...collectGitFileTreeDirectoryPaths(node.children));
    }
  }
  return paths;
}

function pointerName(file: GitStatusFile): string {
  const from = file.submoduleFromCommit;
  const to = file.submoduleToCommit;
  return from !== undefined && to !== undefined ? `${from} → ${to}` : "commit";
}

function createDirectoryAccumulator(path: string): DirectoryAccumulator {
  return { path, directories: new Map(), files: [], isSubmodule: false };
}

function childDirectory(parent: DirectoryAccumulator, segment: string): DirectoryAccumulator {
  const childPath = parent.path.length === 0 ? segment : `${parent.path}/${segment}`;
  const existing = parent.directories.get(childPath);
  if (existing !== undefined) return existing;
  const created = createDirectoryAccumulator(childPath);
  parent.directories.set(childPath, created);
  return created;
}

function ensureDirectory(root: DirectoryAccumulator, path: string): DirectoryAccumulator {
  let directory = root;
  for (const segment of path.split("/").filter((part) => part.length > 0)) directory = childDirectory(directory, segment);
  return directory;
}

function finalizeChildren(directory: DirectoryAccumulator): GitFileTreeNode[] {
  const directories: GitFileTreeDirectoryNode[] = [...directory.directories.values()]
    .map((child): GitFileTreeDirectoryNode => ({ kind: "directory", name: segmentName(child.path), path: child.path, ...(child.isSubmodule ? { isSubmodule: true } : {}), children: finalizeChildren(child) }))
    .sort((left, right) => left.name.localeCompare(right.name));
  const files = [...directory.files].sort((left, right) => left.name.localeCompare(right.name));
  return [...(directory.pointer === undefined ? [] : [directory.pointer]), ...directories, ...files];
}

function segmentName(path: string): string {
  const segments = path.split("/");
  const last = segments[segments.length - 1];
  return last ?? path;
}
