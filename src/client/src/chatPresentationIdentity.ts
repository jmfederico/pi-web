import type { ChatLine, ChatPart } from "./chatTypes";

/** Unscoped address. Durable and live addresses deliberately do not alias. */
export function chatPartIdentity(message: ChatLine, part: ChatPart): string | undefined {
  if ("toolCallId" in part && part.toolCallId) return JSON.stringify(["tool", part.toolCallId]);
  if (part.type === "askUserQuestion") return JSON.stringify(["ask", part.ask.askId]);
  // Successive answers to one ask are distinct transcript facts.
  if (part.type === "askUserRecord") return (message.entryId ?? "") !== ""
    ? JSON.stringify(["ask-record", message.entryId, part.outcome.askId]) : undefined;
  const address = (message.entryId ?? "") !== "" ? ["entry", message.entryId]
    : (message.streamId ?? "") !== "" ? ["stream", message.streamId] : undefined;
  return address === undefined || part.sourcePart === undefined ? undefined : JSON.stringify([...address, part.sourcePart]);
}

/** Identifies a presentation slice by its leading original part, not its position. */
export function chatLinePresentationIdentity(message: ChatLine): string | undefined {
  const first = message.parts[0];
  return first === undefined ? undefined : chatPartIdentity(message, first);
}

/** Only authoritative messages acquire provenance; manual/legacy lines stay unchanged. */
export function withSourcePart<T extends ChatPart>(part: T, message: { entryId?: string | undefined; streamId?: string | undefined }, key: string): T {
  const addressed = (message.entryId ?? "") !== "" || (message.streamId ?? "") !== "";
  return !addressed || part.sourcePart !== undefined ? part : { ...part, sourcePart: key };
}
