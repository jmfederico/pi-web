import { describe, expect, it } from "vitest";
import type { GitStatusFile } from "./api";
import {
  buildGitFileTree,
  collectGitFileTreeDirectoryPaths,
  type GitFileTreeDirectoryNode,
  type GitFileTreeFileNode,
  type GitFileTreeNode,
} from "./gitFileTree";

describe("buildGitFileTree", () => {
  it("returns an empty tree for no changes", () => {
    expect(buildGitFileTree([])).toEqual([]);
    expect(collectGitFileTreeDirectoryPaths([])).toEqual([]);
  });

  it("keeps root-level files at the root", () => {
    const tree = buildGitFileTree([changed("b.txt"), changed("a.txt")]);
    expect(tree.map((node) => node.kind)).toEqual(["file", "file"]);
    expect(tree.map((node) => node.name)).toEqual(["a.txt", "b.txt"]);
    expect(collectGitFileTreeDirectoryPaths(tree)).toEqual([]);
  });

  it("nests files under merged directories, directories before files, alphabetical", () => {
    const tree = buildGitFileTree([
      changed("src/a.ts"),
      changed("src/b/c.ts"),
      changed("README.md"),
      changed("src/b/a.ts"),
    ]);

    expect(tree).toHaveLength(2);
    const src = expectDirectory(tree[0]);
    expect(src.name).toBe("src");
    expect(src.path).toBe("src");
    expect(expectFile(tree[1]).name).toBe("README.md");

    // src groups the shared "b" directory once, ordered before the loose file.
    expect(src.children).toHaveLength(2);
    const srcB = expectDirectory(src.children[0]);
    expect(srcB.name).toBe("b");
    expect(srcB.path).toBe("src/b");
    expect(expectFile(src.children[1]).path).toBe("src/a.ts");

    expect(srcB.children.map((node) => node.name)).toEqual(["a.ts", "c.ts"]);
    expect(srcB.children.map((node) => expectFile(node).path)).toEqual(["src/b/a.ts", "src/b/c.ts"]);
  });

  it("shows the basename on leaves while keeping the full path and original file", () => {
    const original = changed("deep/nested/file.ts");
    const leaf = expectFile(expectDirectory(expectDirectory(buildGitFileTree([original])[0]).children[0]).children[0]);
    expect(leaf.name).toBe("file.ts");
    expect(leaf.path).toBe("deep/nested/file.ts");
    expect(leaf.file).toBe(original);
  });

  it("collects every directory path in pre-order", () => {
    const tree = buildGitFileTree([changed("src/b/c.ts"), changed("src/a.ts"), changed("docs/x.md")]);
    expect(collectGitFileTreeDirectoryPaths(tree)).toEqual(["docs", "src", "src/b"]);
  });

  it("marks a submodule directory and pins its pointer as the first child", () => {
    const pointer = submodulePointer("HARL", "1111111", "2222222");
    const tree = buildGitFileTree([pointer, changed("HARL/tracked.txt"), changed("HARL/src/foo.ts"), changed("README.md")], ["HARL"]);

    expect(tree.map((node) => node.name)).toEqual(["HARL", "README.md"]);
    const harl = expectDirectory(tree[0]);
    expect(harl.isSubmodule).toBe(true);

    // Pointer first, then directories, then files (submodule-relative nesting kept).
    const pointerRow = expectFile(harl.children[0]);
    expect(pointerRow.isSubmodulePointer).toBe(true);
    expect(pointerRow.name).toBe("1111111 → 2222222");
    expect(pointerRow.path).toBe("HARL");
    expect(pointerRow.file).toBe(pointer);

    const src = expectDirectory(harl.children[1]);
    expect(src.path).toBe("HARL/src");
    expect(expectFile(src.children[0]).path).toBe("HARL/src/foo.ts");
    expect(expectFile(harl.children[2]).path).toBe("HARL/tracked.txt");
  });

  it("creates a submodule node for a pointer-only change with no inner files", () => {
    const tree = buildGitFileTree([submodulePointer("HARL", "aaaaaaa", "bbbbbbb")], ["HARL"]);
    const harl = expectDirectory(tree[0]);
    expect(harl.isSubmodule).toBe(true);
    expect(harl.children).toHaveLength(1);
    expect(expectFile(harl.children[0]).isSubmodulePointer).toBe(true);
    expect(collectGitFileTreeDirectoryPaths(tree)).toEqual(["HARL"]);
  });

  it("groups a dirty submodule without a moved pointer and emits no pointer row", () => {
    const tree = buildGitFileTree([changed("HARL/x.txt"), changed("HARL/nested/y.txt")], ["HARL"]);
    const harl = expectDirectory(tree[0]);
    expect(harl.isSubmodule).toBe(true);
    expect(harl.children.every((node) => node.kind !== "file" || node.isSubmodulePointer !== true)).toBe(true);
    expect(collectGitFileTreeDirectoryPaths(tree)).toEqual(["HARL", "HARL/nested"]);
  });
});

function submodulePointer(path: string, from: string, to: string): GitStatusFile {
  return { path, index: "unmodified", workingTree: "modified", submoduleFromCommit: from, submoduleToCommit: to };
}

function changed(path: string): GitStatusFile {
  return { path, index: "modified", workingTree: "modified" };
}

function expectDirectory(node: GitFileTreeNode | undefined): GitFileTreeDirectoryNode {
  if (node?.kind !== "directory") throw new Error(`expected a directory node, received ${node?.kind ?? "undefined"}`);
  return node;
}

function expectFile(node: GitFileTreeNode | undefined): GitFileTreeFileNode {
  if (node?.kind !== "file") throw new Error(`expected a file node, received ${node?.kind ?? "undefined"}`);
  return node;
}
