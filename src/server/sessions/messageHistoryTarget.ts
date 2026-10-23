/**
 * Resolve a message shortcut against the current root-to-leaf branch. Non-user
 * checkpoints retain the intervening history up to, but not including, the next
 * distinct user/assistant checkpoint, or through a question but not its answer.
 * Pi still owns the actual tree mutation.
 * Exact-entry tree operations do not use this resolver.
 */
export function messageHistoryTargetId(branch: readonly unknown[], entryId: string): string {
  const index = branch.findIndex((entry) => isRecord(entry) && entry["id"] === entryId);
  if (index < 0) throw new Error("This message is no longer available on the active session branch.");

  const entry = branch[index];
  // A question is answered from its durable tool result, without retaining any
  // earlier answer (custom messages are otherwise part of a checkpoint's tail).
  if (isQuestionResult(entry)) return entryId;
  // Pi restores a selected user message to the editor by positioning before it.
  if (isRecord(entry) && entry["type"] === "message" && isRecord(entry["message"])
    && entry["message"]["role"] === "user") return entryId;

  let targetId = entryId;
  for (let nextIndex = index + 1; nextIndex < branch.length; nextIndex += 1) {
    const next = branch[nextIndex];
    if (!isRecord(next) || typeof next["id"] !== "string" || isConversationCheckpoint(next)) break;
    targetId = next["id"];
    // The agent message that produced a question retains the request, not any
    // later answer, just like selecting the question itself.
    if (isQuestionResult(next)) break;
  }
  return targetId;
}

function isQuestionResult(entry: unknown): boolean {
  if (!isRecord(entry) || entry["type"] !== "message" || !isRecord(entry["message"])) return false;
  const message = entry["message"];
  const details = message["details"];
  return message["role"] === "toolResult" && message["toolName"] === "ask_user" && message["isError"] === false
    && isRecord(details) && isRecord(details["ask"]);
}

/**
 * Boundaries are intrinsic conversation checkpoints, not transient plugin
 * availability (busy/archived/disabled buttons must not change the cutoff).
 * Tool-only assistant entries have no core history header and stay in the
 * preceding checkpoint along with their results and other technical entries.
 */
function isConversationCheckpoint(entry: Record<string, unknown>): boolean {
  if (entry["type"] !== "message" || !isRecord(entry["message"])) return false;
  const message = entry["message"];
  if (message["role"] === "user") return true;
  if (message["role"] !== "assistant") return false;
  const content = message["content"];
  if (typeof content === "string") return content !== "";
  if (!Array.isArray(content)) return content != null;
  return content.some((part) => {
    if (!isRecord(part)) return true;
    if (part["type"] === "toolCall") return false;
    if (part["type"] === "text") return typeof part["text"] === "string" && part["text"] !== "";
    if (part["type"] === "thinking") {
      const text = part["thinking"] ?? part["text"];
      return typeof text === "string" && text !== "";
    }
    return true;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
