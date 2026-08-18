import type { ChatLine, ChatPart } from "./components/shared";

export type ChatGroup =
  | { kind: "message"; message: ChatLine; index: number }
  | { kind: "tool-image"; message: ChatLine; index: number; toolName?: string }
  | { kind: "group"; messages: ChatLine[]; startIndex: number; endIndex: number };

export function groupChatMessages(messages: ChatLine[], indexOffset = 0): ChatGroup[] {
  const groups: ChatGroup[] = [];
  let eventMessages: ChatLine[] = [];
  let eventStartIndex = 0;

  const pushEvent = (message: ChatLine, index: number) => {
    if (!eventMessages.length) eventStartIndex = index;
    eventMessages.push(message);
  };
  const flushEvents = () => {
    if (!eventMessages.length) return;
    groups.push({ kind: "group", messages: eventMessages, startIndex: eventStartIndex, endIndex: eventStartIndex + eventMessages.length - 1 });
    eventMessages = [];
  };

  messages.forEach((message, index) => {
    const readableParts = message.parts.filter((part) => isReadablePart(message, part));
    const technicalParts = message.parts.filter((part) => !isReadablePart(message, part));

    const absoluteIndex = indexOffset + index;
    const metadata = { ...(message.source === undefined ? {} : { source: message.source }), ...(message.meta === undefined ? {} : { meta: message.meta }) };
    if (technicalParts.length) pushEvent({ role: message.role, parts: technicalParts, ...metadata }, absoluteIndex);
    if (readableParts.length) {
      flushEvents();
      const role = readableParts.every((part) => part.type === "skillRead") ? "skill" : message.role;
      const readableMessage = { role, parts: readableParts, ...metadata };
      if (isToolImageMessage(readableMessage)) {
        const toolName = toolNameFromParts(technicalParts);
        groups.push({ kind: "tool-image", message: readableMessage, index: absoluteIndex, ...(toolName === undefined ? {} : { toolName }) });
      } else {
        groups.push({ kind: "message", message: readableMessage, index: absoluteIndex });
      }
    }
  });
  flushEvents();
  return groups;
}

export function summarizeChatGroup(messages: ChatLine[]): string {
  if (messages.every((message) => message.source === "compaction")) return `${String(messages.length)} history compaction ${messages.length === 1 ? "summary" : "summaries"}`;
  if (messages.every((message) => message.source === "branch_summary")) return `${String(messages.length)} branch ${messages.length === 1 ? "summary" : "summaries"}`;
  const counts = messages.reduce<Record<string, number>>((acc, message) => {
    acc[message.role] = (acc[message.role] ?? 0) + 1;
    return acc;
  }, {});
  const details = Object.entries(counts).map(([role, count]) => `${String(count)} ${role}`).join(" · ");
  return `${String(messages.length)} ${messages.length === 1 ? "event" : "events"}${details !== "" ? ` · ${details}` : ""}`;
}

function isToolImageMessage(message: ChatLine): boolean {
  return message.role === "tool" && message.parts.length > 0 && message.parts.every((part) => part.type === "image");
}

function toolNameFromParts(parts: ChatPart[]): string | undefined {
  for (const part of parts) {
    if ((part.type === "toolCall" || part.type === "toolExecution" || part.type === "toolResult") && part.toolName !== "") return part.toolName;
  }
  return undefined;
}

function isReadablePart(message: ChatLine, part: ChatPart): boolean {
  if (message.source === "compaction" || message.source === "branch_summary") return false;
  if (part.type === "skillInvocation" || part.type === "skillRead" || part.type === "image" || part.type === "askUserRecord") return true;
  return part.type === "text" && (message.role === "user" || message.role === "assistant" || message.role === "system" || message.role === "bash");
}
