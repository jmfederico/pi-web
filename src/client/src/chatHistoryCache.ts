const CACHE_PREFIX = "pi-web:chat-history:v2:";
const CACHE_TTL_MS = 30 * 60 * 1000;

export interface RawMessagePage {
  messages: unknown[];
  start: number;
  total: number;
}

export interface CachedChatHistory extends RawMessagePage {
  savedAt: number;
}

export function readChatHistoryCache(sessionId: string): RawMessagePage | undefined {
  try {
    const raw = sessionStorage.getItem(cacheKey(sessionId));
    if (raw === null || raw === "") return undefined;
    const parsed: unknown = JSON.parse(raw);
    if (!isCachedHistory(parsed)) return undefined;
    if (Date.now() - parsed.savedAt > CACHE_TTL_MS) {
      sessionStorage.removeItem(cacheKey(sessionId));
      return undefined;
    }
    return { messages: parsed.messages, start: parsed.start, total: parsed.total };
  } catch {
    return undefined;
  }
}

export function writeChatHistoryCache(sessionId: string, page: RawMessagePage): void {
  try {
    sessionStorage.setItem(cacheKey(sessionId), JSON.stringify({ ...page, savedAt: Date.now() }));
  } catch {
    // Ignore quota/private-mode failures; history paging still works without cache.
  }
}

export function removeChatHistoryCache(sessionId: string): void {
  try {
    sessionStorage.removeItem(cacheKey(sessionId));
  } catch {
    // Ignore storage access errors; cache may simply be unavailable.
  }
}

export function mergeChatHistory(existing: RawMessagePage | undefined, incoming: RawMessagePage): RawMessagePage {
  if (existing === undefined || !isValidMessagePage(existing)) return incoming;
  if (!isValidMessagePage(incoming)) return existing;
  if (isCompleteReplacement(existing, incoming)) return incoming;

  const start = Math.min(existing.start, incoming.start);
  const end = Math.max(existing.start + existing.messages.length, incoming.start + incoming.messages.length);
  const messages = new Array<unknown>(end - start);
  copyInto(messages, start, existing);
  copyInto(messages, start, incoming);

  if (hasSparseEntries(messages)) return incoming;
  return { start, total: Math.max(existing.total, incoming.total), messages };
}

/**
 * True when `page` is exactly the already-held tail of `history`, so merging it
 * would reproduce `history` unchanged. Poll responses arrive as fresh JSON
 * objects, so identity never holds; the messages are compared by JSON text,
 * which is exact for values that crossed the wire as JSON. The selected-session
 * poll uses this to skip a redundant merge, storage rewrite, and render when a
 * tick returns what is already shown.
 */
export function isHistoryTailSlice(history: RawMessagePage | undefined, page: RawMessagePage): boolean {
  if (history === undefined || !isValidMessagePage(page)) return false;
  if (page.total !== history.total) return false;
  const offset = page.start - history.start;
  if (offset < 0 || offset + page.messages.length !== history.messages.length) return false;
  return JSON.stringify(page.messages) === JSON.stringify(history.messages.slice(offset));
}

function isCompleteReplacement(existing: RawMessagePage, incoming: RawMessagePage): boolean {
  return existing.total > incoming.total && existing.start === 0 && incoming.start === 0 && incoming.messages.length === incoming.total;
}

function hasSparseEntries(messages: unknown[]): boolean {
  for (let index = 0; index < messages.length; index += 1) {
    if (!(index in messages) || messages[index] === undefined) return true;
  }
  return false;
}

function copyInto(target: unknown[], targetStart: number, page: RawMessagePage): void {
  page.messages.forEach((message, index) => {
    target[page.start - targetStart + index] = message;
  });
}

function cacheKey(sessionId: string): string {
  return `${CACHE_PREFIX}${sessionId}`;
}

function isCachedHistory(value: unknown): value is CachedChatHistory {
  if (typeof value !== "object" || value === null) return false;
  if (!("messages" in value) || !("start" in value) || !("total" in value) || !("savedAt" in value)) return false;
  const { messages, start, total, savedAt } = value;
  return Array.isArray(messages)
    && typeof start === "number"
    && typeof total === "number"
    && typeof savedAt === "number"
    && isValidMessagePage({ messages, start, total });
}

function isValidMessagePage(page: RawMessagePage): boolean {
  return Number.isInteger(page.start)
    && Number.isInteger(page.total)
    && page.start >= 0
    && page.total >= page.start
    && page.messages.length <= page.total - page.start
    && !page.messages.some(isNormalizedChatLine);
}

function isNormalizedChatLine(value: unknown): boolean {
  return typeof value === "object"
    && value !== null
    && "role" in value
    && "parts" in value
    && !("content" in value)
    && typeof value.role === "string"
    && Array.isArray(value.parts);
}
