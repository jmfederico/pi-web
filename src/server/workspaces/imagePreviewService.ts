import { createReadStream, type ReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname } from "node:path";
import { MAX_IMAGE_PREVIEW_BYTES, MAX_IMAGE_PREVIEW_LABEL } from "../../shared/workspaceFiles.js";
import { resolveInsideWorkspace } from "./pathSafety.js";

const IMAGE_MIME_TYPES: Record<string, string | undefined> = {
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

export interface WorkspaceImagePreview {
  path: string;
  mimeType: string;
  size: number;
  modifiedAt: string;
  stream: ReadStream;
}

export function imageMimeTypeForPath(path: string): string | undefined {
  return IMAGE_MIME_TYPES[extname(path).toLowerCase()];
}

export async function readWorkspaceImagePreview(rootPath: string, path: string | undefined): Promise<WorkspaceImagePreview> {
  if (path === undefined || path === "") throw new Error("path query parameter is required");
  const { target, relativePath } = await resolveInsideWorkspace(rootPath, path);
  const s = await stat(target);
  if (!s.isFile()) throw new Error("Path is not a file");
  const mimeType = imageMimeTypeForPath(relativePath);
  if (mimeType === undefined) throw new Error("Image preview is not supported for this file type");
  if (s.size > MAX_IMAGE_PREVIEW_BYTES) throw new Error(`Image is too large to preview (limit ${MAX_IMAGE_PREVIEW_LABEL})`);
  return {
    path: relativePath,
    mimeType,
    size: s.size,
    modifiedAt: s.mtime.toISOString(),
    stream: createReadStream(target),
  };
}
