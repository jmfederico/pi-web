import { normalizeContext, type Api, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";

const SESSION_NAME_TIMEOUT_MS = 10_000;
const SESSION_NAME_MAX_INPUT_CHARS = 4_000;
const SESSION_NAME_MAX_LENGTH = 60;
const FALLBACK_SESSION_NAME_MAX_WORDS = 6;
/** Explicit extension names are validated, not silently rewritten. */
export function requireInitialSessionName(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "" || value !== value.trim()
    // eslint-disable-next-line no-control-regex -- explicit names must not contain control characters.
    || value.length > SESSION_NAME_MAX_LENGTH || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error("Initial session name must be trimmed, non-empty, at most 60 characters, and contain no control characters");
  }
  return value;
}

export async function generateShortSessionName<TApi extends Api>(streamFn: StreamFn, model: Model<TApi>, firstMessage: string): Promise<string | undefined> {
  const stream = await streamFn(
    model,
    normalizeContext({
      systemPrompt: "Generate a concise title for a coding-agent chat session. Return only the title, with no quotes or punctuation wrapper.",
      messages: [{
        role: "user",
        content: `Create a 2-6 word title for this request:\n\n${truncateInput(firstMessage)}`,
        timestamp: Date.now(),
      }],
    }),
    {
      maxTokens: 24,
      reasoning: "minimal",
      signal: AbortSignal.timeout(SESSION_NAME_TIMEOUT_MS),
    },
  );

  let streamedText = "";
  let finalMessage: AssistantMessage | undefined;
  for await (const event of stream) {
    if (event.type === "text_delta") streamedText += event.delta;
    if (event.type === "done") finalMessage = event.message;
    if (event.type === "error") return undefined;
  }

  return cleanSessionName(finalMessage === undefined ? streamedText : textFromAssistant(finalMessage));
}

export function fallbackSessionName(firstMessage: unknown): string | undefined {
  if (typeof firstMessage !== "string") return undefined;

  return cleanSessionName(firstMessage
    .replace(/<skill name="[^"]+" location="[^"]+">[\s\S]*?<\/skill>/g, "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[`*_#[\](){}<>]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, FALLBACK_SESSION_NAME_MAX_WORDS)
    .join(" "));
}

export function cleanSessionName(value: string): string | undefined {
  const title = (value.split("\n", 1)[0] ?? "")
    .replace(/^\s*(title|session title)\s*:\s*/i, "")
    .replace(/^\s*["'`]+|["'`.]+\s*$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, SESSION_NAME_MAX_LENGTH)
    .trim();
  return title === "" ? undefined : title;
}

function textFromAssistant(message: AssistantMessage): string {
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function truncateInput(value: string): string {
  return value.length <= SESSION_NAME_MAX_INPUT_CHARS ? value : `${value.slice(0, SESSION_NAME_MAX_INPUT_CHARS)}…`;
}
