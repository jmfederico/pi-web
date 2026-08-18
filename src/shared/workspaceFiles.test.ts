import { describe, expect, it } from "vitest";
import { classifyWorkspaceFile, workspaceFileName } from "./workspaceFiles.js";

describe("classifyWorkspaceFile", () => {
  it.each([
    ["PHOTO.AVIF", "image/avif"],
    ["PHOTO.BMP", "image/bmp"],
    ["PHOTO.GIF", "image/gif"],
    ["PHOTO.ICO", "image/x-icon"],
    ["PHOTO.JPEG", "image/jpeg"],
    ["PHOTO.JPG", "image/jpeg"],
    ["PHOTO.PNG", "image/png"],
    ["PHOTO.WEBP", "image/webp"],
  ])("classifies %s as streamed image bytes", (path, previewMimeType) => {
    expect(classifyWorkspaceFile(path)).toEqual({ mediaType: "image", source: "stream", previewMimeType });
  });

  it.each(["PHOTO.SVG", "diagram.svg"])("classifies %s as an image that keeps literal source for Raw mode", (path) => {
    expect(classifyWorkspaceFile(path)).toEqual({ mediaType: "image", source: "text", previewMimeType: "image/svg+xml" });
  });

  it.each(["REPORT.HTM", "REPORT.HTML"])("classifies %s as literal HTML source", (path) => {
    expect(classifyWorkspaceFile(path)).toEqual({ mediaType: "html", source: "text", previewMimeType: "text/html; charset=utf-8" });
  });

  it.each(["notes.MD", "notes.MarkDown"])("classifies %s as literal Markdown source", (path) => {
    expect(classifyWorkspaceFile(path)).toEqual({ mediaType: "markdown", source: "text" });
  });

  it("classifies PDFs as streamed bytes and leaves unsupported extensions unclassified", () => {
    expect(classifyWorkspaceFile("SPEC.PDF")).toEqual({ mediaType: "pdf", source: "stream", previewMimeType: "application/pdf" });
    expect(classifyWorkspaceFile("archive.zip")).toBeUndefined();
    expect(classifyWorkspaceFile("folder.with.dot/file")).toBeUndefined();
  });
});

describe("workspaceFileName", () => {
  it("extracts the real leaf name from POSIX, Windows, and mixed workspace paths", () => {
    expect(workspaceFileName("reports/annual.pdf")).toBe("annual.pdf");
    expect(workspaceFileName(String.raw`C:\reports\annual.pdf`)).toBe("annual.pdf");
    expect(workspaceFileName(String.raw`C:\reports/archive.zip`)).toBe("archive.zip");
  });
});
