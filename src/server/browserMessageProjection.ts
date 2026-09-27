import { createHash } from "node:crypto";
import type { MessagePage, SessionUiEvent } from "../shared/apiTypes.js";

/**
 * Media-reference behaviour for one browser projection pass. The caller turns
 * a request-level opt-in (for example a `maxInlineMedia` query parameter) into
 * this shape; without it images stay fully inline.
 */
export interface BrowserMediaProjection {
  /** Build the application-relative URL a browser fetches an oversized image from. */
  mediaSrc(mediaId: string): string;
  /** Inline base64 length above which an image part becomes a media reference. */
  inlineLimit: number;
}

/**
 * Remove provider-only thinking data and, when a media projection is supplied,
 * replace oversized inline images with on-demand media references at the
 * browser transport boundary. The runtime message remains unchanged because
 * only affected messages and content blocks are copied.
 */
export function projectBrowserMessage(message: unknown, media?: BrowserMediaProjection): unknown {
  if (!isRecord(message)) return message;
  const originalContent = message["content"];
  if (!isUnknownArray(originalContent)) return message;

  const content = mapChanged(originalContent, (part) => {
    if (!isRecord(part)) return part;
    if (part["type"] === "thinking") {
      if (!Object.hasOwn(part, "thinkingSignature")) return part;
      const projected = { ...part };
      delete projected["thinkingSignature"];
      return projected;
    }
    if (part["type"] === "image") {
      const data = part["data"];
      if (media === undefined || typeof data !== "string" || data.length <= media.inlineLimit) return part;
      const mimeType = typeof part["mimeType"] === "string" && part["mimeType"] !== "" ? part["mimeType"] : "application/octet-stream";
      return {
        type: "image",
        mimeType,
        src: media.mediaSrc(mediaIdForData(data)),
        byteSize: Math.floor((data.length * 3) / 4),
      };
    }
    return part;
  });

  return content === originalContent ? message : { ...message, content };
}

/** Content-hash id used to fetch an oversized image from the media endpoint. */
export function mediaIdForData(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}

export function projectBrowserMessageResponse(response: MessagePage, media?: BrowserMediaProjection): MessagePage {
  const messages = mapChanged(response.messages, (message) => projectBrowserMessage(message, media));
  return messages === response.messages ? response : { ...response, messages };
}

export function projectBrowserSessionEvent(event: SessionUiEvent, media?: BrowserMediaProjection): SessionUiEvent {
  if (event.type !== "message.end" || event.message === undefined) return event;
  const message = projectBrowserMessage(event.message, media);
  return message === event.message ? event : { ...event, message };
}

function mapChanged<T>(values: T[], project: (value: T) => T): T[] {
  let projectedValues: T[] | undefined;
  let index = 0;
  for (const value of values) {
    const projected = project(value);
    if (projectedValues === undefined) {
      if (projected === value) {
        index += 1;
        continue;
      }
      projectedValues = values.slice(0, index);
    }
    projectedValues.push(projected);
    index += 1;
  }
  return projectedValues ?? values;
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
