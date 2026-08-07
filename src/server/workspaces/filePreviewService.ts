import { createReadStream, type ReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import type { FileContentMediaType, PiWebPathAccessConfig } from "../../shared/apiTypes.js";
import { MAX_INLINE_PREVIEW_BYTES, MAX_INLINE_PREVIEW_LABEL } from "../../shared/workspaceFiles.js";
import { resolveWorkspacePathAccessTarget } from "./pathAccessPolicy.js";

export interface PreviewMedia {
  mediaType: FileContentMediaType;
  mimeType: string;
}

// Extension → media classification for files that render inline in the browser.
// This is an allowlist on purpose: only these types are served with a MIME type
// the browser will render; everything else is offered as a download instead.
const INLINE_PREVIEW_MEDIA: Record<string, PreviewMedia | undefined> = {
  ".avif": { mediaType: "image", mimeType: "image/avif" },
  ".bmp": { mediaType: "image", mimeType: "image/bmp" },
  ".gif": { mediaType: "image", mimeType: "image/gif" },
  ".ico": { mediaType: "image", mimeType: "image/x-icon" },
  ".jpeg": { mediaType: "image", mimeType: "image/jpeg" },
  ".jpg": { mediaType: "image", mimeType: "image/jpeg" },
  ".png": { mediaType: "image", mimeType: "image/png" },
  ".svg": { mediaType: "image", mimeType: "image/svg+xml" },
  ".webp": { mediaType: "image", mimeType: "image/webp" },
  ".htm": { mediaType: "html", mimeType: "text/html" },
  ".html": { mediaType: "html", mimeType: "text/html" },
  ".pdf": { mediaType: "pdf", mimeType: "application/pdf" },
};

export function previewMediaForPath(path: string): PreviewMedia | undefined {
  return INLINE_PREVIEW_MEDIA[extname(path).toLowerCase()];
}

export interface WorkspaceFilePreview {
  path: string;
  filename: string;
  mediaType?: FileContentMediaType;
  mimeType: string;
  disposition: "inline" | "attachment";
  size: number;
  modifiedAt: string;
  stream: ReadStream;
}

export interface ReadWorkspaceFilePreviewOptions {
  download?: boolean;
}

export async function readWorkspaceFilePreview(
  rootPath: string,
  path: string | undefined,
  pathAccess?: PiWebPathAccessConfig,
  options: ReadWorkspaceFilePreviewOptions = {},
): Promise<WorkspaceFilePreview> {
  if (path === undefined || path === "") throw new Error("path query parameter is required");
  const { target, displayPath } = await resolveWorkspacePathAccessTarget(rootPath, path, pathAccess);
  const s = await stat(target);
  if (!s.isFile()) throw new Error("Path is not a file");
  const filename = basename(displayPath);
  const modifiedAt = s.mtime.toISOString();

  // Download mode serves any file as an opaque octet-stream attachment. No size
  // cap: the response is streamed, and the browser writes it straight to disk.
  if (options.download === true) {
    return { path: displayPath, filename, mimeType: "application/octet-stream", disposition: "attachment", size: s.size, modifiedAt, stream: createReadStream(target) };
  }

  const media = previewMediaForPath(displayPath);
  if (media === undefined) throw new Error("Inline preview is not supported for this file type");
  if (s.size > MAX_INLINE_PREVIEW_BYTES) throw new Error(`File is too large to preview (limit ${MAX_INLINE_PREVIEW_LABEL})`);
  return { path: displayPath, filename, mediaType: media.mediaType, mimeType: media.mimeType, disposition: "inline", size: s.size, modifiedAt, stream: createReadStream(target) };
}
