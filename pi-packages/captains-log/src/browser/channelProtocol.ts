import { isLogEntry, UUID, type LogEntry } from "./protocol.js";

/** Browser peer contract: open `log` with null; requests are only `list`/`read` snapshots. */
export const LOG_CHANNEL = "log";
// JSON wire values must be structurally assignable to JsonValue.
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
export type CaptainClientFrame = { type: "translate"; requestId: string; sourceSessionId: string };
export type CaptainServerFrame =
  | { type: "admitted"; requestId: string; id: string }
  | { type: "rejected"; requestId: string; message: string }
  | { type: "entry"; entry: LogEntry; saved: boolean }
  | { type: "text"; id: string; text: string };

export function isCaptainClientFrame(value: unknown): value is CaptainClientFrame {
  if (value === null || typeof value !== "object") return false;
  return "type" in value && value.type === "translate"
    && "requestId" in value && typeof value.requestId === "string" && UUID.test(value.requestId)
    && "sourceSessionId" in value && typeof value.sourceSessionId === "string" && !!value.sourceSessionId.trim() && value.sourceSessionId.length <= 512;
}
export function isCaptainServerFrame(value: unknown): value is CaptainServerFrame {
  if (value === null || typeof value !== "object" || !("type" in value)) return false;
  switch (value.type) {
    case "entry": return "entry" in value && isLogEntry(value.entry) && "saved" in value && typeof value.saved === "boolean";
    case "text": return "id" in value && typeof value.id === "string" && UUID.test(value.id) && "text" in value && typeof value.text === "string" && value.text.length <= 4000;
    case "admitted": return "requestId" in value && typeof value.requestId === "string" && UUID.test(value.requestId) && "id" in value && typeof value.id === "string" && UUID.test(value.id);
    case "rejected": return "requestId" in value && typeof value.requestId === "string" && UUID.test(value.requestId) && "message" in value && typeof value.message === "string";
    default: return false;
  }
}
/** Reset text with each entry, then append bounded chunks. Even escaped Unicode fits host frames. */
export function entryFrames(entry: LogEntry, saved: boolean): CaptainServerFrame[] {
  const frames: CaptainServerFrame[] = [{ type: "entry", entry: { ...entry, stages: [...entry.stages], text: "" }, saved }];
  for (let offset = 0; offset < entry.text.length; offset += 4000) frames.push({ type: "text", id: entry.id, text: entry.text.slice(offset, offset + 4000) });
  return frames;
}
