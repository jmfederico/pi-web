const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
/**
 * How far a page start may move forward to reach a user turn boundary.
 *
 * Starting a page at the user message that produced the turn keeps it
 * readable, but a page must never grow past the requested limit to reach one.
 * Moving the start forward shortens the page instead, and a boundary farther
 * away than this is skipped rather than shrinking the page to almost nothing.
 */
const TURN_BOUNDARY_LOOKAHEAD = 10;

export interface MessagePageRequest {
  before?: number;
  limit?: number;
}

export interface MessagePageResult<T> {
  messages: T[];
  start: number;
  total: number;
}

/**
 * Page the transcript messages into the window `[start, before)`.
 *
 * `before` is the exclusive end of the page (the transcript end when omitted)
 * and `limit` is the maximum number of messages the page may hold. The start
 * never moves behind `before - limit`, so a page holds at most `limit`
 * messages: a page request bounds the work and the payload, it is not a hint.
 * An earlier implementation expanded the start backwards to the previous user
 * message without any bound, so a small `limit` could return the whole
 * transcript.
 *
 * The start may still move forward to a user turn boundary close to it, so a
 * page usually begins with the prompt that produced the turn it shows.
 */
export function pageMessages<T>(messages: T[], page?: MessagePageRequest): MessagePageResult<T> {
  const total = messages.length;
  const before = clampInteger(page?.before ?? total, 0, total);
  const limit = clampInteger(page?.limit ?? DEFAULT_LIMIT, 1, MAX_LIMIT);
  const requestedStart = Math.max(0, before - limit);
  const start = turnBoundaryStart(messages, requestedStart, before);
  return { messages: messages.slice(start, before), start, total };
}

/**
 * The page start, moved forward to the next user turn boundary when one is
 * close enough. Moving forward keeps the page within the requested limit; the
 * boundary is a readability preference and is skipped when it is far away.
 *
 * A page that already holds the whole transcript is never trimmed: it is not
 * at its limit, so trimming it would only lose messages.
 */
function turnBoundaryStart(messages: unknown[], requestedStart: number, before: number): number {
  if (requestedStart === 0) return 0;
  const lookahead = Math.min(TURN_BOUNDARY_LOOKAHEAD, before - requestedStart);
  for (let index = requestedStart; index < requestedStart + lookahead; index += 1) {
    if (isTurnBoundary(messages[index])) return index;
  }
  return requestedStart;
}

function isTurnBoundary(message: unknown): boolean {
  return getString(message, "role") === "user";
}

function getProperty(value: unknown, key: string): unknown {
  if (!isRecord(value)) return undefined;
  return value[key];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getString(value: unknown, key: string): string | undefined {
  const property = getProperty(value, key);
  return typeof property === "string" ? property : undefined;
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return max;
  return Math.max(min, Math.min(max, Math.floor(value)));
}
