import { ASK_USER_ANSWERS_CUSTOM_TYPE } from "../../shared/apiTypes.js";
import { isRecord } from "./sessionFileFormat.js";

/** Session execution state, not a particular form's lifetime or selected branch. */
export const SESSION_INTERVENTION_CUSTOM_TYPE = "pi-web.intervention";

/** Generic successful tool-result signal; tool names and presentation do not matter. */
export function requestsHumanIntervention(message: unknown): boolean {
  if (!isRecord(message) || message["role"] !== "toolResult" || message["isError"] !== false) return false;
  const details = message["details"];
  return isRecord(details) && details["interventionRequired"] === true;
}

/**
 * Whether a transcript message moves the conversation past an open request:
 * a user, assistant, or tool-result message, or delivered question answers.
 * Passive entries (other custom messages, shell output, summaries) do not.
 * The client applies the same rule to the open question form; see
 * `continuesConversation` in `src/client/src/chatQuestions.ts`.
 */
export function continuesConversation(message: unknown): boolean {
  if (!isRecord(message)) return false;
  const role = message["role"];
  if (role === "user" || role === "assistant" || role === "toolResult") return true;
  return role === "custom" && message["customType"] === ASK_USER_ANSWERS_CUSTOM_TYPE;
}

export function interventionStateFromEntry(entry: unknown): boolean | undefined {
  if (!isRecord(entry) || entry["type"] !== "custom" || entry["customType"] !== SESSION_INTERVENTION_CUSTOM_TYPE) return undefined;
  const data = entry["data"];
  return isRecord(data) && data["version"] === 1 && typeof data["required"] === "boolean" ? data["required"] : undefined;
}

/**
 * Latest execution-state transition in file order. Selecting another transcript
 * branch does not resume execution or resurrect an earlier intervention request.
 */
export function sessionInterventionRequired(entries: readonly unknown[]): boolean {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const required = interventionStateFromEntry(entries[index]);
    if (required !== undefined) return required;
  }
  return false;
}
