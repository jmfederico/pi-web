import type { MessagePage, SessionStreamSnapshot, SessionTranscriptSnapshot, SessionUiEvent } from "../shared/apiTypes.js";
import type { SessionMediaReference } from "../shared/sessionMedia.js";

export type BrowserImageProjector = (image: Record<string, unknown>) => SessionMediaReference | undefined;

/**
 * Strip provider-only thinking data and optionally reference images at the
 * browser transport boundary. Runtime messages stay unchanged: only affected
 * messages and content blocks are copied.
 */
export function projectBrowserMessage(message: unknown, images?: BrowserImageProjector): unknown {
  if (!isRecord(message)) return message;
  const originalContent = message["content"];
  const content = projectBrowserContent(originalContent, images);
  return content === originalContent ? message : { ...message, content };
}

function projectBrowserContent(content: unknown, images?: BrowserImageProjector): unknown {
  if (isUnknownArray(content)) return mapChanged(content, (part) => projectBrowserContent(part, images));
  if (!isRecord(content)) return content;
  if (content["type"] === "image" && images !== undefined) return images(content) ?? content;
  if (content["type"] !== "thinking" || !Object.hasOwn(content, "thinkingSignature")) return content;
  const projected = { ...content };
  delete projected["thinkingSignature"];
  return projected;
}

export function projectBrowserMessageResponse(response: MessagePage, images?: BrowserImageProjector): MessagePage {
  const messages = mapChanged(response.messages, (message) => projectBrowserMessage(message, images));
  return messages === response.messages ? response : { ...response, messages };
}

export function projectBrowserStreamSnapshot<T extends SessionStreamSnapshot>(snapshot: T, images?: BrowserImageProjector): T {
  const partial = projectBrowserMessage(snapshot.partial, images);
  return partial === snapshot.partial ? snapshot : { ...snapshot, partial };
}

export function projectBrowserTranscriptSnapshot(snapshot: SessionTranscriptSnapshot, images?: BrowserImageProjector): SessionTranscriptSnapshot {
  const stream = projectBrowserStreamSnapshot(snapshot, images);
  const page = projectBrowserMessageResponse(snapshot.page, images);
  return page === snapshot.page ? stream : { ...stream, page };
}

export function projectBrowserSessionEvent(event: SessionUiEvent, images?: BrowserImageProjector): SessionUiEvent {
  if ((event.type === "assistant.start" || event.type === "message.end" || event.type === "message.append") && event.message !== undefined) {
    const message = projectBrowserMessage(event.message, images);
    return message === event.message ? event : { ...event, message };
  }
  if (event.type === "tool.end" || event.type === "tool.update") {
    const content = projectBrowserContent(event.content, images);
    return content === event.content ? event : { ...event, content };
  }
  return event;
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
