import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { deleteWorkspaceFile, readWorkspaceFile } from "./fileContentService.js";
import { cleanupTempWorkspaces, createTempWorkspace } from "./fileContentService.testSupport.js";

afterEach(async () => {
  await cleanupTempWorkspaces();
});

describe("deleteWorkspaceFile", () => {
  it("deletes an existing file and returns existed: true", async () => {
    const root = await createTempWorkspace();
    await writeFile(join(root, "notes.txt"), "hello");

    const result = await deleteWorkspaceFile(root, "notes.txt");

    expect(result).toMatchObject({ path: "notes.txt", existed: true });
    await expect(readWorkspaceFile(root, "notes.txt")).rejects.toThrow("Path does not exist");
  });

  it("returns existed: false when deleting a non-existent file", async () => {
    const root = await createTempWorkspace();

    const result = await deleteWorkspaceFile(root, "missing.txt");

    expect(result).toMatchObject({ path: "missing.txt", existed: false });
  });

  it("rejects deleting a directory", async () => {
    const root = await createTempWorkspace();
    await mkdir(join(root, "mydir"), { recursive: true });

    await expect(deleteWorkspaceFile(root, "mydir")).rejects.toThrow("Path is a directory");
  });

  it("rejects traversal and absolute paths", async () => {
    const root = await createTempWorkspace();

    await expect(deleteWorkspaceFile(root, "../secret.txt")).rejects.toThrow("Path traversal is not allowed");
    await expect(deleteWorkspaceFile(root, "/etc/passwd")).rejects.toThrow("Absolute paths are not allowed");
  });

  it("rejects missing path", async () => {
    const root = await createTempWorkspace();

    await expect(deleteWorkspaceFile(root, undefined)).rejects.toThrow("path query parameter is required");
    await expect(deleteWorkspaceFile(root, "")).rejects.toThrow("path query parameter is required");
  });

  it("deletes a symlink itself, not its target", async () => {
    const root = await createTempWorkspace();
    const outsideDir = await createTempWorkspace("pi-web-outside-delete-");
    await writeFile(join(outsideDir, "real.txt"), "real content");
    // Create a symlink inside the workspace pointing outside
    await symlink(join(outsideDir, "real.txt"), join(root, "link.txt"));

    const result = await deleteWorkspaceFile(root, "link.txt");

    expect(result).toMatchObject({ path: "link.txt", existed: true });
    // The symlink should be gone, but the target file should still exist
    await expect(readWorkspaceFile(root, "link.txt")).rejects.toThrow("Path does not exist");
    const realContent = await readFile(join(outsideDir, "real.txt"), "utf8");
    expect(realContent).toBe("real content");
  });

  it("prevents deleting through a symlinked parent directory that escapes the workspace", async () => {
    const root = await createTempWorkspace();
    await mkdir(join(root, "subdir"), { recursive: true });
    // A real file living outside the workspace that must not be deletable.
    const outsideDir = await createTempWorkspace("pi-web-outside-delete-parent-");
    await writeFile(join(outsideDir, "victim.txt"), "important");
    // A symlinked parent directory inside the workspace pointing outside.
    await symlink(outsideDir, join(root, "subdir", "escape"), "junction");

    await expect(deleteWorkspaceFile(root, "subdir/escape/victim.txt")).rejects.toThrow("Path escapes workspace");
    // The outside file must survive.
    const realContent = await readFile(join(outsideDir, "victim.txt"), "utf8");
    expect(realContent).toBe("important");
  });
});
