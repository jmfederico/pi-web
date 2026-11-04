import { Type } from "pi-web-typebox";
import { defineTool } from "../../piSdk.js";

const Parameters = Type.Object({
  reason: Type.String({ minLength: 1, maxLength: 1_000, description: "Shown to the user as your request. Make it self-contained: what you need them to decide, answer, or do, and why. Put longer context in the conversation before calling this tool." }),
});

/** Explicit intent works for prose questions, approvals, and actions outside PI WEB. */
export function createRequestHumanInterventionToolDefinition() {
  return defineTool<typeof Parameters, { interventionRequired: true; reason: string }>({
    name: "request_human_intervention",
    exposure: "model-only",
    label: "Request human intervention",
    description: "Show the user a request and mark this session as needing their attention, then end the run. Use when you need something from the user here, such as an answer, an approval, or an action to take. Any new agent run clears the indicator.",
    promptSnippet: "request_human_intervention: show the user a request for input or action; ends the run",
    promptGuidelines: [
      "When you stop for human input or an external human action, call request_human_intervention alone and last with a self-contained reason; it is shown to the user as your request. A plain-text question does not set the indicator by itself. ask_user sets it automatically for structured forms, so do not call both.",
    ],
    parameters: Parameters,
    // eslint-disable-next-line @typescript-eslint/require-await -- Tool execution is promise-shaped.
    async execute(_toolCallId, params) {
      const reason = params.reason.trim();
      if (reason.length === 0) throw new Error("Intervention reason must not be empty");
      return { content: [{ type: "text", text: `Needs human input: ${reason}` }], details: { interventionRequired: true, reason }, terminate: true };
    },
  });
}
