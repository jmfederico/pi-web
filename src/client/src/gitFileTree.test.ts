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
});

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
