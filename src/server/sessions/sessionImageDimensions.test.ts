import { imageSize } from "image-size";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readSessionImageDimensions } from "./sessionImageDimensions.js";

// Real 3x2 images; the JPEG has no EXIF until a test adds an APP1 segment.
const png = "iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAAFUlEQVR42mOUT3nIwMDAwMDAxAADABiCAWj7JLiIAAAAAElFTkSuQmCC";
const jpeg = "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcp"
  + "LDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIy"
  + "MjIyMjIyMjIyMjIyMjL/wAARCAACAAMDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAb/xAAUEAEAAAAAAAAAAAAA"
  + "AAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABgf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdAUIXf//Z";
const gif = "R0lGODdhAwACAIEAAB9k4QAAAAAAAAAAACwAAAAAAwACAAAIBgABCBwYEAA7";
const webp = "UklGRh4AAABXRUJQVlA4TBEAAAAvAkAAAAdQsn40vP+BiOh/AAA=";
const fixtures = [
  { source: png, mimeType: "image/png" },
  { source: jpeg, mimeType: "image/jpeg" },
  { source: gif, mimeType: "image/gif" },
  { source: webp, mimeType: "image/webp" },
];

function orientedJpeg(orientation: number, endian: "little" | "big"): string {
  const exif = Buffer.from(endian === "little"
    ? "ffe1002245786966000049492a0008000000010012010300010000000000000000000000"
    : "ffe100224578696600004d4d002a00000008000101120003000000010000000000000000", "hex");
  if (endian === "little") exif.writeUInt16LE(orientation, 28);
  else exif.writeUInt16BE(orientation, 28);
  const bytes = Buffer.from(jpeg, "base64");
  return Buffer.concat([bytes.subarray(0, 2), exif, bytes.subarray(2)]).toString("base64");
}

afterEach(() => { vi.restoreAllMocks(); });

describe("readSessionImageDimensions", () => {
  it.each(fixtures)("reads $mimeType header dimensions", ({ source, mimeType }) => {
    expect(readSessionImageDimensions(source, mimeType)).toEqual({ width: 3, height: 2 });
    expect(readSessionImageDimensions(source.replace(/=+$/u, ""), mimeType)).toEqual({ width: 3, height: 2 });
  });

  it.each(fixtures)("omits mismatched declared MIME for $mimeType", ({ source, mimeType }) => {
    for (const declared of fixtures) {
      if (declared.mimeType === mimeType) continue;
      expect(readSessionImageDimensions(source, declared.mimeType)).toBeUndefined();
    }
    expect(readSessionImageDimensions(source, mimeType.toUpperCase())).toBeUndefined();
  });

  describe.each(["little", "big"] as const)("%s-endian JPEG EXIF", (endian) => {
    it.each([1, 2, 3, 4, 5, 6, 7, 8])("reports display dimensions for orientation %i", (orientation) => {
      expect(readSessionImageDimensions(orientedJpeg(orientation, endian), "image/jpeg"))
        .toEqual(orientation >= 5 ? { width: 2, height: 3 } : { width: 3, height: 2 });
    });
  });

  it.each(fixtures)("omits truncated $mimeType headers", ({ source, mimeType }) => {
    const truncated = Buffer.from(source, "base64").subarray(0, 8).toString("base64");
    expect(readSessionImageDimensions(truncated, mimeType)).toBeUndefined();
  });

  it.each([16, 20])("omits a zero PNG dimension at header offset %i", (offset) => {
    const bytes = Buffer.from(png, "base64");
    bytes.writeUInt32BE(0, offset);
    expect(readSessionImageDimensions(bytes.toString("base64"), "image/png")).toBeUndefined();
  });

  it.each(["", "AQID", "not an image", Buffer.from('<svg width="3" height="2"></svg>').toString("base64")])(
    "treats unreadable or unsupported metadata as unavailable (%s)", (source) => {
      expect(readSessionImageDimensions(source, "image/png")).toBeUndefined();
    },
  );

  it("decodes only a bounded base64 prefix even for a multi-megabyte source", () => {
    const source = Buffer.concat([Buffer.from(png, "base64"), Buffer.alloc(2 * 1024 * 1024)]).toString("base64");
    const from = vi.spyOn(Buffer, "from");
    expect(readSessionImageDimensions(source, "image/png")).toEqual({ width: 3, height: 2 });
    expect(from).toHaveBeenCalledExactlyOnceWith(source.slice(0, Math.floor(256 * 1024 / 3) * 4), "base64");
  });

  it("does not retry with a full decode when JPEG dimensions lie beyond the header cap", () => {
    const bytes = Buffer.from(jpeg, "base64");
    const app2 = Buffer.alloc(65537);
    app2.writeUInt16BE(0xffe2, 0);
    app2.writeUInt16BE(65535, 2);
    const lateHeader = Buffer.concat([bytes.subarray(0, 2), ...Array.from({ length: 5 }, () => app2), bytes.subarray(2)]);
    expect(imageSize(lateHeader)).toMatchObject({ width: 3, height: 2, type: "jpg" });
    const source = lateHeader.toString("base64");
    const from = vi.spyOn(Buffer, "from");
    expect(readSessionImageDimensions(source, "image/jpeg")).toBeUndefined();
    expect(from).toHaveBeenCalledExactlyOnceWith(source.slice(0, Math.floor(256 * 1024 / 3) * 4), "base64");
  });
});
