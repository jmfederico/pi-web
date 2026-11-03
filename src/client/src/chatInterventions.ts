import type { ChatPart } from "./chatTypes";

const REQUEST_HUMAN_INTERVENTION_TOOL = "request_human_intervention";

/**
 * The request an agent addressed to the user when it stopped for input.
 * Any successful tool result may carry `details.reason` with the generic
 * intervention signal. Sessions saved before results carried the reason fall
 * back to the validated arguments of the core tool.
 */
export function interventionRequestText(part: ChatPart): string | undefined {
  if (part.type !== "toolExecution" || part.status !== "success") return undefined;
  if (!isRecord(part.details) || part.details["interventionRequired"] !== true) return undefined;
  const reason = nonEmptyString(part.details["reason"]);
  if (reason !== undefined) return reason;
  return part.toolName === REQUEST_HUMAN_INTERVENTION_TOOL && isRecord(part.args) ? nonEmptyString(part.args["reason"]) : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
