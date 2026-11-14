// This module contains only non-secret records shared by the three package entries.
export const PRIVATE_INPUT_TOOL = "request_private_input";
export const OUTCOME_TYPE = "private-input.outcome";
export const CHECK_EVENT = "private-input:check";
export const NOTIFY_EVENT = "private-input:notify";
export const REPLY_EVENT = "private-input:reply";
export const MAX_SECRET_BYTES = 64 * 1024;

export type FailureCode = "exists" | "destination_changed" | "write_failed" | "write_uncertain";
export type RequestStatus = "waiting" | "writing" | "saved" | "cancelled" | "failed";
export interface PrivateInputRecord {
  requestId: string;
  sessionId: string;
  destination: string;
  purpose: string;
  status: RequestStatus;
  failure?: FailureCode;
}

export function recordObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid private input request");
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- Object guard; individual fields are validated by callers.
  return value as Record<string, unknown>;
}

export function boundedText(value: unknown, max: number): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > max || value.includes("\0")) {
    throw new Error("Invalid private input request");
  }
  return value;
}

export function requestId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9-]{36}$/u.test(value)) throw new Error("Invalid private input request ID");
  return value;
}

export function stateNamespace(id: string): string { return `private-input.${requestId(id)}`; }

/** Reconstruct an allowlisted record; never forward opaque input or error objects. */
export function parseRecord(value: unknown): PrivateInputRecord {
  const input = recordObject(value);
  const status = input["status"];
  if (status !== "waiting" && status !== "writing" && status !== "saved" && status !== "cancelled" && status !== "failed") {
    throw new Error("Invalid private input state");
  }
  const failure = input["failure"];
  if (failure !== undefined && failure !== "exists" && failure !== "destination_changed" && failure !== "write_failed" && failure !== "write_uncertain") {
    throw new Error("Invalid private input outcome");
  }
  return {
    requestId: requestId(input["requestId"]), sessionId: boundedText(input["sessionId"], 512),
    destination: boundedText(input["destination"], 4096), purpose: boundedText(input["purpose"], 2000), status,
    ...(failure === undefined ? {} : { failure }),
  };
}

export function isFinished(record: PrivateInputRecord): boolean {
  return record.status === "saved" || record.status === "cancelled" || record.status === "failed";
}

export function outcomeText(record: PrivateInputRecord): string {
  const location = JSON.stringify(record.destination);
  if (record.status === "saved") return `Private input ${record.requestId}: saved to ${location}. The value was not included in the conversation.`;
  if (record.status === "cancelled") return `Private input ${record.requestId}: cancelled by the user. No file was written.`;
  const reason = record.failure === "exists" ? "The destination already exists; it was not overwritten."
    : record.failure === "destination_changed" ? "The destination changed after confirmation; no file was written."
      : record.failure === "write_uncertain" ? "The write could not be confirmed. A file may exist; do not retry automatically."
        : "The file could not be written.";
  return `Private input ${record.requestId}: failed for ${location}. ${reason}`;
}
