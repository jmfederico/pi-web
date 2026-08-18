import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listWorkspaceTree } from "./fileTreeService.js";

const roots: string[] = [];

async function tempWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-web-file-tree-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("listWorkspaceTree", () => {
  it("lists entries with directories first, sorted by name", async () => {
    const root = await tempWorkspace();
    await mkdir(join(root, "z-dir"));
    await mkdir(join(root, "a-dir"));
    await mkdir(join(root, ".git"));
    await mkdir(join(root, "node_modules"));
    await writeFile(join(root, "b.txt"), "b");
    await writeFile(join(root, "a.txt"), "a");
    const createdSymlink = await trySymlink(join(root, "a.txt"), join(root, "link.txt"));

    const tree = await listWorkspaceTree(root, undefined);

    expect(tree.path).toBe("");
    expect(tree.truncated).toBe(false);
    expect(tree.entries.map((entry) => [entry.name, entry.type])).toEqual([
      [".git", "directory"],
      ["a-dir", "directory"],
      ["node_modules", "directory"],
      ["z-dir", "directory"],
      ["a.txt", "file"],
      ["b.txt", "file"],
      ...(createdSymlink ? [["link.txt", "symlink"]] : []),
    ]);
    expect(Date.parse(tree.scannedAt)).not.toBeNaN();
  });

  it("lists nested directories using normalized relative paths", async () => {
    const root = await tempWorkspace();
    await mkdir(join(root, "src", "client"), { recursive: true });
    await writeFile(join(root, "src", "client", "main.ts"), "");

    const tree = await listWorkspaceTree(root, "./src//client");

    expect(tree.path).toBe("src/client");
    expect(tree.entries).toHaveLength(1);
    expect(tree.entries[0]).toMatchObject({ name: "main.ts", path: "src/client/main.ts", type: "file" });
  });

  it("lists allowed absolute directories outside the workspace", async () => {
    const root = await tempWorkspace();
    const external = await tempWorkspace();
    await mkdir(join(external, "docs"));
    await writeFile(join(external, "sdk.ts"), "export {};\n");

    const tree = await listWorkspaceTree(root, external, { allowedPaths: [external] });

    expect(tree.path).toBe(external);
    expect(tree.entries.map((entry) => [entry.name, entry.path, entry.type])).toEqual([
      ["docs", join(external, "docs"), "directory"],
      ["sdk.ts", join(external, "sdk.ts"), "file"],
    ]);
    await expect(listWorkspaceTree(root, external)).rejects.toThrow("Absolute paths are not allowed");
  });

  it("rejects non-directory targets and unsafe paths", async () => {
    const root = await tempWorkspace();
    await writeFile(join(root, "file.txt"), "content");

    await expect(listWorkspaceTree(root, "file.txt")).rejects.toThrow("Path is not a directory");
    await expect(listWorkspaceTree(root, "missing-dir")).rejects.toThrow("Path does not exist");
    await expect(listWorkspaceTree(root, "../outside")).rejects.toThrow("Path traversal is not allowed");
    await expect(listWorkspaceTree(root, "/tmp")).rejects.toThrow("Absolute paths are not allowed");
  });

  // Writing MAX_ENTRIES + 1 files is inherently I/O-heavy; slow filesystems (notably
  // Windows CI) can exceed Vitest's default 5s timeout, so give this case extra headroom.
  it("marks responses as truncated after the service entry limit", async () => {
    const root = await tempWorkspace();
    await Promise.all(Array.from({ length: 1001 }, (_, index) => writeFile(join(root, `${String(index).padStart(4, "0")}.txt`), "")));

    const tree = await listWorkspaceTree(root, undefined);

    expect(tree.entries).toHaveLength(1000);
    expect(tree.truncated).toBe(true);
  }, 30_000);
});

async function trySymlink(target: string, path: string): Promise<boolean> {
  try {
    await symlink(target, path);
    return true;
  } catch (error) {
    if (isNodeErrorWithCode(error, "EPERM")) return false;
    throw error;
  }
}

function isNodeErrorWithCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
