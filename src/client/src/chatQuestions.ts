import type { AskUserOutcome, AskUserRequest } from "../../shared/apiTypes";
import type { ChatLine } from "./chatTypes";

export interface QuestionTailContext {
  historyReady: boolean;
  messageEnd: number;
  messageTotal: number;
  writable: boolean;
}

/** The last visible page is not necessarily the active conversation's tail. */
export function openTranscriptQuestion(messages: readonly ChatLine[], context: QuestionTailContext): AskUserRequest | undefined {
  if (!context.historyReady || !context.writable || context.messageEnd < context.messageTotal) return undefined;
  const last = messages.at(-1)?.parts.at(-1);
  return last?.type === "askUserQuestion" ? last.ask : undefined;
}

/** Responses remain separate transcript facts; none is treated as stale. */
export function transcriptQuestionOutcomes(messages: readonly ChatLine[]): ReadonlyMap<string, AskUserOutcome[]> {
  const outcomes = new Map<string, AskUserOutcome[]>();
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== "askUserRecord") continue;
      const replies = outcomes.get(part.outcome.askId) ?? [];
      replies.push(part.outcome);
      outcomes.set(part.outcome.askId, replies);
    }
  }
  return outcomes;
}
