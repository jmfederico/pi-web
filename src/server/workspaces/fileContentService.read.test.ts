import { mkdir, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_IMAGE_PREVIEW_BYTES } from "../../shared/workspaceFiles.js";
import { readWorkspaceFile } from "./fileContentService.js";
import { cleanupTempWorkspaces, createTempWorkspace } from "./fileContentService.testSupport.js";
import { readWorkspaceImagePreview } from "./imagePreviewService.js";

afterEach(async () => {
  await cleanupTempWorkspaces();
});

describe("readWorkspaceFile", () => {
  it("reads text files with normalized paths and language metadata", async () => {
    const root = await createTempWorkspace();
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
    const root = await createTempWorkspace();
    await mkdir(join(root, "dir"));

    await expect(readWorkspaceFile(root, undefined)).rejects.toThrow("path query parameter is required");
    await expect(readWorkspaceFile(root, "dir")).rejects.toThrow("Path is not a file");
    await expect(readWorkspaceFile(root, "missing.txt")).rejects.toThrow("Path does not exist");
    await expect(readWorkspaceFile(root, "../secret.txt")).rejects.toThrow("Path traversal is not allowed");
    await expect(readWorkspaceFile(root, "/etc/passwd")).rejects.toThrow("Absolute paths are not allowed");
  });

  it("reads allowed absolute files outside the workspace", async () => {
    const root = await createTempWorkspace();
    const external = await createTempWorkspace();
    await writeFile(join(external, "README.md"), "external docs\n");

    const file = await readWorkspaceFile(root, join(external, "README.md"), { allowedPaths: [external] });

    expect(file).toMatchObject({
      path: join(external, "README.md"),
      language: "markdown",
      content: "external docs\n",
      truncated: false,
      binary: false,
    });
    await expect(readWorkspaceFile(root, join(external, "README.md"))).rejects.toThrow("Absolute paths are not allowed");
  });

  it("detects binary files and omits binary content", async () => {
    const root = await createTempWorkspace();
    await writeFile(join(root, "image.bin"), Buffer.from([0x66, 0x6f, 0x00, 0x6f]));

    const file = await readWorkspaceFile(root, "image.bin");

    expect(file).toMatchObject({ content: "", binary: true, truncated: false });
    expect(file.size).toBe(4);
  });

  it("marks supported images as previewable", async () => {
    const root = await createTempWorkspace();
    await writeFile(join(root, "logo.PNG"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]));

    const file = await readWorkspaceFile(root, "logo.PNG");

    expect(file).toMatchObject({ mediaType: "image", mimeType: "image/png", content: "", binary: true, truncated: false });
    expect(file.size).toBe(9);
  });

  it("opens image preview streams only for supported images within the preview size limit", async () => {
    const root = await createTempWorkspace();
    await writeFile(join(root, "diagram.svg"), "<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>");
    await writeFile(join(root, "note.txt"), "hello");
    await writeFile(join(root, "huge.png"), "");
    await truncate(join(root, "huge.png"), MAX_IMAGE_PREVIEW_BYTES + 1);

    const preview = await readWorkspaceImagePreview(root, "diagram.svg");
    preview.stream.destroy();

    expect(preview).toMatchObject({ path: "diagram.svg", mimeType: "image/svg+xml", size: 46 });
    await expect(readWorkspaceImagePreview(root, "note.txt")).rejects.toThrow("Image preview is not supported");
    await expect(readWorkspaceImagePreview(root, "huge.png")).rejects.toThrow("Image is too large to preview");
  });

  it("truncates large text files", async () => {
    const root = await createTempWorkspace();
    await writeFile(join(root, "large.md"), "a".repeat(512 * 1024 + 7));

    const file = await readWorkspaceFile(root, "large.md");

    expect(file.language).toBe("markdown");
    expect(file.content).toHaveLength(512 * 1024);
    expect(file.truncated).toBe(true);
    expect(file.binary).toBe(false);
  });
});
