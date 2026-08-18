import type { MessagePage, SessionUiEvent } from "../shared/apiTypes.js";

/**
 * Remove provider-only thinking data at the browser transport boundary. The
 * runtime message remains unchanged because only affected messages and content
 * blocks are copied.
 */
export function projectBrowserMessage(message: unknown): unknown {
  if (!isRecord(message)) return message;
  const originalContent = message["content"];
  if (!isUnknownArray(originalContent)) return message;

  const content = mapChanged(originalContent, (part) => {
    if (!isRecord(part) || part["type"] !== "thinking" || !Object.hasOwn(part, "thinkingSignature")) return part;
    const projected = { ...part };
    delete projected["thinkingSignature"];
    return projected;
  });

  return content === originalContent ? message : { ...message, content };
}

export function projectBrowserMessageResponse(response: MessagePage): MessagePage {
  const messages = mapChanged(response.messages, projectBrowserMessage);
  return messages === response.messages ? response : { ...response, messages };
}

export function projectBrowserSessionEvent(event: SessionUiEvent): SessionUiEvent {
  if (event.type !== "message.end" || event.message === undefined) return event;
  const message = projectBrowserMessage(event.message);
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
