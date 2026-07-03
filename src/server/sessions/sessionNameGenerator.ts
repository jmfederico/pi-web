import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";

const SESSION_NAME_TIMEOUT_MS = 10_000;
const SESSION_NAME_MAX_INPUT_CHARS = 4_000;
const SESSION_NAME_MAX_LENGTH = 60;
const FALLBACK_SESSION_NAME_MAX_WORDS = 6;
const RELAY_HANDOFF_FIRST_LINE = /^Relay\s+"([^"\n]+)"\s+leg\s+(\d+)\s+begins now\.?\s*(?:\n|$)/;

export function deterministicSessionName(firstMessage: unknown): string | undefined {
  if (typeof firstMessage !== "string") return undefined;

  return relayHandoffSessionName(firstMessage.trimStart());
}

export async function generateShortSessionName<TApi extends Api>(streamFn: StreamFn, model: Model<TApi>, firstMessage: string): Promise<string | undefined> {
  const stream = await streamFn(
    model,
    {
      systemPrompt: "Generate a concise title for a coding-agent chat session. Return only the title, with no quotes or punctuation wrapper.",
      messages: [{
        role: "user",
        content: `Create a 2-6 word title for this request:\n\n${truncateInput(firstMessage)}`,
        timestamp: Date.now(),
      }],
    },
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

function relayHandoffSessionName(firstMessage: string): string | undefined {
  const match = RELAY_HANDOFF_FIRST_LINE.exec(firstMessage);
  if (match === null) return undefined;

  const relayName = match[1]?.replace(/\s+/g, " ").trim();
  const legNumber = match[2];
  if (relayName === undefined || relayName === "" || legNumber === undefined) return undefined;

  return cleanSessionName(formatRelaySessionName(relayName, legNumber));
}

function formatRelaySessionName(relayName: string, legNumber: string): string {
  const prefix = "Relay ";
  const suffix = ` leg ${legNumber}`;
  const maxRelayNameLength = Math.max(1, SESSION_NAME_MAX_LENGTH - prefix.length - suffix.length);
  const displayedRelayName = truncateRelayName(relayName, maxRelayNameLength);
  return `${prefix}${displayedRelayName}${suffix}`;
}

function truncateRelayName(relayName: string, maxLength: number): string {
  if (relayName.length <= maxLength) return relayName;
  const truncated = relayName.slice(0, maxLength).replace(/[\s._-]+$/g, "").trim();
  return truncated === "" ? relayName.slice(0, maxLength).trim() : truncated;
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
