import type { TranscriptMessage } from "../../shared/apiTypes.js";

/** Flatten durable branch entries without substituting provider IDs or array positions. */
export function historyMessagesFromEntries(entries: readonly unknown[]): unknown[] {
  const messages: unknown[] = [];
  let thinkingLevel: string | undefined;
  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    if (entry["type"] === "thinking_level_change") {
      if (typeof entry["thinkingLevel"] === "string") thinkingLevel = entry["thinkingLevel"];
      continue;
    }
    let message: unknown;
    if (entry["type"] === "message") message = annotateAssistantThinkingLevel(entry["message"], thinkingLevel);
    else if (entry["type"] === "custom_message" && entry["display"] === true) message = { role: "custom", content: entry["content"], customType: entry["customType"], details: entry["details"] };
    else if (entry["type"] === "compaction") message = { role: "system", source: "compaction", content: `Compacted history:\n\n${stringValue(entry["summary"])}` };
    else if (entry["type"] === "branch_summary") message = { role: "system", source: "branch_summary", content: `Branch summary:\n\n${stringValue(entry["summary"])}` };
    else continue;
    if (isRecord(message)) {
      // Only the enclosing durable entry is authoritative, never message.id/entryId.
      const payload = { ...message };
      delete payload["entryId"];
      const entryId = entry["id"];
      const transcriptMessage: TranscriptMessage = {
        ...payload,
        ...(typeof entryId === "string" && entryId !== "" ? { entryId } : {}),
      };
      messages.push(transcriptMessage);
    } else messages.push(message);
  }
  return messages;
}

/** Attribute the level in effect when an assistant message was generated. */
export function annotateAssistantThinkingLevel(message: unknown, thinkingLevel: string | undefined): unknown {
  if (thinkingLevel === undefined || thinkingLevel === "" || thinkingLevel === "off") return message;
  if (!isRecord(message) || message["role"] !== "assistant") return message;
  return { ...message, thinkingLevel };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}
