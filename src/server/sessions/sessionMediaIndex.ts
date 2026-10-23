import { createHash } from "node:crypto";
import type { SessionMediaReference } from "../../shared/sessionMedia.js";
import { canonicalizeStoredCwd } from "../workingDirectory.js";
import { readSessionImageDimensions } from "./sessionImageDimensions.js";

export type SessionImageMimeType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";
export interface SessionMedia {
  data: Buffer;
  mimeType: SessionImageMimeType;
}
export interface SessionMediaScope {
  id: string;
  cwd: string;
}

interface ImageMemo {
  source: string;
  mimeType: SessionImageMimeType;
  reference: SessionMediaReference;
}

export interface SessionMediaIndexOptions {
  maxMediaBytes?: number;
  maxMediaEntries?: number;
  maxMemoBytes?: number;
  maxMemoEntries?: number;
  /** Hash the canonical MIME, NUL separator, and original base64 (never bytes). */
  hash?: (source: string) => string;
  /** Only invoked for the image matched by a media request. */
  decode?: (source: string) => Buffer;
  /** Bounded header metadata, extracted once per image memo (including misses). */
  readDimensions?: typeof readSessionImageDimensions;
}

/**
 * Disposable daemon-owned source bindings and hash memos, never extracted files
 * or decoded-byte caches. Bindings are scoped to a session AND workspace. Both
 * strong indexes are bounded; weak block memos survive eviction only as long as
 * their runtime/transcript owner retains the original block.
 */
export class SessionMediaIndex {
  private readonly media = new Map<string, ImageMemo>();
  private readonly memo = new Map<string, ImageMemo>();
  private blocks = new WeakMap<object, ImageMemo>();
  private mediaBytes = 0;
  private memoBytes = 0;
  private readonly maxMediaBytes: number;
  private readonly maxMediaEntries: number;
  private readonly maxMemoBytes: number;
  private readonly maxMemoEntries: number;
  private readonly hash: (source: string) => string;
  private readonly decode: (source: string) => Buffer;
  private readonly readDimensions: typeof readSessionImageDimensions;

  constructor(options: SessionMediaIndexOptions = {}) {
    this.maxMediaBytes = options.maxMediaBytes ?? 64 * 1024 * 1024;
    this.maxMediaEntries = options.maxMediaEntries ?? 1024;
    this.maxMemoBytes = options.maxMemoBytes ?? 32 * 1024 * 1024;
    this.maxMemoEntries = options.maxMemoEntries ?? 256;
    this.hash = options.hash ?? ((source) => createHash("sha256").update(source).digest("hex"));
    this.decode = options.decode ?? ((source) => Buffer.from(source, "base64"));
    this.readDimensions = options.readDimensions ?? readSessionImageDimensions;
  }

  /** An unscoped projection may produce a reference, but cannot create a binding. */
  reference(scope: SessionMediaScope | undefined, block: Record<string, unknown>): SessionMediaReference | undefined {
    const image = this.image(block);
    if (image === undefined) return undefined;
    if (scope !== undefined) this.remember(scope, image);
    return image.reference;
  }

  get(scope: SessionMediaScope, mediaId: string): SessionMedia | undefined {
    const key = bindingKey(scope, mediaId);
    const image = this.media.get(key);
    if (image === undefined) return undefined;
    this.media.delete(key);
    this.media.set(key, image);
    return this.decodeImage(image);
  }

  /** Stop at the match; known nonmatching blocks need neither hashing nor decoding. */
  find(scope: SessionMediaScope, mediaId: string, values: readonly unknown[]): SessionMedia | undefined {
    for (const value of values) {
      for (const block of imageBlocks(value)) {
        const image = this.image(block);
        if (image?.reference.mediaId !== mediaId) continue;
        this.remember(scope, image);
        return this.decodeImage(image);
      }
    }
    return undefined;
  }

  forgetSession(scope: SessionMediaScope): void {
    const prefix = `${scopeKey(scope)}:`;
    for (const [key, image] of this.media) {
      if (!key.startsWith(prefix)) continue;
      this.media.delete(key);
      this.mediaBytes -= bindingWeight(image);
    }
  }

  clear(): void {
    this.media.clear();
    this.memo.clear();
    this.blocks = new WeakMap();
    this.mediaBytes = 0;
    this.memoBytes = 0;
  }

  private image(block: Record<string, unknown>): ImageMemo | undefined {
    if (block["type"] !== "image" || typeof block["data"] !== "string" || !isSessionImageMimeType(block["mimeType"])) return undefined;
    const source = block["data"];
    const mimeType = block["mimeType"];
    const previous = this.blocks.get(block);
    if (previous?.source === source && previous.mimeType === mimeType) return previous;
    const key = `${mimeType}\0${source}`;
    const cached = this.memo.get(key);
    if (cached !== undefined) {
      this.memo.delete(key);
      this.memo.set(key, cached);
      this.blocks.set(block, cached);
      return cached;
    }
    const byteSize = imageByteSize(source);
    if (byteSize === undefined) return undefined;
    const dimensions = this.readDimensions(source, mimeType);
    const image: ImageMemo = {
      source, mimeType,
      reference: { type: "image", mediaId: this.hash(key), mimeType, byteSize, ...dimensions },
    };
    this.blocks.set(block, image);
    const weight = memoWeight(image);
    if (weight <= this.maxMemoBytes && this.maxMemoEntries > 0) {
      this.memo.set(key, image);
      this.memoBytes += weight;
      while (this.memoBytes > this.maxMemoBytes || this.memo.size > this.maxMemoEntries) {
        const oldest = this.memo.entries().next().value;
        if (oldest === undefined) break;
        this.memo.delete(oldest[0]);
        this.memoBytes -= memoWeight(oldest[1]);
      }
    }
    return image;
  }

  private decodeImage(image: ImageMemo): SessionMedia {
    return { data: this.decode(image.source), mimeType: image.mimeType };
  }

  private remember(scope: SessionMediaScope, image: ImageMemo): void {
    const weight = bindingWeight(image);
    if (weight > this.maxMediaBytes || this.maxMediaEntries <= 0) return;
    const key = bindingKey(scope, image.reference.mediaId);
    const previous = this.media.get(key);
    if (previous !== undefined) this.mediaBytes -= bindingWeight(previous);
    this.media.delete(key);
    this.media.set(key, image);
    this.mediaBytes += weight;
    while (this.mediaBytes > this.maxMediaBytes || this.media.size > this.maxMediaEntries) {
      const oldest = this.media.entries().next().value;
      if (oldest === undefined) break;
      this.media.delete(oldest[0]);
      this.mediaBytes -= bindingWeight(oldest[1]);
    }
  }
}

export function isSessionImageMimeType(value: unknown): value is SessionImageMimeType {
  return value === "image/png" || value === "image/jpeg" || value === "image/gif" || value === "image/webp";
}

function scopeKey(scope: SessionMediaScope): string {
  return JSON.stringify([scope.id, canonicalizeStoredCwd(scope.cwd)]);
}
function bindingKey(scope: SessionMediaScope, mediaId: string): string {
  return `${scopeKey(scope)}:${mediaId}`;
}
function bindingWeight(image: ImageMemo): number {
  // Conservatively count UTF-16 source storage, not the deferred binary size.
  return image.source.length * 2;
}
function memoWeight(image: ImageMemo): number {
  // The content key also retains a copy of the source and MIME.
  return bindingWeight(image) + (image.mimeType.length + 1 + image.source.length) * 2;
}
function imageByteSize(source: string): number | undefined {
  // Buffer.from(base64) silently accepts junk. Validate standard base64 (with
  // optional omitted padding) arithmetically, including unused final sextet bits,
  // without allocating, decoding, or re-encoding every transcript image.
  if (source === "" || !/^[A-Za-z0-9+/]+={0,2}$/u.test(source)) return undefined;
  const padding = source.endsWith("==") ? 2 : source.endsWith("=") ? 1 : 0;
  const length = source.length - padding;
  const remainder = length % 4;
  if (remainder === 1 || (padding > 0 && (source.length % 4 !== 0 || padding !== 4 - remainder))) return undefined;
  const last = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".indexOf(source.charAt(length - 1));
  if ((remainder === 2 && (last & 15) !== 0) || (remainder === 3 && (last & 3) !== 0)) return undefined;
  return Math.floor(length * 3 / 4);
}

/** Only Pi content containers, not arbitrary tool arguments or provider metadata. */
function* imageBlocks(value: unknown): Generator<Record<string, unknown>> {
  if (isUnknownArray(value)) {
    for (const part of value) yield* imageBlocks(part);
  } else if (isRecord(value)) {
    if (value["type"] === "image") yield value;
    else {
      if (value["content"] !== undefined) yield* imageBlocks(value["content"]);
      if (value["message"] !== undefined) yield* imageBlocks(value["message"]);
    }
  }
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
