import { argumentSummaryPresentation, summarizeArgs } from "./chatPresentation";
import { ASK_USER_ANSWERS_CUSTOM_TYPE } from "../../shared/apiTypes";
import { parseAskUserOutcome, parseAskUserRequest } from "./api/parsers";
import { isSessionMediaId, validImageDimensions } from "../../shared/sessionMedia";
import type { ChatLine, ChatPart, ToolExecutionPart, ToolPreview } from "./chatTypes";

export { summarizeArgs } from "./chatPresentation";

export function normalizeMessages(messages: unknown[]): ChatLine[] {
  const lines: ChatLine[] = [];
  for (const message of messages) {
    const normalized = normalizeMessage(message);
    if (normalized.every((line) => line.parts.length === 0) && getString(message, "role") !== undefined
      && lines.at(-1)?.parts.at(-1)?.type === "askUserQuestion") {
      // Even a non-visible conversation entry closes the preceding question.
      const emptyLine = normalized[0] ?? withMessageMeta({ role: normalizeRole(getString(message, "role")), parts: [] }, message);
      lines.push({ ...emptyLine, parts: [{ type: "empty" }] });
    } else {
      lines.push(...normalized);
    }
  }
  return coalesceToolExecutions(lines).filter((message) => message.parts.length > 0);
}

export function textMessage(role: ChatLine["role"], text: string): ChatLine {
  return { role, parts: [{ type: "text", text }] };
}

export function withMessageMeta(line: ChatLine, rawMessage: unknown): ChatLine {
  const meta = normalizeMeta(rawMessage);
  const entryId = getString(rawMessage, "entryId");
  const streamId = getString(rawMessage, "streamId");
  if (meta === undefined && entryId === undefined && streamId === undefined) return line;
  return {
    ...line,
    ...(streamId === undefined ? {} : { streamId }),
    ...(meta === undefined ? {} : { meta }),
    ...(entryId === undefined || entryId === "" ? {} : { entryId }),
  };
}

export function appendText(messages: ChatLine[], role: ChatLine["role"], text: string): ChatLine[] {
  if (text === "") return messages;
  const last = messages.at(-1);
  const lastPart = last?.parts.at(-1);
  if (last?.role === role && lastPart?.type === "text") {
    return [
      ...messages.slice(0, -1),
      { ...last, parts: [...last.parts.slice(0, -1), { type: "text", text: lastPart.text + text }] },
    ];
  }
  if (last?.role === role) return [...messages.slice(0, -1), { ...last, parts: [...last.parts, { type: "text", text }] }];
  return [...messages, textMessage(role, text)];
}

export function appendThinking(messages: ChatLine[], text: string): ChatLine[] {
  if (text === "") return messages;
  const last = messages.at(-1);
  const lastPart = last?.parts.at(-1);
  if (last?.role === "assistant" && lastPart?.type === "thinking") {
    return [
      ...messages.slice(0, -1),
      { ...last, parts: [...last.parts.slice(0, -1), { type: "thinking", text: lastPart.text + text }] },
    ];
  }
  if (last?.role === "assistant") return [...messages.slice(0, -1), { ...last, parts: [...last.parts, { type: "thinking", text }] }];
  return [...messages, { role: "assistant", parts: [{ type: "thinking", text }] }];
}

export function normalizeMessage(message: unknown): ChatLine[] {
  if (isChatLine(message)) {
    if (!message.parts.some((part) => getString(part, "type") === "image")) return [message];
    return [{ ...message, parts: message.parts.flatMap((part) => getString(part, "type") === "image" ? normalizeImage(part) : [part]) }];
  }
  if (getString(message, "role") === "bashExecution") return [withMessageMeta(normalizeBashExecution(message), message)];
  const rawRole = getString(message, "role");
  const role = normalizeRole(rawRole);
  const contentParts = normalizeContent(getProperty(message, "content"), message);
  const supersededRecord = rawRole === "toolResult"
    ? askUserRecordFromToolDetails(getString(message, "toolName") ?? "", getProperty(message, "details"))
    : undefined;
  const question = rawRole === "toolResult"
    ? askUserQuestionFromToolDetails(getString(message, "toolName") ?? "", getProperty(message, "details"), getBoolean(message, "isError") === true)
    : undefined;
  // Every tool result needs a result part, even when its output is empty or
  // image-only, so coalescing can finish the call without losing chronology.
  const resultParts = rawRole === "toolResult" && !contentParts.some((part) => part.type === "toolResult")
    ? [toolResultPartFromText(contentParts.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n"), message), ...contentParts.filter((part) => part.type === "image")]
    : contentParts;
  const parts = [...resultParts, ...(supersededRecord === undefined ? [] : [supersededRecord]), ...(question === undefined ? [] : [question])];
  const skillLines = role === "user" ? normalizeSkillInvocation(parts) : undefined;
  if (skillLines !== undefined) return skillLines.map((line) => withMessageMeta(line, message));
  const source = normalizeSource(message);
  if (role === "tool") return [withMessageMeta({ role, parts, ...(source === undefined ? {} : { source }) }, message)];

  const visible = parts.filter((part) => part.type !== "empty");
  const displayRole = role === "assistant" && visible.length > 0 && visible.every((part) => part.type === "skillRead") ? "skill" : role;
  const lines = visible.length > 0 ? [withMessageMeta({ role: displayRole, parts: visible, ...(source === undefined ? {} : { source }) }, message)] : [];
  const errorLine = assistantErrorLine(message);
  return errorLine === undefined ? lines : [...lines, withMessageMeta(errorLine, message)];
}

function assistantErrorLine(message: unknown): ChatLine | undefined {
  if (getString(message, "role") !== "assistant" || getString(message, "stopReason") !== "error") return undefined;
  const errorMessage = getString(message, "errorMessage")?.trim();
  const detail = errorMessage === undefined || errorMessage === "" ? "The model returned an error." : errorMessage;
  return { role: "system", parts: [{ type: "text", text: `Model response failed: ${detail}`, presentation: { kind: "modelError", detail: errorMessage ?? "" } }] };
}

function isChatLine(message: unknown): message is ChatLine {
  const role = getString(message, "role");
  return (role === "user" || role === "assistant" || role === "tool" || role === "system" || role === "bash" || role === "skill")
    && Array.isArray(getProperty(message, "parts"));
}

function normalizeSkillInvocation(parts: ChatPart[]): ChatLine[] | undefined {
  if (parts.length !== 1 || parts[0]?.type !== "text") return undefined;
  const skill = parseSkillBlock(parts[0].text);
  if (skill === undefined) return undefined;
  return [
    { role: "user", parts: [{ type: "skillInvocation", name: skill.name, location: skill.location, content: skill.content }] },
    ...(skill.userMessage === undefined ? [] : [{ role: "user" as const, parts: [{ type: "text" as const, text: skill.userMessage }] }]),
  ];
}

function parseSkillBlock(text: string): { name: string; location: string; content: string; userMessage?: string } | undefined {
  const match = /^<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+))?$/.exec(text);
  if (match === null) return undefined;
  const userMessage = match[4]?.trim();
  return {
    name: match[1] ?? "skill",
    location: match[2] ?? "",
    content: match[3] ?? "",
    ...(userMessage === undefined || userMessage === "" ? {} : { userMessage }),
  };
}

function normalizeSource(message: unknown): ChatLine["source"] | undefined {
  const source = getString(message, "source");
  if (source === "compaction" || source === "branch_summary") return source;
  return undefined;
}

function normalizeMeta(message: unknown): ChatLine["meta"] | undefined {
  const timestamp = normalizeTimestamp(getProperty(message, "timestamp"));
  const model = normalizeModel(message);
  const thinkingLevel = getString(message, "thinkingLevel");
  if (timestamp === undefined && model === undefined && (thinkingLevel === undefined || thinkingLevel === "")) return undefined;
  return {
    ...(timestamp === undefined ? {} : { timestamp }),
    ...(model === undefined ? {} : { model }),
    ...(thinkingLevel === undefined || thinkingLevel === "" ? {} : { thinkingLevel }),
  };
}

function normalizeTimestamp(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
  if (typeof value !== "string" || value === "") return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}

function normalizeModel(message: unknown): NonNullable<ChatLine["meta"]>["model"] | undefined {
  if (getString(message, "role") !== "assistant") return undefined;
  const provider = getString(message, "provider");
  const id = getString(message, "model");
  const responseId = getString(message, "responseModel");
  if ((provider === undefined || provider === "") && (id === undefined || id === "") && (responseId === undefined || responseId === "")) return undefined;
  return {
    ...(provider === undefined || provider === "" ? {} : { provider }),
    ...(id === undefined || id === "" ? {} : { id }),
    ...(responseId === undefined || responseId === "" ? {} : { responseId }),
  };
}

function normalizeBashExecution(message: unknown): ChatLine {
  const command = getString(message, "command") ?? "";
  const lines = getBoolean(message, "excludeFromContext") === true ? ["excluded from context", "", `$ ${command}`] : [`$ ${command}`];
  const output = getProperty(message, "output");
  if (output != null) lines.push("", stringifyPrimitive(output));
  const exitCode = getProperty(message, "exitCode");
  if (exitCode != null) lines.push("", `exit ${stringifyPrimitive(exitCode)}`);
  if (getBoolean(message, "cancelled") === true) lines.push("", "cancelled");
  if (getBoolean(message, "truncated") === true) lines.push("", "output truncated");
  const fullOutputPath = getString(message, "fullOutputPath");
  if (fullOutputPath !== undefined && fullOutputPath !== "") lines.push("", `full output: ${fullOutputPath}`);
  return { role: "bash", parts: [{ type: "text", text: lines.join("\n"), presentation: {
    kind: "bash", command, excluded: getBoolean(message, "excludeFromContext") === true,
    cancelled: getBoolean(message, "cancelled") === true, truncated: getBoolean(message, "truncated") === true,
    ...(output == null ? {} : { output: stringifyPrimitive(output) }),
    ...(exitCode == null ? {} : { exitCode: stringifyPrimitive(exitCode) }),
    ...(fullOutputPath === undefined || fullOutputPath === "" ? {} : { fullOutputPath }),
  } }] };
}

function normalizeRole(role: unknown): ChatLine["role"] {
  if (role === "assistant") return "assistant";
  if (role === "user") return "user";
  if (role === "toolResult") return "tool";
  return "system";
}

function normalizeContent(content: unknown, message: unknown): ChatPart[] {
  const askUserRecord = askUserRecordPart(message);
  if (askUserRecord !== undefined) return [askUserRecord];
  if (typeof content === "string") {
    const displayText = getString(message, "displayText");
    return content !== "" ? [{ type: "text", text: content, ...(displayText === undefined ? {} : { displayText }) }] : [];
  }
  if (!Array.isArray(content)) return objectFallback(content);

  return content.flatMap((part): ChatPart[] => {
    const type = getString(part, "type");
    const text = getString(part, "text");
    const displayText = getString(part, "displayText");
    const display = displayText === undefined ? {} : { displayText };
    if (type === "text") return text !== undefined && text !== "" ? [{ type: "text", text, ...display }] : [];
    if (type === "thinking") {
      const thinking = getString(part, "thinking") ?? text;
      return thinking !== undefined && thinking !== "" ? [{ type: "thinking", text: thinking, ...display }] : [];
    }
    if (type === "toolCall") {
      const toolName = getString(part, "name") ?? "tool";
      const args = getProperty(part, "arguments");
      const toolCallId = getString(part, "id");
      const skillRead = toolName === "read" ? parseSkillReadPath(getString(args, "path")) : undefined;
      if (skillRead !== undefined) return [{ type: "skillRead", ...skillRead, ...(toolCallId === undefined ? {} : { toolCallId }) }];
      return [{ type: "toolCall", ...(toolCallId === undefined ? {} : { toolCallId }), toolName, summary: summarizeArgs(args), ...argumentSummaryPresentation(args), ...(args === undefined ? {} : { args }) }];
    }
    if (type === "image") return normalizeImage(part);
    return objectFallback(part);
  }).map((part) => part.type === "text" && getString(message, "role") === "toolResult"
    ? toolResultPartFromText(part.text, message)
    : part);
}

function normalizeImage(part: unknown): ChatPart[] {
  const mimeType = getString(part, "mimeType");
  const mediaId = getProperty(part, "mediaId");
  const dimensions = validImageDimensions(getProperty(part, "width"), getProperty(part, "height"));
  if (mediaId !== undefined) {
    const byteSize = getNumber(part, "byteSize");
    if (isSessionMediaId(mediaId)
      && mimeType !== undefined && /^image\/[a-z0-9][a-z0-9.+-]*$/iu.test(mimeType)
      && byteSize !== undefined && Number.isSafeInteger(byteSize) && byteSize >= 0) {
      return [{ type: "image", mediaId, mimeType, byteSize, ...dimensions }];
    }
  } else {
    const data = getString(part, "data");
    if (data !== undefined && data !== "" && mimeType !== undefined && mimeType !== "") return [{ type: "image", mimeType, data, ...dimensions }];
  }
  return [{ type: "text", text: "[image]", presentation: { kind: "imagePlaceholder" } }];
}

function askUserRecordPart(message: unknown): Extract<ChatPart, { type: "askUserRecord" }> | undefined {
  if (getString(message, "role") !== "custom" || getString(message, "customType") !== ASK_USER_ANSWERS_CUSTOM_TYPE) return undefined;
  return parsedAskUserRecord(getProperty(message, "details"));
}

/** Only validated successful results, never tool-call arguments, offer questions. */
export function askUserQuestionFromToolDetails(toolName: string, details: unknown, isError: boolean): Extract<ChatPart, { type: "askUserQuestion" }> | undefined {
  if (toolName !== "ask_user" || isError) return undefined;
  try {
    return { type: "askUserQuestion", ask: parseAskUserRequest(getProperty(details, "ask")) };
  } catch {
    // Invalid persisted results retain their ordinary tool-output presentation.
    return undefined;
  }
}

/** Project the superseded ask carried by an `ask_user` tool result, if any. */
export function askUserRecordFromToolDetails(toolName: string, details: unknown): Extract<ChatPart, { type: "askUserRecord" }> | undefined {
  if (toolName !== "ask_user") return undefined;
  return parsedAskUserRecord(getProperty(details, "superseded"));
}

function parsedAskUserRecord(value: unknown): Extract<ChatPart, { type: "askUserRecord" }> | undefined {
  try {
    return { type: "askUserRecord", outcome: parseAskUserOutcome(value) };
  } catch {
    // A malformed legacy/session entry must not make the whole transcript fail.
    // Fall back to its model-facing text through the ordinary normalizer.
    return undefined;
  }
}

function toolResultPartFromText(text: string, message: unknown): Extract<ChatPart, { type: "toolResult" }> {
  const toolCallId = getString(message, "toolCallId");
  const content = getProperty(message, "content");
  const details = getProperty(message, "details");
  return {
    type: "toolResult",
    ...(toolCallId === undefined ? {} : { toolCallId }),
    toolName: getString(message, "toolName") ?? "tool",
    text,
    ...(content === undefined ? {} : { content }),
    ...(details === undefined ? {} : { details }),
    isError: getBoolean(message, "isError") === true,
  };
}

function parseSkillReadPath(path: string | undefined): { name: string; path: string } | undefined {
  if (path === undefined || path === "") return undefined;
  const normalized = path.replace(/\\/g, "/");
  if (!normalized.endsWith("/SKILL.md") && normalized !== "SKILL.md") return undefined;
  const name = normalized.split("/").at(-2);
  if (name === undefined || name === "") return undefined;
  return { name, path };
}

function coalesceToolExecutions(lines: ChatLine[]): ChatLine[] {
  const result: ChatLine[] = [];
  const pendingTools = new Map<string, { lineIndex: number; partIndex: number }>();

  for (const line of lines) {
    let passthroughParts: ChatPart[] = [];
    const metadata = {
      ...(line.streamId === undefined ? {} : { streamId: line.streamId }),
      ...(line.entryId === undefined ? {} : { entryId: line.entryId }),
      ...(line.source === undefined ? {} : { source: line.source }),
      ...(line.meta === undefined ? {} : { meta: line.meta }),
    };
    const flushPassthrough = () => {
      if (passthroughParts.length === 0) return;
      result.push({ role: line.role, parts: passthroughParts, ...metadata });
      passthroughParts = [];
    };

    for (const part of line.parts) {
      if (part.type === "toolCall") {
        flushPassthrough();
        const execution = toolExecutionFromCall(part);
        const lineIndex = result.length;
        result.push({ role: "tool", parts: [execution], ...metadata });
        if (execution.toolCallId !== undefined) pendingTools.set(execution.toolCallId, { lineIndex, partIndex: 0 });
        continue;
      }

      if (part.type === "toolResult") {
        const target = part.toolCallId === undefined ? undefined : pendingTools.get(part.toolCallId);
        if (target !== undefined && mergeToolResultInto(result, target, part, line.meta)) {
          pendingTools.delete(part.toolCallId ?? "");
          // Coalescing must not erase a later conversation entry and reopen an
          // earlier question. The question itself always stays at result position.
          if (result.at(-1)?.parts.at(-1)?.type === "askUserQuestion"
            && !line.parts.some((item) => item.type === "askUserQuestion" || item.type === "askUserRecord")) {
            passthroughParts.push({ type: "toolResultBoundary", ...(part.toolCallId === undefined ? {} : { toolCallId: part.toolCallId }) });
          }
          continue;
        }
      }

      if (part.type === "askUserQuestion" || part.type === "askUserRecord") {
        flushPassthrough();
        result.push({ role: line.role, parts: [part], ...metadata });
      } else {
        passthroughParts.push(part);
      }
    }

    flushPassthrough();
  }

  return result;
}

function toolExecutionFromCall(part: Extract<ChatPart, { type: "toolCall" }>): ToolExecutionPart {
  return {
    type: "toolExecution",
    ...(part.toolCallId === undefined ? {} : { toolCallId: part.toolCallId }),
    toolName: part.toolName,
    summary: part.summary,
    ...(part.summaryPresentation === undefined ? {} : { summaryPresentation: part.summaryPresentation }),
    ...(part.args === undefined ? {} : { args: part.args }),
    status: "pending",
  };
}

function mergeToolResultInto(lines: ChatLine[], target: { lineIndex: number; partIndex: number }, result: Extract<ChatPart, { type: "toolResult" }>, meta: ChatLine["meta"]): boolean {
  const line = lines[target.lineIndex];
  const current = line?.parts[target.partIndex];
  if (line === undefined || current?.type !== "toolExecution") return false;
  const preview = previewFromDetails(result.details) ?? current.preview;
  const next: ToolExecutionPart = {
    ...current,
    status: result.isError ? "error" : "success",
    resultText: result.text,
    ...(result.content === undefined ? {} : { content: result.content }),
    ...(result.details === undefined ? {} : { details: result.details }),
    ...(preview === undefined ? {} : { preview }),
  };
  lines[target.lineIndex] = { ...line, parts: [...line.parts.slice(0, target.partIndex), next, ...line.parts.slice(target.partIndex + 1)], ...(meta === undefined ? {} : { meta }) };
  return true;
}

export function previewFromDetails(details: unknown): ToolPreview | undefined {
  const preview = getProperty(details, "preview");
  if (!isRecord(preview)) return undefined;
  const diff = getString(preview, "diff");
  const error = getString(preview, "error");
  const firstChangedLine = getNumber(preview, "firstChangedLine");
  if (diff === undefined && error === undefined && firstChangedLine === undefined) return undefined;
  return {
    ...(diff === undefined ? {} : { diff }),
    ...(error === undefined ? {} : { error }),
    ...(firstChangedLine === undefined ? {} : { firstChangedLine }),
  };
}

function objectFallback(value: unknown): ChatPart[] {
  if (value == null) return [];
  if (typeof value === "object") return [{ type: "text", text: summarizeArgs(value), presentation: { kind: "arguments", args: value } }];
  return [{ type: "text", text: stringifyPrimitive(value) }];
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

function getNumber(value: unknown, key: string): number | undefined {
  const property = getProperty(value, key);
  return typeof property === "number" && Number.isFinite(property) ? property : undefined;
}

function stringifyPrimitive(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  return "";
}
