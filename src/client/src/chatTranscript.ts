import { appendText, appendThinking, normalizeMessage, normalizeMessages, previewFromDetails, summarizeArgs, textMessage } from "./chatMessages";
import type { ChatLine, ToolExecutionPart } from "./components/shared";
import { appendShellChunk, finalizeShellMessage, shellStartMessage } from "./shellMessages";
import type { SessionUiEvent } from "./sessionSocket";

type ToolResultImage = Extract<ChatLine["parts"][number], { type: "image" }>;

interface ToolResultPresentation {
  images: ToolResultImage[];
  meta?: ChatLine["meta"];
}

interface ToolResultUpdate {
  toolCallId?: string;
  toolName: string;
  text: string;
  isError: boolean;
  content: unknown;
  details: unknown;
  presentation: ToolResultPresentation;
}

/**
 * Seed the in-flight partial assistant message on top of committed history at
 * join time. `partial` is the browser-projected `AssistantMessage` from the
 * stream snapshot (or `null`/`undefined` when the session is not mid
 * assistant-message stream). The partial is normalized the same way a streamed
 * message is (text/thinking parts plus any in-progress tool call parts kept on
 * the assistant line), so live `assistant.delta`/`assistant.thinking.delta`
 * events append onto it and `message.end` reconciles it into the finalized shape.
 * This returns a new in-memory message list only; it never writes to the raw
 * history cache.
 */
export function seedStreamingPartial(messages: ChatLine[], partial: unknown): ChatLine[] {
  if (partial === null || partial === undefined) return messages;
  // Normalize the same way committed history is (coalescing an in-progress tool
  // call into a `toolExecution` line) so the seeded partial renders identically
  // to its finalized form and live `tool.*` events can target it by call id.
  const lines = normalizeMessages([partial]);
  return lines.length === 0 ? messages : [...messages, ...lines];
}

export function applyTranscriptEvent(messages: ChatLine[], event: SessionUiEvent): ChatLine[] | undefined {
  if (event.type === "message.append") return appendNewMessage(messages, event.message);
  if (event.type === "assistant.delta") return appendText(messages, "assistant", event.text);
  if (event.type === "assistant.thinking.delta") return appendThinking(messages, event.text);
  if (event.type === "tool.start") return appendToolExecutionStart(messages, event);
  if (event.type === "tool.update") return updateToolExecution(messages, event.toolCallId, (part) => mergeToolExecutionUpdate(part, event));
  if (event.type === "tool.end") {
    return finalizeToolExecution(messages, {
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      text: event.text,
      isError: event.isError,
      content: event.content,
      details: event.details,
      presentation: toolResultPresentation({ role: "toolResult", content: event.content }),
    });
  }
  if (event.type === "shell.start") return [...messages, shellStartMessage(event.command, event.excludeFromContext)];
  if (event.type === "shell.chunk") return appendShellChunk(messages, event.chunk);
  if (event.type === "shell.end") return finalizeShellMessage(messages, event);
  if (event.type === "command.output") return [...messages, textMessage(event.level === "error" ? "system" : "tool", event.message)];
  if (event.type === "session.error") return [...messages, textMessage("system", event.message)];
  if (event.type === "message.end") return event.message === undefined ? undefined : applyFinalMessage(messages, event.message);
  return undefined;
}

function applyFinalMessage(messages: ChatLine[], rawMessage: unknown): ChatLine[] | undefined {
  const rawToolResult = toolResultFromRawMessage(rawMessage);
  if (rawToolResult !== undefined) return finalizeToolExecution(messages, rawToolResult);

  const ended = normalizeMessage(rawMessage);
  if (ended.length === 0) return undefined;
  const displayEnded = ended
    .map((line) => line.role === "assistant" ? withoutToolCalls(line) : line)
    .filter((line) => line.parts.length > 0);
  if (displayEnded.length === 0) return messages;
  return displayEnded.reduce((next, line) => applyFinalLine(next, line), messages);
}

function applyFinalLine(messages: ChatLine[], displayEnded: ChatLine): ChatLine[] {
  const skillReadIndexes = findMatchingSkillReadIndexes(messages, displayEnded);
  if (skillReadIndexes.length > 0) return replaceSkillReadLines(messages, skillReadIndexes, displayEnded);
  const last = messages.at(-1);
  if (last?.role !== displayEnded.role) return [...messages, displayEnded];
  if (displayEnded.role === "assistant" || sameMessageText(last, displayEnded)) return [...messages.slice(0, -1), displayEnded];
  return [...messages, displayEnded];
}

function withoutToolCalls(message: ChatLine): ChatLine {
  return { ...message, parts: message.parts.filter((part) => part.type !== "toolCall") };
}

function parseSkillReadPath(path: string | undefined): { name: string; path: string } | undefined {
  if (path === undefined || path === "") return undefined;
  const normalized = path.replace(/\\/g, "/");
  if (!normalized.endsWith("/SKILL.md") && normalized !== "SKILL.md") return undefined;
  const name = normalized.split("/").at(-2);
  if (name === undefined || name === "") return undefined;
  return { name, path };
}

function appendToolExecutionStart(messages: ChatLine[], event: Extract<SessionUiEvent, { type: "tool.start" }>): ChatLine[] {
  const skillRead = event.toolName === "read" ? parseSkillReadPath(getString(event.args, "path")) : undefined;
  if (skillRead !== undefined) {
    return appendLine(messages, { role: "skill", parts: [{ type: "skillRead", ...skillRead, ...(event.toolCallId === "" ? {} : { toolCallId: event.toolCallId }) }] });
  }

  const part: ToolExecutionPart = {
    type: "toolExecution",
    ...(event.toolCallId === "" ? {} : { toolCallId: event.toolCallId }),
    toolName: event.toolName,
    summary: event.summary || summarizeArgs(event.args),
    ...(event.args === undefined ? {} : { args: event.args }),
    status: "running",
  };
  return [...messages, { role: "tool", parts: [part] }];
}

function mergeToolExecutionUpdate(part: ToolExecutionPart, event: Extract<SessionUiEvent, { type: "tool.update" }>): ToolExecutionPart {
  const preview = previewFromDetails(event.details) ?? part.preview;
  return {
    ...part,
    status: part.status === "pending" ? "running" : part.status,
    ...(event.text === "" ? {} : { resultText: event.text }),
    ...(event.content === undefined ? {} : { content: event.content }),
    ...(event.details === undefined ? {} : { details: event.details }),
    ...(preview === undefined ? {} : { preview }),
  };
}

function finalizeToolExecution(messages: ChatLine[], result: ToolResultUpdate): ChatLine[] {
  const { toolCallId, toolName, text, isError, content, details, presentation } = result;
  const updated = updateToolExecution(messages, toolCallId, (part) => {
    const preview = previewFromDetails(details) ?? part.preview;
    return {
      ...part,
      status: isError ? "error" : "success",
      resultText: text,
      ...(content === undefined ? {} : { content }),
      ...(details === undefined ? {} : { details }),
      ...(preview === undefined ? {} : { preview }),
    };
  }, (line) => reconcileToolResultPresentation(line, presentation));
  if (updated !== messages) return updated;

  const preview = previewFromDetails(details);
  const part: ToolExecutionPart = {
    type: "toolExecution",
    ...(toolCallId === undefined || toolCallId === "" ? {} : { toolCallId }),
    toolName,
    summary: summarizeArgs(content),
    status: isError ? "error" : "success",
    resultText: text,
    ...(content === undefined ? {} : { content }),
    ...(details === undefined ? {} : { details }),
    ...(preview === undefined ? {} : { preview }),
  };
  return [...messages, reconcileToolResultPresentation({ role: "tool", parts: [part] }, presentation)];
}

function updateToolExecution(
  messages: ChatLine[],
  toolCallId: string | undefined,
  update: (part: ToolExecutionPart) => ToolExecutionPart,
  reconcileLine: (line: ChatLine) => ChatLine = (line) => line,
): ChatLine[] {
  if (toolCallId === undefined || toolCallId === "") return messages;
  for (let lineIndex = messages.length - 1; lineIndex >= 0; lineIndex--) {
    const line = messages[lineIndex];
    if (line === undefined) continue;
    const partIndex = line.parts.findIndex((part) => part.type === "toolExecution" && part.toolCallId === toolCallId);
    if (partIndex < 0) continue;
    const part = line.parts[partIndex];
    if (part?.type !== "toolExecution") continue;
    const updatedLine = { ...line, parts: [...line.parts.slice(0, partIndex), update(part), ...line.parts.slice(partIndex + 1)] };
    const nextLine = reconcileLine(updatedLine);
    return [...messages.slice(0, lineIndex), nextLine, ...messages.slice(lineIndex + 1)];
  }
  return messages;
}

function reconcileToolResultPresentation(line: ChatLine, presentation: ToolResultPresentation): ChatLine {
  const next = { ...line, parts: [...line.parts.filter((part) => part.type !== "image"), ...presentation.images] };
  return presentation.meta === undefined ? next : { ...next, meta: presentation.meta };
}

function toolResultPresentation(message: unknown): ToolResultPresentation {
  const normalized = normalizeMessage(message);
  const images = normalized.flatMap((line) => line.parts.filter((part): part is ToolResultImage => part.type === "image"));
  const meta = normalized.find((line) => line.meta !== undefined)?.meta;
  return { images, ...(meta === undefined ? {} : { meta }) };
}

function toolResultFromRawMessage(message: unknown): ToolResultUpdate | undefined {
  if (getString(message, "role") !== "toolResult") return undefined;
  const toolCallId = getString(message, "toolCallId");
  const content = getProperty(message, "content");
  return {
    ...(toolCallId === undefined ? {} : { toolCallId }),
    toolName: getString(message, "toolName") ?? "tool",
    text: stringifyToolContent(content),
    isError: getBoolean(message, "isError") === true,
    content,
    details: getProperty(message, "details"),
    presentation: toolResultPresentation(message),
  };
}

function stringifyToolContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(stringifyToolContent).filter((text) => text !== "").join("\n");
  if (typeof content === "object" && content !== null) {
    const text = getString(content, "text") ?? getString(content, "content") ?? getString(content, "output");
    if (text !== undefined) return text;
  }
  return "";
}

function findMatchingSkillReadIndexes(messages: ChatLine[], ended: ChatLine): number[] {
  const endedReads = skillReads(ended);
  if (endedReads.length === 0) return [];

  const matchedIndexes: number[] = [];
  let readEnd = endedReads.length;
  const lowerBound = lastUserBoundaryIndex(messages) + 1;

  for (let index = messages.length - 1; index >= lowerBound; index--) {
    const reads = skillReads(messages[index]);
    if (reads.length === 0) continue;
    const readStart = readEnd - reads.length;
    if (readStart < 0) continue;
    if (!sameSkillReads(reads, endedReads.slice(readStart, readEnd))) continue;
    matchedIndexes.unshift(index);
    readEnd = readStart;
    if (readEnd === 0) return matchedIndexes;
  }

  return [];
}

function replaceSkillReadLines(messages: ChatLine[], indexes: number[], replacement: ChatLine): ChatLine[] {
  const replacementIndexes = indexesWithAdjacentAssistantFragment(messages, indexes, replacement);
  const insertIndex = replacementIndexes[0];
  if (insertIndex === undefined) return messages;
  const replaced = new Set(replacementIndexes);
  const next: ChatLine[] = [];
  for (let index = 0; index < messages.length; index++) {
    if (index === insertIndex) next.push(replacement);
    const message = messages[index];
    if (message !== undefined && !replaced.has(index)) next.push(message);
  }
  return next;
}

function indexesWithAdjacentAssistantFragment(messages: ChatLine[], indexes: number[], replacement: ChatLine): number[] {
  const firstIndex = indexes[0];
  if (replacement.role !== "assistant" || firstIndex === undefined) return indexes;
  const previousIndex = firstIndex - 1;
  return isStreamedAssistantFragment(messages[previousIndex]) ? [previousIndex, ...indexes] : indexes;
}

function isStreamedAssistantFragment(message: ChatLine | undefined): boolean {
  return message?.role === "assistant" && message.parts.length > 0 && message.parts.every((part) => part.type === "text" || part.type === "thinking");
}

function skillReads(message: ChatLine | undefined): SkillRead[] {
  if (message === undefined) return [];
  return message.parts.filter((part): part is SkillRead => part.type === "skillRead");
}

type SkillRead = Extract<ChatLine["parts"][number], { type: "skillRead" }>;

function sameSkillReads(left: SkillRead[], right: SkillRead[]): boolean {
  return left.length === right.length && left.every((read, index) => sameSkillRead(read, right[index]));
}

function sameSkillRead(left: SkillRead, right: SkillRead | undefined): boolean {
  if (right === undefined) return false;
  if (left.toolCallId !== undefined && right.toolCallId !== undefined) return left.toolCallId === right.toolCallId;
  return normalizeSkillPath(left.path) === normalizeSkillPath(right.path) || left.name === right.name;
}

function normalizeSkillPath(path: string): string {
  return path.replace(/\\/g, "/");
}

function sameMessageText(left: ChatLine, right: ChatLine): boolean {
  return messageText(left) === messageText(right);
}

function messageText(message: ChatLine): string {
  return message.parts
    .filter((part): part is Extract<ChatLine["parts"][number], { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n\n");
}

function appendNewMessage(messages: ChatLine[], rawMessage: unknown): ChatLine[] {
  const lines = normalizeMessage(rawMessage);
  return lines.length === 0 ? messages : [...messages, ...lines];
}

function appendLine(messages: ChatLine[], line: ChatLine): ChatLine[] {
  const last = messages.at(-1);
  if (isDuplicateSkillLine(messages, line)) return messages;
  if (last?.role === line.role && line.role !== "skill") return [...messages.slice(0, -1), { ...last, parts: [...last.parts, ...line.parts] }];
  return [...messages, line];
}

function isDuplicateSkillLine(messages: ChatLine[], line: ChatLine): boolean {
  const reads = skillReads(line);
  if (line.role !== "skill" || reads.length === 0) return false;
  const lowerBound = lastUserBoundaryIndex(messages) + 1;
  return reads.every((read) => hasMatchingSkillRead(messages, read, lowerBound));
}

function hasMatchingSkillRead(messages: ChatLine[], read: SkillRead, lowerBound: number): boolean {
  for (let index = messages.length - 1; index >= lowerBound; index--) {
    if (skillReads(messages[index]).some((candidate) => sameSkillRead(candidate, read))) return true;
  }
  return false;
}

function lastUserBoundaryIndex(messages: ChatLine[]): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]?.role === "user") return index;
  }
  return -1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getProperty(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

function getString(value: unknown, key: string): string | undefined {
  const property = getProperty(value, key);
  return typeof property === "string" ? property : undefined;
}

function getBoolean(value: unknown, key: string): boolean | undefined {
  const property = getProperty(value, key);
  return typeof property === "boolean" ? property : undefined;
}
