import { imageSize } from "image-size";
import { validImageDimensions, type ImageDimensions } from "../../shared/sessionMedia.js";

// Whole base64 quartets keep decoding below 256 KiB, regardless of source size.
const MAX_HEADER_BASE64_LENGTH = Math.floor(256 * 1024 / 3) * 4;
const mimeByFormat: Readonly<Record<string, string | undefined>> = {
  png: "image/png",
  jpg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

/** Optional header metadata only: no pixel decoding or full-payload allocation. */
export function readSessionImageDimensions(source: string, mimeType: string): ImageDimensions | undefined {
  try {
    // image-size's DataView reads use the backing buffer, not the view's length.
    // Exact-sized storage prevents truncated headers from reading pooled bytes.
    const header = Uint8Array.from(Buffer.from(source.slice(0, MAX_HEADER_BASE64_LENGTH), "base64"));
    const metadata = imageSize(header);
    if (metadata.type === undefined || mimeByFormat[metadata.type] !== mimeType) return undefined;
    const swap = metadata.type === "jpg" && [5, 6, 7, 8].includes(metadata.orientation ?? 0);
    return swap
      ? validImageDimensions(metadata.height, metadata.width)
      : validImageDimensions(metadata.width, metadata.height);
  } catch {
    // Truncated, malformed, or beyond-cap headers leave geometry (and load
    // failures) to the browser; they must not invalidate an otherwise usable reference.
    return undefined;
  }
}
