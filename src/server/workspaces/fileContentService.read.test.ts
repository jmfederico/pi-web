import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_WORKSPACE_FILE_CONTENT_BYTES } from "../../shared/workspaceFiles.js";
import { readWorkspaceFile } from "./fileContentService.js";
import { cleanupTempWorkspaces, createTempWorkspace } from "./fileContentService.testSupport.js";

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

  it("preserves literal HTML, Markdown, and SVG source while keeping PDF bytes out of JSON", async () => {
    const root = await createTempWorkspace();
    const html = "<h1>hi</h1><script>window.top.location = '/stolen'</script>";
    const markdown = "# Notes\n\n<img src=x onerror=alert(1)>\n";
    const svg = "<svg xmlns=\"http://www.w3.org/2000/svg\" onload=\"alert(1)\"></svg>";
    await writeFile(join(root, "report.html"), html);
    await writeFile(join(root, "README.MD"), markdown);
    await writeFile(join(root, "diagram.SVG"), svg);
    await writeFile(join(root, "spec.PDF"), Buffer.from("%PDF-1.4\n"));

    const htmlFile = await readWorkspaceFile(root, "report.html");
    const markdownFile = await readWorkspaceFile(root, "README.MD");
    const svgFile = await readWorkspaceFile(root, "diagram.SVG");
    const pdfFile = await readWorkspaceFile(root, "spec.PDF");

    expect(svgFile).toMatchObject({ mediaType: "image", mimeType: "image/svg+xml", content: svg, binary: false });
    expect(htmlFile).toMatchObject({ mediaType: "html", mimeType: "text/html; charset=utf-8", content: html, binary: false });
    expect(markdownFile).toMatchObject({ mediaType: "markdown", language: "markdown", content: markdown, binary: false });
    expect(markdownFile.mimeType).toBeUndefined();
    expect(pdfFile).toMatchObject({ mediaType: "pdf", mimeType: "application/pdf", content: "", binary: true });
  });

  it("leaves unsupported binaries without a media type so they fall back to download", async () => {
    const root = await createTempWorkspace();
    await writeFile(join(root, "archive.zip"), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]));

    const file = await readWorkspaceFile(root, "archive.zip");

    expect(file.mediaType).toBeUndefined();
    expect(file).toMatchObject({ content: "", binary: true });
  });

  it.each(["large.md", "large.html"])("caps literal source for %s", async (path) => {
    const root = await createTempWorkspace();
    await writeFile(join(root, path), "a".repeat(MAX_WORKSPACE_FILE_CONTENT_BYTES + 7));

    const file = await readWorkspaceFile(root, path);

    expect(file.content).toHaveLength(MAX_WORKSPACE_FILE_CONTENT_BYTES);
    expect(file.truncated).toBe(true);
    expect(file.binary).toBe(false);
  });

});
