import type { ChatLine, ChatPart } from "./chatTypes";

export type ChatGroup =
  | { kind: "message"; message: ChatLine; index: number }
  | { kind: "tool-image"; message: ChatLine; index: number; toolName?: string }
  // Members keep their source indexes even when invisible entries are skipped.
  | { kind: "group"; messages: { message: ChatLine; index: number }[]; startIndex: number; endIndex: number };

export type ChatToolImageOutput = Extract<ChatGroup, { kind: "tool-image" }>;
export type ChatDisplayGroup = Exclude<ChatGroup, ChatToolImageOutput>
  | { kind: "tool-images"; outputs: [ChatToolImageOutput, ...ChatToolImageOutput[]] };

/** Combine only adjoining image outputs; conversation and activity remain boundaries. */
export function groupConsecutiveImageOutputs(groups: readonly ChatGroup[]): ChatDisplayGroup[] {
  const result: ChatDisplayGroup[] = [];
  for (const group of groups) {
    if (group.kind !== "tool-image") { result.push(group); continue; }
    const previous = result.at(-1);
    if (previous?.kind === "tool-images") previous.outputs.push(group);
    else result.push({ kind: "tool-images", outputs: [group] });
  }
  return result;
}

export function groupChatMessages(messages: ChatLine[], indexOffset = 0): ChatGroup[] {
  const groups: ChatGroup[] = [];
  let eventMessages: Extract<ChatGroup, { kind: "group" }>["messages"] = [];

  const pushEvent = (message: ChatLine, index: number) => {
    eventMessages.push({ message, index });
  };
  const flushEvents = () => {
    const first = eventMessages[0];
    const last = eventMessages.at(-1);
    if (first === undefined || last === undefined) return;
    groups.push({ kind: "group", messages: eventMessages, startIndex: first.index, endIndex: last.index });
    eventMessages = [];
  };

  messages.forEach((message, index) => {
    const visibleParts = message.parts.filter((part) => part.type !== "toolResultBoundary" && part.type !== "empty");
    // Ordering markers affect the conversation tail, not visual grouping.
    if (visibleParts.length === 0) return;
    const readableParts = visibleParts.filter((part) => isReadablePart(message, part));
    const technicalParts = visibleParts.filter((part) => !isReadablePart(message, part));

    const absoluteIndex = indexOffset + index;
    const metadata = { ...(message.entryId === undefined ? {} : { entryId: message.entryId }), ...(message.source === undefined ? {} : { source: message.source }), ...(message.meta === undefined ? {} : { meta: message.meta }) };
    if (technicalParts.length) {
      const role = technicalParts.every((part) => part.type === "skillRead") ? "skill" : message.role;
      pushEvent({ role, parts: technicalParts, ...metadata }, absoluteIndex);
    }
    if (readableParts.length) {
      flushEvents();
      const readableMessage = { role: message.role, parts: readableParts, ...metadata };
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

/** Whether this slice renders a message header rather than a headerless shell. */
export function chatMessageHasHeader(message: ChatLine): boolean {
  return !(message.parts.length > 0 && (
    (message.role === "tool" && message.parts.every((part) => part.type === "toolExecution"))
    || message.parts.every((part) => part.type === "askUserRecord")
  ));
}

/** Select rendered slice identities, independent of disclosure and plugin policy. */
export function canonicalEntryActionHeaders(groups: readonly ChatGroup[]): ReadonlySet<ChatLine> {
  const entries = new Map<string, { message: ChatLine; priority: number }>();
  for (const group of groups) {
    for (const message of group.kind === "group" ? group.messages.map((event) => event.message) : [group.message]) {
      if (message.entryId === undefined || !chatMessageHasHeader(message)) continue;
      // A normal reply wins over attached events. Conversation headers also
      // outrank skill-only slices, so thinking retains history when no reply exists.
      const conversation = message.role === "user" || message.role === "assistant";
      const reply = group.kind !== "group" && message.parts.some((part) => part.type === "text" || part.type === "image");
      const priority = conversation ? (reply ? 3 : 2) : (group.kind !== "group" ? 1 : 0);
      const previous = entries.get(message.entryId);
      if (previous === undefined || priority > previous.priority) entries.set(message.entryId, { message, priority });
    }
  }
  return new Set(Array.from(entries.values(), ({ message }) => message));
}

export interface ChatGroupSummary {
  kind: "compaction" | "branch" | "events";
  count: number;
  roles: Partial<Record<ChatLine["role"], number>>;
}

export function summarizeChatGroup(messages: ChatLine[], format?: (summary: ChatGroupSummary) => string): string {
  if (format !== undefined) {
    const roles: ChatGroupSummary["roles"] = {};
    for (const message of messages) roles[message.role] = (roles[message.role] ?? 0) + 1;
    return format({
      kind: messages.every((message) => message.source === "compaction") ? "compaction"
        : messages.every((message) => message.source === "branch_summary") ? "branch" : "events",
      count: messages.length, roles,
    });
  }
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
  if (part.type === "skillInvocation" || part.type === "image" || part.type === "askUserQuestion" || part.type === "askUserRecord") return true;
  return part.type === "text" && (message.role === "user" || message.role === "assistant" || message.role === "system" || message.role === "bash");
}
