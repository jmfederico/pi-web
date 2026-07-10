import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";

// --- Types ---

export const MAX_QUESTIONS = 4;
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 4;
const MAX_LABEL_LENGTH = 60;
const MAX_HEADER_LENGTH = 16;

export const RESERVED_LABELS = ["Other", "Type something.", "Chat about this.", "Next"] as const;

export interface AskUserQuestionResult {
  answers: QuestionAnswer[];
  cancelled: boolean;
  error?: string;
}

export interface QuestionAnswer {
  questionIndex: number;
  question: string;
  kind: "option" | "custom" | "chat" | "multi";
  answer: string | null;
  selected?: string[];
  notes?: string;
}

// --- Schema ---

const OptionSchema = Type.Object({
  label: Type.String({
    maxLength: MAX_LABEL_LENGTH,
    description:
      `MAX ${String(MAX_LABEL_LENGTH)} CHARACTERS — hard limit, requests over the limit are rejected. The display text for this option that the user will see and select. Should be concise (1-5 words) and clearly describe the choice.`,
  }),
  description: Type.String({
    description:
      "Explanation of what this option means or what will happen if chosen. Useful for providing context about trade-offs or implications.",
  }),
  preview: Type.Optional(
    Type.String({
      description:
        "Optional preview content rendered when this option is focused. Use for mockups, code snippets, or visual comparisons that help users compare options. See the tool description for the expected content format.",
    }),
  ),
});

const QuestionSchema = Type.Object({
  question: Type.String({
    description:
      'The complete question to ask the user. Should be clear, specific, and end with a question mark. Example: "Which library should we use for date formatting?" If multiSelect is true, phrase it accordingly, e.g. "Which features do you want to enable?"',
  }),
  header: Type.String({
    maxLength: MAX_HEADER_LENGTH,
    description:
      `MAX ${String(MAX_HEADER_LENGTH)} CHARACTERS — hard limit, requests over the limit are rejected. Very short chip/tag shown next to the question. Examples: "Auth method", "Library", "Approach".`,
  }),
  options: Type.Array(OptionSchema, {
    minItems: MIN_OPTIONS,
    maxItems: MAX_OPTIONS,
    description:
      "The available choices for this question. Must have 2-4 options. Each option should be a distinct, mutually exclusive choice (unless multiSelect is enabled). The 'Type something.' row is appended automatically — do NOT author it.",
  }),
  multiSelect: Type.Optional(
    Type.Boolean({
      default: false,
      description:
        "Set to true to allow the user to select multiple options instead of just one. Use when choices are not mutually exclusive.",
    }),
  ),
});

const QuestionParamsSchema = Type.Object({
  questions: Type.Array(QuestionSchema, {
    minItems: 1,
    maxItems: MAX_QUESTIONS,
    description: "Questions to ask the user (1-4 questions)",
  }),
});

// --- Tool dependencies ---

export interface AskUserQuestionDeps {
  /** Show the questionnaire to the user and wait for their response. */
  ask(toolCallId: string, params: AskUserQuestionParams): Promise<AskUserQuestionResult>;
}

export interface AskUserQuestionParams {
  questions: {
    question: string;
    header: string;
    multiSelect: boolean;
    options: { label: string; description: string; preview?: string }[];
  }[];
}

// --- Validation ---

function validateQuestionnaire(params: AskUserQuestionParams): { ok: true } | { ok: false; error: string } {
  if (params.questions.length === 0) return { ok: false, error: "Error: At least one question is required" };
  if (params.questions.length > MAX_QUESTIONS) {
    return { ok: false, error: `Error: At most ${String(MAX_QUESTIONS)} questions are allowed per invocation` };
  }

  const seenQuestions = new Set<string>();
  for (const q of params.questions) {
    if (seenQuestions.has(q.question)) {
      return { ok: false, error: "Error: Question text must be unique within an invocation" };
    }
    seenQuestions.add(q.question);
  }

  const reservedLabelSet: ReadonlySet<string> = new Set(RESERVED_LABELS);
  for (const q of params.questions) {
    if (q.options.length < MIN_OPTIONS) {
      return { ok: false, error: `Error: Each question requires at least ${String(MIN_OPTIONS)} options` };
    }
    const seenLabels = new Set<string>();
    for (const o of q.options) {
      if (reservedLabelSet.has(o.label)) {
        return { ok: false, error: `Error: Option label is reserved (${RESERVED_LABELS.join(", ")})` };
      }
      if (seenLabels.has(o.label)) {
        return { ok: false, error: "Error: Option labels must be unique within a question" };
      }
      seenLabels.add(o.label);
    }
  }

  return { ok: true };
}

// --- Response formatting ---

function formatAnswerScalar(a: QuestionAnswer): string {
  switch (a.kind) {
    case "chat":
      return "User wants to chat about this. Continue the conversation to help them decide.";
    case "multi":
      return a.selected !== undefined && a.selected.length > 0 ? a.selected.join(", ") : "(no input)";
    case "custom":
      return a.answer !== null && a.answer.length > 0 ? a.answer : "(no input)";
    case "option":
      return a.answer ?? "(no input)";
  }
}

function buildToolResult(result: AskUserQuestionResult) {
  const DECLINE_MESSAGE = "User declined to answer questions";
  const ENVELOPE_PREFIX = "User has answered your questions:";
  const ENVELOPE_SUFFIX = "You can now continue with the user's answers in mind.";

  if (result.cancelled) {
    return {
      content: [{ type: "text" as const, text: DECLINE_MESSAGE }],
      details: { answers: result.answers, cancelled: true },
    };
  }

  const segments: string[] = [];
  for (const a of result.answers) {
    segments.push(`"${a.question}"="${formatAnswerScalar(a)}"`);
  }

  if (segments.length === 0) {
    return {
      content: [{ type: "text" as const, text: DECLINE_MESSAGE }],
      details: { answers: result.answers, cancelled: true },
    };
  }

  return {
    content: [{ type: "text" as const, text: `${ENVELOPE_PREFIX} ${segments.join(" ")} ${ENVELOPE_SUFFIX}` }],
    details: result,
  };
}

// --- Tool factory ---

export function createAskUserQuestionToolDefinition(deps: AskUserQuestionDeps) {
  const maxQ = String(MAX_QUESTIONS);
  const minO = String(MIN_OPTIONS);
  const maxO = String(MAX_OPTIONS);

  return defineTool<typeof QuestionParamsSchema, AskUserQuestionResult>({
    name: "ask_user_question",
    label: "Ask User Question",
    description: `Ask the user one or more structured questions during execution. Use when you need to:
1. Gather user preferences or requirements
2. Clarify ambiguous instructions
3. Get decisions on implementation choices as you work
4. Offer choices to the user about what direction to take

Usage notes:
- Users will always be able to type a custom answer ("Type something." row is appended automatically to every single-select question) or pick "Chat about this" to abandon the questionnaire and continue in free-form conversation. Do NOT author "Other" / "Type something." / "Chat about this" labels yourself — duplicates are rejected at runtime.
- Use multiSelect: true to allow multiple answers to be selected for a question. The "Type something." row is suppressed on multi-select questions, and is ALSO suppressed on single-select questions where any option carries a \`preview\` (the side-by-side layout has no room for inline custom text — "Chat about this" remains as the free-form escape hatch).
- If you recommend a specific option, make that the first option in the list and add "(Recommended)" at the end of the label.

Preview feature:
Use the optional \`preview\` field on options when presenting concrete artifacts that users need to visually compare:
- ASCII mockups of UI layouts or components
- Code snippets showing different implementations
- Diagram variations
- Configuration examples

Preview content is rendered as markdown in a monospace box. Multi-line text with newlines is supported. When any option has a preview, the UI switches to a side-by-side layout with a vertical option list on the left and preview on the right. Do not use previews for simple preference questions where labels and descriptions suffice. Note: previews are only supported for single-select questions (not multiSelect).`,
    promptSnippet:
      `Ask the user up to ${maxQ} structured questions (${minO}-${maxO} options each) when requirements are ambiguous`,
    promptGuidelines: [
      `Use ask_user_question whenever the user's request is underspecified and you cannot proceed without concrete decisions — you can ask up to ${maxQ} questions per invocation.`,
      `Each question MUST have ${minO}-${maxO} options. Every option requires a concise label (1-5 words) and a description explaining what the choice means or its trade-offs. The user can additionally type a custom answer ("Type something." row is appended automatically to single-select questions) or pick "Chat about this" to abandon the questionnaire.`,
      `Set multiSelect: true when multiple answers are valid; this suppresses the "Type something." row. Provide an options[].preview markdown string when an option benefits from richer side-by-side context (mockups, code snippets, diagrams, configs) — single-select only. NOTE: any non-empty preview on a single-select question ALSO suppresses the "Type something." row (no room in the side-by-side layout); "Chat about this" remains the escape hatch. If you recommend a specific option, make it the first option and append "(Recommended)" to its label.`,
      "Do not stack multiple ask_user_question calls back-to-back — group all clarifying questions into one invocation.",
    ],
    parameters: QuestionParamsSchema,

    async execute(_toolCallId, rawParams, _signal, _onUpdate) {
      void _signal;
      void _onUpdate;
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
      const params = rawParams as unknown as AskUserQuestionParams;

      const validation = validateQuestionnaire(params);
      if (!validation.ok) {
        const result: AskUserQuestionResult = { answers: [], cancelled: true, error: validation.error };
        return buildToolResult(result);
      }

      const result = await deps.ask(_toolCallId, params);
      return buildToolResult(result);
    },
  });
}