import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readWorkspaceFile } from "./fileContentService.js";

const roots: string[] = [];

async function tempWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-web-file-content-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("readWorkspaceFile", () => {
  it("reads text files with normalized paths and language metadata", async () => {
    const root = await tempWorkspace();
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "main.ts"), "const answer = 42;\n");

    const file = await readWorkspaceFile(root, "./src//main.ts");

    expect(file).toMatchObject({
      path: "src/main.ts",
      language: "typescript",
      encoding: "utf8",
      content: "const answer = 42;\n",
      truncated: false,
      binary: false,
    });
    expect(file.size).toBe(19);
    expect(Date.parse(file.modifiedAt)).not.toBeNaN();
  });

  it("rejects missing paths, directories, traversal, and absolute paths", async () => {
    const root = await tempWorkspace();
    await mkdir(join(root, "dir"));

    await expect(readWorkspaceFile(root, undefined)).rejects.toThrow("path query parameter is required");
    await expect(readWorkspaceFile(root, "dir")).rejects.toThrow("Path is not a file");
    await expect(readWorkspaceFile(root, "missing.txt")).rejects.toThrow("Path does not exist");
    await expect(readWorkspaceFile(root, "../secret.txt")).rejects.toThrow("Path traversal is not allowed");
    await expect(readWorkspaceFile(root, "/etc/passwd")).rejects.toThrow("Absolute paths are not allowed");
  });

  it("detects binary files and omits binary content", async () => {
    const root = await tempWorkspace();
    await writeFile(join(root, "image.bin"), Buffer.from([0x66, 0x6f, 0x00, 0x6f]));

    const file = await readWorkspaceFile(root, "image.bin");

    expect(file).toMatchObject({ content: "", binary: true, truncated: false });
    expect(file.size).toBe(4);
  });

  it("truncates large text files", async () => {
    const root = await tempWorkspace();
    await writeFile(join(root, "large.md"), "a".repeat(512 * 1024 + 7));

    const file = await readWorkspaceFile(root, "large.md");

    expect(file.language).toBe("markdown");
    expect(file.content).toHaveLength(512 * 1024);
    expect(file.truncated).toBe(true);
    expect(file.binary).toBe(false);
  });
});
