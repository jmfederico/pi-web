export const CAPTAIN_REQUEST = "captains-log:v1:request";
export const CAPTAIN_REPLY = "captains-log:v1:reply";
export const SOURCE_REQUEST = "captains-log:v1:source-request";
export const SOURCE_REPLY = "captains-log:v1:source-reply";
export const PIRATE_INTRO = "We are pirates. Always speak pirate.";
export const PIRATE_MARKER = "captains-log:pirate-introduced";
export const MAX_FINDINGS = 48_000;
export const MAX_QUESTION = 8_000;
export const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

// A type alias keeps records structurally compatible with the public JSON peer API.
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
export type LogEntry = {
  id: string;
  createdAt: string;
  sessionId: string;
  question: string;
  sourceSessionId?: string;
  status: "running" | "completed" | "failed" | "interrupted";
  failureCode?: "session-unavailable" | "request-failed" | "interrupted";
  stages: string[];
  text: string;
};
export function isLogEntry(value: unknown): value is LogEntry {
  if (typeof value !== "object" || value === null) return false;
  return "id" in value && typeof value.id === "string" && UUID.test(value.id)
    && "createdAt" in value && typeof value.createdAt === "string"
    && "sessionId" in value && typeof value.sessionId === "string" && value.sessionId.length <= 512
    && (!("sourceSessionId" in value) || value.sourceSessionId === undefined || (typeof value.sourceSessionId === "string" && !!value.sourceSessionId.trim() && value.sourceSessionId.length <= 512))
    && "question" in value && typeof value.question === "string" && value.question.length <= MAX_QUESTION
    && "status" in value && ["running", "completed", "failed", "interrupted"].includes(String(value.status))
    && (!("failureCode" in value) || value.failureCode === undefined || (typeof value.failureCode === "string" && ["session-unavailable", "request-failed", "interrupted"].includes(value.failureCode)))
    && "stages" in value && Array.isArray(value.stages) && value.stages.length <= 16 && value.stages.every((s: unknown) => typeof s === "string" && s.length <= 256)
    && "text" in value && typeof value.text === "string" && value.text.length <= MAX_FINDINGS;
}
export function captainPrompt(text: string): string {
  return `Retell this as a theatrical pirate captain briefing the crew. Rewrite it from scratch: nautical metaphors, colorful pirate phrasing, and a little humor. Preserve the important facts, warnings, and next steps; keep code and commands exact. Don't merely sprinkle “arrr” onto the original. Always speak pirate.\n\nSource reply:\n${text}`;
}
