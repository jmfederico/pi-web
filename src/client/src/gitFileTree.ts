import type { GitStatusFile } from "./api";

/**
 * A changed file placed at a leaf of the Git file tree. `path` is the full
 * repository-relative path (used to load its diff); `name` is just the final
 * segment shown in the tree row.
 */
export interface GitFileTreeFileNode {
  readonly kind: "file";
  readonly name: string;
  readonly path: string;
  readonly file: GitStatusFile;
}

/**
 * A directory grouping in the Git file tree. `path` is the full directory path
 * and doubles as the stable key used to track expand/collapse state.
 */
export interface GitFileTreeDirectoryNode {
  readonly kind: "directory";
  readonly name: string;
  readonly path: string;
  readonly children: readonly GitFileTreeNode[];
}

export type GitFileTreeNode = GitFileTreeDirectoryNode | GitFileTreeFileNode;

interface DirectoryAccumulator {
  readonly path: string;
  readonly directories: Map<string, DirectoryAccumulator>;
  readonly files: GitFileTreeFileNode[];
}

/**
 * Build a nested directory/file tree from Git's flat changed-file list. The
 * status response already carries every changed path, so this is a pure
 * client-side transform (no lazy per-directory loading like the Files tab).
 * Directories sort before files, and both sort alphabetically within a level.
 */
export function buildGitFileTree(files: readonly GitStatusFile[]): GitFileTreeNode[] {
  const root = createDirectoryAccumulator("");
  for (const file of files) {
    const segments = file.path.split("/").filter((segment) => segment.length > 0);
    const name = segments[segments.length - 1];
    if (name === undefined) continue;
    let directory = root;
    for (let index = 0; index < segments.length - 1; index += 1) {
      const segment = segments[index];
      if (segment === undefined) continue;
      const childPath = directory.path.length === 0 ? segment : `${directory.path}/${segment}`;
      const existing = directory.directories.get(childPath);
      if (existing === undefined) {
        const created = createDirectoryAccumulator(childPath);
        directory.directories.set(childPath, created);
        directory = created;
      } else {
        directory = existing;
      }
    }
    directory.files.push({ kind: "file", name, path: file.path, file });
  }
  return finalizeChildren(root);
}

/**
 * Every directory path in the tree, in a stable order. Used to drive the
 * expand-all / collapse-all control and to decide whether the tree is fully
 * expanded.
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

function createDirectoryAccumulator(path: string): DirectoryAccumulator {
  return { path, directories: new Map(), files: [] };
}

function finalizeChildren(directory: DirectoryAccumulator): GitFileTreeNode[] {
  const directories: GitFileTreeDirectoryNode[] = [...directory.directories.values()]
    .map((child): GitFileTreeDirectoryNode => ({ kind: "directory", name: segmentName(child.path), path: child.path, children: finalizeChildren(child) }))
    .sort((left, right) => left.name.localeCompare(right.name));
  const files = [...directory.files].sort((left, right) => left.name.localeCompare(right.name));
  return [...directories, ...files];
}

function segmentName(path: string): string {
  const segments = path.split("/");
  const last = segments[segments.length - 1];
  return last ?? path;
}
