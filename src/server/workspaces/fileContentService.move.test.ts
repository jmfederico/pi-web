import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { moveWorkspaceFile, readWorkspaceFile } from "./fileContentService.js";
import { cleanupTempWorkspaces, createTempWorkspace } from "./fileContentService.testSupport.js";

afterEach(async () => {
  await cleanupTempWorkspaces();
});

describe("moveWorkspaceFile", () => {
  it("moves a file to a new path", async () => {
    const root = await createTempWorkspace();
    await writeFile(join(root, "original.txt"), "content");

    const result = await moveWorkspaceFile(root, "original.txt", "moved.txt");

    expect(result).toMatchObject({ fromPath: "original.txt", toPath: "moved.txt" });
    expect(result.size).toBe(7);
    expect(Date.parse(result.modifiedAt)).not.toBeNaN();
    // Source should no longer exist
    await expect(readWorkspaceFile(root, "original.txt")).rejects.toThrow("Path does not exist");
    // Target should exist
    const target = await readWorkspaceFile(root, "moved.txt");
    expect(target.content).toBe("content");
  });

  it("creates intermediate directories by default", async () => {
    const root = await createTempWorkspace();
    await writeFile(join(root, "file.txt"), "data");

    await moveWorkspaceFile(root, "file.txt", "deep/nested/dir/file.txt");

    const target = await readWorkspaceFile(root, "deep/nested/dir/file.txt");
    expect(target.content).toBe("data");
  });

  it("fails when createDirs is false and parent directory does not exist", async () => {
    const root = await createTempWorkspace();
    await writeFile(join(root, "file.txt"), "data");

    await expect(moveWorkspaceFile(root, "file.txt", "missing/dir/file.txt", { createDirs: false })).rejects.toThrow();
    const source = await readWorkspaceFile(root, "file.txt");
    expect(source.content).toBe("data");
  });

  it("overwrites target when overwrite is true", async () => {
    const root = await createTempWorkspace();
    await writeFile(join(root, "source.txt"), "source content");
    await writeFile(join(root, "target.txt"), "target content");

    const result = await moveWorkspaceFile(root, "source.txt", "target.txt", { overwrite: true });

    expect(result.toPath).toBe("target.txt");
    const target = await readWorkspaceFile(root, "target.txt");
    expect(target.content).toBe("source content");
  });

  it("throws when target exists and overwrite is false (default)", async () => {
    const root = await createTempWorkspace();
    await writeFile(join(root, "source.txt"), "source");
    await writeFile(join(root, "target.txt"), "target");

    await expect(moveWorkspaceFile(root, "source.txt", "target.txt")).rejects.toThrow("File already exists");
    // Source and target should remain unchanged
    const source = await readWorkspaceFile(root, "source.txt");
    expect(source.content).toBe("source");
    const target = await readWorkspaceFile(root, "target.txt");
    expect(target.content).toBe("target");
  });

  it("rejects source path traversal", async () => {
    const root = await createTempWorkspace();

    await expect(moveWorkspaceFile(root, "../secret.txt", "target.txt")).rejects.toThrow("Path traversal is not allowed");
  });

  it("rejects target path traversal", async () => {
    const root = await createTempWorkspace();
    await writeFile(join(root, "source.txt"), "data");

    await expect(moveWorkspaceFile(root, "source.txt", "../secret.txt")).rejects.toThrow("Path traversal is not allowed");
    const source = await readWorkspaceFile(root, "source.txt");
    expect(source.content).toBe("data");
  });

  it("rejects moving a directory", async () => {
    const root = await createTempWorkspace();
    await mkdir(join(root, "mydir"), { recursive: true });

    await expect(moveWorkspaceFile(root, "mydir", "newdir")).rejects.toThrow("Source path is not a file");
  });

  it("rejects missing fromPath or toPath", async () => {
    const root = await createTempWorkspace();

    await expect(moveWorkspaceFile(root, undefined, "target.txt")).rejects.toThrow("fromPath query parameter is required");
    await expect(moveWorkspaceFile(root, "source.txt", undefined)).rejects.toThrow("toPath query parameter is required");
    await expect(moveWorkspaceFile(root, "", "target.txt")).rejects.toThrow("fromPath query parameter is required");
    await expect(moveWorkspaceFile(root, "source.txt", "")).rejects.toThrow("toPath query parameter is required");
  });

  it("prevents moving through symlinks that escape the workspace", async () => {
    const root = await createTempWorkspace();
    await mkdir(join(root, "subdir"), { recursive: true });
    await writeFile(join(root, "subdir", "file.txt"), "data");
    // Create a symlink inside the workspace that points outside
    const outsideDir = await createTempWorkspace("pi-web-move-outside-");
    await symlink(outsideDir, join(root, "subdir", "escape"), "junction");

    await expect(moveWorkspaceFile(root, "subdir/file.txt", "subdir/escape/evil.txt")).rejects.toThrow("Path escapes workspace");
    const source = await readWorkspaceFile(root, "subdir/file.txt");
    expect(source.content).toBe("data");
    await expect(readFile(join(outsideDir, "evil.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("prevents moving a source symlink that escapes the workspace", async () => {
    const root = await createTempWorkspace();
    const outsideDir = await createTempWorkspace("pi-web-move-source-outside-");
    await writeFile(join(outsideDir, "secret.txt"), "secret");
    await symlink(join(outsideDir, "secret.txt"), join(root, "source-link.txt"));

    await expect(moveWorkspaceFile(root, "source-link.txt", "moved.txt")).rejects.toThrow("Path escapes workspace");
    await expect(readWorkspaceFile(root, "moved.txt")).rejects.toThrow("Path does not exist");
    await expect(readFile(join(outsideDir, "secret.txt"), "utf8")).resolves.toBe("secret");
  });
});
