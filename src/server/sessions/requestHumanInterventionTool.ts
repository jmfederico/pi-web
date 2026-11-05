import { Type } from "pi-web-typebox";
import { defineTool } from "../../piSdk.js";

const Parameters = Type.Object({
  reason: Type.String({ minLength: 1, maxLength: 1_000, description: "One short sentence stating the action the user needs to take. Put context and formatted steps in chat before calling this tool." }),
});

/** Requests a user action before work can continue. */
export function createRequestHumanInterventionToolDefinition() {
  return defineTool<typeof Parameters, { interventionRequired: true; reason: string }>({
    name: "request_human_intervention",
    exposure: "model-only",
    label: "Request human intervention",
    description: "Request an action the user must perform before work can continue. Marks the session as needing attention and ends the run. Any new agent run clears the indicator.",
    promptSnippet: "request_human_intervention: request an action the user must perform; ends the run",
    promptGuidelines: [
      "Use request_human_intervention when progress requires the user to take an action, not answer a question or give approval.",
      "Put detailed instructions in chat first. Keep the intervention request to one short, concrete sentence.",
      "Call request_human_intervention alone and last; it marks the session as needing attention and ends the run.",
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
