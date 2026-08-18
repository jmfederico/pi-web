const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

export interface MessagePageRequest {
  before?: number;
  limit?: number;
}

export interface MessagePageResult<T> {
  messages: T[];
  start: number;
  total: number;
}

export function pageMessagesAtSafeBoundary<T>(messages: T[], page?: MessagePageRequest): MessagePageResult<T> {
  const total = messages.length;
  if (page?.before === undefined && page?.limit === undefined) return { messages, start: 0, total };
  const before = clampInteger(page.before ?? total, 0, total);
  const limit = clampInteger(page.limit ?? DEFAULT_LIMIT, 1, MAX_LIMIT);
  const requestedStart = Math.max(0, before - limit);
  const start = expandStartToSafeBoundary(messages, requestedStart);
  return { messages: messages.slice(start, before), start, total };
}

export function expandStartToSafeBoundary(messages: unknown[], requestedStart: number): number {
  const start = clampInteger(requestedStart, 0, messages.length);
  if (start === 0 || isTurnBoundary(messages[start])) return start;
  for (let index = start - 1; index >= 0; index -= 1) {
    if (isTurnBoundary(messages[index])) return index;
  }
  return 0;
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
