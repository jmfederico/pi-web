import type { FileContentMediaType } from "./pluginApiTypes.js";

export const MAX_INLINE_PREVIEW_BYTES = 10 * 1024 * 1024;
export const MAX_INLINE_PREVIEW_LABEL = "10 MB";
export const MAX_WORKSPACE_FILE_CONTENT_BYTES = 512 * 1024;

type WorkspaceFileClassificationDetails =
  | { readonly mediaType: "image"; readonly source: "stream" | "text"; readonly previewMimeType: string }
  | { readonly mediaType: "html"; readonly source: "text"; readonly previewMimeType: "text/html; charset=utf-8" }
  | { readonly mediaType: "pdf"; readonly source: "stream"; readonly previewMimeType: "application/pdf" }
  | { readonly mediaType: "markdown"; readonly source: "text" };

/** Internal classification constrained to the public file-response media types. */
export type WorkspaceFileClassification = WorkspaceFileClassificationDetails & {
  readonly mediaType: FileContentMediaType;
};

// Extension classification is shared by JSON source reads, streamed previews,
// and proxy response policy. Keep this an allowlist: only classifications with
// a preview MIME type may be served as browser-rendered bytes.
//
// `source` decides what a JSON file read carries: "text" formats keep capped
// literal UTF-8 source so the viewer can offer Raw mode, while "stream" formats
// stay out of JSON and are only ever served as preview bytes.
const WORKSPACE_FILE_CLASSIFICATIONS: Readonly<Record<string, WorkspaceFileClassification>> = {
  ".avif": { mediaType: "image", source: "stream", previewMimeType: "image/avif" },
  ".bmp": { mediaType: "image", source: "stream", previewMimeType: "image/bmp" },
  ".gif": { mediaType: "image", source: "stream", previewMimeType: "image/gif" },
  ".ico": { mediaType: "image", source: "stream", previewMimeType: "image/x-icon" },
  ".jpeg": { mediaType: "image", source: "stream", previewMimeType: "image/jpeg" },
  ".jpg": { mediaType: "image", source: "stream", previewMimeType: "image/jpeg" },
  ".png": { mediaType: "image", source: "stream", previewMimeType: "image/png" },
  // SVG is markup: it previews as an image but also has readable source, so it
  // keeps literal text for Raw mode.
  ".svg": { mediaType: "image", source: "text", previewMimeType: "image/svg+xml" },
  ".webp": { mediaType: "image", source: "stream", previewMimeType: "image/webp" },
  ".htm": { mediaType: "html", source: "text", previewMimeType: "text/html; charset=utf-8" },
  ".html": { mediaType: "html", source: "text", previewMimeType: "text/html; charset=utf-8" },
  ".pdf": { mediaType: "pdf", source: "stream", previewMimeType: "application/pdf" },
  ".md": { mediaType: "markdown", source: "text" },
  ".markdown": { mediaType: "markdown", source: "text" },
};

export function classifyWorkspaceFile(path: string): WorkspaceFileClassification | undefined {
  const slashIndex = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const dotIndex = path.lastIndexOf(".");
  if (dotIndex <= slashIndex) return undefined;
  const extension = path.slice(dotIndex).toLowerCase();
  return WORKSPACE_FILE_CLASSIFICATIONS[extension];
}

/** Return the leaf filename for either POSIX or Windows-style workspace paths. */
export function workspaceFileName(path: string): string {
  const separatorIndex = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return path.slice(separatorIndex + 1);
}
