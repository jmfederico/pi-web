import { Type } from "pi-web-typebox";
import { defineTool } from "../../piSdk.js";

const Parameters = Type.Object({
  reason: Type.String({ minLength: 1, maxLength: 1_000, description: "What the human needs to decide or do. Write any detailed question in the conversation before calling this tool." }),
});

/** Explicit intent works for prose questions, approvals, and actions outside PI WEB. */
export function createRequestHumanInterventionToolDefinition() {
  return defineTool<typeof Parameters, { interventionRequired: true }>({
    name: "request_human_intervention",
    exposure: "model-only",
    label: "Request human intervention",
    description: "Mark this session as needing the user's attention and end the run. Use when you have a request for the user here, such as a question, an approval, or an action to take. Any new agent run clears the indicator.",
    promptSnippet: "request_human_intervention: signal that human input or action is needed; ends the run",
    promptGuidelines: [
      "When you stop for human input or an external human action, explain what is needed and call request_human_intervention alone and last. A plain-text question does not set the indicator by itself. ask_user sets it automatically for structured forms, so do not call both.",
    ],
    parameters: Parameters,
    // eslint-disable-next-line @typescript-eslint/require-await -- Tool execution is promise-shaped.
    async execute(_toolCallId, params) {
      const reason = params.reason.trim();
      if (reason.length === 0) throw new Error("Intervention reason must not be empty");
      return { content: [{ type: "text", text: `Needs human input: ${reason}` }], details: { interventionRequired: true }, terminate: true };
    },
  });
}
