export interface ImageDimensions {
  width: number;
  height: number;
}

/** Browser-only projection of an image; Pi runtime messages and transcripts keep their original data. */
export interface SessionMediaReference {
  type: "image";
  mediaId: string;
  mimeType: string;
  byteSize: number;
  /** Display-oriented intrinsic dimensions, absent on older machines or unreadable headers. */
  width?: number;
  height?: number;
}

/** Only a complete, positive pixel pair can establish image geometry. */
export function validImageDimensions(width: unknown, height: unknown): ImageDimensions | undefined {
  return typeof width === "number" && Number.isSafeInteger(width) && width > 0
    && typeof height === "number" && Number.isSafeInteger(height) && height > 0
    ? { width, height } : undefined;
}

/** Explicit opt-in keeps older browser clients and remote machines compatible. */
export const SESSION_MEDIA_MODE = "reference";

export function isSessionMediaId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}
