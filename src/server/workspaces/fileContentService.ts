import { open, stat } from "node:fs/promises";
import type { FileContentResponse } from "../../shared/apiTypes.js";
import { imageMimeTypeForPath } from "./imagePreviewService.js";
import { resolveInsideWorkspace } from "./pathSafety.js";

const MAX_BYTES = 512 * 1024;

export async function readWorkspaceFile(rootPath: string, path: string | undefined): Promise<FileContentResponse> {
  if (path === undefined || path === "") throw new Error("path query parameter is required");
  const { target, relativePath } = await resolveInsideWorkspace(rootPath, path);
  const s = await stat(target);
  if (!s.isFile()) throw new Error("Path is not a file");
  const bytesToRead = Math.min(s.size, MAX_BYTES);
  const buffer = await readFilePrefix(target, bytesToRead);
  const media = mediaForPath(relativePath);
  const binary = media.mediaType === "image" || isProbablyBinary(buffer);
  return {
    path: relativePath,
    ...languageForPath(relativePath),
    ...media,
    encoding: "utf8",
    size: s.size,
    modifiedAt: s.mtime.toISOString(),
    content: binary ? "" : buffer.toString("utf8"),
    truncated: s.size > MAX_BYTES,
    binary,
  };
}

async function readFilePrefix(target: string, bytesToRead: number): Promise<Buffer> {
  if (bytesToRead === 0) return Buffer.alloc(0);
  const buffer = Buffer.alloc(bytesToRead);
  const handle = await open(target, "r");
  try {
    const result = await handle.read(buffer, 0, bytesToRead, 0);
    return buffer.subarray(0, result.bytesRead);
  } finally {
    await handle.close();
  }
}

function isProbablyBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  return sample.includes(0);
}

function languageForPath(path: string): { language?: string } {
  const ext = path.split(".").pop()?.toLowerCase();
  const languages: Record<string, string | undefined> = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    json: "json",
    md: "markdown",
    css: "css",
    html: "html",
    py: "python",
    rs: "rust",
    go: "go",
    sh: "shell",
    yml: "yaml",
    yaml: "yaml",
  };
  const language = ext === undefined ? undefined : languages[ext];
  return language === undefined ? {} : { language };
}

function mediaForPath(path: string): { mediaType?: "image"; mimeType?: string } {
  const mimeType = imageMimeTypeForPath(path);
  return mimeType === undefined ? {} : { mediaType: "image", mimeType };
}
