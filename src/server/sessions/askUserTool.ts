import { Type, type Static } from "pi-web-typebox";
import { defineTool } from "../../piSdk.js";
import {
  ASK_USER_ID_MAX_LENGTH,
  ASK_USER_OPTION_LIMIT,
  ASK_USER_QUESTION_LIMIT,
  ASK_USER_TEXT_MAX_LENGTH,
  type AskUserQuestion,
  type AskUserQuestionOption,
  type AskUserRequest,
} from "../../shared/apiTypes.js";
import { createAskUserRequest, type AskUserRequestOptions } from "./askUserDomain.js";

interface AskUserToolDetails { ask: AskUserRequest; interventionRequired: true }

const AskUserOptionParams = Type.Object({
  value: Type.String({
    maxLength: ASK_USER_ID_MAX_LENGTH,
    description: "Stable machine value reported back to you when the user picks this option.",
  }),
  label: Type.String({
    maxLength: ASK_USER_TEXT_MAX_LENGTH,
    description: "Short label the user reads, ideally a few words.",
  }),
  detail: Type.Optional(Type.String({
    maxLength: ASK_USER_TEXT_MAX_LENGTH,
    description: "Optional clarification shown under the label.",
  })),
});

const AskUserQuestionParams = Type.Object({
  id: Type.String({
    maxLength: ASK_USER_ID_MAX_LENGTH,
    description: "Unique within this call; used as the answer key reported back to you.",
  }),
  question: Type.String({
    maxLength: ASK_USER_TEXT_MAX_LENGTH,
    description: "The question itself, as one plain-text line.",
  }),
  detail: Type.Optional(Type.String({
    maxLength: ASK_USER_TEXT_MAX_LENGTH,
    description: "Optional supporting context shown under the question.",
  })),
  options: Type.Optional(Type.Array(AskUserOptionParams, {
    maxItems: ASK_USER_OPTION_LIMIT,
    description: "Options to choose from. Omit when free text is the whole answer; the browser always adds a Custom choice.",
  })),
  multiple: Type.Optional(Type.Boolean({
    description: "Allow several options at once. Default: one answer per question.",
  })),
});

const AskUserParams = Type.Object({
  questions: Type.Array(AskUserQuestionParams, {
    minItems: 1,
    maxItems: ASK_USER_QUESTION_LIMIT,
    description: "The questions to post, in the order the user should read them. Every question may be left unanswered.",
  }),
});

/** Shapes schema defaults before domain validation builds the durable payload. */
function toQuestion(param: Static<typeof AskUserQuestionParams>): AskUserQuestion {
  const { detail, options, multiple } = param;
  return {
    id: param.id,
    question: param.question,
    ...(detail === undefined ? {} : { detail }),
    options: (options ?? []).map(toOption),
    ...(multiple === undefined ? {} : { multiple }),
  };
}

function toOption(param: Static<typeof AskUserOptionParams>): AskUserQuestionOption {
  const { detail } = param;
  return { value: param.value, label: param.label, ...(detail === undefined ? {} : { detail }) };
}

function postedText(ask: AskUserRequest): string {
  const count = ask.questions.length;
  return `Posted ${count.toString()} question${count === 1 ? "" : "s"} to the user as ask ${ask.askId}. Ending this run; the answers arrive as a follow-up message that wakes you, naming every question the user left unanswered.`;
}

/**
 * Custom tool that posts a question set to the user's browser as interactive UI.
 *
 * It deliberately does **not** await the user. Awaiting would pin the agent run
 * for an unbounded human-scale wait, keep the session streaming, and leave a
 * dangling tool call if the runtime were replaced meanwhile. Instead the ask
 * is durably recorded in the successful tool result's details, the tool
 * terminates the run, and answers return later as a follow-up message. There
 * is no service registration or runtime question state to reconstruct.
 *
 * Rejected question sets throw: the agent loop turns the thrown message into an
 * error tool result, so the model can fix the ask and post it again.
 */
export function createAskUserToolDefinition(options: AskUserRequestOptions = {}) {
  return defineTool<typeof AskUserParams, AskUserToolDetails>({
    name: "ask_user",
    // Nested tools cannot terminate the outer agent run.
    exposure: "model-only",
    label: "Ask user",
    description: "Ask the user questions through a browser form and end the run. Answers arrive as a follow-up message; the user may leave questions unanswered.",
    promptSnippet: "ask_user: request answers, decisions, or approvals; ends the run, answers return as a follow-up",
    promptGuidelines: [
      "Use ask_user for answers, decisions, and approvals. Group related questions in one call.",
      "Call ask_user alone and last; it marks the session as needing attention and ends the run.",
      "Answers return as a follow-up message identifying unanswered questions.",
    ],
    parameters: AskUserParams,
    // eslint-disable-next-line @typescript-eslint/require-await -- Tool execution is promise-shaped; validation failures reject before a successful result exists.
    async execute(_toolCallId, params) {
      const ask = createAskUserRequest(params.questions.map(toQuestion), options);
      return {
        content: [{ type: "text", text: postedText(ask) }],
        details: { ask, interventionRequired: true },
        terminate: true,
      };
    },
  });
}
