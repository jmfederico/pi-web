import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { projectBrowserMessageResponse } from "../browserMessageProjection.js";
import { SessionMediaIndex, type SessionMediaScope } from "./sessionMediaIndex.js";
import { readSessionImageDimensions } from "./sessionImageDimensions.js";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=";
const image = () => ({ type: "image", data: png, mimeType: "image/png" });
const sha256 = (source: string) => createHash("sha256").update(source).digest("hex");
const decodeBase64 = (source: string) => Buffer.from(source, "base64");
const scope = { id: "s1", cwd: "/workspace" };

function referenceOf(index: SessionMediaIndex, block = image(), binding: SessionMediaScope = scope) {
  const reference = index.reference(binding, block);
  if (reference === undefined) throw new Error("Expected image reference");
  return reference;
}

describe("SessionMediaIndex", () => {
  it("projects dimensioned MIME/source SHA256 references, then decodes exactly the requested original image", () => {
    const decode = vi.fn(decodeBase64);
    const index = new SessionMediaIndex({ decode });
    const block = Object.freeze(image());
    const other = Object.freeze({ ...image(), data: "AQID" });
    const page = { messages: [{ role: "user", content: [block, other] }], start: 0, total: 1 };
    const projected = projectBrowserMessageResponse(page, (part) => index.reference(scope, part));
    const id = sha256(`image/png\0${png}`);
    expect(projected.messages).toEqual([{ role: "user", content: [
      { type: "image", mediaId: id, mimeType: "image/png", byteSize: decodeBase64(png).byteLength, width: 1, height: 1 },
      { type: "image", mediaId: sha256("image/png\0AQID"), mimeType: "image/png", byteSize: 3 },
    ] }]);
    expect(decode).not.toHaveBeenCalled();
    expect(index.get({ id: "s2", cwd: scope.cwd }, id)).toBeUndefined();
    expect(index.get({ ...scope, cwd: "/other" }, id)).toBeUndefined();
    expect(index.get(scope, "0".repeat(64))).toBeUndefined();
    expect(decode).not.toHaveBeenCalled();
    expect(index.get(scope, id)).toEqual({ data: decodeBase64(png), mimeType: "image/png" });
    expect(decode).toHaveBeenCalledExactlyOnceWith(png);
    expect(block).toEqual(image());
    expect(page.messages[0]?.content).toEqual([block, other]);
  });

  it("keeps immutable IDs distinct for MIME types and different original base64 encodings", () => {
    const index = new SessionMediaIndex();
    const padded = referenceOf(index, { ...image(), data: "AQ==" });
    const unpadded = referenceOf(index, { ...image(), data: "AQ" });
    const jpeg = referenceOf(index, { ...image(), data: "AQ==", mimeType: "image/jpeg" });
    expect(padded.mediaId).toBe(sha256("image/png\0AQ=="));
    expect(unpadded.mediaId).toBe(sha256("image/png\0AQ"));
    expect(jpeg.mediaId).toBe(sha256("image/jpeg\0AQ=="));
    expect(new Set([padded.mediaId, unpadded.mediaId, jpeg.mediaId]).size).toBe(3);
    expect(index.get(scope, padded.mediaId)).toEqual({ data: Buffer.from([1]), mimeType: "image/png" });
    expect(index.get(scope, jpeg.mediaId)).toEqual({ data: Buffer.from([1]), mimeType: "image/jpeg" });
  });

  it("reuses hashes and dimensions across clones and detects data, MIME, and type mutations", () => {
    const hash = vi.fn(sha256);
    const readDimensions = vi.fn(readSessionImageDimensions);
    const index = new SessionMediaIndex({ hash, readDimensions });
    const block = image();
    const first = referenceOf(index, block);
    expect(first).toMatchObject({ width: 1, height: 1 });
    expect(referenceOf(index, { ...block })).toBe(first);
    expect(referenceOf(index, block, { ...scope, id: "s2" })).toBe(first);
    expect(hash).toHaveBeenCalledOnce();
    expect(readDimensions).toHaveBeenCalledExactlyOnceWith(png, "image/png");
    block.data = "AQID";
    expect(referenceOf(index, block).mediaId).not.toBe(first.mediaId);
    block.mimeType = "image/webp";
    expect(referenceOf(index, block).mediaId).toBe(sha256("image/webp\0AQID"));
    expect(hash).toHaveBeenCalledTimes(3);
    expect(readDimensions).toHaveBeenCalledTimes(3);
    block.type = "text";
    expect(index.reference(scope, block)).toBeUndefined();
    expect(readDimensions).toHaveBeenCalledTimes(3);
  });

  it("bounds strong memos while weak memos prevent rehashing and metadata re-extraction after eviction", () => {
    const hash = vi.fn(sha256);
    const decode = vi.fn(decodeBase64);
    const readDimensions = vi.fn(readSessionImageDimensions);
    const index = new SessionMediaIndex({ maxMediaEntries: 1, maxMemoEntries: 1, hash, decode, readDimensions });
    const first = image();
    const firstId = referenceOf(index, first).mediaId;
    const clonedFirst = { ...first };
    referenceOf(index, clonedFirst); // A new parse reuses the content memo.
    const second = { ...image(), data: "AQID", mimeType: "image/webp" };
    const secondId = referenceOf(index, second).mediaId;
    expect(index.get(scope, firstId)).toBeUndefined();
    expect(decode).not.toHaveBeenCalled();
    const values = [{ type: "message", message: { content: [second, clonedFirst] } }];
    expect(index.find(scope, firstId, values)).toEqual({ data: decodeBase64(png), mimeType: "image/png" });
    expect(decode).toHaveBeenCalledExactlyOnceWith(png);
    expect(index.get(scope, secondId)).toBeUndefined();
    index.find(scope, "0".repeat(64), values);
    index.find(scope, "0".repeat(64), values);
    referenceOf(index, first);
    expect(hash).toHaveBeenCalledTimes(2);
    expect(readDimensions).toHaveBeenCalledTimes(2);
    expect(decode).toHaveBeenCalledOnce();
    index.forgetSession(scope);
    expect(index.get(scope, firstId)).toBeUndefined();
    index.clear();
    referenceOf(index, first);
    expect(hash).toHaveBeenCalledTimes(3);
    expect(readDimensions).toHaveBeenCalledTimes(3);
  });

  it("cold-scans and memoizes nonmatches without payload decoding, even with both strong caches disabled", () => {
    const hash = vi.fn(sha256);
    const decode = vi.fn(decodeBase64);
    const readDimensions = vi.fn(readSessionImageDimensions);
    const index = new SessionMediaIndex({ maxMediaEntries: 0, maxMemoEntries: 0, hash, decode, readDimensions });
    const blocks = [image(), { ...image(), data: "AQID" }];
    expect(index.find(scope, "0".repeat(64), blocks)).toBeUndefined();
    expect(index.find(scope, "0".repeat(64), blocks)).toBeUndefined();
    expect(hash).toHaveBeenCalledTimes(2);
    expect(readDimensions).toHaveBeenCalledTimes(2);
    expect(decode).not.toHaveBeenCalled();
    expect(index.find(scope, sha256("image/png\0AQID"), blocks)?.data).toEqual(Buffer.from([1, 2, 3]));
    expect(hash).toHaveBeenCalledTimes(2);
    expect(readDimensions).toHaveBeenCalledTimes(2);
    expect(decode).toHaveBeenCalledExactlyOnceWith("AQID");
  });

  it("serves oversized sources on reconstruction without retaining them in either strong cache", () => {
    const hash = vi.fn(sha256);
    const decode = vi.fn(decodeBase64);
    const index = new SessionMediaIndex({ maxMediaBytes: 1, maxMemoBytes: 1, hash, decode });
    const block = image();
    const id = referenceOf(index, block).mediaId;
    expect(index.get(scope, id)).toBeUndefined();
    expect(decode).not.toHaveBeenCalled();
    expect(index.find(scope, id, [block])?.data).toEqual(decodeBase64(png));
    expect(index.get(scope, id)).toBeUndefined();
    referenceOf(index, { ...block });
    expect(hash).toHaveBeenCalledTimes(2); // Clone cannot use an evicted content memo.
  });

  it("evicts least-recently-used bindings by retained source bytes, not decoded bytes", () => {
    const index = new SessionMediaIndex({ maxMediaBytes: 16 }); // Two 4-character UTF-16 sources.
    const first = referenceOf(index, { ...image(), data: "AQID" }).mediaId;
    const second = referenceOf(index, { ...image(), data: "BAUG" }).mediaId;
    expect(index.get(scope, first)).toBeDefined(); // Touch first, making second oldest.
    const third = referenceOf(index, { ...image(), data: "BwgJ" }).mediaId;
    expect(index.get(scope, second)).toBeUndefined();
    expect(index.get(scope, first)).toBeDefined();
    expect(index.get(scope, third)).toBeDefined();
  });

  it("isolates workspace bindings, canonicalizes cwd, and forgets only the specified identity", () => {
    const index = new SessionMediaIndex();
    const other = { ...scope, cwd: "/other" };
    const id = referenceOf(index, image()).mediaId;
    expect(index.get({ ...scope, cwd: "/workspace/./nested/.." }, id)).toBeDefined();
    expect(index.get(other, id)).toBeUndefined();
    referenceOf(index, image(), other);
    index.forgetSession(scope);
    expect(index.get(scope, id)).toBeUndefined();
    expect(index.get(other, id)).toBeDefined();
    index.clear();
    expect(index.get(other, id)).toBeUndefined();
  });

  it("does not bind unscoped projections, and propagates recoverable decode failures", () => {
    const decode = vi.fn(decodeBase64).mockImplementationOnce(() => { throw new Error("decode failure"); });
    const index = new SessionMediaIndex({ decode });
    const block = image();
    const reference = index.reference(undefined, block);
    expect(reference).toBeDefined();
    expect(index.get(scope, reference?.mediaId ?? "")).toBeUndefined();
    const id = referenceOf(index, block).mediaId;
    expect(() => index.get(scope, id)).toThrow("decode failure");
    expect(index.get(scope, id)?.data).toEqual(decodeBase64(png));
  });

  it.each(["image/png", "image/jpeg", "image/gif", "image/webp"])("preserves supported MIME types but omits mismatched metadata (%s)", (mimeType) => {
    expect(referenceOf(new SessionMediaIndex(), { ...image(), mimeType })).toEqual({
      type: "image", mediaId: sha256(`${mimeType}\0${png}`), mimeType, byteSize: decodeBase64(png).byteLength,
      ...(mimeType === "image/png" ? { width: 1, height: 1 } : {}),
    });
  });

  it.each(["AQID", "iVBORw0KGgo="])("retains a lazy reference and memoizes unavailable metadata (%s)", (data) => {
    const readDimensions = vi.fn(readSessionImageDimensions);
    const decode = vi.fn(decodeBase64);
    const index = new SessionMediaIndex({ readDimensions, decode });
    const block = { ...image(), data };
    const reference = referenceOf(index, block);
    expect(reference).toEqual({ type: "image", mediaId: sha256(`image/png\0${data}`), mimeType: "image/png", byteSize: decodeBase64(data).byteLength });
    expect(referenceOf(index, block)).toBe(reference);
    expect(referenceOf(index, { ...block })).toBe(reference);
    expect(readDimensions).toHaveBeenCalledExactlyOnceWith(data, "image/png");
    expect(decode).not.toHaveBeenCalled();
    expect(index.get(scope, reference.mediaId)).toEqual({ data: decodeBase64(data), mimeType: "image/png" });
    expect(decode).toHaveBeenCalledExactlyOnceWith(data);
    expect(block).toEqual({ ...image(), data });
  });

  it.each(["AQ==", "AQ", "AQI=", "AQI", "AQID", "/w==", "/w", "//8=", "//8"])("computes standard base64 size without decoding (%s)", (data) => {
    const decode = vi.fn(decodeBase64);
    const index = new SessionMediaIndex({ decode });
    const block = { ...image(), data };
    const reference = referenceOf(index, block);
    expect(reference.byteSize).toBe(decodeBase64(data).byteLength);
    expect(decode).not.toHaveBeenCalled();
    expect(index.find(scope, reference.mediaId, [block])?.data).toEqual(decodeBase64(data));
    expect(decode).toHaveBeenCalledExactlyOnceWith(data);
  });

  it.each([
    { ...image(), mimeType: "image/svg+xml" },
    { ...image(), mimeType: "text/html" },
    { ...image(), mimeType: "IMAGE/PNG" },
    { ...image(), mimeType: "image/png\r\nX-Test: bad" },
    ...["invalid!!", "", "A", "AAAAA", "AQID==", "AQ=", "AQI==", "AQ===", "=AQ=", "AQ==x", "AQ\n==", "AQ-_", "AR==", "AR", "AQJ=", "AQJ", "//9=", "//9"].map((data) => ({ ...image(), data })),
    { ...image(), data: 1 },
    { ...image(), type: "text" },
  ])("consistently rejects malformed content in projection and lookup: %j", (block) => {
    const hash = vi.fn(sha256);
    const decode = vi.fn(decodeBase64);
    const readDimensions = vi.fn(readSessionImageDimensions);
    const index = new SessionMediaIndex({ hash, decode, readDimensions });
    expect(index.reference(scope, block)).toBeUndefined();
    expect(index.find(scope, "0".repeat(64), [block])).toBeUndefined();
    expect(hash).not.toHaveBeenCalled();
    expect(decode).not.toHaveBeenCalled();
    expect(readDimensions).not.toHaveBeenCalled();
  });
});
