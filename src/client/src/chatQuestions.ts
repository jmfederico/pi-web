import type { AskUserOutcome, AskUserRequest } from "../../shared/apiTypes";
import { chatFallbackParts, type ChatLine } from "./chatTypes";

export interface QuestionTailContext {
  historyReady: boolean;
  messageEnd: number;
  messageTotal: number;
  writable: boolean;
}

/**
 * The latest question stays open until a later line continues the conversation.
 * The last visible page is not necessarily the active conversation's tail.
 */
export function openTranscriptQuestion(messages: readonly ChatLine[], context: QuestionTailContext): AskUserRequest | undefined {
  if (!context.historyReady || !context.writable || context.messageEnd < context.messageTotal) return undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const line = messages[index];
    if (line === undefined) continue;
    const last = line.parts.at(-1);
    if (last?.type === "askUserQuestion") return last.ask;
    if (continuesConversation(line)) return undefined;
  }
  return undefined;
}

/**
 * Mirrors the server's `continuesConversation` in
 * `src/server/sessions/sessionIntervention.ts`, which clears the session's
 * attention flag: user, assistant and tool lines, failed replies, and delivered
 * answers continue the conversation. Passive lines (custom notices, shell
 * output, compaction and branch summaries, local errors) do not.
 */
function continuesConversation(line: ChatLine): boolean {
  if (line.role === "user" || line.role === "assistant" || line.role === "tool" || line.role === "skill") return true;
  return chatFallbackParts(line.parts).some((part) => part.type === "askUserRecord"
    || (part.type === "text" && part.presentation?.kind === "modelError"));
}

/** Responses remain separate transcript facts; none is treated as stale. */
export function transcriptQuestionOutcomes(messages: readonly ChatLine[]): ReadonlyMap<string, AskUserOutcome[]> {
  const outcomes = new Map<string, AskUserOutcome[]>();
  for (const message of messages) {
    for (const part of chatFallbackParts(message.parts)) {
      if (part.type !== "askUserRecord") continue;
      const replies = outcomes.get(part.outcome.askId) ?? [];
      replies.push(part.outcome);
      outcomes.set(part.outcome.askId, replies);
    }
  }
  return outcomes;
}
