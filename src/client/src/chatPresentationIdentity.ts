import type { ChatLine, ChatPart } from "./chatTypes";

/** Unscoped durable identity; live presentation ownership belongs to the view. */
export function chatPartIdentity(message: ChatLine, part: ChatPart): string | undefined {
  if ("toolCallId" in part && part.toolCallId) return JSON.stringify(["tool", part.toolCallId]);
  if (part.type === "askUserQuestion") return JSON.stringify(["ask", part.ask.askId]);
  // Successive answers to one ask are distinct transcript facts.
  if (part.type === "askUserRecord") return (message.entryId ?? "") !== ""
    ? JSON.stringify(["ask-record", message.entryId, part.outcome.askId]) : undefined;
  const address = (message.entryId ?? "") !== "" ? ["entry", message.entryId] : undefined;
  return address === undefined || part.sourcePart === undefined ? undefined : JSON.stringify([...address, part.sourcePart]);
}

/** Identifies a presentation slice by its leading original part, not its position. */
export function chatLinePresentationIdentity(message: ChatLine): string | undefined {
  const first = message.parts[0];
  return first === undefined ? undefined : chatPartIdentity(message, first);
}
